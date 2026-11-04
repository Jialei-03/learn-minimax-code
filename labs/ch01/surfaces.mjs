// 实验：同一个结局，三个入口各怎么说。
//   node labs/ch01/surfaces.mjs
import assert from "node:assert/strict";
import { EXIT_CODES, exitCodeOf } from "../../host/src/adapters.mjs";
import { importSource, readSource } from "../../lab/source.mjs";
import { OUTCOME_SCENARIOS, markdownTable, sayIt } from "./scenarios.mjs";

// ─── 一、host：同一个运行时结局，三个入口的说法 ─────────────────────────────────
const rows = [];
for (const scenario of OUTCOME_SCENARIOS) {
  const said = {};
  for (const surface of ["tui", "exec", "acp"]) said[surface] = await sayIt(scenario, surface);
  rows.push({ 结局: scenario.name, "tui（状态行）": said.tui.说法, "exec（退出码）": said.exec.说法, "acp（协议）": said.acp.说法 });
  // 运行时给出的结局只有一份，三个入口翻译的是它。
  // acp 对失败的说法是抛出协议错误，所以它的“运行时结局”只能从错误里的 error 推回 failed。
  const statusOf = (reply) => reply.result?.outcome.status ?? "failed";
  const outcomes = new Set(["tui", "exec", "acp"].map((surface) => statusOf(said[surface])));
  assert.equal(outcomes.size, 1, `${scenario.name}：三个入口应当看到同一个结局，实际是 ${[...outcomes]}`);
}
console.log("### 一、host：同一个结局，三个入口各怎么说\n");
console.log("每一行在一个全新的会话上触发一次结局（“忙”是另一个进程先占住了租约），然后分别从 tui、exec、acp 三个适配器进去：\n");
console.log(markdownTable(rows));
console.log();
assert.equal(rows[0]["exec（退出码）"], "退出码 0");
assert.equal(rows[1]["exec（退出码）"], "退出码 4");
assert.equal(rows[2]["exec（退出码）"], "退出码 130");
assert.equal(rows[4]["exec（退出码）"], "退出码 7");
assert.equal(rows[0]["acp（协议）"], "stopReason: end_turn");
assert.equal(rows[2]["acp（协议）"], "stopReason: cancelled");
assert.equal(rows[4]["acp（协议）"], "stopReason: max_turn_requests");
assert.equal(rows[1]["acp（协议）"], "JSON-RPC 错误 -32603");

// ─── 二、退出码：host 的映射和 MiniMax 真实的函数逐项一致 ────────────────────────
const real = await importSource("packages/tui/src/headless/exit-policy.ts");
const cases = [
  { status: "succeeded" },
  { status: "failed", error: { category: "runtime" } },
  { status: "failed", error: { category: "config" } },
  { status: "failed", error: { category: "internal" } },
  { status: "timeout" },
  { status: "cancelled" },
  { status: "limit_exceeded" },
];
const parity = cases.map((c) => ({
  结局: c.error ? `${c.status}（${c.error.category}）` : c.status,
  "MiniMax 的 exitCodeForExecResult": real.exitCodeForExecResult(c),
  "host 的 exitCodeOf": exitCodeOf(c),
}));
console.log("### 二、退出码：host 和 MiniMax 真实的函数逐项对照\n");
console.log("中间一列是从固定提交 `packages/tui/src/headless/exit-policy.ts` 里装载出来、直接运行的 `exitCodeForExecResult`：\n");
console.log(markdownTable(parity));
console.log();
for (const row of parity) assert.equal(row["host 的 exitCodeOf"], row["MiniMax 的 exitCodeForExecResult"]);
assert.deepEqual({ ...EXIT_CODES }, { ...real.MINIMAX_CODE_EXEC_EXIT_CODES });

// ─── 三、ACP：结局到 stopReason 的映射写在源码的哪几行 ───────────────────────────
const file = "packages/tui/src/acp/agent.ts";
const lines = readSource(file).split("\n");
const find = (needle, after = 0) => {
  const index = lines.findIndex((l, i) => i >= after && l.includes(needle));
  assert.ok(index >= 0, `在 ${file} 里找不到：${needle}`);
  return index + 1;
};
const first = find("if (result.status === 'succeeded') return { stopReason: 'end_turn' };");
const mapping = [
  ["succeeded", "end_turn", first],
  ["cancelled", "cancelled", find("if (result.status === 'cancelled') return { stopReason: 'cancelled' };", first)],
  ["limit_exceeded", "max_turn_requests", find("if (result.status === 'limit_exceeded') return { stopReason: 'max_turn_requests' };", first)],
  ["其余（failed 等）", "抛出 `RequestError.internalError`", find("throw acp.RequestError.internalError(", first)],
];
console.log("### 三、ACP：结局到 `stopReason` 的映射\n");
console.log("ACP 的映射写在 `session/prompt` 处理函数的末尾，不是独立函数，所以这里只核对源码里确实有这几行：\n");
console.log(markdownTable(mapping.map(([status, reason, line]) => ({ 结局: status, 回给编辑器的: reason, 位置: `\`${file.replace("packages/tui/src/", "")}:${line}\`` }))));
