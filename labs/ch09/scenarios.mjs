// 第 9 章的实验场景。每个函数只返回数据，由 durability.mjs / lifecycle.mjs / service.mjs /
// controller.mjs / cancel.mjs / fork.mjs 打印成表格，也被 labs/chapters/09-queue-cancel.mjs 用来做回归检查。
// 全部离线、确定，不需要 API Key。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { importSource } from "../../lab/source.mjs";
import { createApplication } from "../../host/src/app.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
import { SteeringBuffer, WorkQueue, routeDiscardedSteering } from "../../host/src/queue.mjs";
import { forkSession, forkTask, settledPrefix } from "../../host/src/fork.mjs";

/** 把对象数组转成 Markdown 表格文本。 */
export function markdownTable(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${keys.join(" | ")} |`,
    `| ${keys.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(" | ")} |`),
  ].join("\n");
}

/** 在临时目录里运行，结束后删除。 */
export async function withTemp(run) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ch09-")));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SERVICE = "packages/local-runtime-v2/src/service/session-system/queue/service.ts";
const CONTRACT = "packages/local-runtime-v2/src/service/session-system/queue/repo/contract.ts";
const CONTROLLER = "packages/local-runtime-v2/src/service/turn-system/execution/turn-controller/turn.controller.ts";

// ─── 场景一：只有内存的队列 vs. 持久队列 ────────────────────────────────────────

/** Pi 的 steer / followUp 队列就是这个形状：一个数组，取走就没了，没有身份。 */
class MemoryQueue {
  constructor() {
    this.items = [];
  }
  push(text) {
    this.items.push(text);
  }
  drain() {
    return this.items.splice(0);
  }
}

/** 把队列里的消息一条条跑完：取走 → Turn 接纳 → 确认 → 跑完。返回被执行的文本。 */
function runAll(queue, sessionId, label = "turn") {
  const executed = [];
  for (let item = queue.claim(sessionId); item; item = queue.claim(sessionId)) {
    queue.accept(item.id, `${label}-${executed.length + 1}`);
    executed.push(item.text);
    queue.consume(item.id);
  }
  return executed;
}

/** 同一个“重启”：新对象、新 owner，读同一个日志文件。 */
const restart = (file, clock) => new WorkQueue(file, clock);

export async function durability() {
  return withTemp((dir) => {
    const clock = () => 1000;

    // ① 客户端没收到确认，同一条消息发了两次。
    const memory = new MemoryQueue();
    memory.push("fix tests");
    memory.push("fix tests");
    const memoryRetryRuns = memory.drain().length;
    const retry = new WorkQueue(join(dir, "retry.jsonl"), clock);
    const first = retry.enqueue("s", "fix tests", { clientRequestId: "req-1" });
    const second = retry.enqueue("s", "fix tests", { clientRequestId: "req-1" });
    const retryRuns = runAll(retry, "s").length;

    // ②③④ 三个崩溃点：每个都是“旧进程做到这里就没了，新进程读同一个日志”。
    const crashAt = (name, stepsBeforeCrash) => {
      const file = join(dir, `${name}.jsonl`);
      const before = new WorkQueue(file, clock);
      before.enqueue("s", "fix tests", { clientRequestId: "req-1" });
      stepsBeforeCrash(before, before.claim("s"));
      const after = restart(file, clock);
      const reported = after.recover();
      const state = after.items()[0].state;
      const orphanReceipts = after.facts().filter((fact) => fact.type === "ingress").length; // 重跑之前日志里的回执
      const rerun = runAll(after, "s", "turn-B").length;
      return { state, reported: reported.map((item) => item.turnId), rerun, orphanReceipts };
    };
    const afterClaim = crashAt("after-claim", () => {});
    const afterReceipt = crashAt("after-receipt", (queue, claim) => queue.recordIngress(claim.id, "turn-A"));
    const afterAck = crashAt("after-ack", (queue, claim) => queue.accept(claim.id, "turn-A"));

    // 内存队列的“崩溃”：新进程里是一个空数组。无论崩在哪一步，消息都没了，也无从知道做到哪。
    const memoryAfterCrash = new MemoryQueue().drain().length;

    const rows = [
      {
        场景: "客户端超时，同一条消息发了两次",
        内存队列: `排进 ${memoryRetryRuns} 项，执行 ${memoryRetryRuns} 次`,
        WorkQueue: `第二次拿回同一行（同一个 id：${first.id === second.id ? "是" : "否"}），执行 ${retryRuns} 次`,
      },
      {
        场景: "调度器取走之后、Turn 接纳之前崩溃",
        内存队列: `重启后队列里有 ${memoryAfterCrash} 项：消息丢了`,
        WorkQueue: `新进程发现 claim 的 owner 不是自己 → 收回，${afterClaim.state === "pending" ? "放回队列" : afterClaim.state}，重新执行 ${afterClaim.rerun} 次`,
      },
      {
        场景: "Turn 写了回执、队列还没确认就崩溃",
        内存队列: "同上：丢了",
        WorkQueue: `回执在，但确认没做完 = Turn 还没动手 → ${afterReceipt.state === "pending" ? "放回队列" : `状态 ${afterReceipt.state}`}，重新执行 ${afterReceipt.rerun} 次（turn-A 的回执留在日志里：${afterReceipt.orphanReceipts} 条，不会再被用到）`,
      },
      {
        场景: "队列确认之后、Turn 跑完之前崩溃",
        内存队列: "同上：丢了，也不知道做到了哪一步",
        WorkQueue: `不重试：状态 ${afterAck.state}，recover() 报告 turn=${afterAck.reported.join(",")} 交给会话一侧核对`,
      },
    ];
    return { rows, memoryRetryRuns, retryRuns, sameItem: first.id === second.id, afterClaim, afterReceipt, afterAck, memoryAfterCrash };
  });
}

// ─── 场景二：一条消息的一生，以及两个“不让” ─────────────────────────────────────

export async function lifecycle() {
  return withTemp((dir) => {
    const clock = () => 1000;
    const queue = new WorkQueue(join(dir, "queue.jsonl"), clock);
    const rows = [];
    const step = (动作, 结果) => rows.push({ 动作, 结果, 状态: queue.items().map((item) => item.state).join(", ") || "—", 日志条数: queue.facts().length });
    const attempt = (fn) => {
      try {
        return fn();
      } catch (error) {
        return `抛出：${error.message}`;
      }
    };

    const item = queue.enqueue("s", "fix tests", { clientRequestId: "req-1" });
    step("enqueue(clientRequestId=req-1)", "写入一行");
    queue.enqueue("s", "fix tests", { clientRequestId: "req-1" });
    step("同一个 clientRequestId 再 enqueue", "拿回同一行，没有新增");
    const waiting = queue.enqueue("s", "and lint", { clientRequestId: "req-2" });
    step("enqueue(clientRequestId=req-2)", "第二条排在后面");

    const claim = queue.claim("s");
    step("claim(s)", "取走第一条，生成 claimId 和租约");
    const blocked = queue.claim("s");
    step("claim(s) 再来一次", blocked === undefined ? "undefined：这个会话已经有一个 claim 在手" : "（不应该）");
    const early = attempt(() => queue.acknowledge(claim.id));
    step("没有 Turn 的回执就 acknowledge", early);
    queue.recordIngress(claim.id, "turn-A");
    step("Turn 一侧 recordIngress(turn-A)", "回执写好了，队列行还是 claimed");
    queue.acknowledge(claim.id);
    step("acknowledge", "队列确认：从这里起，崩溃后的善后归 Turn");
    const early2 = attempt(() => queue.consume(waiting.id));
    step("consume 一个还没被确认的项（req-2）", early2);
    queue.consume(claim.id);
    step("consume", "Turn 事件已送达、历史已落盘");
    const replayAfter = queue.enqueue("s", "fix tests", { clientRequestId: "req-1" });
    step("消费之后客户端又重发 req-1", `拿回 state=${replayAfter.state} 的旧行，不会再排一次`);

    const pauseRows = [];
    const pauseStep = (动作, 结果) => pauseRows.push({ 动作, 结果 });
    const pause = queue.pauseIfPending("s", "user-stop", "turn-A");
    pauseStep("用户停止后 pauseIfPending（队列里还有 req-2）", pause ? `写入暂停：cause=${pause.cause}` : "（没有写）");
    pauseStep("claim(s)", queue.claim("s") === undefined ? "undefined：暂停期间不自己派发" : "（不应该）");
    pauseStep("list(s)（界面看到的排队项）", `${queue.list("s").length} 项仍在队里，没有丢`);
    queue.continueQueue("s");
    const resumed = queue.claim("s");
    pauseStep("continueQueue 之后 claim(s)", resumed ? `取到 “${resumed.text}”` : "（没取到）");
    const noPause = new WorkQueue(join(dir, "empty.jsonl"), clock).pauseIfPending("s", "user-stop", "turn-A");
    pauseStep("队列是空的时候 pauseIfPending", noPause === undefined ? "什么也不写：没有东西需要等用户" : "（不应该）");

    return { rows, pauseRows, early, early2, blocked, replayAfter, item, resumed };
  });
}

// ─── 场景三：真实的上游 QueueService ───────────────────────────────────────────

export async function realQueueService() {
  const { QueueService } = await importSource(SERVICE);
  const { QueueDataCorruptionError, QueueEnqueueAdmissionError } = await importSource(CONTRACT);
  const stored = new Map();
  const calls = { resolve: [], storeEnqueue: 0, storeModels: [] };
  // 假的仓库：只实现 QueueService.enqueue 会碰的两个方法。事务、claim、恢复都不在这里验证。
  const store = {
    async findByClientRequestId(sessionId, clientRequestId) {
      return { value: stored.get(`${sessionId}/${clientRequestId}`), facts: [] };
    },
    async enqueue(input) {
      calls.storeEnqueue++;
      calls.storeModels.push(input.model?.model_id);
      const key = `${input.session.sessionId}/${input.clientRequestId}`;
      if (!stored.has(key)) stored.set(key, { itemId: `item-${stored.size + 1}`, model: input.model });
      return { value: { item: stored.get(key), position: stored.size }, facts: [] };
    },
    async cancel() {
      throw new QueueEnqueueAdmissionError("s", calls.admission);
    },
    async list() {
      throw new QueueDataCorruptionError("s", "item-9");
    },
  };
  const service = new QueueService({
    store,
    nowMs: () => 1000,
    sessions: { get: async (sessionId) => ({ sessionId, agentName: "mcode", runtime: "local" }) },
    resolveModel: (_session, model) => {
      calls.resolve.push(model?.model_id);
      return { ...model, resolved: `解析自 ${model?.model_id}` };
    },
  });
  const input = (clientRequestId, modelId, extra = {}) => ({
    session: { sessionId: "s", agentName: "mcode" },
    clientRequestId,
    message: { content: "fix tests", attachments: [] },
    model: { model_id: modelId },
    ...extra,
  });
  const rows = [];
  const record = (调用, resolveModel被调用, 入队的model, 说明) => rows.push({ 调用, resolveModel被调用: resolveModel被调用, 入队的model, 说明 });

  const r1 = await service.enqueue(input("req-1", "m-old"));
  record("enqueue(req-1, model=m-old)", `是（${calls.resolve.join(",")}）`, r1.value.item.model.resolved, "第一次见这个 clientRequestId：解析模型");
  const resolvedBefore = calls.resolve.length;
  const r2 = await service.enqueue(input("req-1", "m-new"));
  record("重试 enqueue(req-1, model=m-new)", calls.resolve.length === resolvedBefore ? "否" : "是", r2.value.item.model.resolved, "已存在：沿用第一次解析出的 model，不换成新参数");
  const r3 = await service.enqueue(input("req-2", "m-new"));
  record("enqueue(req-2, model=m-new)", `是（${calls.resolve.join(",")}）`, r3.value.item.model.resolved, "新的 clientRequestId：照常解析");

  const storeCallsBefore = calls.storeEnqueue;
  const expiry = [];
  for (const expiresAt of [999, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
    try {
      await service.enqueue(input(`exp-${String(expiresAt)}`, "m-new", { expiresAt }));
      expiry.push(`${expiresAt}: 通过（不应该）`);
    } catch (error) {
      expiry.push(`${expiresAt}: ${error.reason}`);
    }
  }
  record("expiresAt = 999 / 1000 / NaN / Infinity（现在是 1000）", "否", "—", `${expiry.join("；")}；仓库被调用 ${calls.storeEnqueue - storeCallsBefore} 次`);

  const mapped = [];
  for (const admission of ["maintenance-active", "session-not-found"]) {
    calls.admission = admission;
    mapped.push(await service.cancel("s", "i").catch((error) => `${admission} → ${error.reason}`));
  }
  mapped.push(await service.list("s").catch((error) => `QueueDataCorruptionError → ${error.reason}`));
  record("仓库抛出的错误", "—", "—", mapped.join("；"));

  return { rows, calls, expiry, mapped, r1, r2, r3 };
}

// ─── 场景四：运行中的 Turn 的所有权与插话（真实的 TurnController vs. host 的 SteeringBuffer）──────

const userMessage = (key, text) => ({ producerId: "composer-steer", idempotencyKey: key, text, message: { text } });
const machineMessage = (key, text) => ({ producerId: "cron", idempotencyKey: key, text, message: { text } });
const keys = (messages) => `[${messages.map((m) => m.idempotencyKey).join(",")}]`;

/** 同一组操作的两种实现：上游真实的 TurnController，和 host 的 SteeringBuffer。 */
async function steeringImplementations() {
  const { createTurnController } = await importSource(CONTROLLER);

  // 上游：每个 Turn 注册一次，通过 scope(lease) 拿到只属于它的那几个操作。
  const upstreamDiscards = [];
  const controller = createTurnController({
    renew: async () => true,
    abortTimeoutMs: 60,
    onSteeringDiscarded: (d) => upstreamDiscards.push(`${d.cause}${keys(d.messages)}`),
  });
  const register = (turnId) => {
    const lease = { sessionId: "s", turnId, leaseId: `lease-${turnId}`, acceptedSequence: 1, acceptedAtMs: 0, busyReason: "turn" };
    const turn = controller.register(lease);
    const scope = controller.scope(turn);
    const adapter = {
      turn,
      scope,
      steer: async (message) => (await controller.steerActiveTurn({ sessionId: "s", turnId, message })).status,
      drain: () => scope.drainSteering(),
      ack: (messages) => scope.ackSteering(messages),
      restore: (messages) => scope.restoreSteering(messages),
      tryBeginClose: () => {
        const result = scope.tryBeginClose();
        return result.closed ? "closed" : result.reason;
      },
      abort: (reason) => controller.abort({ sessionId: "s", reason }),
      takeDiscards: () => upstreamDiscards.splice(0).join(" "),
    };
    return adapter;
  };

  // host：每个 Turn 一个 SteeringBuffer。
  const hostDiscards = [];
  const buffer = () => {
    const box = new SteeringBuffer({ onDiscard: (cause, messages) => hostDiscards.push(`${cause}${keys(messages)}`) });
    return {
      box,
      steer: async (message) => box.steer(message).status,
      drain: () => box.drain(),
      ack: (messages) => box.ack(messages),
      restore: (messages) => box.restore(messages),
      tryBeginClose: () => {
        const result = box.tryBeginClose();
        return result.closed ? "closed" : result.reason;
      },
      abort: (reason) => box.abort(reason),
      takeDiscards: () => hostDiscards.splice(0).join(" "),
    };
  };
  return { controller, register, buffer };
}

export async function steering() {
  // TurnController 的等待计时器是 unref 的（产品进程里还有别的句柄撑着事件循环），实验里自己撑着。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await runSteering();
  } finally {
    clearInterval(keepAlive);
  }
}

async function runSteering() {
  const impl = await steeringImplementations();
  const upstream = impl.register("turn-1");
  const host = impl.buffer();
  const m1 = userMessage("m1", "别动 tests 目录");
  const m2 = userMessage("m2", "顺便把 README 也改了");
  const c1 = machineMessage("c1", "定时任务提醒");
  const m3 = userMessage("m3", "再加一条");

  const rows = [];
  /** 对两种实现各执行一遍，结果必须逐行一致。 */
  const both = async (阶段, 操作, run) => {
    const a = await run(upstream);
    const b = await run(host);
    rows.push({ 阶段, 操作, 上游TurnController: a, hostSteeringBuffer: b, 一致: a === b ? "是" : "否" });
  };

  await both("运行中", "steer m1（用户的插话）", (x) => x.steer(m1));
  await both("运行中", "同一个 m1 再 steer 一次", (x) => x.steer(m1));
  await both("运行中", "drain（模型这一步结束，取走插话）", (x) => keys(x.drain()));
  await both("运行中", "插话正在被消费时 tryBeginClose", (x) => x.tryBeginClose());
  await both("运行中", "ack m1（已经进了模型的输入）", (x) => {
    x.ack([m1]);
    return "ok";
  });
  await both("最后一步", "steer m2（用户）和 c1（定时任务）", async (x) => `${await x.steer(m2)} ${await x.steer(c1)}`);
  await both("最后一步", "tryBeginClose（c1 是机器的插话，不能丢）", (x) => x.tryBeginClose());
  await both("出口边界", "drain，再 restore 用户的 m2，ack 机器的 c1", (x) => {
    const taken = x.drain();
    x.restore(taken.filter((m) => m.producerId === "composer-steer"));
    x.ack(taken.filter((m) => m.producerId === "cron"));
    return `取走 ${keys(taken)}`;
  });
  await both("出口边界", "tryBeginClose", (x) => `${x.tryBeginClose()} ${x.takeDiscards()}`.trim());
  await both("收尾之后", "steer m3", (x) => x.steer(m3));

  // 取消：第一个 Turn 已经收尾，释放；再注册第二个 Turn。
  impl.controller.complete(upstream.turn);
  const upstream2 = impl.register("turn-2");
  const host2 = impl.buffer();
  const m4 = userMessage("m4", "先读一下 config");
  const m5 = userMessage("m5", "算了，改成只读");
  const m6 = userMessage("m6", "取消后才到的一条");
  const both2 = async (阶段, 操作, run) => {
    const a = await run(upstream2);
    const b = await run(host2);
    rows.push({ 阶段, 操作, 上游TurnController: a, hostSteeringBuffer: b, 一致: a === b ? "是" : "否" });
  };
  await both2("取消", "steer m4，drain（取走但还没消费）", async (x) => {
    await x.steer(m4);
    return keys(x.drain());
  });
  await both2("取消", "steer m5（还在等待）", (x) => x.steer(m5));
  let abortPromise;
  await both2("取消", "用户停止：abort(user_stop)", (x) => {
    if (x === upstream2) abortPromise = x.abort("user_stop");
    else x.abort("user_stop");
    return x.takeDiscards();
  });
  await both2("取消", "restore m4（取走的那条没来得及消费）", (x) => {
    x.restore([m4]);
    return x.takeDiscards();
  });
  await both2("取消", "取消之后 steer m6", (x) => x.steer(m6));

  // 只有上游能演示的：所有权。
  const ownership = [];
  const sessionBusy = (() => {
    try {
      impl.register("turn-3");
      return "（不应该）";
    } catch (error) {
      return error.message;
    }
  })();
  ownership.push({ 动作: "abort 已发出、Turn 还没释放时，注册同一会话的下一个 Turn", 结果: sessionBusy });
  ownership.push({ 动作: "此刻 activeTurnId", 结果: impl.controller.activeTurnId("s") });
  const settledEarly = await Promise.race([abortPromise.then(() => "已返回"), sleep(10).then(() => "还在等")]);
  ownership.push({ 动作: "abort() 的 Promise（等 Turn 释放，最多 abortTimeoutMs）", 结果: settledEarly });
  impl.controller.complete(upstream2.turn);
  ownership.push({ 动作: "Turn 收尾完毕，controller.complete()", 结果: JSON.stringify(await abortPromise) });
  const next = impl.register("turn-3");
  ownership.push({ 动作: "现在注册下一个 Turn", 结果: `成功：${next.turn.turnId}` });

  // abort 超时：Turn 一直不释放。
  const timeout = await next.abort("user_stop");
  ownership.push({ 动作: "这个 Turn 收不了尾，abort() 等满 60ms", 结果: JSON.stringify(timeout) });
  ownership.push({ 动作: "超时之后 activeTurnId", 结果: `${impl.controller.activeTurnId("s")}（会话仍然忙，abort-timeout 不等于释放）` });
  impl.controller.complete(next.turn);

  // 已经在收尾的 Turn：stop 不去打断它，只等它释放。
  const closing = impl.register("turn-4");
  closing.tryBeginClose();
  const abortDuringClose = closing.abort("user_stop");
  setTimeout(() => impl.controller.complete(closing.turn), 5);
  ownership.push({ 动作: "Turn 已经在收尾（closing）时收到 stop", 结果: `${JSON.stringify(await abortDuringClose)}；signal.aborted=${closing.turn.signal.aborted}` });

  return { rows, ownership, sessionBusy, timeout, allAgree: rows.every((row) => row.一致 === "是") };
}

/** 没来得及消费的插话去哪里：对应 steering-requeue.ts 的两条出口。 */
export async function steeringExits() {
  return withTemp((dir) => {
    const clock = () => 1000;
    const rows = [];
    const history = [];
    const queue = new WorkQueue(join(dir, "queue.jsonl"), clock);
    queue.enqueue("s", "稍后再做的事", { clientRequestId: "later" });

    const m1 = userMessage("m1", "别动 tests 目录");
    const m2 = userMessage("m2", "顺便把 README 也改了");
    const c1 = machineMessage("c1", "定时任务提醒");
    const route = (cause, messages) =>
      routeDiscardedSteering({ cause, messages, sessionId: "s", turnId: "turn-1", queue, appendToHistory: (rows) => history.push(...rows) });

    const exit = route("exit-close", [m1, m2, c1]);
    const exitAgain = route("exit-close", [m1, m2, c1]);
    const head = queue.list("s")[0];
    rows.push({
      出口: "exit-close（Turn 正常结束，用户的话还没说完）",
      去处: `排队项放到队首：“${head.text.replace(/\n\n/g, " / ")}”`,
      说明: `${exit.count} 条用户插话合成一项；机器的 c1 丢弃；再处理一次仍是同一项（${exit.itemId === exitAgain.itemId ? "是" : "否"}）`,
    });
    const abort = route("abort", [userMessage("m7", "取消前最后一句")]);
    rows.push({
      出口: "abort / abnormal-seal（Turn 被取消或失败）",
      去处: `写进会话历史：${JSON.stringify(history.map((row) => row.text))}`,
      说明: `不进队列（队列里仍是 ${queue.list("s").length} 项）：用户刚按了停止，排队的指令不该自己跑起来`,
    });
    const machine = route("abort", [machineMessage("c2", "定时任务提醒")]);
    rows.push({ 出口: "任何出口上的机器插话", 去处: "丢弃", 说明: `route=${machine.route}` });
    return { rows, exit, exitAgain, abort, machine, queued: queue.list("s"), history };
  });
}

// ─── 场景五：取消的收尾顺序（真实的 host 应用 + 真实的工具进程）──────────────────────

export async function cancelTimeline() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "slow.cjs"), "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)");
    const log = [];
    const mark = (事件) => log.push({ 步骤: log.length + 1, 事件 });
    const labels = new Map(); // turnId → A、B：随机的 id 对读者没有意义
    const label = (turnId) => labels.get(turnId) ?? labels.set(turnId, String.fromCharCode(65 + labels.size)).get(turnId);

    const app = await createApplication(join(dir, "data"), {
      writer: async (frame) => {
        if (frame.type !== "turn.completed") return;
        await sleep(60); // 终态帧写得慢：busy 必须等它
        mark(`终态帧 turn.completed(${frame.status}) 送达客户端（${label(frame.turnId)}）`);
      },
    });
    // 观察 busy：包一层 admit，记录占用和释放的时刻。
    const admit = app.sessions.admit.bind(app.sessions);
    app.sessions.admit = (sessionId, turnId) => {
      const release = admit(sessionId, turnId);
      mark(`会话 busy：${label(turnId)} 占用`);
      return () => {
        release();
        mark(`会话 busy 释放：${label(turnId)} 让出`);
      };
    };

    try {
      const session = app.sessions.create(root);
      const first = app.run(session.id, "run the slow job", {
        model: scriptedKernel([{ calls: [{ id: "slow", name: "test", input: { path: "slow.cjs" } }] }]),
        rules: { allow: ["test"] },
      });
      for (let i = 0; i < 200 && !existsSync(join(root, "started")); i++) await sleep(10);
      mark("工具进程已经启动（slow.cjs 写了 started）");

      const queued = app.queue.enqueue(session.id, "then fix the slug", { clientRequestId: "B" });
      mark("用户又发了一条，排进队列（clientRequestId=B）");
      mark("用户按停止：app.cancel(session)");
      app.cancel(session.id);

      const early = await app.next(session.id, { model: scriptedKernel([{ text: "too early" }]) }).then(
        () => "通过（不应该）",
        (error) => `被拒绝：${error.message}`,
      );
      mark(`立刻 app.next()：${early}`);

      const result = await first;
      mark(`A 的 app.run 返回：status=${result.status}`);
      const frames = app.events.replay(result.turnId);
      const lastFrame = frames.at(-1);

      // MiniMax 在 settle 的事务里同时写“暂停队列”；这里单独调用以演示这一步（第 12 章的 app 在收尾阶段自动暂停）。
      const pause = app.queue.pauseIfPending(session.id, "user-stop", result.turnId);
      mark(`队列暂停：cause=${pause?.cause}`);
      const whilePaused = app.queue.claim(session.id);
      mark(`暂停期间 claim：${whilePaused === undefined ? "undefined（不自己跑）" : "（不应该）"}`);
      app.queue.continueQueue(session.id);
      mark("用户点“继续”：continueQueue");
      const next = await app.next(session.id, { model: scriptedKernel([{ text: "slug fixed" }]) });
      mark(`B 的 app.next 返回：status=${next.status}`);

      return {
        rows: log,
        early,
        result,
        lastFrame,
        pausedClaim: whilePaused,
        next,
        queueItem: app.queue.items().find((item) => item.id === queued.id),
        busyAfter: app.sessions.active.has(session.id),
      };
    } finally {
      await app.close();
    }
  });
}

// ─── 场景六：子会话与分叉 ──────────────────────────────────────────────────────

/** 一个有“断头”的来源历史：最后一次 edit 调用没有结果（用户按了停止）。 */
const SOURCE_HISTORY = [
  { role: "user", text: "读一下 a.txt 再改" },
  { role: "assistant", text: "", calls: [{ id: "r1", name: "read", input: { path: "a.txt" } }] },
  { role: "tool", id: "r1", text: "safe" },
  { role: "assistant", text: "我来改", calls: [{ id: "w1", name: "edit", input: { path: "a.txt", old: "safe", next: "bad" } }] },
];

export async function forkSessions() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    const app = await createApplication(join(dir, "data"));
    try {
      const source = app.sessions.create(root);
      app.sessions.append(source.id, "turn-0", SOURCE_HISTORY);
      const count = () => app.sessions.meta.read().length - 1; // 除去来源会话
      const rows = [];
      const note = (操作, 结果, childId) =>
        rows.push({ 操作, 结果, 子会话总数: count(), 子会话历史条数: childId ? app.sessions.history(childId).length : "—" });
      const attempt = (fn) => {
        try {
          return fn();
        } catch (error) {
          return { error: error.message };
        }
      };

      note(`来源历史 ${SOURCE_HISTORY.length} 条，已收尾的前缀 ${settledPrefix(SOURCE_HISTORY)} 条`, "最后一个 edit 调用没有结果，分叉点不能落在它上面");
      const a = forkSession(app, source.id, { operationId: "op-1" });
      note("forkSession(op-1)", `${a.status}，复制了 ${a.length} 条`, a.childId);
      const b = forkSession(app, source.id, { operationId: "op-1" });
      note("同一个 op-1 再来一次", `${b.status}，childId 相同：${a.childId === b.childId ? "是" : "否"}`, b.childId);

      const crashed = attempt(() => forkSession(app, source.id, { operationId: "op-2", stopAfter: "session-created" }));
      note("op-2 在 session-created 之后崩溃", crashed.error, undefined);
      const resumed = forkSession(app, source.id, { operationId: "op-2" });
      note("op-2 重试", `${resumed.status}：从上次停下的阶段继续`, resumed.childId);

      const crashedAgain = attempt(() => forkSession(app, source.id, { operationId: "op-3", stopAfter: "history-published" }));
      const resumed3 = forkSession(app, source.id, { operationId: "op-3" });
      note("op-3 在 history-published 之后崩溃，再重试", `${crashedAgain.error}；重试 ${resumed3.status}`, resumed3.childId);

      const unsettled = attempt(() => forkSession(app, source.id, { operationId: "op-4", throughLength: 4 }));
      note("op-4 要求复制前 4 条（切在没有结果的调用上）", `拒绝：${unsettled.error}`, undefined);
      const conflict = attempt(() => forkSession(app, source.id, { operationId: "op-1", throughLength: 1 }));
      note("op-1 换了参数再来", `拒绝：${conflict.error}`, undefined);

      return { rows, a, b, resumed, resumed3, crashed, unsettled, conflict, total: count() };
    } finally {
      await app.close();
    }
  });
}

export async function forkTasks() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "safe");
    writeFileSync(join(root, "slow.cjs"), "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)");
    const app = await createApplication(join(dir, "data"));
    try {
      const parent = app.sessions.create(root);
      const rows = [];
      const reply = (id, name, input) => ({ calls: [{ id, name, input }] });

      // 子任务试图改文件：工具目录里没有 edit。
      const explore = await forkTask(app, parent.id, "explore a.txt", {
        model: scriptedKernel([reply("r", "read", { path: "a.txt" }), reply("w", "edit", { path: "a.txt", old: "safe", next: "bad" }), { text: "done" }]),
      });
      const editResult = explore.messages.find((message) => message.id === "w");
      const item = app.queue.items().find((candidate) => candidate.id === explore.queueItemId);
      rows.push({
        子任务: "explore：read 之后试图 edit",
        结果: `status=${explore.status}；edit 的结果：${editResult.text}（error=${editResult.error}）`,
        队列项: `task-turn:‹子会话 id› → ${item.state}`,
        说明: app.sessions.history(parent.id).length === 0 ? "工具目录里没有 edit；父会话历史仍为空" : "父会话历史被改了",
      });

      // 取消发生在开始之前。
      const early = new AbortController();
      early.abort(Error("parent cancelled"));
      const beforeStart = await forkTask(app, parent.id, "never starts", { model: scriptedKernel([{ text: "unused" }]), signal: early.signal });
      const itemBefore = app.queue.items().find((candidate) => candidate.id === beforeStart.queueItemId);
      rows.push({ 子任务: "父任务在子任务开始前取消", 结果: `status=${beforeStart.status}`, 队列项: `task-turn:‹子会话 id› → ${itemBefore.state}`, 说明: "排队项被撤销，没有 Turn 被创建" });

      // 取消发生在运行中：子任务的工具进程在跑。
      const running = new AbortController();
      const during = forkTask(app, parent.id, "slow job", {
        model: scriptedKernel([reply("slow", "test", { path: "slow.cjs" })]),
        allowTools: ["read", "test"],
        rules: { allow: ["test"] },
        signal: running.signal,
      });
      for (let i = 0; i < 200 && !existsSync(join(root, "started")); i++) await sleep(10);
      running.abort(Error("parent cancelled"));
      const cancelled = await during;
      const itemDuring = app.queue.items().find((candidate) => candidate.id === cancelled.queueItemId);
      rows.push({ 子任务: "父任务在子任务运行中取消", 结果: `status=${cancelled.status}`, 队列项: `task-turn:‹子会话 id› → ${itemDuring.state}`, 说明: "工具进程被结束，子 Turn 以 cancelled 收尾；排队项已被 Turn 接纳，不会自己再跑" });

      return { rows, explore, editResult, item, beforeStart, itemBefore, cancelled, itemDuring, parentHistory: app.sessions.history(parent.id) };
    } finally {
      await app.close();
    }
  });
}
