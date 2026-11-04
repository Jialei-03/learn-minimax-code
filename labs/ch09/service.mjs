// 实验：运行 MiniMax 的真实 QueueService（从固定提交读出完整的 service.ts / policy.ts / contract.ts 执行）。
//   node labs/ch09/service.mjs
import assert from "node:assert/strict";
import { markdownTable, realQueueService } from "./scenarios.mjs";

const result = await realQueueService();

console.log("QueueService 前面是一个假的内存仓库（只实现 findByClientRequestId 和 enqueue）；下面每一行的判断都是上游代码做的：\n");
console.log(markdownTable(result.rows));

assert.deepEqual(result.calls.resolve, ["m-old", "m-new"]);
assert.equal(result.r2.value.item.model.resolved, "解析自 m-old");
assert.equal(result.r3.value.item.model.resolved, "解析自 m-new");
assert.equal(result.expiry.every((line) => line.endsWith("expiry-invalid")), true);
assert.deepEqual(result.mapped, [
  "maintenance-active → session-busy",
  "session-not-found → session-not-found",
  "QueueDataCorruptionError → data-corrupt",
]);
