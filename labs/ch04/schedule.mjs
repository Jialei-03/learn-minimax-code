// 实验：模型在一条回复里发了四个调用——读 a、读 b、改 a、再读一次 a。三种排法各自怎么跑。
//   node labs/ch04/schedule.mjs
import assert from "node:assert/strict";
import { markdownTable, schedules } from "./scenarios.mjs";

const { rows, plan } = await schedules();
console.log("四个调用（A、B、C 是读，E 是改写 a.txt，原内容是 old）：\n");
console.log(markdownTable(plan.map((p) => ({ 编号: p.id, 调用: p.label, 声明: p.name === "read" ? "parallel" : "sequential" }))));
console.log("\n每种排法下，调用的开始（+）和结束（-）怎样交错：\n");
console.log(markdownTable(rows.map(({ log, ...row }) => row)));
console.log(`
- Pi 的规则看整批：里面有一个 sequential（edit），四个调用就一个接一个，读与读之间也没有重叠；
- Claude Code 的相邻分批和 run_code 的屏障队列得到同一个形状：A、B 一起开始，E 等它们都结束，C 等 E；
- host 的 SubcallScheduler 和 MiniMax 的 PtcSubcallScheduler（真实代码）给出完全一样的顺序；
- 最后一行是 edit 被误标成 parallel 的后果：C 在 E 生效之前就读了文件，拿到旧内容。`);

const by = Object.fromEntries(rows.map((r) => [r.做法, r]));
assert.equal(by["Pi / MiniMax 整批规则"].同时在跑的峰值, 1);
assert.equal(by["Claude Code：相邻分批"].log.join(" "), by["run_code：MiniMax 的 PtcSubcallScheduler"].log.join(" "));
assert.equal(by["run_code：host 的 SubcallScheduler"].log.join(" "), by["run_code：MiniMax 的 PtcSubcallScheduler"].log.join(" "));
assert.equal(by["反例：edit 误标成 parallel，全部同时开始"]["末尾 read 读到"], "old");
for (const name of ["Pi / MiniMax 整批规则", "Claude Code：相邻分批", "run_code：host 的 SubcallScheduler"]) assert.equal(by[name]["末尾 read 读到"], "new");
