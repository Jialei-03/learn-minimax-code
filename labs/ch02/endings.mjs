// 实验：同一个 Turn 的七种结局，以及每种结局下谁先出问题、工具有没有执行。
//   node labs/ch02/endings.mjs
import assert from "node:assert/strict";
import { endings, markdownTable } from "./scenarios.mjs";

const { rows, runs } = await endings();

console.log("每个场景都让模型请求把 a.txt 里的 old 改成 new（取消场景请求的是一个会一直等待的工具），再对某个环节注入一次故障：\n");
console.log(markdownTable(rows));

const byName = Object.fromEntries(runs.map((run) => [run.name, run]));
assert.equal(byName["正常结束"].fileChanged, true);
for (const run of runs.filter((run) => run.name !== "正常结束")) assert.equal(run.fileChanged, false, run.name);
assert.equal(byName["终态帧写不出去"].result.status, "failed");
