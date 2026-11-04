// 实验：请求模型之前的压缩钩子，在七种处境下各自的结局。
//   node labs/ch06/pipeline.mjs
import assert from "node:assert/strict";
import { markdownTable, pipelineScenarios } from "./scenarios.mjs";

const { rows, results, model } = await pipelineScenarios();
console.log(`模型窗口 ${model.contextWindow}、最大输出 ${model.maxOutputTokens}（触发线 142500）。同一段约 15 万 token 的修 bug 会话，在每种处境下进入“请求模型之前”的钩子：\n`);
console.log(markdownTable(rows));

const done = results.done;
console.log(
  `\nB 的细节：压缩前约 ${done.out.before} token，压缩后约 ${done.out.after} token；内存里剩 ${done.live.length} 条（${done.live.map((m) => m.role).join(" + ")}），` +
    `磁盘进入第 ${done.generation} 代。摘要请求的输入是 ${done.requests[0]} token。`,
);
console.log(`D 的细节：服务商拒绝了完整历史，第二份输入（工具结果换成占位）只有 ${results.tooLarge.requests[0]} token，摘要在这一份上写成。`);

assert.equal(results.under.out.status, "unchanged");
assert.equal(done.out.status, "completed");
assert.equal(done.generation, 1);
assert.deepEqual(done.live.map((m) => m.role), ["compactionSummary", "user"]);
assert.equal(results.toolCall.out.status, "skipped");
assert.equal(results.toolCall.generation, 0);
assert.equal(results.tooLarge.out.rung, "hall/exact");
assert.equal(results.providerDown.out.reason, "CHECKPOINT_PROVIDER_FAILED");
assert.equal(results.commit.out.status, "threw");
assert.equal(results.commit.generation, 0, "提交失败：磁盘上仍是压缩前的历史");
assert.equal(results.recovery.out.status, "completed");
