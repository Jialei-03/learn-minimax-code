// 第 3 章回归实验：模型键、凭证、输出预算、重试与用量。
//   node labs/chapters/03-models.mjs          打印实验过程和每项检查
//   node labs/chapters/03-models.mjs --json   构建模式
// 场景在 labs/ch03/scenarios.mjs；正文里嵌入的是 labs/ch03/*.mjs 打印的表格。
// 标着"真实上游"的对照，是 importSource 从固定提交装载 MiniMax Code 的原文件算出来的。
import { lesson } from "./harness.mjs";
import { runTurn } from "../../host/src/turns.mjs";
import {
  BudgetResolver,
  DEFAULT_RETRY_POLICY,
  LLMTimeoutError,
  classifyError,
  commitsOutput,
  composeModel,
  dynamicMaxTokens,
  parseModelKey,
  resolveModel,
  scriptedKernel,
  withRetry,
  withTimeouts,
} from "../../host/src/models.mjs";
import {
  CONFIGURED, ERROR_SAMPLES, RESOLVE_CASES, USAGE_MODEL_KEY, WINDOW,
  authRows, backoffRows, budgetRows, cellText, compactionLimits, errorRows, httpError, keyRows,
  patchRows, pinningRows, recordWithUpstream, resolveCase, resolveConfig, resolveRows, retryMatrix,
  RETRY_POLICIES, upstreamBudget, usageThroughRetry,
} from "../ch03/scenarios.mjs";

const noSleep = async () => {};
const resolvedM27 = resolveModel(resolveConfig(), "minimax_api/MiniMax-M2.7");
const managedM3 = resolveModel(resolveConfig(), "minimax/MiniMax-M3", { accessToken: "token-demo" });

await lesson(3, "模型键、凭证、输出预算、重试与用量", async (t) => {
  // ── 一、模型键 ────────────────────────────────────────────────
  t.log("一、模型键只认第一个斜杠");
  t.table(keyRows());
  const gateway = "custom_provider:my-gateway/deepseek-ai/DeepSeek-V3";
  t.equal("朴素的 split('/')[1] 丢掉了模型 id 里的命名空间", gateway.split("/")[1], "deepseek-ai");
  t.equal("只认第一个斜杠：带斜杠的模型 id 完整保留", parseModelKey(gateway), {
    source: "custom_provider",
    providerId: "custom_provider:my-gateway",
    providerKey: "my-gateway",
    modelId: "deepseek-ai/DeepSeek-V3",
  });
  t.equal(
    "不合法的键一律拒绝，不替用户猜归属",
    [null, undefined, 3, "model", "/model", "provider/", "custom_provider:/m"].map(parseModelKey),
    Array(7).fill(undefined),
  );

  // ── 二、从键到凭证 ────────────────────────────────────────────
  t.log("\n二、同一份配置里，九个键走到哪条路、拿到什么凭证");
  t.table(resolveRows());
  const outcome = Object.fromEntries(RESOLVE_CASES.map((c) => [c.场景, resolveCase(c)]));
  t.equal("官方账号：走 token_plan，令牌放在 Authorization 里", [outcome["已登录官方账号"].resolved.route, outcome["已登录官方账号"].resolved.headers.Authorization], ["token_plan", "Bearer token-demo"]);
  t.equal("官方账号：api key 只是占位符", outcome["已登录官方账号"].resolved.apiKey, "sk-xxx");
  t.equal("开关 minimaxModelSource 把官方键改道到用户自己的 API Key", outcome["开关改道到自己的 API Key"].resolved.route, "minimax_api_key");
  t.equal("自定义网关：限额取自模型自己的配置", [outcome["自定义网关，模型 id 带斜杠"].resolved.contextWindow, outcome["自定义网关，模型 id 带斜杠"].resolved.maxTokens], [65_536, 8_192]);
  t.ok("provider 或模型被删掉时，回退到内置模型并留下警告", /回退/.test(outcome["网关里没有这个模型"].resolved.warning) && /回退/.test(outcome["整个 provider 被删了"].resolved.warning));
  t.ok("没登录就用官方账号：在发请求之前报错", /令牌/.test(outcome["官方账号没登录"].error));
  t.ok("配置了 provider 却没填 key：报错，不静默回退", /api_key/.test(outcome["网关配了但没填 key"].error));
  t.throws("不合法的键直接报错", () => resolveModel(resolveConfig(), "not-a-key"), /不合法/);
  t.log("\n\"这个地址是不是官方账号\"：真实的 resolveProviderAuthMode 与 host 的版本：");
  const auth = authRows();
  t.table(auth);
  t.ok("host 的凭证模式判定与真实上游一致", auth.every((row) => row.一致 === "是"));

  // ── 三、输出预算 ──────────────────────────────────────────────
  t.log(`\n三、输出预算：窗口 ${WINDOW.toLocaleString("en-US")}，输出上限 ${CONFIGURED.toLocaleString("en-US")}`);
  t.table(budgetRows());
  let compared = 0;
  let mismatches = 0;
  for (const window of [32_000, 128_000, 200_000, 512_000, 1_000_000]) {
    for (const configured of [4_096, 16_384, 32_000, 128_000]) {
      for (let i = 0; i <= 40; i++) {
        const estimated = Math.floor((window * i) / 40);
        compared += 1;
        if (dynamicMaxTokens({ window, configured, estimated }) !== upstreamBudget(estimated, window, configured)) mismatches += 1;
      }
    }
  }
  t.log(`  host 的公式与真实 resolveDynamicMaxTokens：${compared} 个组合，${mismatches} 个不同`);
  t.equal("host 的动态预算与真实上游逐个相等", mismatches, 0);
  t.equal("输出触底的位置，就是输入的硬上限", [compactionLimits.providerInputLimit, upstreamBudget(compactionLimits.providerInputLimit)], [181_568, 16_384]);
  t.equal("输入小的时候，输出等于配置的上限", dynamicMaxTokens({ window: WINDOW, configured: CONFIGURED, estimated: 10_000 }), CONFIGURED);

  t.log("\n同一次逻辑调用内的重试共用预算（刻意让请求在两次尝试之间变大）：");
  const pinning = pinningRows();
  t.table(pinning);
  t.equal("同一个 identity：预算被钉住，不随请求变化", pinning[0].使用的预算, pinning[1].使用的预算);
  t.ok("新的 identity：按新请求重新计算", pinning[2].使用的预算 !== pinning[1].使用的预算);
  const resolver = new BudgetResolver();
  const sample = { messages: ["x".repeat(4 * 100_000)] };
  const plain = resolver.resolve({}, sample, { window: WINDOW, configuredMax: CONFIGURED });
  const thinking = resolver.resolve({}, sample, { window: WINDOW, configuredMax: CONFIGURED, thinking: 8_192 });
  t.equal("收缩时先扣掉思考预算：Pi 加回来之后总量不变", thinking.maxTokens + 8_192, plain.maxTokens);
  t.throws("输入本身就塞不进窗口：在发给模型之前拒绝", () => new BudgetResolver().resolve({}, { messages: ["x".repeat(800)] }, { window: 100, configuredMax: 50 }), /exhausted/);
  const circular = {};
  circular.self = circular;
  t.equal("估算本身失败：只要 1 个令牌并关掉思考", (({ maxTokens, disableReasoning }) => ({ maxTokens, disableReasoning }))(new BudgetResolver().resolve({}, circular, { window: WINDOW })), { maxTokens: 1, disableReasoning: true });

  // ── 四、失败分类 ──────────────────────────────────────────────
  t.log("\n四、十八种错误：真实分类器的结论，以及 host 是否一致");
  const errors = errorRows();
  t.table(errors);
  t.ok("host 的分类和两种重试判定与真实分类器逐个一致", errors.every((row) => row["host 一致"] === "是"));
  const verdict = Object.fromEntries(errors.map((row) => [row.错误, row]));
  t.equal("官方账号只重试超时、网络、限流、过载", errors.filter((row) => row.官方账号 === "重试").map((row) => row.分类), ["overloaded", "rate_limited", "tpm_rate_limited", "network", "timeout"]);
  t.equal("官方账号：普通 5xx 不重试（宁可失败，不去猜）", [verdict["500 服务器内部错误"].官方账号, verdict["502 网关错误"].官方账号], ["不重试", "不重试"]);
  t.equal("BYOK：连 401 也重试，因为网关的报错不可信", verdict["401 key 无效"].BYOK, "重试");
  t.equal(
    "BYOK 不重试：取消、拒答、重发也一样被拒的请求",
    ["用户取消", "模型拒答", "413 请求太大", "上下文溢出（2013）", "图片数量超限", "400 invalid_request_error"].map((name) => verdict[name].BYOK),
    Array(6).fill("不重试"),
  );
  t.equal("样本数", errors.length, ERROR_SAMPLES.length);

  // ── 五、重试 ──────────────────────────────────────────────────
  t.log("\n五、同一批故障，四种策略（虚拟时钟）");
  const matrix = await retryMatrix();
  t.table(matrix.map(({ scenario, cells }) => ({ 场景: scenario.名称, ...Object.fromEntries(RETRY_POLICIES.map((p) => [p, cellText(cells[p])])) })));
  const calls = (policy) => matrix.map(({ cells }) => cells[policy].calls);
  t.equal("官方账号策略：各场景的物理请求次数", calls("官方账号"), [3, 1, 1, 2, 1]);
  t.equal("BYOK 策略：各场景的物理请求次数", calls("BYOK"), [3, 6, 1, 2, 3]);
  t.equal("朴素重试：401 也发了 6 次，慢超时拖了 30 分钟", [calls("朴素重试")[1], Math.round(matrix[3].cells.朴素重试.elapsedMs / 60_000)], [6, 30]);
  t.equal("提交边界：已经说出口的话，不会因为重试再说一遍", [matrix[2].cells.官方账号.screen, matrix[2].cells.朴素重试.screen], ["我先看看", "我先看看我先看看入口文件。"]);
  t.equal("慢超时：从第一次失败起算 120 秒的上限，让每次等 300 秒的请求只重试一次", matrix[3].cells.官方账号.calls, 2);

  t.log("\n退避的节奏：");
  t.table(backoffRows());
  const delays = [];
  const exhaustedEvents = [];
  const alwaysOverloaded = withRetry(scriptedKernel(Array(6).fill(httpError(529, "overloaded_error"))), {
    sleep: async (ms) => void delays.push(ms),
    random: () => 0,
    observe: (event) => exhaustedEvents.push(event.status),
  });
  await t.rejects("一直过载：用完 5 次重试，抛出最后一个错误", alwaysOverloaded({ messages: [] }), /overloaded/);
  t.equal("五次退避依次是 500、1000、2000、4000、8000（与上游测试里的数字一样）", delays, [500, 1000, 2000, 4000, 8000]);
  t.equal("界面收到 5 个 waiting 和 1 个 exhausted", [exhaustedEvents.filter((s) => s === "waiting").length, exhaustedEvents.at(-1)], [5, "exhausted"]);
  t.equal("默认策略", DEFAULT_RETRY_POLICY, { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30000, maxRetryElapsedMs: 120000 });

  const hinted = [];
  const retryAfter = withRetry(scriptedKernel([Object.assign(httpError(429, "rate limit"), { retryAfterMs: 2_000 }), { text: "ok" }]), { sleep: async (ms) => void hinted.push(ms), random: () => 0 });
  await retryAfter({ messages: [] });
  t.equal("服务端给了 Retry-After：听服务端的", hinted, [2_000]);

  const controller = new AbortController();
  const cancelled = [];
  const interrupted = withRetry(scriptedKernel([httpError(529, "overloaded_error"), { text: "never" }]), {
    sleep: async (ms, signal) => new Promise((_, reject) => { controller.abort(Error("user cancelled")); reject(signal.reason); }),
    observe: (event) => cancelled.push(event.status),
  });
  await t.rejects("退避期间用户取消：不再发下一次请求", interrupted({ messages: [] }, controller.signal), /user cancelled/);
  t.equal("取消时界面收到 waiting 和 cancelled", cancelled, ["waiting", "cancelled"]);
  t.equal("事件分类：start 不算可见输出，非空文字和工具调用才算", [{ type: "start" }, { type: "text", delta: "" }, { type: "text", delta: "好" }, { type: "tool_call" }].map(commitsOutput), [false, false, true, true]);

  // ── 六、看门狗（真实计时器，毫秒级）──────────────────────────
  t.log("\n六、流卡住时的两个看门狗");
  // 一个永远不返回的模型：只有被取消才结束。保活计时器模拟真实请求里撑住进程的那条 socket。
  const stall = (signal) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5_000);
    signal.addEventListener("abort", () => (clearTimeout(keepAlive), reject(signal.reason)), { once: true });
  });
  const silent = (request, signal) => stall(signal); // 连响应头都不给
  const headersThenStall = (request, signal, call) => (call.emit({ type: "start" }), stall(signal)); // 响应头到了，然后没了下文
  let innerSignal;
  const firstTimeout = await withTimeouts((request, signal) => ((innerSignal = signal), stall(signal)), { firstEventMs: 20 })({ messages: [] }).catch((error) => error);
  t.ok("首包超时：抛出 TimeoutError，并让里面的请求停下", firstTimeout instanceof LLMTimeoutError && /no response/.test(firstTimeout.message) && innerSignal.aborted);
  t.equal("超时被分类为 timeout，官方账号也会重试", classifyError(firstTimeout), { kind: "timeout", retryable: true });
  const idle = await withTimeouts(headersThenStall, { firstEventMs: 500, idleMs: 20 })({ messages: [] }).catch((error) => error);
  t.ok("空闲超时：响应头到了之后又卡住", idle instanceof LLMTimeoutError && /idle/.test(idle.message));
  const callerAbort = new AbortController();
  setTimeout(() => callerAbort.abort(Error("user cancelled")), 10);
  const aborted = await withTimeouts(silent, { firstEventMs: 500, idleMs: 500 })({ messages: [] }, callerAbort.signal).catch((error) => error);
  t.ok("用户取消原样穿过，不会被说成超时", !(aborted instanceof LLMTimeoutError) && /user cancelled/.test(aborted.message));
  let attempts = 0;
  const flaky = withRetry(withTimeouts((request, signal, call) => (++attempts === 1 ? headersThenStall(request, signal, call) : { text: "好了" }), { firstEventMs: 500, idleMs: 20 }), { sleep: noSleep, random: () => 0 });
  t.equal("卡住的那次被看门狗打断，重试后成功", [(await flaky({ messages: [] })).text, attempts], ["好了", 2]);

  // ── 七、内核补丁的措辞约定 ────────────────────────────────────
  t.log("\n七、内核补丁与宿主分类器之间的措辞约定");
  const patches = patchRows();
  t.table(patches);
  const patch = (补丁, 措辞) => patches.find((row) => row.补丁 === 补丁 && row.措辞 === 措辞);
  t.equal("补丁的原话：只作为\"流被截断\"，诊断里的数字不参与判断", patch("没有 stop_reason 的流", "MiniMax 补丁的原话").真实分类器的判定, "unknown");
  t.equal("换一句话，诊断里的 1008 被读成余额不足", patch("没有 stop_reason 的流", "同样的诊断数字，措辞改成别的（假设）").真实分类器的判定, "credits_exhausted");
  t.equal("拒答：标记在，解释里的故障词不起作用", patch("拒答详情", "补丁的措辞，解释里碰巧有故障词").BYOK, "不重试");
  t.equal("拒答：没有标记，解释里的 timed out 决定了结论", patch("拒答详情", "没有标记，解释里碰巧有 timed out（假设）").官方账号, "重试");
  t.equal("Pi v1.5.0 的拒答措辞没有标记：BYOK 会重试", patch("拒答详情", "Pi v1.5.0 的措辞").BYOK, "重试");

  // ── 八、用量 ──────────────────────────────────────────────────
  t.log("\n八、用量：真实的 recordCommittedPiUsage");
  const upstream = await recordWithUpstream();
  t.table(upstream.rows.map((row) => ({ ts: row.ts, model: row.model, 输入: row.inputTokens, 输出: row.outputTokens, 思考: row.reasoningTokens, "缓存读": row.cacheReadTokens, "缓存写": row.cacheWriteTokens })));
  t.equal("每条带用量的 assistant 消息一行，没有用量或全是 0 的不落账", upstream.recorded, 3);
  t.equal("只给 total_tokens 的服务商：total 当作输入", upstream.rows[1].inputTokens, 900);
  t.equal("goal 口径：不含缓存，并标出有消息缺用量", upstream.goal, { tokens: 2_545, incomplete: true });
  const throughRetry = await usageThroughRetry({ failures: 2 });
  const allFailed = await usageThroughRetry({ failures: 6, succeed: false });
  t.equal("重试两次后成功：3 次物理请求，1 行用量", [throughRetry.calls, throughRetry.ledger.rows.length], [3, 1]);
  t.equal("全部失败：没有回复，没有用量", [allFailed.outcome, allFailed.ledger.rows.length], ["失败", 0]);
  t.equal("用量表里的 model 字段拼回去就是配置里的原键", throughRetry.ledger.rows[0].model, USAGE_MODEL_KEY);

  // ── 九、组合起来，接进第 2 章的 Turn ──────────────────────────
  t.log("\n九、composeModel：预算、看门狗、重试、用量按上游的顺序套起来");
  const seen = [];
  const request = { system: [], messages: ["x".repeat(4 * 100_000)], tools: [] };
  const composed = composeModel(
    scriptedKernel([
      (req) => (seen.push(req.maxTokens), request.messages.push("y".repeat(4 * 70_000)), Promise.reject(httpError(529, "overloaded_error"))),
      (req) => (seen.push(req.maxTokens), { text: "ok" }),
    ]),
    resolvedM27,
    { retry: { sleep: noSleep, random: () => 0 } },
  );
  await composed(request);
  t.equal("重试的两次请求带着同一个 maxTokens", seen[0], seen[1]);
  t.equal("maxTokens 是第一次请求时按窗口算出来的", seen[0], dynamicMaxTokens({ window: 200_000, configured: 128_000, estimated: Math.ceil(JSON.stringify({ system: [], messages: [request.messages[0]], tools: [] }).length / 4) }));

  const runWith = (replies) =>
    runTurn({
      sessionId: "s",
      turnId: "T",
      text: "你好",
      root: t.root,
      prompt: { system: [] },
      tools: [],
      model: composeModel(scriptedKernel(replies), managedM3, { retry: { sleep: noSleep, random: () => 0 } }),
      write: async () => {},
      persist: async () => {},
    });
  const recovered = await runWith([httpError(529, "overloaded_error"), { text: "你好" }]);
  t.equal("一次 529 被模型层吃掉，Turn 正常完成", [recovered.status, recovered.failure], ["completed", undefined]);
  const rejected = await runWith([httpError(401, "invalid api key")]);
  t.equal("401 不重试，Turn 以 failed 结束并归因到模型", [rejected.status, rejected.failure?.source], ["failed", "model"]);

  t.equal("scriptedKernel 向后兼容：回复对象是拷贝，用完了会报错", await (async () => {
    const reply = { text: "x" };
    const kernel = scriptedKernel([reply]);
    const first = await kernel({});
    first.text = "changed";
    return [reply.text, await kernel({}).catch((error) => error.message)];
  })(), ["x", "kernel script exhausted"]);

  t.observations = {
    keys: keyRows().length,
    routes: Object.fromEntries(RESOLVE_CASES.map((c) => [c.场景, resolveCase(c).resolved?.route ?? "error"])),
    budgets: Object.fromEntries([10_000, 100_000, 181_568].map((n) => [n, upstreamBudget(n)])),
    retryCalls: { 官方账号: calls("官方账号"), BYOK: calls("BYOK"), 朴素重试: calls("朴素重试") },
  };
});
