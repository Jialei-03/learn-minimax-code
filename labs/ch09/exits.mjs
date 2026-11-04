// 实验：没来得及消费的插话去哪里——正常结束时回到队首，被取消时并入会话历史。
//   node labs/ch09/exits.mjs
import assert from "node:assert/strict";
import { markdownTable, steeringExits } from "./scenarios.mjs";

const result = await steeringExits();

console.log("队列里原本已有一项“稍后再做的事”。Turn 结束时还剩 m1、m2（用户的插话）和 c1（定时任务的插话）没被模型读到：\n");
console.log(markdownTable(result.rows));

assert.equal(result.exit.route, "queue");
assert.equal(result.exit.count, 2);
assert.equal(result.exit.itemId, result.exitAgain.itemId);
assert.match(result.queued[0].text, /别动 tests 目录/);
assert.equal(result.queued.length, 2);
assert.equal(result.abort.route, "conversation");
assert.equal(result.machine.route, "dropped");
