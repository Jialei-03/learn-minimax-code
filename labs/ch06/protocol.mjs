// 实验：checkpoint 协议。直接运行 MiniMax 的 checkpoint-format.ts 和 checkpoint-protocol.ts。
//   node labs/ch06/protocol.mjs
import assert from "node:assert/strict";
import { importSource } from "../../lab/source.mjs";
import { markdownTable, protocolAssembly, protocolMatrix } from "./scenarios.mjs";

const matrix = await protocolMatrix();
console.log("模型写出的摘要能不能用？上游 validateCheckpointGeneration 和 host 的 checkpoint 对同一批生成结果的判断（输出预算 25000 token）：\n");
console.log(markdownTable(matrix));
console.log("\n只有“没写完 / 空 / 调了工具 / 超预算”才被拒绝；格式不合只记为 soft_fallback，照样提交。\n");

const a = await protocolAssembly();
console.log("装一条 checkpoint（真实的 buildCheckpointMessage）。输入历史里有三条用户消息，最后一条是 /compact。它的组成：\n");
console.log(
  markdownTable([
    { 部分: "模型写的八节摘要", 内容: `${a.parts["八节摘要（模型写的）"]} 个 ## 标题` },
    { 部分: "存档位置说明", 内容: a.parts["存档位置说明"] ? "有：Files from before this compaction（snapshots/ 与 tool-outputs/ 的路径）" : "无" },
    { 部分: "宿主备注", 内容: a.parts["宿主备注"] ? "有：Host note，说明下面的用户原话与上面各节冲突时以谁为准" : "无" },
    { 部分: "宿主核实的附录", 内容: `mavis-context-appendix version ${a.parts["附录版本"]}：最近用户原话，不经模型` },
  ]),
);

console.log("\n第二次压缩时，附录里的用户原话怎样接力（只留最近两条，/compact 这类控制命令不算）：\n");
console.log(
  markdownTable([
    { 压缩: "第一次", 用户原话: a.firstQueries.map((q) => `“${q}”`).join("、"), "host 版": a.hostFirst.map((q) => `“${q}”`).join("、") },
    { 压缩: "第二次（之后又说了三句）", 用户原话: a.secondQueries.map((q) => `“${q}”`).join("、"), "host 版": a.hostSecond.map((q) => `“${q}”`).join("、") },
  ]),
);

const prompt = await importSource("packages/local-runtime-v2/src/service/turn-system/compaction/execution/checkpoint-prompt.ts");
console.log("\n摘要自己的输出预算（checkpointMaxOutputTokens）：预留的 4/5 与窗口的 1/8 取大，不超过模型的输出上限：\n");
console.log(
  markdownTable(
    [
      [128_000, 8_192],
      [200_000, 8_192],
      [200_000, 64_000],
      [1_000_000, 64_000],
    ].map(([window, max]) => ({ 窗口: window, 模型输出上限: max, 摘要输出预算: prompt.checkpointMaxOutputTokens(16_384, max, window) })),
  ),
);

assert.deepEqual(matrix.map((r) => r.上游), matrix.map((r) => r.host), "host 版与上游版逐项一致");
assert.deepEqual(matrix.map((r) => r.接受), ["是", "是", "是", "是", "否", "否", "否", "否"]);
assert.deepEqual(a.firstQueries, a.hostFirst);
assert.deepEqual(a.secondQueries, a.hostSecond);
assert.deepEqual(a.secondQueries, ["别忘了 lint", "顺便看看 CI"].slice(-2));
assert.equal(a.sections.length, 8);
