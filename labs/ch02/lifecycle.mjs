// 实验：一个带两个并行工具的真实 Turn，事件帧和历史写入各自在什么时候发生。
//   node labs/ch02/lifecycle.mjs
import assert from "node:assert/strict";
import { lifecycle, markdownTable } from "./scenarios.mjs";

const { rows, result } = await lifecycle();

console.log("模型第一次回复同时请求 slow_a（60ms）和 fast_b（5ms）两个并行工具，第二次回复给出总结。下表按发生顺序列出 writer 和 persist 收到的每一次调用：\n");
console.log(markdownTable(rows));
console.log(`\n结局：status=${result.status}，共发出 ${result.seq} 帧，persisted=${result.persisted}，delivered=${result.delivered}。`);

const first = (predicate) => rows.findIndex(predicate);
const firstToolFrame = first((row) => row.内容.includes("item.started 工具"));
const firstHistory = first((row) => row.通道 === "历史写入");
assert.ok(firstHistory < firstToolFrame, "带调用的 assistant 消息必须先于任何工具执行写进历史");
assert.equal(rows.at(-1).内容, "#12 turn.completed（completed）");
