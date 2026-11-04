// 实验：host 的模型层和真实上游函数逐项对照。左列是 MiniMax Code 的原文件（importSource 装载），右列是 host 的版本。
//   node labs/ch03/compare.mjs
import assert from "node:assert/strict";
import {
  ERROR_SAMPLES, authRows, compareUsage, errorRows, markdownTable, upstreamBudget,
} from "./scenarios.mjs";
import { dynamicMaxTokens } from "../../host/src/models.mjs";

let budgetSamples = 0;
let budgetDifferent = 0;
for (const window of [32_000, 128_000, 200_000, 512_000, 1_000_000]) {
  for (const configured of [4_096, 16_384, 32_000, 128_000]) {
    for (let i = 0; i <= 40; i++) {
      const estimated = Math.floor((window * i) / 40);
      budgetSamples += 1;
      if (dynamicMaxTokens({ window, configured, estimated }) !== upstreamBudget(estimated, window, configured)) budgetDifferent += 1;
    }
  }
}
const auth = authRows();
const errors = errorRows();
const [usageSamples, usageDifferent] = await compareUsage();

const rows = [
  { 对照项: "输出预算", 上游文件: "provider-budget.ts 的 resolveDynamicMaxTokens", host: "dynamicMaxTokens", 样本数: budgetSamples, 不一致: budgetDifferent },
  { 对照项: "官方账号的判定", 上游文件: "provider-auth-mode.ts 的 resolveProviderAuthMode", host: "resolveAuthMode", 样本数: auth.length, 不一致: auth.filter((row) => row.一致 !== "是").length },
  { 对照项: "错误分类和两种重试判定", 上游文件: "llm-error-classifier.ts 的 normalizeLLMError / toLLMRetryDecision", host: "classifyError", 样本数: ERROR_SAMPLES.length, 不一致: errors.filter((row) => row["host 一致"] !== "是").length },
  { 对照项: "用量落账", 上游文件: "pi-usage.ts 的 recordCommittedPiUsage", host: "usageRow", 样本数: usageSamples, 不一致: usageDifferent },
];
console.log(markdownTable(rows));
assert.ok(rows.every((row) => row.不一致 === 0));
