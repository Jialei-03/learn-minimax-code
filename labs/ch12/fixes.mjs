// 实验：总装时接上的几处，各一个小场景。
//   node labs/ch12/fixes.mjs steering | compaction | lease | release | shape | cli
import assert from "node:assert/strict";
import { cliExitCodes, compactionCase, leaseLostCase, markdownTable, releaseOrderCase, requestShapeCase, steeringCases } from "./scenarios.mjs";

const which = process.argv[2];

if (which === "steering") {
  const { rows, facts } = await steeringCases();
  console.log("同一个 app.steer，四种处境，去处不同：\n");
  console.log(markdownTable(rows));
  assert.equal(facts.running.answer.status, "accepted");
  assert.equal(facts.exit.result.steering[0].route, "queue");
  assert.equal(facts.abort.result.steering[0].route, "conversation");
  assert.equal(facts.abort.afterStop.status, "queued");
} else if (which === "compaction") {
  const result = await compactionCase();
  console.log("压缩钩子接进 Turn：历史很长的会话再发一条消息：\n");
  console.log(markdownTable(result.rows));
  assert.equal(result.first.compactions[0].status, "completed");
  assert.equal(result.history[0].role, "compactionSummary");
} else if (which === "lease") {
  const result = await leaseLostCase();
  console.log("另一个进程回收了 A 的租约，A 怎么办：\n");
  console.log(markdownTable(result.rows));
  assert.equal(result.result.status, "cancelled");
  assert.equal(result.result.error, "lease lost");
  assert.equal(result.pause, undefined);
} else if (which === "release") {
  const result = await releaseOrderCase();
  console.log("释放会话时 release() 抛了错：\n");
  console.log(markdownTable(result.rows));
  assert.equal(result.closing, "close() 正常返回");
} else if (which === "shape") {
  const result = await requestShapeCase();
  console.log("发给模型的请求：存下来的历史经过唯一的一个投影入口：\n");
  console.log(markdownTable(result.shape));
  console.log("\n一条回复里有两个工具调用，谁和谁能同时跑：\n");
  console.log(markdownTable(result.batches));
  assert.ok(result.reads.indexOf("开始:p2") < result.reads.indexOf("结束:p1"));
  assert.ok(result.mixed.indexOf("结束:q1") < result.mixed.indexOf("开始:q2"));
} else if (which === "cli") {
  const result = await cliExitCodes();
  console.log("命令行入口：退出码是最后一次运行的结局：\n");
  console.log(markdownTable(result.rows));
  assert.deepEqual(result.codes, [0, 4, 2]);
} else {
  throw Error("用法：node labs/ch12/fixes.mjs steering|compaction|lease|release|shape|cli");
}
