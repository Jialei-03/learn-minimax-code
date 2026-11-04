// 实验：取消一个正在跑工具的 Turn，哪些事情按什么顺序发生，下一条什么时候才能开始。
//   node labs/ch09/cancel.mjs
// 用的是 host 的真实应用：工具是一个真的子进程（slow.cjs），终态帧故意写得很慢（60ms）。
import assert from "node:assert/strict";
import { cancelTimeline, markdownTable } from "./scenarios.mjs";

const result = await cancelTimeline();

console.log("A 正在运行一个不会自己结束的工具；用户排了一条 B，然后按了停止：\n");
console.log(markdownTable(result.rows));

const order = result.rows.map((row) => row.事件);
const at = (prefix) => order.findIndex((event) => event.startsWith(prefix));
assert.match(result.early, /session busy/);
assert.equal(result.result.status, "cancelled");
assert.equal(result.lastFrame.type, "turn.completed");
assert.equal(result.lastFrame.status, "cancelled");
assert.ok(at("立刻 app.next()") < at("终态帧 turn.completed(cancelled)"));
assert.ok(at("终态帧 turn.completed(cancelled)") < at("会话 busy 释放"));
assert.ok(at("会话 busy 释放：A") < at("队列暂停"));
assert.equal(result.pausedClaim, undefined);
assert.equal(result.next.status, "completed");
assert.equal(result.queueItem.state, "consumed");
assert.equal(result.busyAfter, false);
