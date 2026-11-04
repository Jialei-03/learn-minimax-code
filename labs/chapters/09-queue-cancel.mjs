// 第 9 章回归实验：忙的时候来了一条新消息。
//   node labs/chapters/09-queue-cancel.mjs          读者模式：打印过程和每项检查
//   node labs/chapters/09-queue-cancel.mjs --json   构建模式
// 场景都在 labs/ch09/scenarios.mjs，正文里嵌入的是 labs/ch09/*.mjs 各自的输出；这里把它们串起来，并补上旧版的几项身份检查。
import { lesson } from "./harness.mjs";
import { join } from "node:path";
import { WorkQueue } from "../../host/src/queue.mjs";
import {
  cancelTimeline,
  durability,
  forkSessions,
  forkTasks,
  lifecycle,
  realQueueService,
  steering,
  steeringExits,
} from "../ch09/scenarios.mjs";

await lesson(9, "队列、插话与取消：接纳之后谁负责", async (t) => {
  // ─── 1. 重试与崩溃 ─────────────────────────────────────────────────────────
  t.log("① 内存队列 vs. WorkQueue：重发和三个崩溃点\n");
  const dur = await durability();
  t.table(dur.rows);
  t.equal("内存队列把重发的消息排了两次", dur.memoryRetryRuns, 2);
  t.equal("WorkQueue 对同一个 clientRequestId 只执行一次", dur.retryRuns, 1);
  t.equal("取走之后崩溃：claim 被收回，消息重新执行一次", [dur.afterClaim.state, dur.afterClaim.rerun], ["pending", 1]);
  t.equal("回执写好、确认之前崩溃：Turn 没动过手，重新执行一次", dur.afterReceipt.rerun, 1);
  t.equal("确认之后崩溃：不重试，报告给会话核对", [dur.afterAck.rerun, dur.afterAck.reported], [0, ["turn-A"]]);

  // 旧版的两项身份检查：重发保留第一次的行和 model；过期时间在写日志之前检查。
  const file = join(t.temp, "identity.jsonl");
  const queue = new WorkQueue(file, () => 100);
  const first = queue.enqueue("s", "one", { clientRequestId: "same", model: "p/old" });
  const again = queue.enqueue("s", "changed", { clientRequestId: "same", model: "p/new" });
  t.equal("重发拿回同一行", again.id, first.id);
  t.equal("重发保留第一次的 model", again.model, "p/old");
  t.throws("已经过期的消息不进队列", () => queue.enqueue("s", "bad", { expiresAt: 100 }), /expiry/);
  t.equal("被拒绝的过期消息没有写日志", queue.facts().length, 1);

  // ─── 2. 一条消息的一生 ─────────────────────────────────────────────────────
  t.log("\n② 一条排队消息的一生\n");
  const life = await lifecycle();
  t.table(life.rows);
  t.log("用户停止之后：\n");
  t.table(life.pauseRows);
  t.equal("同一个会话同一时刻只有一个 claim", life.blocked, undefined);
  t.ok("没有 Turn 的回执，队列不能确认", /not accepted/.test(life.early));
  t.ok("没有确认过的项不能消费", /durable acceptance required/.test(life.early2));
  t.equal("消费之后重发，拿回旧行而不是再排一次", life.replayAfter.state, "consumed");
  t.equal("暂停期间不派发，继续之后取到下一条", life.resumed.text, "and lint");

  // 同一个日志换一个 WorkQueue 对象（= 重启）：状态完全由日志重放得到。
  const restarted = new WorkQueue(file, () => 100);
  t.equal("重启后队列状态相同", restarted.items().map((item) => item.state), ["pending"]);

  // ─── 3. 真实的 QueueService ────────────────────────────────────────────────
  t.log("\n③ MiniMax 真实的 QueueService（假仓库）\n");
  const service = await realQueueService();
  t.table(service.rows);
  t.equal("重试时 resolveModel 没有再被调用", service.calls.resolve, ["m-old", "m-new"]);
  t.equal("重试沿用第一次解析出的 model", service.r2.value.item.model.resolved, "解析自 m-old");
  t.ok("四种非法 expiresAt 都被拒绝", service.expiry.every((line) => line.endsWith("expiry-invalid")));

  // ─── 4. 插话 ───────────────────────────────────────────────────────────────
  t.log("\n④ 插话：上游 TurnController 与 host SteeringBuffer 逐行对照\n");
  const steer = await steering();
  t.table(steer.rows);
  t.equal("上游和 host 每一行都一致", steer.allAgree, true);
  t.log("所有权（只有上游能演示）：\n");
  t.table(steer.ownership);
  t.ok("abort 之后、释放之前，下一个 Turn 注册不进来", /Turn already active/.test(steer.sessionBusy));
  t.equal("abort 等满超时返回 abort-timeout，而不是假装释放了", steer.timeout.status, "abort-timeout");

  t.log("\n没来得及消费的插话：\n");
  const exits = await steeringExits();
  t.table(exits.rows);
  t.equal("正常结束：两条用户插话合成一个排队项", [exits.exit.route, exits.exit.count], ["queue", 2]);
  t.equal("同一批插话重复处理只得到一个排队项", exits.exitAgain.itemId, exits.exit.itemId);
  t.ok("插话排在原有排队项的前面", exits.queued[0].text.startsWith("别动 tests") && exits.queued[1].text === "稍后再做的事");
  t.equal("取消：并入会话历史，不进队列", [exits.abort.route, exits.queued.length], ["conversation", 2]);
  t.equal("机器的插话在两条出口上都丢弃", exits.machine.route, "dropped");

  // ─── 5. 取消 ───────────────────────────────────────────────────────────────
  t.log("\n⑤ 取消：真实的工具进程，下一条什么时候才能开始\n");
  const cancel = await cancelTimeline();
  t.table(cancel.rows);
  t.ok("取消后立刻 next() 被拒绝", /session busy/.test(cancel.early));
  t.equal("A 以 cancelled 收尾，最后一帧是终态", [cancel.result.status, cancel.lastFrame.type, cancel.lastFrame.status], ["cancelled", "turn.completed", "cancelled"]);
  const order = cancel.rows.map((row) => row.事件);
  const at = (prefix) => order.findIndex((event) => event.startsWith(prefix));
  t.ok("终态帧送达在先，busy 释放在后", at("终态帧 turn.completed(cancelled)") < at("会话 busy 释放：A"));
  t.equal("停止之后队列暂停，claim 不派发", cancel.pausedClaim, undefined);
  t.equal("点继续之后 B 正常完成并被消费", [cancel.next.status, cancel.queueItem.state], ["completed", "consumed"]);

  // ─── 6. 子会话 ─────────────────────────────────────────────────────────────
  t.log("\n⑥ 会话分叉：同一个 operationId 只会得到一个子会话\n");
  const forks = await forkSessions();
  t.table(forks.rows);
  t.equal("重试同一个 operationId：duplicate，同一个子会话", [forks.b.status, forks.b.childId === forks.a.childId], ["duplicate", true]);
  t.equal("崩溃后重试：沿用同一个子会话，没有造出第二个", forks.total, 3);
  t.equal("分叉点落在没有结果的调用上：拒绝", forks.unsettled.error, "assistant-not-settled");
  t.equal("同一个 operationId 换了请求：冲突", forks.conflict.error, "request-conflict");

  t.log("\n⑦ 子任务：新会话，更小的工具目录，两种取消\n");
  const tasks = await forkTasks();
  t.table(tasks.rows);
  t.equal("子任务用的是另一个会话，父会话历史为空", tasks.parentHistory, []);
  t.equal("子任务调用 edit：工具目录里没有", tasks.editResult.error, true);
  t.equal("开始前取消：排队项被撤销，没有运行", [tasks.beforeStart.status, tasks.itemBefore.state], ["cancelled", "cancelled"]);
  t.equal("运行中取消：子 Turn 以 cancelled 收尾", tasks.cancelled.status, "cancelled");

  t.observations.queue = restarted.items();
});
