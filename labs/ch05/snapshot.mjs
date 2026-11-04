// 实验：同一个 Turn 里模型被请求 4 次，中途有人改了 AGENTS.md、提示模板也刷新了。
// 每次请求现读，和 Turn 开始时拍照，系统提示各是什么样。
//   node labs/ch05/snapshot.mjs
import assert from "node:assert/strict";
import { markdownTable, mixedGeneration, snapshotVsLive } from "./scenarios.mjs";

const { live, snapshot, summary, raw } = await snapshotVsLive();

console.log("一个 Turn 里请求 4 次。第 2 次之前有人改了 AGENTS.md，第 3 次之前一次提示刷新落地；之后下一个 Turn 开始。\n");
console.log("**每次请求现读**\n");
console.log(markdownTable(live));
console.log("\n**Turn 开始时拍照**\n");
console.log(markdownTable(snapshot));
console.log("\n**合计**\n");
console.log(markdownTable(summary));

console.log("\n再看渲染要读两个模板、中间等了一会儿的情形，等待期间一次刷新落地：\n");
const mixed = await mixedGeneration();
console.log(markdownTable(mixed));

// ── 检查 ──
const turn1 = (rows) => rows.filter((r) => r.Turn === 1);
assert.equal(new Set(turn1(raw.snapshot).map((r) => r.系统提示指纹)).size, 1, "拍照：Turn 内指纹不变");
assert.ok(new Set(turn1(raw.live).map((r) => r.系统提示指纹)).size > 1, "现读：Turn 内指纹变了");
assert.equal(summary[1]["其中发生在 Turn 中途"], 0);
assert.equal(summary[1].提示改变的次数, 1, "拍照：两次变化合并成 Turn 边界上的一次");
assert.equal(summary[0].提示改变的次数, 2);
assert.equal(mixed[0].同一代, "否");
assert.equal(mixed[1].同一代, "是");
