// 第 6 章的实验场景。每个函数只返回数据，由同目录的 trigger / views / crash / commit / protocol / ladder 脚本
// 打印成表格，也被 labs/chapters/06-session-compaction.mjs 用来做回归检查。全部离线、确定，不需要 API Key。
//
// 能直接运行 MiniMax 自己代码的地方（checkpoint 协议、触发线公式、图片上限、崩溃后的展示行修复）都用 importSource 装载
// 固定提交里的真实模块；host 里重新实现的部分，则拿同一批输入和真实模块对一遍。
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import {
  CanonicalHistory,
  CommitUncertainError,
  checkpoint,
  checkpointInputs,
  checkpointMessage,
  compactBeforeModelCall,
  compactionBudget,
  estimateTokens,
  historyCursor,
  nodeFiles,
  projectOutbound,
  recentUserQueries,
} from "../../host/src/history.mjs";

const SRC = "packages/local-runtime-v2/src/service/turn-system/compaction";

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

/** 在临时目录里跑一段实验，结束后删除。 */
export async function inTemp(work) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ch06-")));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const noWait = async () => {};
export const newHistory = (dir, options = {}) => new CanonicalHistory(dir, { retryDelay: noWait, ...options });

// ─── 样例会话 ────────────────────────────────────────────────────────────────

/** 一段修 bug 的对话。`bulk` 控制 read 工具返回的文件有多大。 */
export function codingSession({ bulk = 0, rounds = 1 } = {}) {
  const file = (n) => `// search.ts (${n})\n` + "export const lookup = (a: string, b: string) => a.toLowerCase() === b;\n".repeat(bulk);
  const messages = [{ role: "user", text: "修复 search.ts 里大小写比较的 bug，不要引入新依赖" }];
  for (let r = 1; r <= rounds; r++) {
    messages.push(
      { role: "assistant", text: `第 ${r} 轮：先读文件，再搜一下。`, calls: [{ id: `r${r}a`, name: "read", input: { path: "src/search.ts" } }, { id: `r${r}b`, name: "grep", input: { pattern: "toLowerCase" } }] },
      { role: "tool", id: `r${r}a`, text: file(r) },
      { role: "tool", id: `r${r}b`, text: "src/search.ts:14: return a.toLowerCase() === b" },
      { role: "assistant", text: `第 ${r} 轮：改第 14 行。`, calls: [{ id: `r${r}c`, name: "edit", input: { path: "src/search.ts" } }] },
      { role: "tool", id: `r${r}c`, text: "edited src/search.ts" },
    );
  }
  messages.push(
    { role: "assistant", text: "已改成 localeCompare，测试还差一个土耳其语用例。" },
    { role: "user", text: "再跑一遍测试，然后别忘了跑 lint" },
  );
  return messages;
}

// ─── 一、什么时候压缩 ─────────────────────────────────────────────────────────

/** 上游 `resolveCompactionTokenBudget` 的真实结果，和 host 版放在一起。 */
export async function triggerTable() {
  const budget = await importSource("packages/agent-modules/context-manager/src/provider-budget.ts");
  const configs = [
    { window: 128_000, maxOutput: 8_192 },
    { window: 200_000, maxOutput: 8_192 },
    { window: 200_000, maxOutput: 32_000 },
    { window: 200_000, maxOutput: 64_000 },
    { window: 1_000_000, maxOutput: 64_000 },
  ];
  const k = (n) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`);
  const rows = configs.map(({ window, maxOutput }) => {
    const real = budget.resolveCompactionTokenBudget({ contextWindow: window, configuredMaxOutputTokens: maxOutput });
    const mine = compactionBudget({ contextWindow: window, maxOutputTokens: maxOutput });
    return {
      real,
      mine,
      row: {
        窗口: k(window),
        最大输出: k(maxOutput),
        "MiniMax 触发线": k(real.automaticTriggerAt),
        占窗口: `${Math.round((real.automaticTriggerAt / window) * 100)}%`,
        "MiniMax 请求上限": k(real.providerInputLimit),
        Pi: k(window - 16_384),
        "Claude Code": k(window - Math.min(maxOutput, 20_000) - 13_000),
      },
    };
  });

  // 用户设置 `compactionTriggerAt`：比例或绝对 token 数，只能把线调低。
  const settings = [0.5, 80_000, 0.99, 1.5, -1].map((triggerAt) => {
    const real = budget.resolveCompactionTokenBudget({ contextWindow: 200_000, configuredMaxOutputTokens: 8_192, compactionTriggerAt: triggerAt });
    const mine = compactionBudget({ contextWindow: 200_000, maxOutputTokens: 8_192, triggerAt });
    return { triggerAt, real, mine };
  });

  // host 版和上游版在一整个网格上逐个对比。
  let compared = 0;
  const mismatches = [];
  for (const window of [32_000, 64_000, 128_000, 200_000, 512_000, 1_000_000]) {
    for (const maxOutput of [1_024, 8_192, 16_384, 32_000, 64_000, 128_000]) {
      for (const triggerAt of [undefined, 0.3, 0.8, 1, 50_000, 300_000, 0, -5, 1.5, Number.NaN]) {
        const real = budget.resolveCompactionTokenBudget({ contextWindow: window, configuredMaxOutputTokens: maxOutput, compactionTriggerAt: triggerAt });
        const mine = compactionBudget({ contextWindow: window, maxOutputTokens: maxOutput, triggerAt });
        compared++;
        if (real.providerInputLimit !== mine.inputLimit || real.automaticTriggerAt !== mine.triggerAt) mismatches.push({ window, maxOutput, triggerAt, real, mine });
      }
    }
  }
  return { rows, settings, compared, mismatches };
}

// ─── 二、存下来的、发出去的 ────────────────────────────────────────────────────

/** 一份“什么都有”的存档：宿主专用消息、连发的两条用户消息、没有对应调用的结果、别的模型的思考、七张图。 */
export function messyHistory() {
  const shot = (n) => `shot-${n}.png`;
  return [
    { role: "user", text: "帮我看看这个页面哪里错位了", images: [shot(1), shot(2)], hostMetadata: { immediateSendBatchId: "b1" } },
    { role: "user", text: "顺便把上一轮的截图也对比一下", images: [shot(3)], hostMetadata: { immediateSendBatchId: "b1" } },
    { role: "custom", text: "[界面：已展开侧栏]", hostMetadata: { providerVisibility: "omit" } },
    { role: "tool", id: "ghost-1", text: "一个没有对应调用的工具结果（旧版本留下的）" },
    { role: "assistant", text: "先截个图。", model: "other-model", thinking: "用户提到错位，应该先看渲染结果。", calls: [{ id: "c1", name: "screenshot", input: {} }] },
    { role: "tool", id: "c1", text: "已截图", images: [shot(4), shot(5), shot(6)] },
    { role: "assistant", text: "标题栏左移了 8 像素。", model: "current-model", thinking: "对比 shot-4 和 shot-6。" },
    { role: "user", text: "再截一张确认", images: [shot(7)] },
  ];
}

export function viewsReport() {
  const history = messyHistory();
  const before = JSON.stringify(history);
  const current = { id: "current-model", provider: "demo" };
  const claude = { id: "claude-sonnet-demo", provider: "demo" };
  const sent = projectOutbound(history, current, { maxImages: 3 });
  const cached = projectOutbound(history, claude, { maxImages: 3 });
  const images = (messages) => messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  return {
    history,
    unchanged: JSON.stringify(history) === before,
    current,
    sent,
    cached,
    totalImages: images(history),
    sentImages: images(sent.messages),
    cachedImages: images(cached.messages),
  };
}

/** 真实的 `limitRequestImages` 对 Pi 形状的消息做同样的事，用来核对 host 版的取舍。 */
export async function upstreamImageLimit() {
  const images = await importSource("packages/agent-core/src/pi-turn-runner/request-image-limit.ts");
  const user = (n) => ({ role: "user", content: [{ type: "text", text: `shot ${n}` }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: n });
  const messages = [1, 2, 3, 4, 5].map(user);
  const limited = images.limitRequestImages(messages, 2);
  return {
    omitted: limited.omittedCount,
    kept: limited.messages.filter((m) => m.content.some((b) => b.type === "image")).length,
    placeholder: limited.messages[0].content[1].text,
    claudeKeepsAll: images.keepsRequestImages({ id: "claude-sonnet-4" }),
    otherKeeps: images.keepsRequestImages({ id: "MiniMax-M2" }),
    defaultLimit: images.resolveMaxImagesPerRequest({}),
  };
}

// ─── 三、崩溃留下了什么 ────────────────────────────────────────────────────────

const call = (id, name = "read") => ({ id, name, input: {} });
const asst = (text, ...calls) => ({ role: "assistant", text, calls });
const result = (id) => ({ role: "tool", id, text: `result of ${id}` });
const brief = (m) => (m.role === "assistant" ? `assistant(${(m.calls ?? []).map((c) => c.id).join(",") || "文字"})` : m.role === "tool" ? `tool(${m.id})` : m.role);

/** 四种崩溃现场：每种先写进文件，再分别用“活动读取”和“落定读取”各读一次（两次都从同一份原始字节开始）。 */
export async function crashScenarios() {
  const cases = [
    { 场景: "A 调用已存、结果一个没到", rows: [{ role: "user", text: "改一下" }, asst("读文件", call("c1"), call("c2"))] },
    { 场景: "B 两个结果到了一个", rows: [{ role: "user", text: "改一下" }, asst("读文件", call("c1"), call("c2")), result("c1")] },
    { 场景: "C 重启后用户又发了一条", rows: [{ role: "user", text: "改一下" }, asst("读文件", call("c1"), call("c2")), result("c1"), { role: "user", text: "怎么没反应" }] },
    { 场景: "D 有结果没有调用", rows: [{ role: "user", text: "改一下" }, result("zz"), asst("好的")] },
  ];
  const out = [];
  for (const scenario of cases) {
    out.push(
      await inTemp(async (dir) => {
        const store = newHistory(dir);
        await store.append(scenario.rows);
        const original = readFileSync(store.activePath, "utf8");
        const active = await store.read({ pendingTail: true });
        const activeRewritten = readFileSync(store.activePath, "utf8") !== original;
        writeFileSync(store.activePath, original); // 恢复现场，让落定读取面对同样的文件
        const settled = await store.read();
        const settledRewritten = readFileSync(store.activePath, "utf8") !== original;
        const answered = new Set(scenario.rows.filter((m) => m.role === "tool").map((m) => m.id));
        const missing = scenario.rows.flatMap((m) => (m.calls ?? []).map((c) => c.id)).filter((id) => !answered.has(id));
        return {
          scenario: scenario.场景,
          stored: scenario.rows.map(brief),
          activeRows: active.messages.map(brief),
          activeRewritten,
          settledRows: settled.messages.map(brief),
          issues: settled.issues,
          settledRewritten,
          piWouldFill: missing.length,
        };
      }),
    );
  }
  return out;
}

/** 用真实的 `StaleCompactionMessageRepair` 修崩溃留下的展示行。 */
export async function staleDisplayRows() {
  const { StaleCompactionMessageRepair } = await importSource("packages/local-runtime-v2/src/service/session-system/messages/stale-compaction-repair.ts");
  const processStartedAtMs = 1_000;
  const rows = [
    { msg_id: "m1", role: "user", timestamp: 100 },
    { msg_id: "m2", kind: "compaction_start", timestamp: 400 }, // 上一个进程发的，之后再没有下文
    { msg_id: "m3", role: "user", timestamp: 500 },
    { msg_id: "m4", kind: "compaction_start", timestamp: 1_200 }, // 本进程发的，而且是最后一行：压缩正在进行
  ];
  const upserts = [];
  const repair = new StaleCompactionMessageRepair({ messages: { upsert: async (input) => upserts.push(input.message.msg_id) }, processStartedAtMs });
  const fixed = await repair.repair("s1", rows);
  const patched = [...upserts];
  upserts.length = 0;
  // 同一批行，如果后面又来了新消息：本进程发的 compaction_start 也不再是“正在进行”。
  const later = await repair.repair("s1", [...rows, { msg_id: "m5", role: "user", timestamp: 1_300 }]);
  return { rows, fixed, patched, later, laterPatched: [...upserts] };
}

// ─── 四、压缩的提交，和写失败 ───────────────────────────────────────────────────

/** 在 nodeFiles 外面包一层，按计划在指定操作上注入故障。 */
export function faultyFiles(plan) {
  const state = { calls: { append: 0, replace: 0, publish: 0 } };
  const base = nodeFiles;
  const hit = (op) => {
    state.calls[op]++;
    const rule = plan[op];
    if (!rule) return undefined;
    const times = rule.times ?? Infinity;
    return state.calls[op] <= times ? rule.mode : undefined;
  };
  const files = {
    append(path, bytes) {
      const mode = hit("append");
      if (mode === "before") throw Error("EIO: nothing written");
      if (mode === "partial") {
        base.append(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw Error("EIO: short write");
      }
      if (mode === "after") {
        base.append(path, bytes);
        throw Error("EIO: write succeeded, then the call failed");
      }
      if (mode === "garbled") {
        base.append(path, Buffer.alloc(Math.floor(bytes.length / 2), "#"));
        throw Error("EIO: unknown bytes on disk");
      }
      return base.append(path, bytes);
    },
    replace(path, bytes) {
      if (hit("replace") === "crash") throw Error("crash before rename");
      return base.replace(path, bytes);
    },
    publish(path, bytes) {
      if (hit("publish") === "crash") throw Error("crash while publishing the snapshot");
      return base.publish(path, bytes);
    },
  };
  return { files, state };
}

const treeOf = (dir) => {
  const names = [];
  const walk = (current, prefix) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (entry.includes(".tmp") || entry.includes(".publish")) continue;
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else names.push(`${prefix}${entry}`);
    }
  };
  walk(dir, "");
  return names;
};

const checkpointMessageFor = (note) => [{ role: "compactionSummary", summary: `## Goal\n${note}` }];

/** 压缩提交在不同位置崩溃之后，磁盘上剩下什么；以及把顺序反过来会怎样。 */
export async function commitScenarios() {
  const seed = codingSession({ rounds: 2 });
  const run = async (name, plan, work) =>
    inTemp(async (dir) => {
      const { files } = faultyFiles(plan);
      const store = newHistory(dir, { files });
      await new CanonicalHistory(dir, { retryDelay: noWait }).append(seed, "t1");
      const outcome = await work(store, dir).then(
        (value) => value ?? "提交成功",
        (error) => `失败：${error.message}`,
      );
      const reader = new CanonicalHistory(dir);
      const active = reader.readEnvelopes();
      return {
        场景: name,
        结果: outcome,
        活动文件: `第 ${reader.generation} 代 · ${active.length} 条`,
        快照: treeOf(join(dir, "snapshots")).map((n) => n.replace(/^g0+(\d)/, "g$1")).join(" ") || "（无）",
      };
    });

  const rows = [];
  rows.push(await run("1 正常提交", {}, (s) => s.compact({ compactionId: "ctx1", replacement: checkpointMessageFor("v1") }).then(() => undefined)));
  rows.push(await run("2 发布快照时崩溃", { publish: { mode: "crash" } }, (s) => s.compact({ compactionId: "ctx1", replacement: checkpointMessageFor("v1") })));
  rows.push(await run("3 快照写好了，替换时崩溃", { replace: { mode: "crash" } }, (s) => s.compact({ compactionId: "ctx1", replacement: checkpointMessageFor("v1") })));

  // 4 场景 3 之后，用同一个 compactionId 重来
  rows.push(
    await inTemp(async (dir) => {
      const { files } = faultyFiles({ replace: { mode: "crash", times: 1 } });
      const store = newHistory(dir, { files });
      await new CanonicalHistory(dir, { retryDelay: noWait }).append(seed, "t1");
      await store.compact({ compactionId: "ctx1", replacement: checkpointMessageFor("v1") }).catch(() => {});
      const retry = await store.compact({ compactionId: "ctx1", replacement: checkpointMessageFor("v1") });
      const reader = new CanonicalHistory(dir);
      return { 场景: "4 同一个 id 重来", 结果: `提交成功（快照 ${retry.outcome}）`, 活动文件: `第 ${reader.generation} 代 · ${reader.readEnvelopes().length} 条`, 快照: treeOf(join(dir, "snapshots")).map((n) => n.replace(/^g0+(\d)/, "g$1")).join(" ") };
    }),
  );

  // 5 已存在的快照和活动历史对不上（被人改过）
  rows.push(
    await inTemp(async (dir) => {
      const store = newHistory(dir);
      await store.append(seed, "t1");
      mkdirSync(join(dir, "snapshots"), { recursive: true });
      writeFileSync(store.snapshotPath(0, "ctx1"), JSON.stringify({ message_id: "x", turn_id: "x", message: { role: "user", text: "被改过" } }) + "\n");
      const outcome = await store.compact({ compactionId: "ctx1", replacement: checkpointMessageFor("v1") }).then(() => "提交成功", (e) => `失败：${e.message.replace(/: .*/, "")}`);
      const reader = new CanonicalHistory(dir);
      return { 场景: "5 同名快照内容不同", 结果: outcome, 活动文件: `第 ${reader.generation} 代 · ${reader.readEnvelopes().length} 条`, 快照: "g0--ctx1.jsonl（别人写的）" };
    }),
  );

  // 6 反面教材：先替换，后存档
  rows.push(
    await inTemp(async (dir) => {
      const { files } = faultyFiles({ publish: { mode: "crash" } });
      const store = newHistory(dir, { files });
      await new CanonicalHistory(dir, { retryDelay: noWait }).append(seed, "t1");
      const outcome = await (async () => {
        const active = store.readEnvelopes();
        await files.replace(store.activePath, Buffer.from(JSON.stringify({ message_id: "s", turn_id: "t", message: checkpointMessageFor("v1")[0], history_artifact: { generation: 1 } }) + "\n"));
        await files.publish(store.snapshotPath(0, "ctx1"), Buffer.from(active.map((e) => JSON.stringify(e)).join("\n")));
      })().then(() => "提交成功", (e) => `失败：${e.message}`);
      const reader = new CanonicalHistory(dir);
      return { 场景: "6 反面教材：先替换后存档", 结果: outcome, 活动文件: `第 ${reader.generation} 代 · ${reader.readEnvelopes().length} 条`, 快照: treeOf(join(dir, "snapshots")).join(" ") || "（无）→ 旧历史永远丢了" };
    }),
  );
  return rows;
}

/** 追加失败的几种形态：每种都问两个问题——这批消息在文件里出现几次，调用方看到什么。 */
export async function appendFailures() {
  const batch = [{ role: "user", text: "一条要紧的消息" }, { role: "assistant", text: "收到" }];
  const modes = [
    { 失败方式: "什么都没写进去", plan: { append: { mode: "before", times: 1 } } },
    { 失败方式: "只写了一半", plan: { append: { mode: "partial", times: 1 } } },
    { 失败方式: "整批都写进去了，调用才报错", plan: { append: { mode: "after", times: 1 } } },
    { 失败方式: "写了一半，而且内容对不上", plan: { append: { mode: "garbled" } } },
    { 失败方式: "一直失败", plan: { append: { mode: "before" } } },
  ];
  const rows = [];
  for (const { 失败方式, plan } of modes) {
    rows.push(
      await inTemp(async (dir) => {
        const { files, state } = faultyFiles(plan);
        const store = newHistory(dir, { files });
        const outcome = await store.append(batch).then(() => "成功", (error) => error.name === "CommitUncertainError" ? "CommitUncertainError" : `抛出 ${error.message.split(":")[0]}`);
        const text = existsSync(store.activePath) ? readFileSync(store.activePath, "utf8") : "";
        const copies = text.split("\n").filter((l) => l.includes("一条要紧的消息")).length;
        return { 失败方式, 写入尝试: state.calls.append, 调用方看到: outcome, "这批消息出现的次数": copies, 文件是否整洁: text === "" || text.split("\n").filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }) ? "是" : "否（留有残片）" };
      }),
    );
  }
  return rows;
}

// ─── 五、checkpoint 协议 ──────────────────────────────────────────────────────

/** 上游 `validateCheckpointGeneration` 和 host `checkpoint` 对同一批生成结果的判断。 */
export async function protocolMatrix() {
  const format = await importSource(`${SRC}/algorithm/checkpoint-format.ts`);
  const proto = await importSource(`${SRC}/algorithm/checkpoint-protocol.ts`);
  const headings = proto.parseCheckpointHeadings(proto.CHECKPOINT_SYSTEM_PROMPT);
  const full = headings.map((h) => `## ${h}\n内容`).join("\n");
  const base = { stopReason: "stop", responseContentKinds: ["text"], outputTokens: 800 };
  const cases = [
    { 情形: "八个标题齐全", text: full, generation: base },
    { 情形: "只写了 Goal 一节", text: "## Goal\n修 search.ts", generation: base },
    { 情形: "标题译成了中文", text: headings.map((h) => `## ${h === "Goal" ? "目标" : h}\n内容`).join("\n"), generation: base },
    { 情形: "写到输出上限被截断（length）", text: full.slice(0, 90), generation: { ...base, stopReason: "length" } },
    { 情形: "响应是空的", text: "  \n", generation: base },
    { 情形: "模型发起了工具调用", text: full, generation: { ...base, stopReason: "toolUse", responseContentKinds: ["toolCall"] } },
    { 情形: "输出超过了预算", text: full, generation: { ...base, outputTokens: 30_000 } },
    { 情形: "请求被取消（aborted）", text: full, generation: { ...base, stopReason: "aborted" } },
  ];
  const maxOutputTokens = 25_000;
  const rows = [];
  for (const c of cases) {
    let real;
    try {
      real = format.validateCheckpointGeneration({ text: c.text, ...c.generation }, maxOutputTokens);
      real = real.schemaStatus;
    } catch (error) {
      real = error.code;
    }
    let mine;
    try {
      mine = (await checkpoint(c.text, { stopReason: c.generation.stopReason, kinds: c.generation.responseContentKinds, outputTokens: c.generation.outputTokens, maxOutputTokens })).status;
    } catch (error) {
      mine = error.code;
    }
    rows.push({ 情形: c.情形, 上游: real, host: mine, 接受: real === "exact" || real === "soft_fallback" ? "是" : "否" });
  }
  return rows;
}

/** 用真实的 `buildCheckpointMessage` 装一条 checkpoint，再做第二次压缩看用户原话怎样接力。 */
export async function protocolAssembly() {
  const format = await importSource(`${SRC}/algorithm/checkpoint-format.ts`);
  const proto = await importSource(`${SRC}/algorithm/checkpoint-protocol.ts`);
  const headings = proto.parseCheckpointHeadings(proto.CHECKPOINT_SYSTEM_PROMPT);
  const summary = headings.map((h) => `## ${h}\n(none)`).join("\n");
  const user = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts, genuineUserQueryText: text });
  const first = [
    user("修复 search.ts 的大小写 bug", 1),
    { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 2 },
    user("别引入新依赖", 3),
    user("/compact", 4),
  ];
  const one = format.buildCheckpointMessage(first, summary, 12_345, {
    timestamp: 100,
    earlierFiles: { snapshots: "<会话目录>/snapshots", toolOutputs: "<会话目录>/tool-outputs" },
  });
  // 第二次压缩：历史 = [第一次的 checkpoint, 之后的新消息]
  const second = [one, user("再跑一遍测试", 5), user("别忘了 lint", 6), user("顺便看看 CI", 7)];
  const two = format.buildCheckpointMessage(second, summary, 20_000, { timestamp: 200 });
  const queriesOf = (message) => [...message.summary.matchAll(/- Text: "([^"]*)"/g)].map((m) => m[1]);

  // host 版：同样的历史，用玩具形状
  const toHost = (messages) => messages.filter((m) => m.role === "user").map((m) => ({ role: "user", text: m.genuineUserQueryText }));
  const hostFirst = recentUserQueries(toHost(first));
  const hostSecond = recentUserQueries([{ role: "compactionSummary", summary: "…", recentUserQueries: hostFirst }, ...toHost(second.slice(1))]);
  return {
    sections: headings,
    message: one,
    parts: {
      "八节摘要（模型写的）": one.summary.slice(0, one.summary.indexOf("\n\nFiles from before")).split("\n").filter((l) => l.startsWith("## ")).length,
      "存档位置说明": one.summary.includes("Files from before this compaction:"),
      "宿主备注": one.summary.includes("Host note:"),
      附录版本: /<mavis-context-appendix version="(\d)">/.exec(one.summary)?.[1],
    },
    firstQueries: queriesOf(one),
    secondQueries: queriesOf(two),
    hostFirst,
    hostSecond,
  };
}

// ─── 六、摘要的输入放不下 ──────────────────────────────────────────────────────

export function ladderScenario() {
  const history = codingSession({ bulk: 40, rounds: 6 });
  history.splice(11, 0, { role: "user", text: "中途补充一句：测试在 test/search.test.ts" }); // 第 2 轮（下标 6～10）结束之后
  const sizeOf = (messages) => estimateTokens(messages);
  const limits = [sizeOf(history) + 100, 1_200, 520, 150, 20, 5];
  const rows = limits.map((limit) => {
    const fits = (candidate) => estimateTokens(candidate) <= limit;
    const tried = [];
    for (const rung of checkpointInputs(history, fits)) tried.push(rung);
    const chosen = tried[0];
    return {
      limit,
      chosen: chosen?.name,
      size: chosen ? sizeOf(chosen.messages) : undefined,
      count: chosen?.messages.length,
      messages: chosen?.messages,
    };
  });
  return { history, total: sizeOf(history), rows };
}

// ─── 七、整条链路 ─────────────────────────────────────────────────────────────

const SUMMARY = ["Goal", "Constraints & Preferences", "Completed Work", "Current State", "Blockers", "Key Decisions", "Pending User Asks", "Critical Context & Relevant Files"]
  .map((h) => `## ${h}\n内容`)
  .join("\n");

export const scriptedSummary = (overrides = {}) => async () => ({ text: SUMMARY, stopReason: "stop", kinds: ["text"], outputTokens: 400, ...overrides });

/** 同一份历史，在不同条件下请求模型之前的压缩钩子。 */
export async function pipelineScenarios() {
  // 200K 窗口、64K 输出：触发线 142.5K，请求上限 181.6K
  const model = { id: "current-model", contextWindow: 200_000, maxOutputTokens: 64_000 };
  const big = () => codingSession({ bulk: 2_100, rounds: 4 }); // 约 150K token，越过触发线
  const tooLargeOnce = (inner) => {
    let calls = 0;
    return async (messages) => {
      if (calls++ === 0) throw Object.assign(new Error("context_length_exceeded"), { code: "INPUT_TOO_LARGE" });
      return inner(messages);
    };
  };
  const rows = [];
  const run = async (name, { messages = big(), plan = {}, summarize = scriptedSummary(), extra = {} } = {}) =>
    inTemp(async (dir) => {
      const { files } = faultyFiles(plan);
      const store = newHistory(dir, { files });
      await new CanonicalHistory(dir, { retryDelay: noWait }).append(messages, "t1");
      const requests = [];
      const cursor = historyCursor(messages.length, async (batch, change) => {
        if (change.reason === "replaceMessages") await store.compact({ compactionId: change.metadata.replacementId, replacement: batch });
        else await store.append(batch, "t2");
      });
      const live = structuredClone(messages);
      const spy = async (candidate) => {
        const generation = await summarize(candidate);
        requests.push(estimateTokens(candidate));
        return generation;
      };
      const out = await compactBeforeModelCall({ messages: live, model, cursor, summarize: spy, compactionId: `ctx-${rows.length + 1}`, ...extra }).then(
        (r) => r,
        (error) => ({ status: "threw", reason: error.message.split(":")[0] }),
      );
      const reader = new CanonicalHistory(dir);
      const stored = reader.readEnvelopes();
      const entry = {
        场景: name,
        压缩结果: out.status + (out.reason ? `（${out.reason}）` : out.rung ? `（${out.rung}）` : ""),
        请求前估算: out.before ?? "—",
        内存里的历史: `${live.length} 条`,
        磁盘: `第 ${reader.generation} 代 · ${stored.length} 条`,
        接着请求模型: out.status === "threw" ? "否，Turn 失败" : "是",
      };
      rows.push(entry);
      return { out, entry, live, generation: reader.generation, requests };
    });

  const results = {};
  results.under = await run("A 没到触发线", { messages: codingSession({ rounds: 1 }) });
  results.done = await run("B 越过触发线，正常压缩");
  results.toolCall = await run("C 摘要请求里模型发起了工具调用", { summarize: scriptedSummary({ stopReason: "toolUse", kinds: ["toolCall"] }) });
  results.tooLarge = await run("D 服务商拒绝了完整历史", { summarize: tooLargeOnce(scriptedSummary()) });
  results.providerDown = await run("E 摘要请求连续两次服务商出错", { summarize: scriptedSummary({ stopReason: "error", kinds: [] }) });
  results.commit = await run("F 摘要写好了，替换写不进磁盘", { plan: { replace: { mode: "crash" } } });
  results.recovery = await run("G 服务商刚拒绝过上一次请求（未到触发线）", { messages: codingSession({ rounds: 1 }), extra: { recovery: true } });
  return { rows, results, model };
}

export { CommitUncertainError, checkpointMessage, estimateTokens };
