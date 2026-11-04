// 实验：同一份配置，九个模型键会走到哪条路、拿到什么凭证。
//   node labs/ch03/resolve.mjs
import assert from "node:assert/strict";
import { RESOLVE_CASES, authRows, markdownTable, resolveCase, resolveRows } from "./scenarios.mjs";

console.log("官方账号的令牌、一把 MiniMax API Key、一个自定义网关，都配在同一份配置里：\n");
console.log(markdownTable(resolveRows()));

console.log("\n\"这个地址是不是官方账号\"由 resolveProviderAuthMode 判断。左边是从固定提交装载的真实函数，右边是 host 的版本：\n");
const auth = authRows();
console.log(markdownTable(auth));

const byScenario = Object.fromEntries(RESOLVE_CASES.map((c) => [c.场景, resolveCase(c)]));
assert.equal(byScenario["已登录官方账号"].resolved.route, "token_plan");
assert.match(byScenario["已登录官方账号"].resolved.headers.Authorization, /^Bearer /);
assert.equal(byScenario["开关改道到自己的 API Key"].resolved.route, "minimax_api_key");
assert.equal(byScenario["自定义网关，模型 id 带斜杠"].resolved.modelId, "deepseek-ai/DeepSeek-V3");
assert.match(byScenario["网关里没有这个模型"].resolved.warning, /回退/);
assert.match(byScenario["官方账号没登录"].error, /令牌/);
assert.match(byScenario["认不出的 provider"].error, /api_key/);
assert.ok(auth.every((row) => row.一致 === "是"));
