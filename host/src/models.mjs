// 第 3 章：模型 —— 一次模型调用之前、之中、之后，产品要做的事。
//
// 对应 MiniMax Code 0.7.2 的五处代码：
//   1. local-runtime-v2/src/service/model-system/resolution/model-key.ts
//        模型键 "provider/modelId" 的解析：只认第一个斜杠；provider 有三种来源。
//   2. .../resolution/local-model-resolver.ts、model-resolver-byok.ts、config/src/provider-auth-mode.ts
//        键 → 凭证、地址、上下文窗口、输出上限：官方账号 / MiniMax API Key / 自定义 Provider 三条路。
//   3. .../resolution/dynamic-max-tokens.ts 与 agent-modules/context-manager/src/provider-budget.ts
//        输出上限随输入变大而收缩；同一次逻辑调用的所有重试共用同一份预算。
//   4. agent-core/src/pi-turn-runner/llm-retry.ts、llm-stream-timeout.ts 与 shared/src/llm-error-classifier.ts
//        失败分类、重试（次数、退避、提交边界）、首包与空闲两个看门狗。
//   5. local-runtime-v2/src/service/session-system/usage/pi-usage.ts
//        每条提交的 assistant 消息落一行用量。
//
// host 里的"模型"是一个函数 kernel(request, signal, call) → Promise<reply>：
//   request  { system, messages, tools, maxTokens? }
//   reply    { text, calls, stop, usage? }
//   call     { identity, attempt, emit }：由 withRetry 创建，一路往下传
//   emit(event)  模型"流出"一个事件：{ type: "start" }（响应头到了）、{ type: "text", delta }、{ type: "tool_call" }
// 第 2 章的 runTurn 只传前两个参数，所以不带 call 的老用法完全不受影响。
//
// 包装函数的嵌套顺序和上游一致（composeModel 里能看到）：
//   用量(最外) → 重试 → 看门狗 → 预算 → 模型本身(最内)
//
// 简化：
//   - 上游的模型是 Pi 的流式 StreamFn，host 的模型是一个返回整条回复的函数，流式事件通过 emit 回调表达。
//   - 令牌估算按"字符数 / 4"，上游用 gpt-tokenizer；错误分类只认平铺的 status / code / message，
//     上游还会顺着 cause / responseBody 往里找。

// ─── 1. 模型键 ──────────────────────────────────────────────────────────────

export const MANAGED_PROVIDER = "minimax"; // 官方账号（Token Plan）的 provider
export const MINIMAX_API_PROVIDER = "minimax_api"; // 用户自己的 MiniMax API Key
export const CUSTOM_PROVIDER_PREFIX = "custom_provider:"; // 任意第三方网关

/** providerId 属于哪一种来源？对应 model-key.ts 的 parseProviderId。 */
export function parseProviderId(providerId) {
  if (!providerId) return undefined;
  if (providerId === MINIMAX_API_PROVIDER) {
    return { source: "minimax_api", providerId, providerKey: providerId };
  }
  if (providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    const providerKey = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
    return providerKey ? { source: "custom_provider", providerId, providerKey } : undefined;
  }
  return { source: "provider", providerId, providerKey: providerId };
}

/**
 * "provider/modelId" → { source, providerId, providerKey, modelId }。
 * 只认第一个斜杠：模型 id 自己可以带斜杠（deepseek-ai/DeepSeek-V3），它们属于 modelId。
 * 任何一侧为空都返回 undefined，不替用户猜一个默认归属。
 */
export function parseModelKey(raw) {
  if (typeof raw !== "string") return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  const provider = parseProviderId(raw.slice(0, slash));
  if (!provider) return undefined;
  return { ...provider, modelId: raw.slice(slash + 1) };
}

/** parseModelKey 的逆运算。用量表里的 model 字段就是这样拼出来的，所以能按原键分组。 */
export function formatModelKey(providerId, modelId) {
  return `${providerId}/${modelId}`;
}

// ─── 2. 解析：键 → 凭证、地址、限额 ─────────────────────────────────────────

// 官方模型目录里本章用到的两条（packages/config/src/minimax-model-catalog.ts）。
const MINIMAX_CATALOG = {
  "MiniMax-M3": { context: 512_000, output: 128_000 },
  "MiniMax-M2.7": { context: 200_000, output: 128_000 },
};
const MANAGED_FALLBACK_LIMITS = { context: 200_000, output: 128_000 }; // 目录里查不到的官方模型
const BYOK_FALLBACK_LIMITS = { context: 200_000, output: 16_384 }; // 用户自己的 Provider 没声明限额时
const MANAGED_API_KEY_PLACEHOLDER = "sk-xxx"; // 官方账号走令牌，不走 api key；占位符只是为了让请求结构完整
const MANAGED_HOSTS = ["agent.minimax.io", "agent.minimax.cn", "agent.minimaxi.com"];
const KNOWN_APIS = ["anthropic-messages", "openai-completions", "openai-responses", "google-generative-ai"];

/** 地址是不是官方账号的地址？带用户名密码的 URL 不算（它的真实授权方不明）。 */
export function isManagedBaseUrl(baseURL) {
  try {
    const url = new URL(baseURL);
    if (url.username || url.password) return false;
    return MANAGED_HOSTS.some((host) => url.origin === `https://${host}`);
  } catch {
    return false;
  }
}

/** 对应 resolveProviderAuthMode：显式配置优先，其次看地址，默认当作 api-key。 */
export function resolveAuthMode({ authMode, baseURL } = {}) {
  const managedBaseURL = Boolean(baseURL) && isManagedBaseUrl(baseURL);
  if (["managed-login", "api-key", "oauth"].includes(authMode)) {
    return { authMode, source: "explicit", managedBaseURL };
  }
  if (managedBaseURL) return { authMode: "managed-login", source: "inferred-managed-base-url", managedBaseURL };
  return { authMode: "api-key", source: "default-api-key", managedBaseURL };
}

/**
 * 把一个模型键解析成一次请求要用的全部材料。对应 LocalModelResolver.resolveModel。
 *   config  { minimaxModelSource, provider, minimax_api, custom_provider }（形状同上游的 config.yaml）
 *   auth    { accessToken }：用户登录官方账号后拿到的令牌
 * 路线（route）：token_plan（官方账号）、minimax_api、minimax_api_key（官方键被开关改道）、custom_provider。
 */
export function resolveModel(config, key, auth = {}) {
  const parsed = parseModelKey(key);
  if (!parsed) throw Error(`模型键不合法：${JSON.stringify(key)}`);

  // 先按来源找 BYOK 方案；找不到（配置被删了）就回退到内置的第一个官方模型，并留下一条警告。
  const selected = selectModel(config, parsed);
  // 官方键本身也可能被"模型来源"开关改道到用户自己的 MiniMax API Key。
  const chosen = selected.plan
    ? selected
    : { ...selected, ...selectMinimaxApiSwitch(config, selected.identity) };
  if (chosen.plan) return finishResolve({ key, ...chosen, byok: true });

  // 都不是 BYOK：走官方账号。
  const plan = managedPlan(config, chosen.identity, auth);
  const { identity, warning } = chosen;
  return finishResolve({ key, identity, plan, route: plan.route, byok: false, warning });
}

function selectModel(config, parsed) {
  if (parsed.source === "provider") return { identity: parsed };
  const plan =
    parsed.source === "minimax_api"
      ? planMinimaxApi(config, parsed.modelId)
      : planCustomProvider(config, parsed);
  if (plan) return { identity: parsed, plan, route: parsed.source };
  // 配置被删了：回退到内置的第一个官方模型，让会话还能继续，同时留下警告。
  const fallback = firstBuiltinModel(config);
  if (!fallback) throw Error(`provider "${parsed.providerId}" 没有配置，也没有可回退的内置模型`);
  const to = formatModelKey(fallback.providerId, fallback.modelId);
  return { identity: fallback, warning: `${parsed.providerId} 找不到，回退到 ${to}` };
}

function selectMinimaxApiSwitch(config, identity) {
  if (identity.providerId !== MANAGED_PROVIDER || config.minimaxModelSource !== "minimax_api_key") return {};
  const plan = planMinimaxApi(config, identity.modelId);
  return plan ? { plan, route: "minimax_api_key" } : {};
}

function firstBuiltinModel(config) {
  const modelId = Object.keys(config.provider?.[MANAGED_PROVIDER]?.models ?? MINIMAX_CATALOG)[0];
  if (!modelId) return undefined;
  return { source: "provider", providerId: MANAGED_PROVIDER, providerKey: MANAGED_PROVIDER, modelId };
}

/** 用户自己的 MiniMax API Key。没有 minimax_api 这一段配置就返回 undefined；有这一段却没填 key 是配置错误。 */
function planMinimaxApi(config, modelId) {
  const section = config.minimax_api;
  if (!section) return undefined;
  if (!section.apiKey?.trim()) throw Error("minimax_api 的 apiKey 没有配置");
  const catalog = MINIMAX_CATALOG[modelId];
  return {
    providerId: MINIMAX_API_PROVIDER,
    api: "anthropic-messages",
    apiKey: section.apiKey.trim(),
    baseUrl: section.baseURL?.trim() || "https://api.minimax.io/anthropic",
    contextWindow: catalog?.context ?? BYOK_FALLBACK_LIMITS.context,
    maxTokens: catalog?.output ?? BYOK_FALLBACK_LIMITS.output,
  };
}

/** 自定义 Provider。provider 或模型没有配置（或被禁用）返回 undefined；配置了却缺 key / 地址就报错。 */
function planCustomProvider(config, parsed) {
  const provider = config.custom_provider?.[parsed.providerKey];
  const model = provider?.models?.[parsed.modelId];
  if (!provider || provider.enabled === false || !model) return undefined;
  const apiKey = provider.options?.apiKey?.trim();
  if (!apiKey) throw Error(`provider "${parsed.providerId}" 的 api_key 没有配置`);
  const baseUrl = provider.options?.baseURL?.trim();
  if (!baseUrl) throw Error(`provider "${parsed.providerId}" 的 base_url 没有配置`);
  return {
    providerId: parsed.providerId,
    api: KNOWN_APIS.includes(provider.api) ? provider.api : "anthropic-messages",
    apiKey,
    baseUrl,
    contextWindow: model.limit?.context ?? BYOK_FALLBACK_LIMITS.context,
    maxTokens: model.limit?.output ?? BYOK_FALLBACK_LIMITS.output,
  };
}

/** 官方账号：api key 只是占位符，真正的凭证是登录令牌，放在 Authorization 头里。 */
function managedPlan(config, identity, auth) {
  const options = config.provider?.[identity.providerId]?.options;
  const mode = resolveAuthMode({ authMode: options?.authMode, baseURL: options?.baseURL });
  const apiKey = options?.apiKey?.trim() || (mode.authMode === "managed-login" ? MANAGED_API_KEY_PLACEHOLDER : undefined);
  const token = auth.accessToken?.trim();
  const provider = identity.providerId;
  if (!apiKey) throw Error(`provider "${provider}" 的 api_key 没有配置`);
  if (!options?.baseURL) throw Error(`provider "${provider}" 的 base_url 没有配置`);
  if (mode.authMode === "managed-login" && !mode.managedBaseURL) {
    throw Error(`managed-login 需要官方账号的地址，provider "${provider}" 的地址不是`);
  }
  if (mode.authMode === "managed-login" && apiKey === MANAGED_API_KEY_PLACEHOLDER && !token) {
    throw Error(`官方账号的令牌还没有同步（provider "${provider}"），先登录`);
  }
  const limits = MINIMAX_CATALOG[identity.modelId] ?? MANAGED_FALLBACK_LIMITS;
  return {
    providerId: provider,
    api: "anthropic-messages",
    apiKey,
    headers: mode.authMode === "managed-login" ? { Authorization: `Bearer ${token}` } : undefined,
    baseUrl: options.baseURL,
    contextWindow: limits.context,
    maxTokens: limits.output,
    route: { "managed-login": "token_plan", oauth: "oauth", "api-key": "provider_api_key" }[mode.authMode],
  };
}

function finishResolve({ key, identity, plan, route, byok, warning }) {
  return {
    key,
    route,
    byok,
    provider: plan.providerId,
    modelId: identity.modelId,
    api: plan.api,
    baseUrl: plan.baseUrl,
    apiKey: plan.apiKey,
    headers: plan.headers,
    contextWindow: plan.contextWindow,
    maxTokens: plan.maxTokens,
    ...(warning ? { warning } : {}),
  };
}

// ─── 3. 输出预算 ────────────────────────────────────────────────────────────

const OUTPUT_FLOOR = 16_384; // 输出预算的地板，也是压缩触发线预留的输出空间（reserveTokens）
const SAFETY_MARGIN = 2_048; // 估算有误差，留一点余量
const MIN_OUTPUT_AFTER_THINKING = 1_024; // 扣掉思考预算之后，至少还要给正文留 1024

/** 用字符数粗略估算请求占用的令牌。只用来让预算公式有输入，不是 tokenizer。 */
export function estimateTokens(request) {
  return Math.ceil(JSON.stringify(request).length / 4);
}

/**
 * 输出上限 = min(配置的上限, max(地板, 窗口里还剩多少))。
 * 输入小的时候等于配置值；输入变大，输出被挤小；挤到地板就不再往下，
 * 再大的输入要靠压缩来解决，而不是继续压输出。对应 resolveDynamicMaxTokens。
 */
export function dynamicMaxTokens({ window, configured, estimated }) {
  const floor = Math.min(configured, OUTPUT_FLOOR);
  const remaining = window - estimated - SAFETY_MARGIN;
  return Math.min(configured, Math.max(floor, remaining));
}

/**
 * 一次逻辑调用算一次预算。identity 是这次调用的身份对象（withRetry 创建，所有物理重试共用）：
 * 同一个 identity 第二次来，直接拿回第一次算好的预算，不再看请求；新的调用换新的 identity，重新算。
 * 对应 withLocalDynamicMaxTokens 里以 LLM_RETRY_CALL_IDENTITY 为键的 WeakMap。
 */
export class BudgetResolver {
  constructor() {
    this.pinned = new WeakMap();
  }

  resolve(identity, request, { window, configuredMax = 512, thinking = 0 }) {
    const pinned = this.pinned.get(identity);
    if (pinned) return pinned;
    if (thinking < 0) throw Error("thinking budget must not be negative");
    const budget = Object.freeze(this.compute(request, { window, configuredMax, thinking }));
    this.pinned.set(identity, budget);
    return budget;
  }

  compute(request, { window, configuredMax, thinking }) {
    let input;
    try {
      input = estimateTokens(request);
    } catch {
      // 估算本身出了问题：只要 1 个令牌并关掉思考，宁可让这次请求很快地失败，也不发一个没有边界的请求。
      return { input: NaN, maxTokens: 1, thinking: 0, shrunk: true, disableReasoning: true };
    }
    // host 的准入检查：输入本身就塞不进窗口，不必发给模型。上游把这件事交给压缩和请求准入。
    if (input >= window) throw Error("request budget exhausted");
    const desired = dynamicMaxTokens({ window, configured: configuredMax, estimated: input });
    const shrunk = desired < configuredMax;
    // Pi 的 Anthropic 适配器会把思考预算加回 maxTokens，所以收缩时要先扣掉，加回来之后总量才等于 desired。
    const maxTokens = shrunk ? Math.max(MIN_OUTPUT_AFTER_THINKING, desired - thinking) : configuredMax;
    return { input, maxTokens, thinking, shrunk, disableReasoning: false };
  }
}

/** 给模型套上预算：请求发出前，把算好的 maxTokens 写进请求。 */
export function withBudget(kernel, { resolver = new BudgetResolver(), window, configuredMax, thinking = 0 }) {
  return (request, signal, call = {}) => {
    // 没有重试层时没有 identity，每次调用都是新的一次，每次都重新算。
    const budget = resolver.resolve(call.identity ?? {}, request, { window, configuredMax, thinking });
    return kernel({ ...request, maxTokens: budget.maxTokens }, signal, call);
  };
}

// ─── 4. 失败分类 ────────────────────────────────────────────────────────────

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNABORTED"]);
const REFUSAL = /\bstop_reason:\s*refusal\b/i; // 内核补丁约定的拒答标记
const INCOMPLETE_STREAM = /\bstream ended without stop_reason\b/; // 内核补丁约定的"流被截断"标记
const CREDITS = /\b(?:1400010161|1008)\b|credits?\s+exhausted|insufficient\s+balance/i;
const USAGE_LIMIT = /\b(?:2056|2067)\b|usage[_\s-](?:limit[_\s-])?(?:reached|exceeded)/i;
const TPM_LIMIT = /\b(?:2045|2046|2047|1039|1041)\b/;
const TIMEOUT = /\b(?:timed?\s*out|timeout)\b/i;
const NETWORK_TEXT = /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|network)\b/i;
const INVALID_REQUEST = /\binvalid_request_error\b/i;
const IMAGE_LIMIT = /\btoo many images\b/i;
const TOO_LARGE = /\brequest_too_large\b|\b(?:request entity|payload) too large\b|\binput is too long\b/i;
const CONTEXT_OVERFLOW = /\bprompt is too long\b|\bcontext window exceeds limit\b|\bmaximum context length\b/i;

/** 状态码优先取属性；很多网关只把它写在文字里，就从文字里认 429 / 529。 */
function statusOf(error, text) {
  const status = error?.status ?? error?.statusCode;
  if (status !== undefined) return status;
  if (/\b429\b|rate[_\s-]?limit/i.test(text)) return 429;
  if (/\b529\b|overload/i.test(text)) return 529;
  return undefined;
}

/** 把一个异常整理成几条事实。 */
function factsOf(error) {
  const text = String(error?.message ?? error ?? "");
  return {
    text,
    status: statusOf(error, text),
    code: error?.code,
    aborted: error?.name === "AbortError",
    timeout: error?.name === "TimeoutError" || TIMEOUT.test(text),
  };
}

/** 错误属于哪一类？判断顺序就是优先级：取消 > 拒答 > 流被截断 > 钱和额度 > 限流 > 超时 > 状态码 > 网络。 */
function errorKind(f) {
  if (f.aborted) return "abort";
  if (REFUSAL.test(f.text)) return "content_filter"; // 拒答的解释文字由服务商控制，不能再喂给下面的数字判断
  if (INCOMPLETE_STREAM.test(f.text)) return "unknown"; // 诊断里的计数和耗时长得像状态码，同样不能参与判断
  if (f.status === 402 || CREDITS.test(f.text)) return "credits_exhausted";
  if (USAGE_LIMIT.test(f.text)) return "usage_limit";
  if (TPM_LIMIT.test(f.text)) return "tpm_rate_limited";
  if (f.timeout) return f.status === 529 ? "overloaded" : "timeout";
  if (f.status === 429) return "rate_limited";
  if (f.status === 401 || f.status === 403) return "auth";
  if (f.status === 404) return "not_found";
  if (f.status >= 400 && f.status < 500) return "bad_request";
  if (f.status === 529) return "overloaded";
  if (NETWORK_CODES.has(f.code) || NETWORK_TEXT.test(f.text)) return "network";
  if (f.status >= 500) return "server_error";
  return "unknown";
}

// 官方账号只重试这五类。其余一律不重试，包括普通的 5xx 和认不出来的错误（宁可失败，不去猜）。
const MANAGED_RETRYABLE = new Set(["timeout", "network", "rate_limited", "tpm_rate_limited", "overloaded"]);

/** 同一个请求发多少遍都会被拒绝的错误：图片太多、请求太大、上下文溢出、400 invalid_request_error。 */
function isDeterministicRejection(f) {
  if (f.aborted || f.timeout || NETWORK_CODES.has(f.code) || NETWORK_TEXT.test(f.text)) return false;
  if (f.status === 408 || f.status === 429 || f.status >= 500) return false;
  const rejectable = f.status === undefined || [400, 413, 422].includes(f.status);
  if (IMAGE_LIMIT.test(f.text)) return rejectable;
  if (f.status === 413 || TOO_LARGE.test(f.text) || CONTEXT_OVERFLOW.test(f.text)) return rejectable;
  return f.status === 400 && INVALID_REQUEST.test(f.text);
}

/**
 * 这个错误值不值得重试？
 *   官方账号：只有白名单里的五类可以重试。
 *   BYOK：自定义网关报错五花八门，输出之前的失败几乎都重试，只排除取消、拒答和"重发也一样被拒"的请求。
 * 返回 { kind, retryable }，对应 toLLMRetryDecision 与 llm-retry.ts 里 failureResult 的 BYOK 分支。
 */
export function classifyError(error, { byok = false } = {}) {
  const f = factsOf(error);
  const kind = errorKind(f);
  const retryable = byok
    ? !f.aborted && !REFUSAL.test(f.text) && !isDeterministicRejection(f)
    : MANAGED_RETRYABLE.has(kind);
  return { kind, retryable };
}

// ─── 5. 重试：次数、退避、提交边界 ──────────────────────────────────────────

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxRetries: 5, // 最多重试 5 次，一共最多 6 次物理请求
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryElapsedMs: 120_000, // 从第一次失败算起，到下一次重试开始，不能超过 2 分钟
});

/** 第 n 次重试前等多久：指数退避，再取一半到全部之间的随机值（打散同时失败的客户端）。服务端给了 Retry-After 就听服务端的。 */
export function retryDelayMs(retryAfterMs, retryAttempt, policy = DEFAULT_RETRY_POLICY, random = Math.random) {
  if (retryAfterMs !== undefined) return Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs));
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryAttempt - 1));
  return Math.floor(exponential / 2 + (random() * exponential) / 2);
}

/** 用户已经能看见的输出：非空的文字，或一个工具调用。{type:"start"} 不算：响应头到了，但屏幕上还什么都没有。 */
export function commitsOutput(event) {
  if (event.type === "text") return event.delta.length > 0;
  return event.type === "tool_call";
}

/**
 * 给模型套上重试。一次调用 = 一个逻辑调用，里面可以有多次物理请求。
 * 关键规则：只在"用户还没看到任何输出"时才重试。事件先缓冲，第一个可见输出出现的那一刻放行，
 * 之后的失败留在这次请求上，不再重发（重发要么重复内容，要么得把整条回复缓冲起来）。
 * observe 收到 waiting / recovered / exhausted / cancelled 四种状态，界面据此显示"X 秒后重试（2/5）"。
 */
export function withRetry(kernel, options = {}) {
  const { byok = false, observe, sleep = abortableSleep, now = Date.now, random = Math.random } = options;
  const policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };

  return async (request, signal, outer = {}) => {
    const identity = {}; // 这次逻辑调用的身份，所有物理重试共用（预算据此钉住）
    let firstFailureAt;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const buffer = createCommitBuffer(outer.emit);
      try {
        const reply = await kernel(request, signal, { identity, attempt, emit: buffer.emit });
        buffer.flush();
        if (attempt > 1) observe?.({ status: "recovered", requestAttempt: attempt });
        return reply;
      } catch (error) {
        if (signal?.aborted || buffer.committed) throw error; // 取消不是失败；已经有输出的失败留给上层
        const decision = classifyError(error, { byok });
        if (!decision.retryable) {
          if (attempt > 1) observe?.({ status: "exhausted", requestAttempt: attempt, reason: decision.kind });
          throw error;
        }
        const failedAt = now();
        firstFailureAt ??= failedAt;
        const delayMs = retryDelayMs(error?.retryAfterMs, attempt, policy, random);
        const tooLate = failedAt + delayMs - firstFailureAt > policy.maxRetryElapsedMs;
        if (attempt > policy.maxRetries || tooLate) {
          observe?.({ status: "exhausted", requestAttempt: attempt, reason: decision.kind });
          throw error;
        }
        observe?.({
          status: "waiting",
          retryAttempt: attempt,
          maxRetries: policy.maxRetries,
          requestAttempt: attempt + 1,
          delayMs,
          reason: decision.kind,
        });
        try {
          await sleep(delayMs, signal);
        } catch (aborted) {
          observe?.({ status: "cancelled", requestAttempt: attempt + 1 });
          throw aborted;
        }
      }
    }
  };
}

/** 缓冲一次物理请求的事件：第一个可见输出到达时，把缓冲的事件连同它一起放出去。 */
function createCommitBuffer(forward = () => {}) {
  const pending = [];
  const buffer = {
    committed: false,
    emit(event) {
      if (buffer.committed) return forward(event);
      if (!commitsOutput(event)) return void pending.push(event);
      buffer.committed = true;
      buffer.flush();
      forward(event);
    },
    flush() {
      for (const event of pending.splice(0)) forward(event);
    },
  };
  return buffer;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── 6. 看门狗：流卡住时 ────────────────────────────────────────────────────

export class LLMTimeoutError extends Error {
  name = "TimeoutError";
}

/**
 * 每次物理请求都带两个计时器：
 *   firstEventMs  等第一个事件（响应头）最多多久，默认 300 秒；
 *   idleMs        两个事件之间最多隔多久，默认 60 分钟。0 表示关掉。
 * 超时时，往里传的 signal 被取消（让模型停下），往外抛 TimeoutError 而不是 AbortError：
 * 这样重试层认得它是"传输超时"，可以重试；用户自己的取消则原样穿过，不会被说成超时。
 */
export function withTimeouts(kernel, { firstEventMs = 300_000, idleMs = 3_600_000 } = {}) {
  return (request, signal, call = {}) =>
    new Promise((resolve, reject) => {
      const controller = new AbortController();
      let timer;
      const finish = (settle, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCallerAbort);
        settle(value);
      };
      const arm = (ms, what) => {
        clearTimeout(timer);
        if (ms <= 0) return;
        timer = setTimeout(() => {
          const error = new LLMTimeoutError(`LLM request timed out: ${what} within ${ms}ms`);
          controller.abort(error);
          finish(reject, error);
        }, ms);
        timer.unref?.(); // 看门狗不该单独撑住进程
      };
      const onCallerAbort = () => {
        controller.abort(signal.reason);
        finish(reject, signal.reason);
      };

      if (signal?.aborted) return onCallerAbort();
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      arm(firstEventMs, "no response from the provider");
      const emit = (event) => {
        arm(idleMs, "the provider stream was idle"); // 每来一个事件，重新开始数空闲时间
        call.emit?.(event);
      };
      Promise.resolve()
        .then(() => kernel(request, controller.signal, { ...call, emit }))
        .then(
          (reply) => finish(resolve, reply),
          (error) => finish(reject, error),
        );
    });
}

// ─── 7. 用量 ────────────────────────────────────────────────────────────────

/**
 * 一条回复的 usage → 一行用量。服务商字段五花八门：cacheRead / cache.read / cache_read 三种写法，
 * 有的只给 total_tokens。对应 pi-usage.ts 的 normalizePiUsage；全是 0 的回复不落账。
 */
export function usageRow(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const input = number(usage.input);
  const output = number(usage.output);
  const onlyTotal = input === 0 && output === 0;
  const row = {
    inputTokens: onlyTotal ? number(usage.total_tokens) : input,
    outputTokens: onlyTotal ? 0 : output,
    reasoningTokens: number(usage.reasoning),
    cacheReadTokens: number(usage.cacheRead ?? usage.cache?.read ?? usage.cache_read),
    cacheWriteTokens: number(usage.cacheWrite ?? usage.cache?.write ?? usage.cache_write),
    costUsd: Number.isFinite(usage.cost?.total) ? usage.cost.total : null,
  };
  const total = row.inputTokens + row.outputTokens + row.reasoningTokens + row.cacheReadTokens + row.cacheWriteTokens;
  return total === 0 ? undefined : row;
}

/** 只追加的用量表。 */
export class UsageLedger {
  constructor() {
    this.rows = [];
  }

  append(row) {
    this.rows.push(Object.freeze({ ...row }));
  }

  /** 按 model / session / turn 分组汇总。 */
  summarize(by = "model") {
    const groups = new Map();
    for (const row of this.rows) {
      const empty = { key: row[by], calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      const total = groups.get(row[by]) ?? empty;
      total.calls += 1;
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.cacheReadTokens += row.cacheReadTokens;
      groups.set(row[by], total);
    }
    return [...groups.values()];
  }
}

/**
 * 逻辑调用成功返回之后，给这条回复记一行。包在重试层外面，所以：
 * 失败的物理请求没有回复，不产生行；重试成功的调用只记最后那次。
 * 落账是尽力而为的旁路：出错不能让一次成功的调用变成失败（pi-usage.ts 的 reportUsageFailure）。
 */
export function withUsage(kernel, { ledger, sessionId, turnId, modelKey, now = Date.now }) {
  return async (request, signal, call) => {
    const reply = await kernel(request, signal, call);
    try {
      const row = usageRow(reply.usage);
      if (row) ledger.append({ sessionId, turnId, model: modelKey, ts: now(), ...row });
    } catch {
      // 用量是历史提交之后的投影，写不进去也不影响这次回复
    }
    return reply;
  };
}

// ─── 8. 组装 ────────────────────────────────────────────────────────────────

/**
 * 按上游的顺序把包装套起来：用量(最外) → 重试 → 看门狗 → 预算 → 模型本身。
 *   - 重试在看门狗外面：每次物理请求（包括每一次重试）都有自己的计时器；
 *   - 预算在最里面：它看到的是已经定稿的请求，并按 call.identity 钉住。
 */
export function composeModel(kernel, resolved, options = {}) {
  const { ledger, sessionId, turnId, retry, timeouts, observe, resolver, thinking = 0 } = options;
  const budgeted = withBudget(kernel, {
    resolver,
    window: resolved.contextWindow,
    configuredMax: resolved.maxTokens,
    thinking,
  });
  const guarded = withTimeouts(budgeted, timeouts);
  const retrying = withRetry(guarded, { byok: resolved.byok, observe, ...retry });
  if (!ledger) return retrying;
  const modelKey = formatModelKey(resolved.provider, resolved.modelId);
  return withUsage(retrying, { ledger, sessionId, turnId, modelKey });
}

// ─── 脚本模型 ───────────────────────────────────────────────────────────────

/**
 * 按脚本逐条回复的模型，实验和测试用。脚本的每一项可以是：
 *   回复对象     原样返回（拷贝一份）
 *   Error        抛出，用来模拟这一次请求失败
 *   函数         (request, signal, call) => reply，可以调用 call.emit 流出事件
 */
export function scriptedKernel(replies) {
  let cursor = 0;
  return async (request, signal, call) => {
    signal?.throwIfAborted();
    if (cursor >= replies.length) throw Error("kernel script exhausted");
    const next = replies[cursor++];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(request, signal, call);
    return structuredClone(next);
  };
}
