// 实验：没有结果就是失败——逐行解析、退出码与错误的对应、两段坏结局的录像。
//   node labs/ch10/outcomes.mjs
import assert from "node:assert/strict";
import { parseCases, exitMapping, failureRecordings, markdownTable, quote, TOOL_STATUS } from "./scenarios.mjs";

console.log("**第一层：每一行 stdout 都要通过 `parseEventLine`。** 把几种可能出现在 stdout 上的行交给真实的解析函数：\n");
const parsed = await parseCases();
console.log(markdownTable(parsed.map(({ error, ...row }) => row)));

console.log("\n**第二层：退出码。** CLI 的 `exitCodeForExecResult` 给每种结局一个退出码；SDK 的 `errorForResult`（有 exec.completed）和 `errorForExit`（只剩退出码）把它们变成错误。两个函数都是真实的上游代码：\n");
const { rows, exitOnly } = await exitMapping();
console.log(markdownTable([...rows, ...exitOnly].map(({ fromResult, fromExit, ...row }) => row)));

console.log("\n**第三层：坏结局的录像。** 被取消和上游服务报错，各自抛出的错误里带着什么：\n");
const recordings = await failureRecordings();
console.log(
  markdownTable(
    recordings.map(({ name, folded, error }) => ({
      录像: `${name}.jsonl`,
      事件数: folded.events.length,
      "SDK 抛出": error.constructor.name,
      message: error.message.slice(0, 48) + (error.message.length > 48 ? "…" : ""),
      "status / category / retryable": [error.status ?? "-", error.category ?? "-", error.retryable ?? "-"].join(" / "),
      "错误里带着的 items": error.items.length
        ? error.items.map((item) => `${item.type === "tool_call" ? item.toolCall.name + "（状态 " + item.toolCall.status + " " + TOOL_STATUS[item.toolCall.status] + "）" : quote(item.text, 18)}${item.incomplete ? " incomplete" : ""}`).join("；")
        : "（没有）",
    })),
  ),
);

// 守住结论
const byName = Object.fromEntries(parsed.map((row) => [row.输入, row]));
assert.equal(byName["（空行）"].结果, "忽略");
assert.equal(byName["Update available: run npm i -g @minimax-ai/code"].错误类型, "MCodeProtocolError");
assert.equal(byName["schemaVersion 是 2"].错误类型, "MCodeVersionError");
assert.match(byName["没见过的事件类型"].结果, /放行/);
for (const row of rows.filter((r) => r.fromResult)) {
  // 上游契约测试的断言：有结果和只有退出码，得到同一类错误
  assert.equal(row.fromExit.constructor, row.fromResult.constructor, row.CLI结果);
  assert.equal(row.fromExit.status, row.fromResult.status, row.CLI结果);
  assert.equal(row.fromExit.category, row.fromResult.category, row.CLI结果);
}
assert.equal(rows[0].fromExit.constructor.name, "MCodeProtocolError"); // 退出码 0 却没有 exec.completed
const [cancelled, failed] = recordings;
assert.equal(cancelled.error.constructor.name, "MCodeAbortError");
assert.deepEqual(cancelled.error.items.map((item) => item.incomplete), [true, true]);
assert.equal(failed.error.constructor.name, "MCodeRunError");
assert.equal(failed.error.retryable, true);
