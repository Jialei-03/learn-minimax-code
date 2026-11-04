// 实验：只有内存的队列，和写日志的队列，在重发和崩溃面前的区别。
//   node labs/ch09/durability.mjs
import assert from "node:assert/strict";
import { durability, markdownTable } from "./scenarios.mjs";

const result = await durability();

console.log("同一条指令“fix tests”，在四种情况下各排一次队。“崩溃”是指旧进程做到这一步就没了，新进程读同一个日志。\n");
console.log(markdownTable(result.rows));

assert.equal(result.memoryRetryRuns, 2);
assert.equal(result.retryRuns, 1);
assert.equal(result.sameItem, true);
assert.equal(result.memoryAfterCrash, 0);
assert.equal(result.afterClaim.state, "pending");
assert.equal(result.afterClaim.rerun, 1);
assert.equal(result.afterReceipt.rerun, 1);
assert.equal(result.afterAck.rerun, 0);
assert.deepEqual(result.afterAck.reported, ["turn-A"]);
