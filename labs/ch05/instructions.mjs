// 实验：项目指令和全局指令是怎么选出来、怎么受预算限制的。
//   node labs/ch05/instructions.mjs
import assert from "node:assert/strict";
import { instructionCases, markdownTable } from "./scenarios.mjs";

const { rows, globalRows, bothFound, bigFound, cjkFound, limit } = await instructionCases();

console.log(`预算：项目指令和全局指令各 ${limit} 字节（32KB）。\n`);
console.log("**项目指令**\n");
console.log(markdownTable(rows));
console.log("\n**全局指令**\n");
console.log(markdownTable(globalRows));

const tail = bigFound.content.split("\n").slice(-3).join("\n");
console.log("\n超限的 AGENTS.md 被截断以后，注入内容的最后三行：\n");
console.log("```text");
console.log(tail);
console.log("```");

// ── 检查 ──
assert.ok(bothFound.content.includes("old name"), "CLAUDE.md 先到先得");
assert.ok(!bothFound.content.includes("from AGENTS.md"));
assert.ok(Buffer.byteLength(bigFound.content) <= limit);
assert.ok(Buffer.byteLength(cjkFound.content) <= limit);
assert.ok(!cjkFound.content.includes("�"), "UTF-8 边界上没有乱码");
assert.equal(rows[3].读到的文件, "（没有）");
assert.equal(globalRows[1].注入字节, 0);
assert.ok(bigFound.content.split("\n").at(-3).startsWith("- rule"), "截断发生在完整行上");
