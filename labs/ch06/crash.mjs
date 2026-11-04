// 实验：进程被杀之后，磁盘上留下了什么，下一次读取怎样处理。
//   node labs/ch06/crash.mjs
import assert from "node:assert/strict";
import { crashScenarios, markdownTable, staleDisplayRows } from "./scenarios.mjs";

const scenarios = await crashScenarios();
console.log("规范历史（messages.jsonl）四种崩溃现场。“活动读取”保留最后一个还在等结果的回合，“落定读取”（新 Turn 开始前）把它当作崩溃遗留：\n");
console.log(
  markdownTable(
    scenarios.map((s) => ({
      场景: s.scenario,
      文件里: s.stored.join(" → "),
      活动读取: s.activeRows.join(" → "),
      落定读取: s.settledRows.join(" → "),
      丢掉的: s.issues.map((i) => `${i.kind}（${i.dropped} 条）`).join("，") || "—",
      文件被改写: s.settledRewritten ? "是" : "否",
      "Pi 发送时要补的结果": s.piWouldFill,
    })),
  ),
);

console.log("\n展示用的消息行（SQLite 里 UI 看的那一份）也会被崩溃弄脏：压缩开始时写下的 compaction_start，进程在压缩中途被杀，就永远没有下文。读取会话时，真实的 StaleCompactionMessageRepair 把它们改成 compaction_failed：\n");
const stale = await staleDisplayRows();
console.log(
  markdownTable(
    stale.rows.map((row, i) => ({
      msg_id: row.msg_id,
      类型: row.kind ?? row.role,
      写入时刻: row.timestamp,
      "只有 m4 来自本进程（启动于 1000）": row.timestamp >= 1_000 && row.kind ? "是" : row.kind ? "否" : "—",
      读取后: stale.fixed[i].kind ?? stale.fixed[i].role,
      "m5 到来之后再读": stale.later[i].kind ?? stale.later[i].role,
    })),
  ),
);
console.log(`\n第一次读取写回的行：${stale.patched.join("、")}；m5 到来之后再读，写回的行：${stale.laterPatched.join("、")}。`);

const [a, b, c, d] = scenarios;
assert.deepEqual(a.settledRows, ["user"]);
assert.deepEqual(a.activeRows, a.stored, "活动读取保留正在进行的回合");
assert.equal(a.settledRewritten, true);
assert.deepEqual(b.settledRows, ["user"], "已到的部分结果也一起丢掉");
assert.deepEqual(c.settledRows, ["user", "user"]);
assert.equal(c.issues[0].kind, "interrupted-tool-round");
assert.equal(d.issues[0].kind, "orphan-tool-result");
assert.deepEqual(stale.patched, ["m2"]);
assert.deepEqual(stale.laterPatched, ["m2", "m4"]);
