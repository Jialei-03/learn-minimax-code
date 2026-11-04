// 实验：读补丁台账，再把七条台账条目拿到 Pi v1.5.0 里核对。
//   node labs/ch11/ledger.mjs
import assert from "node:assert/strict";
import { VERDICTS } from "../../host/src/contribution.mjs";
import { LEDGER_FILE, OBSERVED, classifierDrift, ledgerOverview, markdownTable, upstreamChecks } from "./scenarios.mjs";

const { summary, entries } = ledgerOverview();
console.log(`${LEDGER_FILE} 的体检：\n`);
console.log(
  markdownTable([
    { 项目: "条目总数", 数量: summary.entries },
    { 项目: "自认通用、可回馈上游（generic / upstreamable / upstream material）", 数量: summary.generic },
    { 项目: "自认 MiniMax 专用", 数量: summary.minimaxSpecific },
    { 项目: "没有标注类型", 数量: summary.unmarked },
    { 项目: "写着 Upstream PR: not opened / not created", 数量: summary.prNotOpened },
    { 项目: "已经在上游合并", 数量: summary.prMerged },
    { 项目: "没有记录上游 PR 状态", 数量: summary.prUnrecorded },
    { 项目: "点名了回归测试文件", 数量: summary.withNamedTest },
  ]),
);

console.log("\n七条条目对照 Pi v1.5.0（出处行号由程序在真实文件里搜出来）：\n");
const checks = upstreamChecks();
console.log(
  markdownTable(
    checks.map((c) => ({
      台账条目: `${c.date} ${c.entry}`.slice(0, 62),
      结论: VERDICTS[c.verdict],
      出处: c.evidence.map((e) => `${e.file.replace("packages/", "")}:${e.line}`).join("；"),
    })),
  ),
);

console.log(`\n上游讨论（${OBSERVED} 用只读方式看到的状态）：\n`);
console.log(
  markdownTable(
    checks.flatMap((c) => c.issues.map((i) => ({ 台账条目: c.entry.slice(0, 40), 上游议题: `${i.repo}#${i.number}`, 状态: i.state, 标签: i.label || "—" }))),
  ),
);

console.log("\n核对的另一半：stop_reason 那条补丁在 MiniMax 一侧的消费者（packages/shared/src/llm-error-classifier.ts，真实函数）：\n");
const drift = await classifierDrift();
console.log(markdownTable(drift));

assert.equal(summary.entries, entries.length);
assert.deepEqual(drift.map((d) => d.分类结果), ["50113", "null"]);
assert.ok(summary.prNotOpened > summary.entries / 2);
assert.deepEqual(checks.map((c) => c.verdict), ["fixed", "fixed", "still-present", "partial", "different-design", "still-present", "still-present"]);
