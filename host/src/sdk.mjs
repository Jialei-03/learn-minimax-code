// 第 10 章：对外协议的客户端一侧——把一串事件还原成一个可信的结果。
//
// 对应 MiniMax Code 0.7.2 的 `packages/code-sdk`：
//   - `items.ts` 的 `ItemAccumulator`：把交错、重复、增量的 `item.*` 事件，按 id 折叠成 items。
//     这里**直接运行**上游的完整模块（lab/source.mjs 的 importSource），不是模仿。
//   - `thread.ts` 的 `Thread.run`：事件流只是过程，结果由终态说了算。只有成功才返回；
//     失败、取消都抛出，并且把已经收到的 items（没收到 `item.completed` 的标成 incomplete）带在错误上。
//
// host 的 collector 在 ItemAccumulator 外面多包了一层“对账”，这是上游 SDK 没有的。
// 原因：上游 SDK 读的是子进程的 stdout 管道——有序、不丢、不重——它甚至不看 `sequence`
// （code-sdk/src 里除了类型定义没有任何地方用到它）；丢掉尾巴由“没有 exec.completed 就是失败”兜底。
// host 的帧却可能来自 `EventStore.replay`：断线重连之后，补发和已经收到的会有重叠。
// 所以 collector 多检查三件事：归属（turnId）、连续（seq）、重放是否幂等（见过的帧内容必须一致）。
//
// 简化：host 的帧用 `seq`，终态是 `turn.completed{status}`；
//       上游是 `sequence`，终态分成 `turn.completed` / `turn.failed`，最后还有一个 `exec.completed` 信封。
import { importSource } from "../../lab/source.mjs";
import { digest } from "../../runtime/files.mjs";

/**
 * 为一个 Turn 创建收集器。
 *
 * - `apply(frame)`：喂入一帧。返回 true 表示这一帧被接受并折叠进了结果；
 *   返回 false 表示它不该改变结果（别的 Turn 的帧、已经见过的重放帧、重复的快照）。
 *   序号缺口、同序号不同内容、终态之后还有帧，这三种情况说明流不可信，直接抛出——
 *   宁可报错，也不拼出一个看起来完整、其实缺了一块的答案。
 * - `result()`：当前能还原出的结果。`status` 是终态；还没有收到终态就是 "incomplete"。
 */
export async function collector(turnId) {
  const { ItemAccumulator } = await importSource("packages/code-sdk/src/items.ts");
  const items = new ItemAccumulator();

  const digests = new Map(); // seq → 这一帧内容的摘要，用来判断“重放的是不是同一帧”
  let lastSeq = 0; // 已经接受的最后一个序号：客户端的游标
  let terminal; // 终态（completed / failed / cancelled / budget），收到之前是 undefined
  let sessionId; // 第一帧里的会话 id：失败之后用它续会话（Thread.id 也是这样得到的）

  return {
    apply(frame) {
      // ① 归属：别的 Turn 的帧不能改动这个 Turn 的结果。
      if (frame.turnId !== turnId) return false;

      // ② 重放：序号已经处理过。内容一致就是幂等的重复投递，安静地忽略；
      //    内容不一致说明同一个序号对应了两份事实，必须暴露。
      if (frame.seq <= lastSeq) {
        if (digests.get(frame.seq) === digest(frame)) return false;
        throw Error(`event sequence conflict: #${frame.seq} was delivered twice with different content`);
      }

      // ③ 连续：只接受下一个序号。跳号意味着丢了帧——可能是工具调用、工具结果，也可能是终态。
      if (frame.seq !== lastSeq + 1) {
        throw Error(`event sequence gap: expected #${lastSeq + 1}, got #${frame.seq}`);
      }

      // ④ 终态是这个 Turn 的最后一帧，后面不能再有任何事件。
      if (terminal) throw Error("event after terminal");

      digests.set(frame.seq, digest(frame));
      lastSeq = frame.seq;
      sessionId ??= frame.sessionId;
      if (frame.type === "turn.completed") terminal = frame.status;

      // 通过了对账，才交给上游的折叠器：按 id 合并，增量追加，重复的快照返回 false。
      return items.apply(frame);
    },

    result() {
      return {
        status: terminal ?? "incomplete",
        items: items.items(), // 没有 item.completed 的 item 带着 incomplete: true
        lastSeq,
        sessionId,
      };
    },
  };
}

/**
 * 对应 `Thread.run` 的收尾：只有成功的 Turn 才返回结果，其余一律抛出 `TurnError`。
 *
 * 状态的对应关系（host → 上游 `exec.completed.result.status`）：
 *   completed → succeeded    cancelled → cancelled    failed → failed
 *   budget → limit_exceeded（用完 maxTurns，对应 `--max-steps`）
 *   incomplete：流在终态之前就断了。上游没有这个状态——那时没有 `exec.completed`，
 *   SDK 改看进程的退出码（errorForExit）；这里没有进程，只剩“没有终态”这一个事实。
 */
export function requireSuccess(result) {
  if (result.status !== "completed") throw new TurnError(result);
  return result;
}

/** 失败的 Turn。带着调用方继续工作需要的一切：状态、已经收到的 items、可以用来续会话的 sessionId。 */
export class TurnError extends Error {
  constructor({ status, items, sessionId, lastSeq }) {
    super(
      status === "incomplete"
        ? "event stream ended before a terminal frame"
        : `Turn ended with ${status}`,
    );
    this.name = "TurnError";
    this.status = status;
    this.items = items; // 部分结果：未完成的 item 标着 incomplete
    this.sessionId = sessionId;
    this.lastSeq = lastSeq;
  }
}
