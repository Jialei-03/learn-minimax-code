// 实验：先渲染提示、后创建 Turn 的内部流程（/goal 续跑、/review），怎样保证两边读的是同一份快照。
// Registry 和整包回退运行的都是上游的真实代码。
//   node labs/ch05/handoff.mjs
import assert from "node:assert/strict";
import { markdownTable, promptHandoff } from "./scenarios.mjs";

const r = await promptHandoff();

console.log("**一、续跑提示在 v1 时渲染，Turn 被接纳之前模板刷新成 v2**\n");
console.log(markdownTable(r.handoffRows));

console.log("\n**二、Registry 的规则**（容量 2）\n");
console.log(markdownTable(r.ops));

console.log("\n**三、一次不完整的刷新：新的一套里缺了一个受管的模板**\n");
console.log(markdownTable(r.bundleRows));

// ── 检查 ──
assert.equal(r.reserved, true);
assert.equal(r.rebound, true);
assert.equal(r.viaHandoff, "SYSTEM v1");
assert.equal(r.viaFresh, "SYSTEM v2");
assert.equal(r.takenAgain, undefined);
assert.equal(r.identity, true);
const result = Object.fromEntries(r.ops.map((o) => [o.操作, o.结果]));
assert.equal(result["reserve(c)"], "false");
assert.equal(result["rebind(a, b)"], "false");
assert.equal(result["close() 后 reserve(d)"], "false");
assert.equal(r.bundleRows[0]["goal/continuation.md"], "GOAL b1");
assert.equal(r.bundleRows[1]["goal/continuation.md"], "GOAL builtin");
assert.equal(r.bundleRows[1]["goal/recovery.md"], "RECOVERY builtin");
assert.equal(r.bundleRows[2]["goal/continuation.md"], "GOAL b2");
assert.equal(r.bundleRows[2]["goal/recovery.md"], "RECOVERY builtin");
