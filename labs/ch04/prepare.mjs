// 实验：MiniMax 真实的 prepareEditArguments，怎样处理某些模型对 edit 的固定坏习惯。
//   node labs/ch04/prepare.mjs
// 函数来自 agent-core/src/tools/edit-prepare-arguments.ts，从固定提交里装载并运行。
import assert from "node:assert/strict";
import { markdownTable, prepare } from "./scenarios.mjs";

const rows = await prepare();
console.log("模型发来的 edit 参数，在 schema 校验之前先过一遍 prepareEditArguments：\n");
console.log(markdownTable(rows));
console.log("\n解析不了的字符串原样放行，交给后面的 schema 校验去报错：那条错误信息会写给模型，下一轮它自己改。");

assert.equal(rows[1].输出, rows[0].输出);
assert.equal(rows[2].输出, rows[0].输出);
assert.equal(rows[3].输出, rows[3].输入);
