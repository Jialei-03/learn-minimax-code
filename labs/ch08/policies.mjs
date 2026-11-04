// 实验：插件更新时，正在运行的 Turn 怎么办。三种做法，同一个剧本，真实的 MCP 子进程。
//   node labs/ch08/policies.mjs
import assert from "node:assert/strict";
import { markdownTable, updatePolicies } from "./scenarios.mjs";

const rows = await updatePolicies();

console.log("剧本：v1 服务器在线；Turn A 开始一次要 300ms 的 search；50ms 后插件更新到 v2；Turn B 随后开始并调用 search；A 的调用结束，A 释放。\n");
console.log(markdownTable(rows));

const [closeNow, neverClose, lease] = rows;
assert.match(closeNow["A 进行中的调用"], /^失败/);
assert.equal(neverClose["A 释放之后 v1 进程"], "仍在运行（泄漏）");
assert.equal(lease["A 进行中的调用"], "v1:alpha");
assert.equal(lease["B（更新后开始）的调用"], "v2:beta");
assert.equal(lease["更新刚完成时 v1 进程"], "仍在运行");
assert.equal(lease["A 释放之后 v1 进程"], "已退出");
assert.equal(rows.filter((row) => row["B（更新后开始）的调用"] === "v2:beta").length, 3);
