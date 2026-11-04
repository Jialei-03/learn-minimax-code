import { Journal } from "../../runtime/journal.mjs";
/**
 * SerialDelivery：一条把事件逐个写出去的串行队列（第 2 章）。
 *
 * 对应 MiniMax 的两处实现：
 *
 * 1. `agent-core/src/pi-turn-runner/events.ts` 里 `subscribeEvents` 的 `dispatch`：
 *      const queued = queue.then(() => onAgentEvent(event));
 *      queue = queued.catch(() => undefined);
 *    Pi 的并行工具会从不同的 Promise 分支同时发出事件，所有事件必须先排进同一条队列，
 *    再一个一个翻译、写出，客户端看到的顺序才和产生顺序一致。
 * 2. `local-runtime-v2/.../events/turn-commit-pipeline.ts` 里的 `OrderedAgentEventLane`：
 *    第一次失败之后，普通事件不再执行（避免在一条已经断掉的流上继续写），
 *    只有标了 `continueAfterFailure` 的操作（失败或取消的终态）仍然会执行。
 *    这里的 `force` 就是 `continueAfterFailure`。
 *
 * 简化：MiniMax 的 lane 在失败后让排队中的普通操作 reject；这里让它们直接跳过并计数，
 * 失败原因保留在 `error` 里，由 `drain()` 重新抛出。
 */
export class SerialDelivery {
  /**
   * @param write 真正写出一帧的函数（可以是异步的）。
   * @param onFailure 每次写失败时同步通知一次，让调用方记录失败归因（第 2 章的 `recordFailure`）。
   */
  constructor(write, { onFailure } = {}) {
    this.write = write;
    this.onFailure = onFailure;
    this.tail = Promise.resolve(); // 队尾：新的事件只能接在它后面
    this.error = undefined; // 第一次失败的原因（根因），之后不再被覆盖
    this.count = 0; // 已经成功写出的帧数
    this.skipped = 0; // 因为队列已断而被跳过的帧数
    this.pending = 0; // 已入队、还没写完的帧数
  }

  /**
   * 入队一帧，返回的 Promise 在这一帧写完（或被跳过）后兑现，永远不会 reject：
   * 失败记录在 `error` 里，等 `drain()` 统一报告。
   *
   * @param options.force 为 true 时，即使队列此前已经失败也照样尝试写
   *                      （用于 failed / cancelled 终态：让客户端知道这个 Turn 已经结束）。
   */
  send(frame, { force = false } = {}) {
    this.pending++;
    this.tail = this.tail.then(async () => {
      try {
        if (this.error && !force) {
          this.skipped++;
          return;
        }
        // 写之前先深拷贝：writer 拿到的是快照，改它不会影响后面还没写的帧。
        await this.write(structuredClone(frame));
        this.count++;
      } catch (error) {
        this.error ??= error;
        this.onFailure?.(error);
      } finally {
        this.pending--;
      }
    });
    return this.tail;
  }

  /** 等所有已入队的帧处理完；如果过程中出过错，抛出第一个错误。 */
  async drain() {
    await this.tail;
    if (this.error) throw this.error;
  }
}

/**
 * EventStore：对外事件流的“可重放记录”（第 10 章）。
 *
 * 对应 MiniMax 的 `SessionStreamService`（local-runtime-v2/.../session-system/stream/session-stream-service.ts）：
 *   - `write()` 先把帧追加进带游标的环（`BoundedRing`），再发布给订阅者：先记下，后投递。
 *     host 的 app.mjs 里 `events.append(frame)` 排在 `writer(frame)` 前面，是同一个顺序——
 *     客户端看到过的每一帧，这里一定有，所以断线之后总能补上。
 *   - `resume({ afterCursor })` 从游标之后重放。游标已经被挤出环（evicted）或者根本无效（invalid-cursor）时，
 *     它不假装能续上，而是发一个 `resync-required` 帧，让客户端重新读持久化的消息。
 *
 * 简化：
 *   - 上游的环在内存里、有大小上限；这里是 Journal（只追加、落盘、不会丢），所以没有 evicted，只剩 invalid-cursor。
 *   - 上游的游标是整个会话范围内的不透明字符串；这里的游标就是“这个 Turn 里已经处理过的最后一个 seq”。
 *   - 无效游标直接抛错，不发 resync 帧。
 */
export class EventStore {
  constructor(file) {
    this.log = new Journal(file);
  }

  /**
   * 追加一帧。三条规则，违反任何一条都拒绝写入：
   *   1. 有身份：sessionId 和 turnId 都要有，否则这一帧不知道属于谁。
   *   2. 有序号：seq 必须恰好是这个 Turn 已有帧数加一。不接受跳号，也不接受重复。
   *   3. 终态是最后一帧：`turn.completed` 之后这个 Turn 不再接受任何帧。
   */
  append(frame) {
    const sameTurn = framesOfTurn(this.log.read(), frame.turnId);
    if (!frame.sessionId || !frame.turnId || frame.seq !== sameTurn.length + 1)
      throw Error("invalid event identity or sequence");
    if (sameTurn.at(-1)?.type === "turn.completed")
      throw Error("event after terminal");
    this.log.append(frame);
  }

  /**
   * 重放。
   *   replay()                  全部 Turn 的全部帧（按写入顺序）
   *   replay(turnId)            这个 Turn 的全部帧
   *   replay(turnId, afterSeq)  只要 seq 大于 afterSeq 的帧——客户端的游标就是它处理过的最后一个 seq
   *
   * 游标超过已有的最后一帧是无效游标，抛错而不是返回空数组：
   * 空数组会让客户端以为“已经追平了”，其实它的游标根本不在这条流上。
   */
  replay(turnId, afterSeq = 0) {
    const rows = this.log.read();
    if (!turnId) {
      if (afterSeq) throw Error("a cursor needs a turnId");
      return rows;
    }
    const frames = framesOfTurn(rows, turnId);
    if (afterSeq > frames.length) {
      throw Error(`invalid cursor: #${afterSeq} is beyond the last event #${frames.length}`);
    }
    return frames.filter((frame) => frame.seq > afterSeq);
  }

  /** 这个 Turn 已经写入的最后一个 seq；还没有任何帧时是 0。 */
  lastSeq(turnId) {
    return framesOfTurn(this.log.read(), turnId).length;
  }
}

/** 某个 Turn 的帧，保持写入顺序。append 保证了它们的 seq 恰好是 1、2、3……，所以帧数就是最后一个 seq。 */
function framesOfTurn(rows, turnId) {
  return rows.filter((row) => row.turnId === turnId);
}
