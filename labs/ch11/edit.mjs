// 实验：edit 工具的模糊匹配，在被碰到的那一行上改写了哪些没被指名的字符？
//   node labs/ch11/edit.mjs
import assert from "node:assert/strict";
import { EDIT_FILE, EDIT_REQUEST, markdownTable, reproduceFuzzyEdit } from "./scenarios.mjs";

console.log("文件内容：\n");
console.log(EDIT_FILE.split("\n").map((l, i) => `${i + 1}  ${l}`).join("\n"));
console.log(`\n模型的 edit 请求：把 ${JSON.stringify(EDIT_REQUEST[0].oldText)} 改成 ${JSON.stringify(EDIT_REQUEST[0].newText)}（文件里是弯引号，模型写了直引号，精确匹配失败，转入模糊匹配）。\n`);
const rows = await reproduceFuzzyEdit();
console.log(markdownTable(rows));

assert.equal(rows[0].未碰的行是否原样, "是");
assert.notEqual(rows[0].被连带改写的字符, "无");
assert.equal(rows[1].被连带改写的字符, "无");
