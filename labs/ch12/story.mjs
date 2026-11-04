// 实验：长任务 A → 插件更新 → B 排队 → 取消 A → B 修好真实失败的测试 → SDK 还原结果。
//   node labs/ch12/story.mjs
// 跑在 host 的真实应用上：A 的工具是一个不会结束的子进程，R1/R2 是两个真的 MCP 子进程，
// 测试是真的 node 进程，队列和事件是真的日志；只有模型的回复是脚本。
import assert from "node:assert/strict";
import { mainStory, markdownTable } from "./scenarios.mjs";

const story = await mainStory();

console.log("每一行是一个时刻，后四列是那一刻宿主里的事实：\n");
console.log(markdownTable(story.rows));
console.log("\nB 的修复过程（模型的回复是脚本，工具都是真的）：\n");
console.log(markdownTable(story.repair));
console.log("\nSDK 客户端手里只有事件帧，它们能还原出什么：\n");
console.log(markdownTable(story.sdk));

const { facts } = story;
assert.equal(facts.resultA.status, "cancelled");
assert.equal(facts.resultB.status, "completed");
assert.equal(facts.resultB.capabilityRevision, "r2");
assert.deepEqual(facts.closed, ["r1", "r2"]);
