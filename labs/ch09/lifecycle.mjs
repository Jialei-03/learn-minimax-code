// 实验：一条排队消息的一生——每一步之后队列里是什么状态，哪些操作会被拒绝。
//   node labs/ch09/lifecycle.mjs
import assert from "node:assert/strict";
import { lifecycle, markdownTable } from "./scenarios.mjs";

const result = await lifecycle();

console.log("按顺序执行下面的操作。“状态”列是这一步之后队列里所有行的状态（先入队的在前），“日志条数”是队列日志的长度。\n");
console.log(markdownTable(result.rows));
console.log("\n用户按了停止之后：\n");
console.log(markdownTable(result.pauseRows));

assert.match(result.early, /not accepted/);
assert.match(result.early2, /durable acceptance required/);
assert.equal(result.blocked, undefined);
assert.equal(result.replayAfter.state, "consumed");
assert.equal(result.resumed.text, "and lint");
