// 实验：同一批故障，四种重试策略。时间是虚拟的（假时钟），瞬间跑完。
//   node labs/ch03/retry.mjs
import assert from "node:assert/strict";
import { RETRY_POLICIES, backoffRows, cellText, markdownTable, retryMatrix } from "./scenarios.mjs";

const matrix = await retryMatrix();
console.log("每格是：物理请求次数 · 总耗时 · 结局。\"朴素重试\"是任何错误都重试 5 次、固定等 1 秒。\n");
console.log(markdownTable(matrix.map(({ scenario, cells }) => ({
  场景: scenario.名称,
  ...Object.fromEntries(RETRY_POLICIES.map((policy) => [policy, cellText(cells[policy])])),
}))));

const half = matrix[2].cells;
console.log("\n“说了半句话，连接断了”时，用户屏幕上最后出现的文字：\n");
console.log(markdownTable(RETRY_POLICIES.map((policy) => ({ 策略: policy, 屏幕上的文字: half[policy].screen || "（空）" }))));

console.log("\n默认策略的退避：最多重试 5 次，指数增长，取一半到全部之间的随机值：\n");
console.log(markdownTable(backoffRows()));

const waiting = matrix[0].cells.官方账号.events;
console.log("\n“连续两次 529”时，界面收到的重试事件：\n");
for (const event of waiting) {
  console.log(`- ${event.status}${event.delayMs ? `，${event.delayMs}ms 后发起第 ${event.requestAttempt} 次请求（已重试 ${event.retryAttempt}/${event.maxRetries}）` : `，第 ${event.requestAttempt} 次请求`}${event.reason ? `，原因 ${event.reason}` : ""}`);
}

const calls = (scenario, policy) => matrix[scenario].cells[policy].calls;
assert.deepEqual([0, 1, 2, 3, 4].map((i) => calls(i, "官方账号")), [3, 1, 1, 2, 1]);
assert.deepEqual([0, 1, 2, 3, 4].map((i) => calls(i, "BYOK")), [3, 6, 1, 2, 3]);
assert.equal(calls(3, "朴素重试"), 6);
assert.equal(half.朴素重试.screen, "我先看看我先看看入口文件。");
assert.equal(half.官方账号.screen, "我先看看");
assert.deepEqual(waiting.map((event) => event.status), ["waiting", "waiting", "recovered"]);
assert.deepEqual(waiting.filter((event) => event.delayMs).map((event) => event.delayMs), [750, 1500]);
