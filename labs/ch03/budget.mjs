// 实验：输出上限不是常数。窗口 200,000、配置的输出上限 128,000（MiniMax-M2.7），输入变大时会发生什么。
//   node labs/ch03/budget.mjs
import assert from "node:assert/strict";
import {
  CONFIGURED, WINDOW, budgetRows, compactionLimits, group, markdownTable, pinningRows, upstreamBudget,
} from "./scenarios.mjs";
import { BudgetResolver, dynamicMaxTokens } from "../../host/src/models.mjs";

console.log(`窗口 ${group(WINDOW)}，配置的输出上限 ${group(CONFIGURED)}。"动态预算"是真实上游的 resolveDynamicMaxTokens：\n`);
console.log(markdownTable(budgetRows()));

// host 的公式和真实上游，在一大片 (窗口, 输出上限, 输入) 的组合上逐个比较
let compared = 0;
for (const window of [32_000, 128_000, 200_000, 512_000, 1_000_000]) {
  for (const configured of [4_096, 16_384, 32_000, 128_000]) {
    for (let i = 0; i <= 40; i++) {
      const estimated = Math.floor((window * i) / 40);
      assert.equal(dynamicMaxTokens({ window, configured, estimated }), upstreamBudget(estimated, window, configured));
      compared += 1;
    }
  }
}
console.log(`\nhost 的 dynamicMaxTokens 在 ${compared} 个 (窗口, 输出上限, 输入) 组合上与真实函数逐个相等。`);

const resolver = new BudgetResolver();
const request = { messages: ["x".repeat(4 * 100_000)] };
const plain = resolver.resolve({}, request, { window: WINDOW, configuredMax: CONFIGURED });
const thinking = resolver.resolve({}, request, { window: WINDOW, configuredMax: CONFIGURED, thinking: 8_192 });
console.log(`\n同一个请求（估算 ${group(plain.input)} 令牌）：不开思考，maxTokens 是 ${group(plain.maxTokens)}；开 medium 思考（预算 8,192），maxTokens 是 ${group(thinking.maxTokens)}。Pi 的适配器会把 8,192 加回去，总量还是 ${group(thinking.maxTokens + 8_192)}。\n`);

console.log("一次逻辑调用内的重试共用一份预算。下面刻意在第一次失败之后给请求追加了 7 万令牌，看三次调用各用了多少：\n");
const pinning = pinningRows();
console.log(markdownTable(pinning));

assert.ok(compactionLimits.providerInputLimit === 181_568 && compactionLimits.automaticTriggerAt === 142_500);
assert.equal(plain.maxTokens, upstreamBudget(plain.input));
assert.equal(thinking.maxTokens + 8_192, plain.maxTokens);
assert.equal(pinning[0].使用的预算, pinning[1].使用的预算);
assert.notEqual(pinning[1].使用的预算, pinning[2].使用的预算);
assert.throws(() => new BudgetResolver().resolve({}, { messages: ["x".repeat(800)] }, { window: 100, configuredMax: 50 }), /exhausted/);
