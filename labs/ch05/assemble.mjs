// 实验：一个 Turn 开始时，系统提示和用户消息是怎样拼出来的。
//   node labs/ch05/assemble.mjs
import assert from "node:assert/strict";
import { assembleRequest, markdownTable } from "./scenarios.mjs";
import { genuineUserText } from "../../host/src/context.mjs";

const { prompt, userMessage, rows, kindTotals } = await assembleRequest();

console.log("工作区有 AGENTS.md，数据目录有全局 AGENTS.md，还有用户档案、MEMORY.md、一个主题文件和两个 Skill。\n");
console.log(markdownTable(rows));

const total = prompt.text.length;
console.log(`\n系统提示共 ${total} 字符。按 \`composePromptParts\` 记下的范围分账：`);
for (const [kind, size] of Object.entries(kindTotals))
  console.log(`- ${kind}：${size} 字符（${Math.round((size / total) * 100)}%）`);
const named = Object.values(kindTotals).reduce((a, b) => a + b, 0);
console.log(`- 没有归类的（身份与规则、前言、环境）：${total - named} 字符`);

console.log("\n系统提示的骨架（每一部分的第一行）：\n");
console.log("```text");
prompt.system.forEach((part, i) => console.log(`${String(i + 1).padStart(2)}. ${part.split("\n")[0]}`));
console.log("```");

console.log("\n这一轮的用户消息（reminder 在前，用户原话在最后）：\n");
console.log("```text");
console.log(userMessage.text);
console.log("```");
const { startOffset, endOffset } = userMessage.canonicalTextRange;
console.log(`\n\`canonicalTextRange\` = [${startOffset}, ${endOffset})，切出来的原话：“${genuineUserText(userMessage)}”`);

// ── 检查 ──
assert.deepEqual(prompt.sections.slice(0, 5), ["identity", "preamble", "global", "project", "environment"]);
assert.equal(prompt.sections.at(-1), "skills");
assert.ok(!/2026-11-04/.test(prompt.text), "系统提示里没有日期");
assert.ok(/2026-11-04/.test(userMessage.text), "日期在用户消息的 reminder 里");
assert.equal(genuineUserText(userMessage), "把失败的测试修好");
assert.ok(kindTotals.MEMORY > 0 && kindTotals.SKILLS > 0 && kindTotals.OTHER > 0);
