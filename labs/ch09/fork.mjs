// 实验：子会话。
//   node labs/ch09/fork.mjs session   会话分叉：同一个 operationId 只会得到一个子会话
//   node labs/ch09/fork.mjs task      子任务：新会话、更小的工具目录、父任务取消时的两种情况
import assert from "node:assert/strict";
import { forkSessions, forkTasks, markdownTable } from "./scenarios.mjs";

const mode = process.argv[2] ?? "session";

if (mode === "session") {
  const result = await forkSessions();
  console.log("来源会话的最后一个 edit 调用没有结果（用户按了停止）。下面的每一次 forkSession 都读同一个来源：\n");
  console.log(markdownTable(result.rows));

  assert.equal(result.a.status, "created");
  assert.equal(result.a.length, 3);
  assert.equal(result.b.status, "duplicate");
  assert.equal(result.b.childId, result.a.childId);
  assert.equal(result.resumed.status, "created");
  assert.equal(result.resumed3.status, "created");
  assert.equal(result.unsettled.error, "assistant-not-settled");
  assert.equal(result.conflict.error, "request-conflict");
  assert.equal(result.total, 3); // op-1、op-2、op-3 各一个，崩溃重试没有造出第二个
} else {
  const result = await forkTasks();
  console.log("父会话为空。三个子任务各自在新会话里运行，工具目录只有 read（最后一个多给了 test）：\n");
  console.log(markdownTable(result.rows));

  assert.equal(result.explore.status, "completed");
  assert.equal(result.editResult.error, true);
  assert.equal(result.itemBefore.state, "cancelled");
  assert.equal(result.beforeStart.status, "cancelled");
  assert.equal(result.cancelled.status, "cancelled");
  assert.deepEqual(result.parentHistory, []);
}
