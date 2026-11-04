// 第 12 章回归实验：总装。
//   node labs/chapters/12-comparison-interview.mjs          打印实验过程和每项检查
//   node labs/chapters/12-comparison-interview.mjs --json   构建模式
// 场景在 labs/ch12/scenarios.mjs；正文里嵌入的是 labs/ch12/story.mjs、fixes.mjs 打印的表格和 trace.mjs 的回放。
// 这里把它们串起来：主线（长任务 A → 插件更新 → B 排队 → 取消 → B 修好测试 → SDK 还原）→ 总装接上的五处 → 命令行的退出码。
import { lesson } from "./harness.mjs";
import { exitCodeOf } from "../../host/src/adapters.mjs";
import { cliExitCodes, compactionCase, leaseLostCase, mainStory, releaseOrderCase, requestShapeCase, steeringCases } from "../ch12/scenarios.mjs";

await lesson(12, "总装：取消、热更新、排队修复与事件还原", async (t) => {
  // ── 一、主线 ───────────────────────────────────────────────────
  t.log("一、主线：A 在跑长任务，插件更新，用户发来 B，取消 A，B 用新能力修好一个真实失败的测试");
  const story = await mainStory();
  t.table(story.rows);
  const { facts } = story;
  const row = (prefix) => story.rows.findIndex((r) => r.发生了什么.startsWith(prefix));

  t.equal("A 的工具是一个真的长进程：模型只请求了一次，请求里没有它的结果", [facts.requestsA.length, facts.framesA.map((f) => f.type)], [1, ["turn.started", "item.started", "item.started", "item.completed", "turn.completed"]]);
  t.equal("R2 发布之后，R1 进程仍在运行（A 握着租约），R2 也在运行", [story.rows[2]["R1 进程"], story.rows[2]["R2 进程"]], ["运行中", "运行中"]);
  t.equal("B 在会话忙的时候被写进队列，重发同一个 clientRequestId 拿回同一行", [story.rows[3]["B 在队列里"], facts.retriedSame], ["pending", true]);
  t.equal("取消返回 true，但会话仍然忙；立刻 next() 被拒绝", [facts.cancelled, facts.early, story.rows[6].会话], [true, "session busy", "A 占用"]);
  t.ok("终态帧送达客户端发生在会话释放之前", row("终态帧 turn.completed(cancelled)") < row("A 放手"));
  t.equal("A 放手之后：会话空闲、R1 进程退出、R2 仍在、队列暂停", [story.rows[8].会话, story.rows[8]["R1 进程"], story.rows[8]["R2 进程"], story.rows[8]["B 在队列里"]], ["空闲", "已退出", "运行中", "pending（暂停）"]);
  t.equal("A 以 cancelled 收尾，原因是用户的取消", [facts.resultA.status, facts.resultA.error], ["cancelled", "user cancelled"]);
  t.equal("暂停期间 next() 不运行任何东西", facts.whilePaused, undefined);
  t.equal("队列里只有“暂停、继续”两条事实", facts.queueFacts, ["pause", "continue"]);

  t.equal("B 使用 R2，且完成", [facts.resultB.status, facts.resultB.capabilityRevision], ["completed", "r2"]);
  const systemA = facts.requestsA[0].system.join("\n");
  const systemB = facts.requestsB[0].system.join("\n");
  t.equal("A 的提示是 v1 的快照：旧模板、旧 CLAUDE.md、看不到 R2 的 Skill", [systemA.includes("[template v1]"), systemA.includes("Project rules v1"), systemA.includes("course:repair-guide")], [true, true, false]);
  t.equal("B 的提示是 A 取消之后才拍的：新模板、新 CLAUDE.md、R2 的 Skill 在清单里", [systemB.includes("[template v2]"), systemB.includes("Project rules v2"), systemB.includes("course:repair-guide")], [true, true, true]);
  t.equal("B 先看到一个真实失败的测试，修好之后同一个测试通过", [story.repair[0].结果.startsWith("失败"), story.repair.at(-2).结果], [true, "成功：tests passed"]);
  t.ok("磁盘上的 slug.cjs 真的被改了", facts.slug.includes("/ +/g"));
  t.equal("B 经由 R2 的 MCP 进程调用了 mcp_echo", story.repair.at(-1).结果, "成功：verified");
  t.equal("队列项在 Turn 送达并落盘之后才是 consumed", facts.queue.map((item) => item.state), ["consumed"]);
  t.equal("R1 在 A 放手后关闭，R2 在应用关闭时关闭", facts.closed, ["r1", "r2"]);
  t.equal("应用关闭之后，两个 MCP 进程都已退出", [facts.alive.r1, facts.alive.r2], [false, false]);

  t.log("\nB 的修复过程：");
  t.table(story.repair);

  t.log("SDK 客户端手里只有事件帧：");
  t.table(story.sdk);
  t.equal("A 还原成 cancelled，消息 item 是 incomplete", [facts.liveA.status, facts.liveA.items[0].incomplete], ["cancelled", true]);
  t.equal("B 还原成 completed，没有未完成的 item", [facts.liveB.status, facts.liveB.items.some((item) => item.incomplete)], ["completed", false]);
  t.equal("断线后用游标接上、新客户端整段重放，结果都与直播一致", [facts.reconnectB, facts.freshB], [facts.liveB, facts.liveB]);
  t.equal("A 的事件整段重放，同样还原成 cancelled", facts.replayA, facts.liveA);
  t.ok("只拿游标之后的帧：缺口被暴露，而不是拼出一个残缺的结果", /expected #1, got #10/.test(facts.gap));
  t.equal("两个 Turn 的帧互不串台", [facts.framesA.every((f) => f.turnId === facts.resultA.turnId), facts.framesB.every((f) => f.turnId === facts.resultB.turnId)], [true, true]);

  // ── 二、总装接上的五处 ─────────────────────────────────────────
  t.log("\n二、总装接上的第一处：插话（SteeringBuffer）");
  const steering = await steeringCases();
  t.table(steering.rows);
  t.equal("工具运行中的插话被接受，进了这个 Turn，也写进了历史", [steering.facts.running.answer.status, steering.facts.running.seen?.text, steering.facts.running.historyHasIt], ["accepted", "also mention the README", true]);
  t.equal("回答写完那一刻的插话不延长回答，关门后成为队首的排队项", [steering.facts.exit.result.steering[0].route, steering.facts.exit.waiting.map((item) => item.text)], ["queue", ["one more thing: add a changelog"]]);
  t.equal("取消时收件箱里的插话写进会话历史，不进队列", [steering.facts.abort.result.steering[0].route, steering.facts.abort.history.at(-1).steered], ["conversation", true]);
  t.equal("按了停止之后才来的插话改走排队，队列因此暂停", [steering.facts.abort.afterStop.status, Boolean(steering.facts.abort.paused)], ["queued", true]);

  t.log("\n第二处：压缩钩子接进 Turn");
  const compaction = await compactionCase();
  t.table(compaction.rows);
  t.equal("第一个 Turn 请求之前压缩完成，历史换成摘要", [compaction.first.compactions[0].status, compaction.history[0].role], ["completed", "compactionSummary"]);
  t.equal("模型收到的第一条消息是摘要", compaction.requests[0].messages[0].text.startsWith("The conversation history before this point was compacted"), true);
  t.equal("第二个 Turn 不再压缩，摘要请求总共一次", [compaction.second.compactions[0].status, compaction.summarizeCalls.length], ["unchanged", 1]);
  t.equal("被换掉的旧历史还在日志里（存档）", compaction.rowsOnDisk[0].messages.length, compaction.seedLength);

  t.log("\n第三处：租约丢失，Turn 主动中止");
  const lease = await leaseLostCase();
  t.table(lease.rows);
  t.equal("A 以 cancelled 收尾，原因是 lease lost；它的补写被挡下", [lease.result.status, lease.result.error, lease.result.persisted], ["cancelled", "lease lost", false]);
  t.equal("租约丢失不暂停队列", lease.pause, undefined);
  t.ok("中止发生在看门狗的一个续租间隔之内，不用等到下一次写历史", lease.abortedAfterMs < 1500);

  t.log("\n第四处：释放的顺序");
  const release = await releaseOrderCase();
  t.table(release.rows);
  t.equal("release() 抛错：run 把错误交给调用方，close() 照样返回，R1 照样关闭", [release.outcome, release.closing, release.closed], ["run 抛出：release failed", "close() 正常返回", ["r1"]]);

  t.log("\n第五处：请求投影只有一个入口，批次规则来自 tools.mjs");
  const shape = await requestShapeCase();
  t.table(shape.shape);
  t.table(shape.batches);
  t.equal("孤儿结果被丢掉，断头的调用被补上“中断”的结果", [shape.sent.some((m) => m.id === "ghost"), shape.sent.find((m) => m.id === "c1" && m.role === "tool")?.error], [false, true]);
  t.equal("tool 消息只有文本和 error 到达模型；存档里的 details 还在", [Object.keys(shape.sent.find((m) => m.id === "c0")).sort(), Boolean(shape.stored.find((m) => m.id === "c0").details)], [["error", "id", "role", "text"], true]);
  t.ok("两个只读调用并行：两个“开始”都在第一个“结束”之前", shape.reads.indexOf("开始:p2") < shape.reads.indexOf("结束:p1"));
  t.ok("含一个串行工具：整批按顺序一个个跑", shape.mixed.indexOf("结束:q1") < shape.mixed.indexOf("开始:q2"));

  // ── 三、命令行的退出码 ─────────────────────────────────────────
  t.log("\n三、命令行：退出码是最后一次运行的结局");
  const cli = await cliExitCodes();
  t.table(cli.rows);
  t.equal("成功是 0，运行失败是 4，协议错误是 2", cli.codes, [0, 4, 2]);
  t.equal("退出码与 exec 适配器的映射一致", [exitCodeOf({ status: "succeeded" }), exitCodeOf({ status: "failed", error: {} })], [0, 4]);

  t.observations.rows = story.rows;
  t.observations.repair = story.repair;
  t.observations.sdk = story.sdk;
  t.observations.events = { a: facts.framesA.map((f) => f.type), b: facts.framesB.length };
});
