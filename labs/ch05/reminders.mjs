// 实验：reminder 链。运行的是上游真实的默认链（26 个 provider），host 的 buildReminder 只负责串起来。
//   node labs/ch05/reminders.mjs
import assert from "node:assert/strict";
import { markdownTable, reminderChain } from "./scenarios.mjs";

const r = await reminderChain();

console.log(`默认链共 ${r.all} 个 provider，其中 ${r.criticalNames.length} 个标了 critical：${r.criticalNames.join("、")}。\n`);
console.log(markdownTable(r.rows));

console.log("\n会话 A 第 1 轮，上游 provider 渲染出的完整 reminder：\n");
console.log("```text");
console.log(r.texts[0]);
console.log("```");
console.log("\n第 2 轮：\n");
console.log("```text");
console.log(r.texts[1]);
console.log("```");

// ── 检查 ──
assert.deepEqual(r.fired[0], ["agentContext", "mediaOutputReminder", "asyncAudit"]);
assert.deepEqual(r.fired[1], ["agentContext"], "第 2 轮只剩精简的 agent-context");
assert.deepEqual(r.fired[2], ["agentContext", "userMemoryUpdate", "agentMemoryUpdate"]);
assert.deepEqual(r.fired[3], ["mediaOutputReminder", "asyncAudit"], "只跑 critical：agent-context 不在其中");
assert.ok(r.texts[1].length < r.texts[0].length);
assert.ok(!r.texts[3].includes("<agent-context>"));
