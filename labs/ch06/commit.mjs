// 实验：压缩提交在每个位置崩溃，磁盘上剩下什么；追加写失败的几种形态。
//   node labs/ch06/commit.mjs
import assert from "node:assert/strict";
import { appendFailures, commitScenarios, markdownTable } from "./scenarios.mjs";

console.log("一份 13 条的历史做压缩提交（先把旧历史存进 snapshots/，再原子替换 messages.jsonl），在不同位置出故障：\n");
const commits = await commitScenarios();
console.log(markdownTable(commits));

console.log("\n往 messages.jsonl 追加两条消息，写入过程出各种故障。重试规则：普通失败最多写三次，结果不明的绝不重试：\n");
const appends = await appendFailures();
console.log(markdownTable(appends));

const by = (rows, prefix) => rows.find((r) => String(r.场景 ?? r.失败方式).startsWith(prefix));
assert.match(by(commits, "1").活动文件, /第 1 代 · 1 条/);
assert.match(by(commits, "2").活动文件, /第 0 代 · 13 条/);
assert.match(by(commits, "3").活动文件, /第 0 代 · 13 条/);
assert.match(by(commits, "4").结果, /already-exists/);
assert.match(by(commits, "5").结果, /snapshot conflict/);
assert.match(by(commits, "6").快照, /永远丢了/);
assert.deepEqual(appends.map((r) => r.写入尝试), [2, 2, 1, 1, 3]);
assert.deepEqual(appends.map((r) => r["这批消息出现的次数"]), [1, 1, 1, 0, 0]);
assert.equal(appends[3].调用方看到, "CommitUncertainError");
