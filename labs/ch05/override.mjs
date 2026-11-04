// 实验：--system-prompt 换掉的是“身份”，哪些东西还留着？
//   node labs/ch05/override.mjs
import assert from "node:assert/strict";
import { markdownTable, overrideCases } from "./scenarios.mjs";

const { rows, parity, realOutput } = await overrideCases();

console.log("同一个工作区（有项目指令、环境、记忆、Skill 目录），用不同的启动参数组装系统提示：\n");
console.log(markdownTable(rows));

console.log("\n上游真实的 `addRuntimeRules` 对一个只有一句话的自定义提示做了什么（交互界面）：\n");
console.log("```text");
console.log(realOutput);
console.log("```");

console.log("\nhost 里的简化版和上游原函数，在同样的输入上是否逐字一致（规则文字用上游原文）：\n");
console.log(markdownTable(parity));

// ── 检查 ──
const [plain, replaced, appended, child] = rows;
assert.equal(replaced.身份提示, "海盗（被换掉）");
assert.equal(replaced.运行时规则, "有");
assert.equal(replaced.项目指令, "有");
assert.equal(replaced.记忆块, "有");
assert.equal(replaced.能力清单, "有");
assert.equal(appended.追加的文字, "有");
assert.equal(child.身份提示, "内置", "后台任务的子 Agent 不受启动参数影响");
assert.equal(child.追加的文字, "无");
assert.equal(child.先说一句话的规则, "无");
assert.equal(plain.先说一句话的规则, "有");
assert.ok(parity.every((row) => row.逐字一致 === "是"), "host 简化版与上游一致");
