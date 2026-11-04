// 实验：存下来的历史，和发给模型的那一份。
//   node labs/ch06/views.mjs
import assert from "node:assert/strict";
import { markdownTable, upstreamImageLimit, viewsReport } from "./scenarios.mjs";

const v = viewsReport();
const brief = (m) => {
  const body = (m.text ?? "").replace(/\n/g, "⏎");
  const images = m.images?.length ? ` 图${m.images.length}` : "";
  const calls = m.calls?.length ? ` 调用${m.calls.map((c) => c.id).join(",")}` : "";
  return `${m.role}${calls}${images}｜${body.length > 24 ? body.slice(0, 24) + "…" : body}`;
};

// 每一条存档，在这次请求里的去向（来自 projectOutbound 返回的 changes）
const firstOfBatch = (i) => v.history.findIndex((m) => m.hostMetadata?.immediateSendBatchId === v.history[i].hostMetadata?.immediateSendBatchId);
const fate = (i) => {
  const notes = v.sent.report.changes.filter((c) => c.at === i);
  if (notes.length === 0) return "原样发出";
  return [...new Set(notes.map((c) => c.rule))]
    .map((rule) => {
      const n = notes.filter((c) => c.rule === rule).length;
      return { hostOnly: "丢弃：宿主专用消息", orphanResults: "丢弃：没有对应的调用", merged: `并入第 ${firstOfBatch(i) + 1} 条`, thinkingToText: "别的模型的思考 → 文字", imagesOmitted: `省略 ${n} 张旧图` }[rule];
    })
    .join("；");
};

console.log(`存下来的历史 ${v.history.length} 条，混着六种不该原样发出去的东西。这一次请求（模型 ${v.current.id}，图片上限 3 张）里，它们各自的去向：\n`);
console.log(markdownTable(v.history.map((m, i) => ({ "#": i + 1, 存下来的: brief(m), 去向: fate(i) }))));
console.log(`\n发给模型的是 ${v.sent.messages.length} 条；存下来的那份在投影前后逐字节相同：${v.unchanged ? "是" : "否"}。\n`);

const up = await upstreamImageLimit();
console.log("同一份历史，换成按前缀缓存的模型（id 含 claude）。图片上限对它不生效——请求里改动早先的内容，缓存就全废了：\n");
console.log(
  markdownTable([
    { 模型: v.current.id, 历史里的图片: v.totalImages, 发出去的图片: v.sentImages, 被省略: v.sent.report.imagesOmitted },
    { 模型: "claude-sonnet-demo", 历史里的图片: v.totalImages, 发出去的图片: v.cachedImages, 被省略: v.cached.report.imagesOmitted },
  ]),
);
console.log(
  `\n核对真实代码（request-image-limit.ts）：5 张图、上限 2，省略 ${up.omitted} 张，占位文字是“${up.placeholder}”；` +
    `keepsRequestImages('claude-sonnet-4') = ${up.claudeKeepsAll}，keepsRequestImages('MiniMax-M2') = ${up.otherKeeps}；模型没声明时默认上限 ${up.defaultLimit} 张。`,
);

const r = v.sent.report;
assert.ok(v.unchanged, "投影不改动存档");
assert.equal(v.sent.messages.length, v.history.length - 3);
assert.deepEqual([r.hostOnly, r.merged, r.orphanResults, r.thinkingToText, r.imagesOmitted], [1, 1, 1, 1, 4]);
assert.equal(v.sentImages, 3);
assert.equal(v.cachedImages, v.totalImages, "按前缀缓存的模型：不裁图片");
assert.equal(up.omitted, 3);
assert.equal(up.kept, 2);
assert.ok(up.claudeKeepsAll && !up.otherKeeps);
