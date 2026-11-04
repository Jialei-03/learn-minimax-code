// 第 3 章实验共用的场景和工具：键解析、凭证解析、输出预算、失败分类、重试、补丁、用量。
// 每个 labs/ch03/*.mjs 脚本和 labs/chapters/03-models.mjs 都从这里取数据，保证正文里的表格和回归检查是同一份。
//
// 凡是标着"真实上游"的列，都是 importSource 从固定提交里装载的 MiniMax Code 原文件算出来的：
//   packages/shared/src/llm-error-classifier.ts                      错误分类与重试判定
//   packages/agent-modules/context-manager/src/provider-budget.ts    输出预算公式、压缩触发线
//   packages/config/src/provider-auth-mode.ts                        官方账号 / API Key 的判定
//   packages/local-runtime-v2/.../session-system/usage/pi-usage.ts   用量落账
import { importSource } from "../../lab/source.mjs";
import {
  BudgetResolver,
  DEFAULT_RETRY_POLICY,
  UsageLedger,
  classifyError,
  composeModel,
  dynamicMaxTokens,
  estimateTokens,
  formatModelKey,
  parseModelKey,
  resolveAuthMode,
  resolveModel,
  retryDelayMs,
  scriptedKernel,
  usageRow,
  withRetry,
} from "../../host/src/models.mjs";

export const classifier = await importSource("packages/shared/src/llm-error-classifier.ts");
export const budgetSource = await importSource("packages/agent-modules/context-manager/src/provider-budget.ts");
export const authSource = await importSource("packages/config/src/provider-auth-mode.ts");
export const usageSource = await importSource("packages/local-runtime-v2/src/service/session-system/usage/pi-usage.ts");

/** 把对象数组转成 Markdown 表格文本。 */
export function markdownTable(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${keys.join(" | ")} |`,
    `| ${keys.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(" | ")} |`),
  ].join("\n");
}

export const group = (n) => Number(n).toLocaleString("en-US");
const seconds = (ms) => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
const yesNo = (value) => (value ? "重试" : "不重试");

// ─── 一、模型键 ─────────────────────────────────────────────────────────────

export const KEY_CASES = [
  "minimax/MiniMax-M3",
  "minimax_api/MiniMax-M2.7",
  "custom_provider:my-gateway/deepseek-ai/DeepSeek-V3",
  "custom_provider:/deepseek-ai/DeepSeek-V3",
  "MiniMax-M3",
  "provider/",
];

export function keyRows() {
  return KEY_CASES.map((key) => {
    const parsed = parseModelKey(key);
    return {
      配置里的键: `\`${key}\``,
      "朴素：split('/')[1]": `\`${key.split("/")[1]}\``,
      "provider": parsed ? `\`${parsed.providerId}\`` : "—",
      "model id": parsed ? `\`${parsed.modelId}\`` : "拒绝",
      来源: parsed ? parsed.source : "—",
    };
  });
}

// ─── 二、从键到凭证 ─────────────────────────────────────────────────────────

const MANAGED_URL = "https://agent.minimax.io/mavis/api/v1/llm/v1";

export function resolveConfig(overrides = {}) {
  return {
    minimaxModelSource: "token_plan",
    provider: { minimax: { options: { baseURL: MANAGED_URL } } },
    minimax_api: { apiKey: "sk-demo-minimax-api" },
    custom_provider: {
      "my-gateway": {
        api: "openai-completions",
        options: { apiKey: "sk-demo-gateway", baseURL: "https://gw.example.com/v1" },
        models: { "deepseek-ai/DeepSeek-V3": { limit: { context: 65_536, output: 8_192 } } },
      },
      "no-key": { options: { baseURL: "https://nokey.example.com/v1" }, models: { m: {} } },
    },
    ...overrides,
  };
}

export const RESOLVE_CASES = [
  { 场景: "已登录官方账号", key: "minimax/MiniMax-M3", auth: { accessToken: "token-demo" } },
  { 场景: "官方账号没登录", key: "minimax/MiniMax-M3", auth: {} },
  { 场景: "开关改道到自己的 API Key", key: "minimax/MiniMax-M3", config: { minimaxModelSource: "minimax_api_key" } },
  { 场景: "MiniMax API Key", key: "minimax_api/MiniMax-M2.7" },
  { 场景: "自定义网关，模型 id 带斜杠", key: "custom_provider:my-gateway/deepseek-ai/DeepSeek-V3" },
  { 场景: "网关里没有这个模型", key: "custom_provider:my-gateway/ghost-model", auth: { accessToken: "token-demo" } },
  { 场景: "网关配了但没填 key", key: "custom_provider:no-key/m" },
  { 场景: "整个 provider 被删了", key: "custom_provider:ghost/m", auth: { accessToken: "token-demo" } },
  { 场景: "认不出的 provider", key: "acme/model" },
];

const mask = (key) => `${key.slice(0, 3)}***`;

/** 解析一个场景。成功返回 { resolved }，失败返回 { error }。 */
export function resolveCase(testCase) {
  try {
    return { resolved: resolveModel(resolveConfig(testCase.config), testCase.key, testCase.auth ?? {}) };
  } catch (error) {
    return { error: error.message };
  }
}

export function resolveRows() {
  return RESOLVE_CASES.map((testCase) => {
    const { resolved, error } = resolveCase(testCase);
    if (error) return { 场景: testCase.场景, 键: `\`${testCase.key}\``, 路线: "—", 地址: "—", 凭证: "—", "窗口 / 输出上限": "—", 结果: `报错：${error}` };
    const credential = resolved.headers?.Authorization
      ? `登录令牌（api key 只是占位符 ${resolved.apiKey}）`
      : `用户配置的 key（${mask(resolved.apiKey)}）`;
    return {
      场景: testCase.场景,
      键: `\`${testCase.key}\``,
      路线: resolved.route,
      地址: new URL(resolved.baseUrl).host,
      凭证: credential,
      "窗口 / 输出上限": `${group(resolved.contextWindow)} / ${group(resolved.maxTokens)}`,
      结果: resolved.warning ? `回退：${resolved.warning}` : "正常",
    };
  });
}

export const AUTH_CASES = [
  { baseURL: MANAGED_URL },
  { baseURL: "https://agent.minimax.cn/mavis/api/v1/llm/v1" },
  { baseURL: "https://user:pw@agent.minimax.io/mavis/api/v1/llm/v1" },
  { baseURL: "https://relay.example.com/v1" },
  { baseURL: "https://relay.example.com/v1", authMode: "managed-login" },
  { baseURL: MANAGED_URL, authMode: "api-key" },
];

export function authRows() {
  return AUTH_CASES.map((input) => {
    const upstream = authSource.resolveProviderAuthMode(input);
    const host = resolveAuthMode(input);
    return {
      地址: new URL(input.baseURL).origin.replace("https://", "") + (new URL(input.baseURL).username ? "（带用户名密码）" : ""),
      显式配置: input.authMode ?? "—",
      "真实上游判定": `${upstream.authMode}（${upstream.source}）`,
      "host 判定": `${host.authMode}（${host.source}）`,
      一致: upstream.authMode === host.authMode && upstream.source === host.source && upstream.managedBaseURL === host.managedBaseURL ? "是" : "否",
    };
  });
}

// ─── 三、输出预算 ───────────────────────────────────────────────────────────

export const WINDOW = 200_000; // MiniMax-M2.7 的上下文窗口
export const CONFIGURED = 128_000; // MiniMax-M2.7 的输出上限

/** 真实的压缩预算：输入硬上限和自动压缩触发线（第 6 章细讲）。 */
export const compactionLimits = budgetSource.resolveCompactionTokenBudget({
  contextWindow: WINDOW,
  configuredMaxOutputTokens: CONFIGURED,
});

export function upstreamBudget(estimated, window = WINDOW, configured = CONFIGURED) {
  return budgetSource.resolveDynamicMaxTokens({ contextWindow: window, configuredMaxTokens: configured, estimatedContextTokens: estimated });
}

export function budgetRows() {
  const { providerInputLimit, automaticTriggerAt } = compactionLimits;
  const points = [
    [10_000, ""],
    [70_000, "输入开始挤占输出"],
    [100_000, ""],
    [automaticTriggerAt, "自动压缩的触发线"],
    [170_000, ""],
    [providerInputLimit, "输入硬上限，输出触底"],
    [190_000, "触底之后不再收缩"],
  ];
  return points.map(([estimated, note]) => {
    const upstream = upstreamBudget(estimated);
    const host = dynamicMaxTokens({ window: WINDOW, configured: CONFIGURED, estimated });
    return {
      输入令牌: group(estimated),
      "固定 128,000 时，输入 + 输出": group(estimated + CONFIGURED),
      超出窗口: estimated + CONFIGURED > WINDOW ? "是" : "否",
      "动态预算（真实上游）": group(upstream),
      "host 的结果": group(host),
      说明: note,
    };
  });
}

/** 一次逻辑调用内的重试用同一个 identity；一条新的用户消息是新的 identity。 */
export function pinningRows() {
  const request = { messages: ["x".repeat(4 * 100_000)] };
  const resolver = new BudgetResolver();
  const options = { window: WINDOW, configuredMax: CONFIGURED };
  const logical = {};
  const row = (调用, identity, budget) => ({
    调用,
    identity,
    此刻请求的估算大小: group(estimateTokens(request)),
    使用的预算: group(budget.maxTokens),
  });
  const rows = [];
  rows.push(row("第一次请求", "A", resolver.resolve(logical, request, options)));
  request.messages.push("y".repeat(4 * 70_000)); // 第一次失败之后，有人往上下文里追加了 7 万令牌
  rows.push(row("同一次逻辑调用的重试（请求已变大）", "A", resolver.resolve(logical, request, options)));
  rows.push(row("下一次逻辑调用（同样的大请求）", "B", resolver.resolve({}, request, options)));
  return rows;
}

// ─── 四、失败分类 ───────────────────────────────────────────────────────────

export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const named = (name, message) => Object.assign(new Error(message), { name });

export const ERROR_SAMPLES = [
  { 错误: "529 服务过载", error: httpError(529, "overloaded_error") },
  { 错误: "429 限流", error: httpError(429, "rate limit exceeded") },
  { 错误: "429 + 供应商码 2045（TPM 限流）", error: httpError(429, "request failed (2045): too many tokens per minute") },
  { 错误: "连接被重置 ECONNRESET", error: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) },
  { 错误: "首包超时", error: named("TimeoutError", "LLM request timed out: no response from the provider within 300000ms") },
  { 错误: "500 服务器内部错误", error: httpError(500, "Internal server error") },
  { 错误: "502 网关错误", error: httpError(502, "Bad gateway") },
  { 错误: "401 key 无效", error: httpError(401, "invalid api key") },
  { 错误: "402 余额不足", error: httpError(402, "payment required") },
  { 错误: "套餐用量用完（2056）", error: new Error("usage limit exceeded (2056)") },
  { 错误: "模型拒答", error: new Error("Model declined the request (stop_reason: refusal; category: cyber): I can't help with that") },
  { 错误: "400 invalid_request_error", error: httpError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"bad field"}}') },
  { 错误: "413 请求太大", error: httpError(413, "Request Entity Too Large") },
  { 错误: "上下文溢出（2013）", error: httpError(400, "invalid params, context window exceeds limit (2013)") },
  { 错误: "图片数量超限", error: httpError(400, "Too many images in request: 31 > 30") },
  { 错误: "用户取消", error: named("AbortError", "Request was aborted") },
  { 错误: "流被截断，没有 stop_reason", error: new Error("Anthropic stream ended without stop_reason (messageDeltaCount=0; rawEventCount=429; messageEventCount=12; lastEventAtMs=1008; eofAtMs=2066)") },
  { 错误: "认不出的错误", error: new Error("something odd") },
];

/** 真实上游对一个错误的判定：官方账号、BYOK 各自重不重试。 */
export function upstreamDecision(error) {
  const normalized = classifier.normalizeLLMError({ raw: error });
  return {
    kind: classifier.toLLMMetricErrorKind(normalized.facts),
    managed: classifier.toLLMRetryDecision(normalized).retryable,
    // llm-retry.ts 的 failureResult：BYOK 输出之前的失败几乎都重试，除了取消、拒答和"重发也一样被拒"
    byok:
      !normalized.facts.explicitAbort &&
      !normalized.facts.signals.has("refusal") &&
      !classifier.isLLMDeterministicRequestRejection(normalized),
  };
}

export function errorRows() {
  return ERROR_SAMPLES.map(({ 错误, error }) => {
    const upstream = upstreamDecision(error);
    const host = { managed: classifyError(error), byok: classifyError(error, { byok: true }) };
    return {
      错误,
      分类: upstream.kind,
      "官方账号": yesNo(upstream.managed),
      BYOK: yesNo(upstream.byok),
      "host 一致": host.managed.kind === upstream.kind && host.managed.retryable === upstream.managed && host.byok.retryable === upstream.byok ? "是" : "否",
    };
  });
}

// ─── 五、重试：同一批故障，四种策略 ─────────────────────────────────────────

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms) => void (time += ms),
    sleep: async (ms) => void (time += ms),
  };
}

/** 朴素重试：任何错误都重试 5 次，固定等 1 秒，不管用户有没有看到输出。 */
function naiveRetry(kernel, clock) {
  return async (request, signal, outer) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await kernel(request, signal, outer);
      } catch (error) {
        if (attempt > 5) throw error;
        await clock.sleep(1_000);
      }
    }
  };
}

const ok = (text) => (request, signal, call) => {
  call?.emit({ type: "start" });
  call?.emit({ type: "text", delta: text });
  return { text };
};

export const RETRY_SCENARIOS = [
  {
    名称: "连续两次 529（响应头之后才报错），第三次成功",
    script: () => [
      (r, s, call) => (call?.emit({ type: "start" }), Promise.reject(httpError(529, "overloaded_error"))),
      (r, s, call) => (call?.emit({ type: "start" }), Promise.reject(httpError(529, "overloaded_error"))),
      ok("已修好"),
    ],
  },
  {
    名称: "401：key 无效",
    script: () => Array.from({ length: 8 }, () => () => Promise.reject(httpError(401, "invalid api key"))),
  },
  {
    名称: "说了半句话，连接断了",
    script: () => [
      (r, s, call) => {
        call?.emit({ type: "start" });
        call?.emit({ type: "text", delta: "我先看看" });
        return Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      },
      ok("我先看看入口文件。"),
    ],
  },
  {
    名称: "每次都等满 300 秒才超时",
    script: (clock) =>
      Array.from({ length: 8 }, () => () => {
        clock.advance(300_000);
        return Promise.reject(named("TimeoutError", "LLM request timed out: no response from the provider within 300000ms"));
      }),
  },
  {
    名称: "自定义网关偶尔返回 500",
    script: () => [
      () => Promise.reject(httpError(500, "Internal server error")),
      () => Promise.reject(httpError(500, "Internal server error")),
      ok("已修好"),
    ],
  },
];

export const RETRY_POLICIES = ["不重试", "朴素重试", "官方账号", "BYOK"];

/** 用一种策略跑一个场景（虚拟时钟，瞬间完成）。 */
export async function runRetryScenario(scenario, policy, policyOptions = {}) {
  const clock = fakeClock();
  let calls = 0;
  const screen = [];
  const events = [];
  const script = scenario.script(clock).map((step) => (...args) => (calls++, step(...args)));
  const kernel = scriptedKernel(script);
  const common = { sleep: clock.sleep, now: clock.now, random: () => 0.5, observe: (event) => events.push(event), ...policyOptions };
  const model = {
    不重试: kernel,
    朴素重试: naiveRetry(kernel, clock),
    官方账号: withRetry(kernel, { byok: false, ...common }),
    BYOK: withRetry(kernel, { byok: true, ...common }),
  }[policy];
  let outcome;
  try {
    await model({ messages: [] }, undefined, { emit: (event) => event.type === "text" && screen.push(event.delta) });
    outcome = "成功";
  } catch (error) {
    outcome = `失败（${classifyError(error).kind}）`;
  }
  return { calls, elapsedMs: clock.now(), screen: screen.join(""), outcome, events };
}

export async function retryMatrix() {
  const matrix = [];
  for (const scenario of RETRY_SCENARIOS) {
    const cells = {};
    for (const policy of RETRY_POLICIES) cells[policy] = await runRetryScenario(scenario, policy);
    matrix.push({ scenario, cells });
  }
  return matrix;
}

export const cellText = (cell) => `${cell.calls} 次请求 · ${seconds(cell.elapsedMs)} · ${cell.outcome}`;

export function backoffRows() {
  const policy = DEFAULT_RETRY_POLICY;
  const rows = [1, 2, 3, 4, 5].map((attempt) => ({
    第几次重试: attempt,
    "最短等待": seconds(retryDelayMs(undefined, attempt, policy, () => 0)),
    "最长等待": seconds(retryDelayMs(undefined, attempt, policy, () => 1)),
  }));
  rows.push({ 第几次重试: "服务端要求 45 秒（Retry-After）", 最短等待: seconds(retryDelayMs(45_000, 1)), 最长等待: seconds(retryDelayMs(45_000, 1)) });
  return rows;
}

// ─── 六、内核补丁与措辞约定 ─────────────────────────────────────────────────

export const PATCH_SAMPLES = [
  {
    补丁: "没有 stop_reason 的流",
    措辞: "MiniMax 补丁的原话",
    message: "Anthropic stream ended without stop_reason (messageDeltaCount=0; rawEventCount=429; messageEventCount=12; lastEventAtMs=1008; eofAtMs=2066)",
  },
  {
    补丁: "没有 stop_reason 的流",
    措辞: "同样的诊断数字，措辞改成别的（假设）",
    message: "Anthropic stream ended abruptly (messageDeltaCount=0; rawEventCount=429; messageEventCount=12; lastEventAtMs=1008; eofAtMs=2066)",
  },
  {
    补丁: "没有 stop_reason 的流",
    措辞: "Pi v1.5.0 的措辞",
    message: "Anthropic stream ended without a stop reason",
  },
  {
    补丁: "拒答详情",
    措辞: "MiniMax 补丁的原话",
    message: "Model declined the request (stop_reason: refusal; category: cyber): I can't help with that",
  },
  {
    补丁: "拒答详情",
    措辞: "补丁的措辞，解释里碰巧有故障词",
    message: "Model declined the request (stop_reason: refusal): this looks like a 429 rate limit, then timed out, ECONNRESET",
  },
  {
    补丁: "拒答详情",
    措辞: "没有标记，解释里碰巧有 timed out（假设）",
    message: "Model declined the request: the earlier build timed out",
  },
  {
    补丁: "拒答详情",
    措辞: "Pi v1.5.0 的措辞",
    message: "The model refused to complete the request",
  },
];

export function patchRows() {
  return PATCH_SAMPLES.map((sample) => {
    const upstream = upstreamDecision(new Error(sample.message));
    return {
      补丁: sample.补丁,
      措辞: sample.措辞,
      "真实分类器的判定": upstream.kind,
      官方账号: yesNo(upstream.managed),
      BYOK: yesNo(upstream.byok),
    };
  });
}

// ─── 七、用量 ───────────────────────────────────────────────────────────────

export const USAGE_MODEL_KEY = "custom_provider:my-gateway/deepseek-ai/DeepSeek-V3";

export const USAGE_MESSAGES = [
  { role: "user", content: "把失败的测试修好" },
  { role: "assistant", timestamp: 1000, usage: { input: 1200, output: 80, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.0021 } } },
  { role: "assistant", timestamp: 2000, usage: { total_tokens: 900 } },
  { role: "assistant", timestamp: 3000 },
  { role: "assistant", timestamp: 4000, usage: { input: 0, output: 0 } },
  { role: "assistant", timestamp: 5000, usage: { input: 300, output: 40, reasoning: 25, cache: { read: 200, write: 50 } } },
];

/** 用真实的 recordCommittedPiUsage 给一串消息落账。 */
export async function recordWithUpstream() {
  const rows = [];
  const recorded = await usageSource.recordCommittedPiUsage({
    store: { append: async (row) => void rows.push(row) },
    session: { sessionId: "s1", agentName: "main" },
    turnId: "t1",
    model: USAGE_MODEL_KEY,
    nowMs: () => 9_999,
    messages: USAGE_MESSAGES,
  });
  return { recorded, rows, goal: usageSource.summarizeCommittedPiGoalUsage(USAGE_MESSAGES) };
}

/** host 的 usageRow 与真实 recordCommittedPiUsage 落下的行，逐条消息比较。返回 [样本数, 不一致数]。 */
export async function compareUsage() {
  const { rows } = await recordWithUpstream();
  const assistants = USAGE_MESSAGES.filter((message) => message.role === "assistant");
  const fields = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"];
  let different = 0;
  for (const message of assistants) {
    const upstream = rows.find((row) => row.ts === message.timestamp);
    const host = usageRow(message.usage);
    const same = upstream === undefined ? host === undefined : host !== undefined && fields.every((field) => host[field] === upstream[field]);
    if (!same) different += 1;
  }
  return [assistants.length, different];
}

export const USAGE_NOTES = ["有 usage", "只给 total_tokens", "没有 usage", "usage 全是 0", "cache 嵌套写法，带思考令牌"];

/** 重试成功的调用，经过 composeModel 之后在用量表里留下几行？ */
export async function usageThroughRetry({ failures = 2, succeed = true } = {}) {
  const clock = fakeClock();
  const ledger = new UsageLedger();
  const steps = Array.from({ length: failures }, () => () => Promise.reject(httpError(529, "overloaded_error")));
  if (succeed) steps.push(() => ({ text: "已修好", usage: { input: 1200, output: 80, cacheRead: 1000 } }));
  let calls = 0;
  const resolved = resolveModel(resolveConfig(), USAGE_MODEL_KEY);
  const model = composeModel(
    scriptedKernel(steps.map((step) => (...args) => (calls++, step(...args)))),
    resolved,
    { ledger, sessionId: "s1", turnId: "t1", retry: { sleep: clock.sleep, now: clock.now, random: () => 0.5 } },
  );
  let outcome = "成功";
  try {
    await model({ messages: [] });
  } catch {
    outcome = "失败";
  }
  return { calls, outcome, ledger, resolved };
}

export { formatModelKey, estimateTokens, resolveModel };
