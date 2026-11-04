// 第 9 章：忙的时候来了一条新消息——持久队列与插话。
//
// 对应 MiniMax Code 0.7.2 的三处代码：
//   1. local-runtime-v2/src/service/session-system/queue/repo/drizzle.ts（队列仓库）
//      enqueue / claimNext / acknowledgeClaim / releaseClaim / recoverClaims / pauseIfPending
//   2. local-runtime-v2/src/service/turn-system/persistence/turn.repository.ts
//      队列“确认”之前要去问 Turn 一侧有没有接纳回执（findAcceptedQueueTurn）
//   3. local-runtime-v2/src/service/turn-system/execution/turn-controller/turn.controller.ts
//      运行中的 Turn 的插话收件箱，以及 steering-requeue.ts 里“没来得及消费的插话去哪里”
//
// 一条消息在这里依次有四个“负责人”，交接之前，新负责人必须已经把账记在日志里：
//
//   pending ──claim──▶ claimed ──(Turn 侧写回执)──▶ acknowledge ──▶ accepted ──▶ consumed
//      ▲                  │                                              │
//      └───── release ────┘                                    Turn 接管：队列不再负责
//
//   - pending   队列负责。重试同一个 clientRequestId 只会拿回这一行。
//   - claimed   调度器取走了它，同一个会话同一时刻只允许一个 claim；带着租约，崩溃后可以被收回。
//   - accepted  Turn 已经接纳：Turn 一侧留下了回执，队列才肯确认。从这里开始，崩溃后的善后归 Turn。
//   - consumed  host 多记的一步：Turn 的事件已经送达、历史已经落盘（MiniMax 里这一步属于 Turn 的终态）。
//
// 简化（读源码时要知道有这些差别）：
//   - MiniMax 的队列行在确认之后就从表里删掉，只留下一条“已移除（原因：accepted）”的事实；
//     host 的日志只追加，所以行会留着，state 变成 accepted / consumed，方便读者回放。
//   - MiniMax 在 Turn 提交之前先 prepareDelivery，把 (claimId, turnId) 这次“投递尝试”记在行上；
//     host 里 recordIngress 同时扮演了这个角色。
//   - 没有 dedupeKey、排序（reorder）、编辑（update）这些只服务界面的操作。
import { createHash, randomUUID } from "node:crypto";
import { Journal } from "../../runtime/journal.mjs";

const DEFAULT_LEASE_MS = 30_000; // 对应 DEFAULT_CLAIM_LEASE_MS
const NO_CLAIM = { claimId: null, claimOwner: null, leaseExpiresAt: null };

export class WorkQueue {
  /**
   * @param file    日志文件。队列的全部状态都由它重放得到，内存里不存任何东西。
   * @param now     时钟，实验里换成假时钟。
   * @param options.owner    这个进程（这个 WorkQueue 对象）的身份，写在它取走的 claim 上。
   * @param options.leaseMs  claim 的租约。租约内、owner 活着的 claim 不会被 recover() 收走。
   */
  constructor(file, now = Date.now, { owner = `queue-owner:${randomUUID()}`, leaseMs = DEFAULT_LEASE_MS } = {}) {
    this.log = new Journal(file);
    this.now = now;
    this.owner = owner;
    this.leaseMs = leaseMs;
  }

  // ─── 读：全部由日志重放得到 ───────────────────────────────────────────────

  /**
   * 重放日志，得到三样东西：队列行、Turn 一侧的接纳回执、每个会话的暂停标记。
   * MiniMax 把它们放在两张表里（queue_items / turn_ingress），这里放在同一个日志里，用 type 区分。
   */
  replay() {
    const rows = new Map(); // itemId → 行
    const receipts = new Map(); // claimId → { itemId, turnId }：Turn 说“这个 claim 我接纳了”
    const pauses = new Map(); // sessionId → { cause, triggerTurnId, at }
    for (const fact of this.log.read()) {
      if (fact.type === "enqueue") rows.set(fact.item.id, { ...fact.item, state: "pending" });
      else if (fact.type === "transition") {
        if (rows.has(fact.id)) Object.assign(rows.get(fact.id), fact.patch);
      } else if (fact.type === "ingress") receipts.set(fact.claimId, fact);
      else if (fact.type === "pause") pauses.set(fact.sessionId, fact.pause);
      else if (fact.type === "continue") pauses.delete(fact.sessionId);
    }
    const items = [...rows.values()].sort((a, b) => a.order - b.order);
    return { items, receipts, pauses };
  }

  /** 所有行，包括已经结束的（accepted / consumed / cancelled / expired）。 */
  items() {
    return this.replay().items;
  }

  get(id) {
    return this.items().find((item) => item.id === id);
  }

  /** 界面上看得到的排队项：只有 pending。被 claim 的那一条正在派发，不再属于“排队”。 */
  list(sessionId) {
    return this.items().filter((item) => item.sessionId === sessionId && item.state === "pending");
  }

  /** 这个会话的暂停标记；队列里没有待处理的项时，暂停自动失效（对应 reconcilePause）。 */
  paused(sessionId) {
    const { items, pauses } = this.replay();
    return pendingWork(items, sessionId) ? pauses.get(sessionId) : undefined;
  }

  /** 日志本身就是“已提交的事实”（对应 CommittedQueueResult.facts），实验直接拿来回放。 */
  facts() {
    return this.log.read();
  }

  // ─── 入队：重试不能变成两份工作 ──────────────────────────────────────────

  /**
   * 对应 QueueService.enqueue + 仓库的 enqueueInTransaction。
   *
   * clientRequestId 是调用方给这条消息的身份。网络断了、客户端不知道第一次有没有成功，重发一次，
   * 拿回来的必须是同一行——连同第一次解析好的 model，而不是用新的参数再造一行。
   * 过期时间在写日志之前检查：已经过期的消息不应该进队列。
   * `front` 对应 queuePlacement: 'front'：插到所有排队项的最前面（没来得及消费的插话就是这样回来的）。
   */
  enqueue(sessionId, text, { clientRequestId = randomUUID(), expiresAt, model, front = false } = {}) {
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= this.now())) {
      throw Error("expiry-invalid");
    }
    const { items } = this.replay();
    const old = items.find((item) => item.sessionId === sessionId && item.clientRequestId === clientRequestId);
    if (old) return old;
    const queuedOrders = items.filter((i) => i.sessionId === sessionId && i.state === "pending").map((i) => i.order);
    const lastOrder = items.reduce((max, item) => Math.max(max, item.order), 0);
    const item = {
      id: randomUUID(),
      sessionId,
      text,
      clientRequestId,
      expiresAt,
      model,
      createdAt: this.now(),
      order: front && queuedOrders.length ? Math.min(...queuedOrders) - 1 : lastOrder + 1,
    };
    this.log.append({ type: "enqueue", item });
    return { ...item, state: "pending" };
  }

  /** 旧接口：直接追加一条状态变化。其他方法都是在它上面加了前置条件。 */
  transition(id, state, extra = {}) {
    if (!this.items().some((item) => item.id === id)) throw Error("queue item missing");
    this.log.append({ type: "transition", id, patch: { ...extra, state } });
  }

  // ─── 取走：claim ─────────────────────────────────────────────────────────

  /**
   * 对应 claimNext。三个“不给”：
   *   1. 会话处于暂停（用户按过停止）：不给，除非调用方明确要求继续（continuePaused）或点名取某一项（itemId）；
   *   2. 这个会话已经有一个 claim 在手：不给——同一时刻只有一条消息在被派发；
   *   3. 队首已经过期：先把它标成 expired，再看下一条。
   */
  claim(sessionId, { itemId, continuePaused = false } = {}) {
    this.expireDue(sessionId);
    const { items, pauses } = this.replay();
    const mine = items.filter((item) => item.sessionId === sessionId);
    if (!itemId && !continuePaused && pendingWork(items, sessionId) && pauses.has(sessionId)) return undefined;
    if (mine.some((item) => item.state === "claimed")) return undefined;
    const item = itemId
      ? mine.find((candidate) => candidate.id === itemId && candidate.state === "pending")
      : mine.find((candidate) => candidate.state === "pending");
    if (!item) return undefined;
    const claim = {
      claimId: `claim_${randomUUID()}`,
      claimOwner: this.owner,
      leaseExpiresAt: this.now() + this.leaseMs,
    };
    this.transition(item.id, "claimed", claim);
    return { ...item, ...claim, state: "claimed" };
  }

  /** 到期的排队项直接作废（对应每个事务开头的 deleteExpired）。已经被 claim 的不受影响。 */
  expireDue(sessionId) {
    for (const item of this.items()) {
      if (item.sessionId !== sessionId || item.state !== "pending") continue;
      if (item.expiresAt !== undefined && item.expiresAt <= this.now()) this.transition(item.id, "expired");
    }
  }

  // ─── 接纳：先有 Turn 的回执，队列才确认 ───────────────────────────────────

  /**
   * Turn 一侧的动作：“我接纳了这个 claim，对应的 Turn 是 turnId”。
   * 对应 turn.repository.ts 的 insertAdmission，它把 claimId 和队列项 id 写进 turn_ingress。
   * 回执属于 Turn，不属于队列；队列只会来问。同一个 claim 不能被两个 Turn 接纳。
   */
  recordIngress(id, turnId) {
    const item = this.get(id);
    if (item?.state !== "claimed") throw Error("claim required");
    const existing = this.replay().receipts.get(item.claimId);
    if (existing) {
      if (existing.turnId !== turnId) throw Error("claim already belongs to another Turn");
      return;
    }
    this.log.append({ type: "ingress", claimId: item.claimId, itemId: id, sessionId: item.sessionId, turnId });
  }

  /**
   * 队列一侧的动作：确认。对应 acknowledgeClaim——它在同一个事务里问 isAcceptedInTransaction，
   * 没有回执就抛 QueueClaimNotAcceptedError。队列不能自己宣布“这条已经有人接手了”。
   */
  acknowledge(id) {
    const { items, receipts } = this.replay();
    const item = items.find((candidate) => candidate.id === id);
    if (item?.state !== "claimed") throw Error("claim required");
    const receipt = receipts.get(item.claimId);
    if (!receipt) throw Error("claim is not accepted by any Turn");
    this.transition(id, "accepted", { turnId: receipt.turnId });
  }

  /** 旧接口：先让 Turn 记回执，再让队列确认。两步之间崩溃，就是 recover() 要处理的情况。 */
  accept(id, turnId) {
    this.recordIngress(id, turnId);
    this.acknowledge(id);
  }

  /** Turn 的事件已送达、历史已落盘。没有确认过的项不能“消费”。 */
  consume(id) {
    if (this.get(id)?.state !== "accepted") throw Error("durable acceptance required");
    this.transition(id, "consumed");
  }

  // ─── 放回、取消、被插话取走 ─────────────────────────────────────────────

  /**
   * 对应 releaseClaim：这次派发没成（会话还忙、被策略推迟、Turn 启动前出错），放回队列，位置不变。
   * reason 会留在行上（对应 requeue 事实里的 admissionReason），界面可以据此解释“为什么还在排队”。
   */
  release(id, reason) {
    const item = this.get(id);
    if (item?.state !== "claimed") throw Error("claim required");
    if (item.expiresAt !== undefined && item.expiresAt <= this.now()) return this.transition(id, "expired", NO_CLAIM);
    this.transition(id, "pending", { ...NO_CLAIM, ...(reason ? { requeueReason: reason } : {}) });
  }

  /** 用户删除一条排队项。只有还在排队的才能删；已经被 claim 的正在派发，返回 not_editable。 */
  cancel(id) {
    const item = this.get(id);
    if (!item) return undefined;
    if (item.state !== "pending") return "not_editable";
    this.transition(id, "cancelled");
    return { ...item, state: "cancelled" };
  }

  /**
   * 对应 consumeClaim(reason: 'injected')：这条排队项被“立刻发送”——它的内容作为插话进了正在运行的 Turn。
   * 它不再需要自己的 Turn，所以直接从 claimed 结束。
   */
  inject(id) {
    if (this.get(id)?.state !== "claimed") throw Error("claim required");
    this.transition(id, "injected", NO_CLAIM);
  }

  // ─── 崩溃之后 ────────────────────────────────────────────────────────────

  /**
   * 对应 recoverClaims。扫描没人认领的 claim（租约过期，或者 owner 不是当前这个 WorkQueue），一律放回队列。
   *
   * 为什么连“Turn 已经写了回执、只差队列确认”的 claim 也放回去？因为确认发生在 Turn 开始执行之前
   * （MiniMax 的 beforeStart，host 的 app.run 里 accept 先于 runTurn）：claim 还在，就说明确认没做完，
   * 而确认没做完，Turn 一定还没有动过手，重新排队是安全的。已经确认的项（accepted）则相反：Turn 接管了，
   * 它跑到哪里、有没有副作用，队列不知道，所以不重试，只在返回值里报告出来，由会话一侧去核对。
   *
   * 返回“已经被 Turn 接纳、但还没有 consumed”的项（MiniMax 里这些由 Turn 的租约过期 → failed 收尾）。
   */
  recover() {
    for (const item of this.items().filter((candidate) => candidate.state === "claimed")) {
      if (!this.claimIsLive(item)) this.release(item.id, "recovered");
    }
    return this.items().filter((item) => item.state === "accepted");
  }

  /** 对应 activeClaim：租约没过期、owner 还活着（这里只认当前对象自己）。 */
  claimIsLive(item) {
    return item.claimOwner === this.owner && item.leaseExpiresAt > this.now();
  }

  // ─── 用户按了停止之后：暂停，不要自己接着跑 ──────────────────────────────

  /**
   * 对应 pauseIfPending。只有队列里确实有待处理的项才写暂停，否则没有东西需要“等用户”。
   * 暂停之后 claim() 返回 undefined，直到有人明确继续（continueQueue），或者点名取某一项。
   */
  pauseIfPending(sessionId, cause, triggerTurnId) {
    const { items, pauses } = this.replay();
    if (!pendingWork(items, sessionId) || pauses.has(sessionId)) return pauses.get(sessionId);
    const pause = { cause, triggerTurnId, at: this.now() };
    this.log.append({ type: "pause", sessionId, pause });
    return pause;
  }

  continueQueue(sessionId) {
    if (this.replay().pauses.has(sessionId)) this.log.append({ type: "continue", sessionId });
  }
}

function pendingWork(items, sessionId) {
  return items.some((item) => item.sessionId === sessionId && (item.state === "pending" || item.state === "claimed"));
}

// ───────────────────────────────────────────────────────────────────────────
// 插话：运行中的 Turn 的收件箱
// ───────────────────────────────────────────────────────────────────────────

/** 对应 agent-host/runner/contracts.ts 的 USER_STEERING_PRODUCERS：这些来源的插话是用户亲手发的。 */
const USER_PRODUCERS = new Set(["queue-immediate-send", "composer-steer", "paused-queue-composer"]);
export const isUserProducer = (producerId) => USER_PRODUCERS.has(producerId);
const identityOf = (message) => `${message.producerId}\u0000${message.idempotencyKey}`;

/**
 * 对应 turn.controller.ts 里 ActiveTurnEntry 的插话部分（steering / steeringClaims / steeringIdentities / phase）。
 * 一个运行中的 Turn 有一个；Turn 结束它就没用了。它是内存里的，所以“出口”必须定义清楚：
 * 每一条被接纳的插话，最后要么被模型读到，要么交给 onDiscard，由调用方送到某个持久的地方。
 *
 * 一条插话在这里有三种位置：
 *   waiting   已接纳，等着被取走
 *   claimed   已被取走（drain），消费还没确认——这时 Turn 被取消，它不能凭空消失
 *   （消费确认 ack 之后，从 claimed 里删掉，进入模型的历史）
 *
 * phase：running → closing（正常收尾，不再接受）或 aborted（被取消）。
 */
export class SteeringBuffer {
  /** @param onDiscard (cause, messages, abortReason?) => void；cause 是 'exit-close' | 'abort' | 'abnormal-seal' */
  constructor({ onDiscard } = {}) {
    this.onDiscard = onDiscard;
    this.phase = "running";
    this.waiting = [];
    this.claimed = new Map();
    this.seen = new Set(); // 去重：producerId + idempotencyKey。同一条插话投递两次只算一次。
    this.abortReason = undefined;
  }

  /** 对应 steer()：Turn 在跑才接受；重复的投递认账但不重复放入。 */
  steer(message) {
    if (this.phase !== "running") return { status: "closing" };
    const identity = identityOf(message);
    if (!this.seen.has(identity)) {
      this.seen.add(identity);
      this.waiting.push(message);
    }
    return { status: "accepted" };
  }

  /** 对应 drainSteering：把所有等待中的插话取走，记在 claimed 里。 */
  drain() {
    if (this.phase === "aborted") return [];
    const taken = this.waiting.splice(0);
    for (const message of taken) this.claimed.set(identityOf(message), message);
    return taken;
  }

  /** 对应 ackSteering：这些插话已经进了模型的输入，不再需要保管。 */
  ack(messages) {
    for (const message of messages) this.claimed.delete(identityOf(message));
  }

  /**
   * 对应 restoreSteering：取走了但不打算消费（比如在“出口”边界上，用户的插话不能让已经完成的回答继续下去），放回队首。
   * 如果这时 Turn 已经被取消，它们不能放回一个已死的收件箱，直接走 abort 出口。
   */
  restore(messages) {
    const back = messages.filter((message) => this.claimed.delete(identityOf(message)));
    if (this.phase === "aborted") this.discard("abort", back);
    else this.waiting.unshift(...back);
  }

  /**
   * 这个函数合并了 MiniMax 的两处：runner 每一步结束后问宿主要插话（executor.ts 的 getSteeringMessages），
   * 以及 user-input-control.ts 里的“出口规则”——boundary 是 exit（最后一步没有工具调用，回答已经写完）时，
   * 用户的插话不延长这条回答：留着，等 tryBeginClose 把它们交给 onDiscard，变成下一个 Turn。
   */
  poll(boundary) {
    const taken = this.drain();
    const deferred = boundary === "exit" ? taken.filter((message) => isUserProducer(message.producerId)) : [];
    const delivered = taken.filter((message) => !deferred.includes(message));
    if (deferred.length) this.restore(deferred);
    this.ack(delivered);
    return delivered;
  }

  /**
   * 对应 tryBeginClose：Turn 想正常结束了，原子地“关门”。
   *   - 有插话正在被消费（claimed 非空），或者有机器产生的插话还在等：不能关，调用方再 poll 一次；
   *   - 否则关门：phase 变成 closing，剩下的用户插话交给 onDiscard('exit-close')，不会丢也不会延长回答。
   * 关门之后再来的 steer() 返回 closing——调用方应该改走排队（或者开一个新 Turn）。
   */
  tryBeginClose() {
    if (this.phase === "aborted") return { closed: false, reason: "aborted", abortReason: this.abortReason };
    if (this.claimed.size > 0) return { closed: false, reason: "steer-pending" };
    if (this.waiting.some((message) => !isUserProducer(message.producerId))) {
      return { closed: false, reason: "steer-pending" };
    }
    const left = this.waiting.splice(0);
    if (left.length) this.discard("exit-close", left);
    this.phase = "closing";
    return { closed: true };
  }

  /**
   * 对应 abortEntry：用户停止。等待中的插话交给 onDiscard('abort')；已被取走但没确认的先留着
   * （消费可能马上就完成，也可能 restore 回来，到时候再走 abort 出口）。
   */
  abort(reason) {
    this.phase = "aborted";
    this.abortReason = reason;
    this.discard("abort", this.waiting.splice(0));
  }

  /** 对应 sealAbnormalTerminal：Turn 以失败或取消结束，终态提交之前把剩下的插话处理掉。 */
  seal() {
    this.discard("abnormal-seal", this.waiting.splice(0));
    if (this.phase !== "aborted") this.phase = "closing";
  }

  discard(cause, messages) {
    if (messages.length) this.onDiscard?.(cause, messages, this.abortReason);
  }
}

/**
 * 没来得及消费的插话去哪里（对应 steering-requeue.ts 的 resolveRoute）：
 *   exit-close      Turn 正常结束，这些话还没说完：作为一个排队项放回队首，成为下一个 Turn；
 *   abort / abnormal-seal   Turn 被取消或失败：这些话已经被用户“说出口”，写进会话的历史，下一次请求模型就能读到，
 *                           不再排队（否则用户刚按了停止，排队的指令又自己跑起来）。
 * 机器产生的插话（定时任务、通知）在两条出口上都直接丢掉。
 *
 * 一批插话的身份来自 (sessionId, turnId, 每条的 producerId + idempotencyKey)，
 * 所以同一批插话被重复处理，也只会得到一个排队项（对应 batchIdentity）。
 */
export function routeDiscardedSteering({ cause, messages, sessionId, turnId, queue, appendToHistory }) {
  const mine = messages.filter((message) => isUserProducer(message.producerId));
  if (!mine.length) return { route: "dropped", count: 0 };
  if (cause === "exit-close") {
    const batchId = createHash("sha256")
      .update(JSON.stringify([sessionId, turnId, mine.map((m) => [m.producerId, m.idempotencyKey])]))
      .digest("hex");
    const text = mine.map((message) => message.text).join("\n\n");
    const item = queue.enqueue(sessionId, text, { clientRequestId: `steer-batch:${batchId}`, front: true });
    return { route: "queue", count: mine.length, itemId: item.id };
  }
  appendToHistory(mine.map((message) => ({ role: "user", text: message.text, steered: true })));
  return { route: "conversation", count: mine.length };
}
