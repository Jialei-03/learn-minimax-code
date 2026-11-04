// 实验：run_code 程序的几条边界——失败、权限、预算、返回值、提前返回、超时。
//   node labs/ch04/program.mjs
import assert from "node:assert/strict";
import { markdownTable, programs } from "./scenarios.mjs";

const { rows, clocks } = await programs();
console.log("每一行是一段模型写的程序，和它在 host 的 run_code 里的结局。第二列是模型收到的文字，后两列是宿主自己的记录：\n");
console.log(markdownTable(rows.map(({ message, ...row }) => row)));
console.log(`
- 子调用失败不会让程序抛异常，程序自己检查 status 和 error.code；
- 程序里的 edit 要过和直接调用一样的权限，被拒绝只让这一次调用失败（PTC_PERMISSION_DENIED），后面的 read 照常执行；
- 前置 Hook 同样适用于子调用，被拦下的 read 根本没有执行；
- 超出预算的调用不会执行，程序继续往下走；
- 程序返回时还有子调用没结束，模型会收到 PTC_INCOMPLETE，被告知不要假设它们成功了。

timeout_ms 怎样变成程序的 wall clock（host 的 resolveWallClock 与 MiniMax 的 resolvePtcWallClock 对照）：`);
const { resolveWallClock } = await import("../../host/src/tools.mjs");
console.log(markdownTable(clocks.map(({ requested, real }) => ({ timeout_ms: JSON.stringify(requested) ?? "（不写）", "MiniMax": `${real.ms} (${real.source})`, host: (({ ms, source }) => `${ms} (${source})`)(resolveWallClock(requested)) }))));

const by = Object.fromEntries(rows.map((r) => [r.场景, r]));
assert.match(by["程序里的 edit 也要过权限"].模型收到的文字, /PTC_PERMISSION_DENIED/);
assert.equal(by["程序里的 edit 也要过权限"].实际执行的子调用, "read:f0.txt");
assert.equal(by["同一个 Hook 也拦程序里的子调用"].实际执行的子调用, "—");
assert.equal(by["调用预算（这里设成 4 次）"].实际执行的子调用.split(",").length, 4);
assert.match(by["没等子调用就返回"].模型收到的文字, /PTC_INCOMPLETE/);
assert.match(by["超过 wall clock（timeout_ms: 80）"].模型收到的文字, /wall_clock_exceeded/);
assert.equal(by["访客拿不到宿主"].模型收到的文字, '`"undefined,undefined,undefined,undefined"`');
for (const { requested, real } of clocks) assert.deepEqual(resolveWallClock(requested), real);
