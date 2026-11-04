// 实验：用量怎么记。上半部分是真实的 recordCommittedPiUsage；下半部分看重试对用量表的影响。
//   node labs/ch03/usage.mjs
import assert from "node:assert/strict";
import { USAGE_MESSAGES, USAGE_MODEL_KEY, USAGE_NOTES, group, markdownTable, recordWithUpstream, usageThroughRetry } from "./scenarios.mjs";

const { recorded, rows, goal } = await recordWithUpstream();
console.log(`一次 Turn 提交了 ${USAGE_MESSAGES.length} 条消息，真实的 recordCommittedPiUsage 落了 ${recorded} 行：\n`);
const assistants = USAGE_MESSAGES.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "assistant");
console.log(markdownTable(assistants.map(({ message }, i) => {
  const row = rows.find((candidate) => candidate.ts === message.timestamp);
  return {
    "assistant 消息": USAGE_NOTES[i],
    落账: row ? "一行" : "跳过",
    输入: row ? group(row.inputTokens) : "—",
    输出: row ? group(row.outputTokens) : "—",
    思考: row ? group(row.reasoningTokens) : "—",
    "缓存读 / 写": row ? `${group(row.cacheReadTokens)} / ${group(row.cacheWriteTokens)}` : "—",
    model: row ? `\`${row.model}\`` : "—",
  };
})));
console.log(`\n目标（goal）的计费口径另算：令牌 ${group(goal.tokens)}（不含缓存），incomplete=${goal.incomplete}（有一条消息没有 usage）。\n`);

const retried = await usageThroughRetry({ failures: 2 });
const failed = await usageThroughRetry({ failures: 6, succeed: false });
console.log(markdownTable([
  { 场景: "两次 529 之后成功", 物理请求: retried.calls, 结局: retried.outcome, 用量表的行数: retried.ledger.rows.length },
  { 场景: "一直 529，重试用完", 物理请求: failed.calls, 结局: failed.outcome, 用量表的行数: failed.ledger.rows.length },
]));
const [group0] = retried.ledger.summarize("model");
console.log(`\n按 model 汇总的键是 \`${group0.key}\`：${group0.key === USAGE_MODEL_KEY ? "等于配置里的原键" : "和原键不同"}。`);

assert.equal(recorded, 3);
assert.equal(rows.every((row) => row.model === USAGE_MODEL_KEY), true);
assert.deepEqual(goal, { tokens: 2545, incomplete: true });
assert.equal(retried.calls, 3);
assert.equal(retried.ledger.rows.length, 1);
assert.equal(failed.ledger.rows.length, 0);
assert.equal(group0.key, USAGE_MODEL_KEY);
