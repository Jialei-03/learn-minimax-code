// 第 10 章实验的共用场景。每个函数只返回数据，由同目录的 stream / accumulate / outcomes /
// protocols / replay 脚本打印成表格，也被 labs/chapters/10-sdk-events.mjs 拿去做回归检查。
//
// 全部离线、确定、不需要 API Key。这里运行的是 MiniMax Code 0.7.2 的真实代码（lab/source.mjs 的 importSource）：
//   packages/code-sdk/src/{items,protocol,errors}.ts      SDK 的折叠器、逐行解析、错误映射
//   packages/tui/src/headless/{events,exit-policy}.ts     CLI 一侧的事件投影器、退出码策略
//   packages/tui/src/acp/updates.ts                       ACP 一侧的更新投影器
// 以及上游 SDK 测试里“真实运行录下来、脱敏后”的 stream-json 输出（code-sdk/test/fixtures/*.jsonl）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource, readSource } from "../../lab/source.mjs";
import { EventStore } from "../../host/src/events.mjs";
import { collector } from "../../host/src/sdk.mjs";
import { runTurn } from "../../host/src/turns.mjs";
import { localTools } from "../../host/src/tools.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";

// ─── 小工具 ────────────────────────────────────────────────────────────────

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

/** 文本放进表格前：用引号包起来，超过 n 个字符截断。 */
export const quote = (text, n = 22) => {
  const flat = String(text).replace(/\s+/g, " ");
  return `“${flat.length > n ? flat.slice(0, n) + "…" : flat}”`;
};

/** 工具调用的状态码，来自 agent-core/src/protocol/agent-message.ts 的 `ToolCallStatus`。 */
export const TOOL_STATUS = { 1: "执行中", 2: "完成", 3: "失败", 4: "生成参数", 5: "参数就绪" };

// ─── 场景一：一段真实录像，逐条过一遍折叠器 ─────────────────────────────────────

const FIXTURES = "packages/code-sdk/test/fixtures";

/** 读一段录像：每行都经过 SDK 自己的 `parseEventLine`，和真实的 ExecProcess 读 stdout 的方式一样。 */
export async function recording(name) {
  const { parseEventLine } = await importSource("packages/code-sdk/src/protocol.ts");
  return readSource(`${FIXTURES}/${name}.jsonl`)
    .split("\n")
    .filter(Boolean)
    .map((line) => parseEventLine(line));
}

/** 给每个 item 起一个读者看得懂的短名字：工具调用用工具名，消息和思考按出现顺序编号。 */
function itemLabeler() {
  const labels = new Map();
  const counters = { agent_message: 0, reasoning: 0 };
  const names = { agent_message: "消息", reasoning: "思考" };
  return (item) => {
    if (!labels.has(item.id)) {
      labels.set(
        item.id,
        item.type === "tool_call" ? item.toolCall?.name ?? "工具" : `${names[item.type]}${++counters[item.type]}`,
      );
    }
    return labels.get(item.id);
  };
}

/** 一个事件的“形态”和“内容”：增量只带新增的文字，完整带整段文字，快照带工具调用的整个当前状态。 */
function describeEvent(event) {
  const item = event.item;
  if (item?.contentDelta !== undefined) return ["增量", `+${quote(item.contentDelta)}`];
  if (item?.content !== undefined) return ["完整文本", `=${quote(item.content)}`];
  if (item?.toolCall) {
    const call = item.toolCall;
    const extras = [call.input ? "input" : "", call.output ? "output" : ""].filter(Boolean).join(" + ");
    return ["快照", `${call.status}（${TOOL_STATUS[call.status] ?? "?"}）${extras ? " + " + extras : ""}`];
  }
  if (event.type === "exec.completed") return ["-", `status=${event.result.status}`];
  if (event.type === "turn.failed") return ["-", `status=${event.status}`];
  return ["-", ""];
}

/** 把一段录像逐条喂给真实的 ItemAccumulator，记录每一条被接受还是被丢弃。 */
export async function foldRecording(name) {
  const { ItemAccumulator } = await importSource("packages/code-sdk/src/items.ts");
  const events = await recording(name);
  const accumulator = new ItemAccumulator();
  const label = itemLabeler();
  const dropped = [];
  const rows = events.map((event) => {
    const accepted = accumulator.apply(event);
    if (!accepted) dropped.push(event.sequence);
    const [shape, content] = describeEvent(event);
    return {
      序号: event.sequence,
      事件: event.type,
      item: event.item ? label(event.item) : "-",
      形态: shape,
      内容: content,
      折叠器: accepted ? "接受" : "丢弃（和上一份快照相同）",
    };
  });
  const items = accumulator.items();
  const itemRows = items.map((item) => ({
    item: label(item),
    类型: item.type,
    结果:
      item.type === "tool_call"
        ? `${item.toolCall.name}，最后状态 ${item.toolCall.status}（${TOOL_STATUS[item.toolCall.status] ?? "?"}）`
        : quote(item.text, 36),
    状态: item.incomplete ? "incomplete" : "completed",
  }));
  const done = events.find((event) => event.type === "exec.completed");
  return { events, rows, items, itemRows, dropped, result: done?.result, label };
}

/** 三种“直观”的合并办法，在同一段录像上各自得到什么。 */
export function naiveMerges(events) {
  const deltas = events.flatMap((event) => (event.item?.contentDelta !== undefined ? [event.item.contentDelta] : []));
  const itemEvents = events.filter((event) => event.item);
  return {
    // 不看 id，把所有增量接在一起
    concatenated: deltas.join(""),
    // 一个 item.* 事件当一条记录
    eventCount: itemEvents.length,
    // 每个 id 只留最后一个事件
    lastPerId: [...new Map(itemEvents.map((event) => [event.item.id, event])).values()],
  };
}

// ─── 场景二：合成一段会同时撞上三个坑的事件流 ──────────────────────────────────

const message = (extra) => ({ id: "a", type: "agent_message", ...extra });
const thinking = (extra) => ({ id: "r", type: "reasoning", ...extra });
const tool = (status, extra = {}) => ({
  id: "t",
  type: "tool_call",
  toolCall: { id: "t", name: "bash", status, ...extra },
});
const result = { command: "ls" };

/**
 * 事件流：消息 a 和思考 r 的文字是增量（而且两次增量的内容相同），工具 t 是快照（而且有一份重复），
 * 三个 item 的事件交错在一起；最后 a 和 t 完成了，r 没有（比如 Turn 被取消了）。
 */
export const SYNTHETIC = [
  ["item.started", message({ contentDelta: "ha" })],
  ["item.updated", tool(4)],
  ["item.updated", tool(4)], // 和上一条完全相同的快照
  ["item.updated", message({ contentDelta: "ha" })], // 增量的内容也相同，但这是新的文字
  ["item.started", thinking({ contentDelta: "想" })],
  ["item.updated", thinking({ contentDelta: "想" })],
  ["item.updated", tool(1, { input: result })],
  ["item.updated", tool(2, { input: result, output: "a.txt" })],
  ["item.completed", message({ content: "haha" })], // 完成帧带的是整段文字，不是增量
  ["item.completed", tool(2, { input: result, output: "a.txt" })],
].map(([type, item]) => ({ type, item }));

/** 把 items 的当前状态压成表格里的一格：文字（✓ 表示已完成）或工具状态。 */
function cell(item) {
  if (!item) return "";
  if (item.type === "tool_call") return `状态 ${item.toolCall.status}${item.incomplete ? "" : " ✓"}`;
  return `${item.text}${item.incomplete ? "" : " ✓"}`;
}

// 下面四个是“朴素做法”。每一个都只在一条规则上和上游不同，所以失败的原因是单一的。
/** 朴素 1：不看 id，把所有文字接在一起。 */
function concatenateEverything(events) {
  return { text: events.map(({ item }) => item.contentDelta ?? item.content ?? "").join(""), delivered: events.length };
}

/** 按 id 折叠的骨架；各种朴素做法通过 `step` 决定每个事件怎样改变状态，返回 false 表示不往外送。 */
function foldById(events, step) {
  const states = new Map();
  let delivered = 0;
  for (const { type, item } of events) {
    if (!states.has(item.id)) states.set(item.id, { text: "", seen: new Set(), snapshot: "", completed: false });
    const state = states.get(item.id);
    if (step(state, type, item) !== false) delivered++;
    if (type === "item.completed") state.completed = true;
  }
  const text = (id) => states.get(id)?.text;
  return { a: text("a"), r: text("r"), rCompleted: states.get("r")?.completed, delivered, states };
}

/** 朴素 2：为了“去重”，同一个 id 下出现过的文字不再追加（连增量也算）。 */
const dedupeByText = (events) =>
  foldById(events, (state, type, item) => {
    if (item.contentDelta !== undefined) {
      if (state.seen.has(item.contentDelta)) return false;
      state.seen.add(item.contentDelta);
      state.text += item.contentDelta;
    }
    if (item.content !== undefined) state.text = item.content;
  });

/** 朴素 3：完成帧里的 content 也当成增量追加。 */
const completedAsDelta = (events) =>
  foldById(events, (state, type, item) => {
    state.text += item.contentDelta ?? item.content ?? "";
  });

/** 朴素 4：收到什么都往外送，不判断快照是否重复。折叠结果没问题，但消费者看到的事件更多。 */
const neverDrop = (events) =>
  foldById(events, (state, type, item) => {
    if (item.contentDelta !== undefined) state.text += item.contentDelta;
    if (item.content !== undefined) state.text = item.content;
  });

/** 朴素 5：不记哪些 item 收到过 item.completed，Turn 结束时一律当作完成。 */
const assumeAllComplete = (events) => {
  const folded = neverDrop(events);
  return { ...folded, delivered: events.length - 1, rCompleted: true };
};

export async function accumulation() {
  const { ItemAccumulator } = await importSource("packages/code-sdk/src/items.ts");

  // 逐步过一遍真实的折叠器
  const accumulator = new ItemAccumulator();
  const steps = SYNTHETIC.map((event, index) => {
    const accepted = accumulator.apply(event);
    const byId = Object.fromEntries(accumulator.items().map((item) => [item.id, item]));
    const [shape, content] = describeEvent(event);
    return {
      步骤: index + 1,
      事件: `${event.type} ${event.item.id}`,
      内容: `${shape} ${content}`.trim(),
      "apply() 返回": accepted,
      a: cell(byId.a),
      r: cell(byId.r),
      t: cell(byId.t),
    };
  });
  const real = {
    a: accumulator.items().find((item) => item.id === "a").text,
    r: accumulator.items().find((item) => item.id === "r").text,
    rCompleted: !accumulator.items().find((item) => item.id === "r").incomplete,
    delivered: steps.filter((step) => step["apply() 返回"]).length,
  };

  // 五种朴素做法，和真实的折叠器放在一起比
  const concatenated = concatenateEverything(SYNTHETIC);
  const dedupe = dedupeByText(SYNTHETIC);
  const appendCompleted = completedAsDelta(SYNTHETIC);
  const keepAll = neverDrop(SYNTHETIC);
  const allDone = assumeAllComplete(SYNTHETIC);
  const variants = [
    { 做法: "不看 id，所有文字接在一起", a: `全部混在一起：${quote(concatenated.text)}`, r: "（分不出来）", r完成了吗: "（分不出来）", 问题: "不同 item 的文字串在一起，还多出一份完成帧的整段文字" },
    { 做法: "按文字去重（连增量也去）", a: dedupe.a, r: dedupe.r, r完成了吗: "否", 问题: "合法的重复文字被吞掉：“想想”变成“想”；a 靠完成帧的整段文字才补回来" },
    { 做法: "完成帧的 content 也追加", a: appendCompleted.a, r: appendCompleted.r, r完成了吗: "否", 问题: "完成帧带的是整段文字，追加之后整段文字出现了两遍" },
    { 做法: "不丢重复的快照", a: keepAll.a, r: keepAll.r, r完成了吗: "否", 问题: `结果是对的，但消费者要多处理 ${keepAll.delivered - real.delivered} 个重复的工具快照（${keepAll.delivered} 个事件，上游 ${real.delivered} 个）` },
    { 做法: "结束时一律当作已完成", a: allDone.a, r: allDone.r, r完成了吗: "是（错）", 问题: "被取消的思考看上去像完整的" },
    { 做法: "ItemAccumulator（上游）", a: real.a, r: real.r, r完成了吗: real.rCompleted ? "是" : "否（incomplete）", 问题: "—" },
  ];
  return { steps, variants, real, concatenated, accumulator };
}

// ─── 场景三：没有结果就是失败 ────────────────────────────────────────────────

/** 一行 stdout 交给 SDK 的 `parseEventLine`，会得到什么。 */
export async function parseCases() {
  const { parseEventLine } = await importSource("packages/code-sdk/src/protocol.ts");
  const lines = [
    ["（空行）", ""],
    ["Update available: run npm i -g @minimax-ai/code", "Update available: run npm i -g @minimax-ai/code"],
    ["[1,2]", "[1,2]"],
    ['schemaVersion 是 2', '{"schemaVersion":2,"type":"exec.started","sessionId":"s"}'],
    ["缺少 sessionId", '{"schemaVersion":1,"type":"exec.started"}'],
    ["item 没有 id", '{"schemaVersion":1,"type":"item.updated","sessionId":"s","item":{"type":"agent_message"}}'],
    ["exec.completed 的 result 不合格", '{"schemaVersion":1,"type":"exec.completed","sessionId":"s","result":{"status":"ok"}}'],
    ["没见过的事件类型", '{"schemaVersion":1,"type":"plan.updated","sessionId":"s","plan":["a"]}'],
  ];
  return lines.map(([name, line]) => {
    try {
      const event = parseEventLine(line);
      return { 输入: name, 结果: event ? `放行（type=${event.type}）` : "忽略", 错误类型: "-", error: undefined };
    } catch (error) {
      return { 输入: name, 结果: error.message.slice(0, 54) + (error.message.length > 54 ? "…" : ""), 错误类型: error.constructor.name, error };
    }
  });
}

const describeError = (error) => {
  const extra = [error.status, error.category].filter(Boolean).join("/");
  return `${error.constructor.name}${extra ? `（${extra}）` : ""}`;
};

/** CLI 的每种结局：退出码是多少；SDK 有 exec.completed 时抛什么；只剩退出码时抛什么。 */
export async function exitMapping() {
  const { errorForResult, errorForExit } = await importSource("packages/code-sdk/src/errors.ts");
  const { exitCodeForExecResult } = await importSource("packages/tui/src/headless/exit-policy.ts");
  const base = { schemaVersion: 1, type: "exec.result", runId: "r", sessionId: "s", turnId: "t", durationMs: 1 };
  const cases = [
    ["succeeded", { status: "succeeded" }],
    ["failed / config", { status: "failed", error: { category: "config", message: "bad config" } }],
    ["failed / runtime", { status: "failed", error: { category: "runtime", message: "upstream", retryable: true } }],
    ["failed / internal", { status: "failed", error: { category: "internal", message: "bug" } }],
    ["timeout", { status: "timeout" }],
    ["limit_exceeded", { status: "limit_exceeded" }],
    ["cancelled", { status: "cancelled" }],
  ];
  const rows = cases.map(([name, partial]) => {
    const execResult = { ...base, ...partial };
    const exitCode = exitCodeForExecResult(execResult);
    const fromResult = partial.status === "succeeded" ? undefined : errorForResult(execResult, [], {});
    const fromExit = errorForExit({ exitCode, stderr: "" });
    return {
      CLI结果: name,
      退出码: exitCode,
      "有 exec.completed 时 SDK 抛出": fromResult ? describeError(fromResult) : "不抛，run() 返回 Turn",
      "只有退出码时 SDK 抛出":
        describeError(fromExit) + (partial.status === "succeeded" ? "：退出码 0，却没有 exec.completed" : ""),
      fromResult,
      fromExit,
    };
  });
  // 没有对应 CLI 结果的退出方式：参数被拒绝、管道断了、被信号杀死……
  const exitOnly = [
    ["参数被拒绝", { exitCode: 2, stderr: "error: unknown option" }],
    ["stdout 管道断了", { exitCode: 141, stderr: "" }],
    ["其他退出码（比如 1）", { exitCode: 1, stderr: "" }],
    ["被信号杀死", { exitCode: null, signal: "SIGKILL", stderr: "" }],
  ].map(([name, details]) => {
    const error = errorForExit(details);
    return { CLI结果: name, 退出码: details.exitCode ?? details.signal, "有 exec.completed 时 SDK 抛出": "（不存在这种结果）", "只有退出码时 SDK 抛出": describeError(error), fromResult: undefined, fromExit: error };
  });
  return { rows, exitOnly };
}

/** 录像里的两种坏结局：被取消、上游模型服务报错。SDK 抛出的错误里带着什么。 */
export async function failureRecordings() {
  const { errorForResult } = await importSource("packages/code-sdk/src/errors.ts");
  const out = [];
  for (const name of ["cancelled", "failed-upstream"]) {
    const folded = await foldRecording(name);
    const error = errorForResult(folded.result, folded.items, { exitCode: 0, stderr: "" });
    out.push({ name, folded, error });
  }
  return out;
}

// ─── 场景四：同一份内部事件，exec 和 ACP 各说什么 ──────────────────────────────

const call = (status, extra = {}) => ({ id: "call_1", name: "bash", status, input: { command: "ls" }, ...extra });
const delta = (extra) => ({ type: "delta", role: "assistant", messageId: "m1", ...extra });

/**
 * 运行时交给适配器的内部事件（TuiStreamEvent）。形状按上游 SDK 契约测试里用的那几种写：
 * `delta` 是增量（可以同时带文字、思考、工具调用），`message` 是一条完整的消息。
 */
export const INTERNAL_EVENTS = [
  ["增量：思考 “plan”", delta({ thinking: "plan" })],
  ["增量：文字 “Hel”", delta({ content: "Hel" })],
  ["增量：文字 “lo”，同时带出工具调用", delta({ content: "lo", toolCalls: [call(1)] })],
  ["增量：工具调用的状态没变", delta({ toolCalls: [call(1)] })],
  ["增量：工具调用完成", delta({ toolCalls: [call(2, { output: { content: [] } })] })],
  ["完整消息 m1（文字 + 思考 + 工具）", { type: "message", message: { role: "assistant", id: "m1", thinking: "plan", content: "Hello", toolCalls: [call(2, { output: { content: [] } })] } }],
  ["完整消息 m2（没有增量，直接给整条）", { type: "message", message: { role: "assistant", id: "m2", content: "补出来的历史", toolCalls: [call(2, { id: "call_2", output: { content: [] } })] } }],
];

const execText = (event) => {
  if (!event.item) return event.type;
  const [, content] = describeEvent(event);
  const name = event.item.type === "tool_call" ? event.item.toolCall.name : event.item.type;
  return `${event.type} ${name} ${content}`.trim();
};

const acpText = (update) => {
  const text = update.content?.text;
  if (update.sessionUpdate === "tool_call") return `tool_call ${update.title}（${update.status}）`;
  if (update.sessionUpdate === "tool_call_update") return `tool_call_update（${update.status}）`;
  return `${update.sessionUpdate} ${quote(text)}`;
};

export async function projections() {
  const { ExecEventProjector } = await importSource("packages/tui/src/headless/events.ts");
  const { TuiAcpUpdateProjector } = await importSource("packages/tui/src/acp/updates.ts");
  const exec = new ExecEventProjector({ runId: "exec_1", sessionId: "s", turnId: "t", resumed: false, nowMs: () => 0 });
  const acp = new TuiAcpUpdateProjector();
  const rows = [];
  const detail = [];
  for (const [label, event] of INTERNAL_EVENTS) {
    const execEvents = exec.project(event);
    const acpUpdates = acp.project(event);
    detail.push({ label, execEvents, acpUpdates });
    rows.push({
      内部事件: label,
      "exec 的 JSONL 事件": execEvents.map(execText).join("；") || "（无）",
      "ACP 的 session/update": acpUpdates.map(acpText).join("；") || "（无）",
    });
  }
  const terminal = exec.complete({ schemaVersion: 1, type: "exec.result", runId: "exec_1", sessionId: "s", turnId: "t", status: "succeeded", output: "Hello", durationMs: 1 });
  rows.push({
    内部事件: "Turn 成功结束",
    "exec 的 JSONL 事件": terminal.map((event) => (event.type === "exec.completed" ? "exec.completed（result.status=succeeded）" : event.type)).join("；"),
    "ACP 的 session/update": "（无）——结束是 session/prompt 请求的响应 { stopReason: end_turn }",
  });
  return { rows, detail, terminal };
}

// ─── 场景五：断线、重放与对账（用 host 的真实 Turn） ─────────────────────────────

/** 在临时目录里跑一个真实的 host Turn，所有帧同时写进 EventStore 和一个一直在线的 collector。 */
async function withRecordedTurn(work) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch10-")));
  const root = join(temp, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "文件 a\n");
  writeFileSync(join(root, "b.txt"), "文件 b\n");
  try {
    const store = new EventStore(join(temp, "events.jsonl"));
    const live = await collector("T");
    const outcome = await runTurn({
      sessionId: "S",
      turnId: "T",
      text: "读 a 和 b，然后总结",
      root,
      prompt: { system: [] },
      tools: localTools(root),
      rules: { allow: ["read"] },
      model: scriptedKernel([
        { text: "先读两个文件。", calls: [{ id: "ra", name: "read", input: { path: "a.txt" } }, { id: "rb", name: "read", input: { path: "b.txt" } }] },
        { text: "两个文件都读完了。" },
      ]),
      // 和 app.mjs 的 write 一样：先记进 EventStore，再交给客户端。
      write: async (frame) => {
        store.append(frame);
        live.apply(frame);
      },
      persist: async () => {},
    });
    return await work({ store, live, outcome });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** 客户端在第 CUT 帧之后断线。再用不同的办法接上，看谁能得到和“一直在线”相同的结果。 */
export async function reconnects(CUT = 5) {
  return withRecordedTurn(async ({ store, live, outcome }) => {
    const truth = JSON.stringify(live.result());
    const frames = store.replay("T");

    /** 一个已经收了前 CUT 帧、然后断线的客户端。 */
    const disconnected = async () => {
      const client = await collector("T");
      for (const frame of frames.filter((f) => f.seq <= CUT)) client.apply(frame);
      return client;
    };
    const fresh = () => collector("T");
    const tampered = frames.map((f) => (f.seq === 3 ? { ...f, item: { ...f.item, contentDelta: "被篡改的文字" } } : f));

    const attempts = [
      ["从游标继续", `原客户端收 replay(T, ${CUT})`, async () => feed(await disconnected(), store.replay("T", CUT))],
      ["整段重放，和已收到的重叠", "原客户端收 replay(T)", async () => feed(await disconnected(), store.replay("T"))],
      ["新客户端，整段重放", "新 collector 收 replay(T)", async () => feed(await fresh(), store.replay("T"))],
      ["新客户端，只重放游标之后", `新 collector 收 replay(T, ${CUT})`, async () => feed(await fresh(), store.replay("T", CUT))],
      ["游标往后跳了一格", `原客户端收 replay(T, ${CUT + 1})`, async () => feed(await disconnected(), store.replay("T", CUT + 1))],
      ["重放的帧和之前不一样", "原客户端收被改过的第 3 帧", async () => feed(await disconnected(), tampered)],
      ["游标超过最后一帧", "store.replay(T, 99)", async () => feed(await disconnected(), store.replay("T", 99))],
      ["终态之后又来一帧", "completed 之后再喂一帧", async () => {
        const client = await fresh();
        feed(client, frames);
        return feed(client, [{ ...frames.at(-1), seq: frames.length + 1, type: "item.started", item: { id: "x", type: "agent_message" } }]);
      }],
    ];
    const rows = [];
    for (const [name, what, run] of attempts) {
      let outcomeText, same, error;
      try {
        const result = await run();
        same = JSON.stringify(result) === truth;
        outcomeText = `${result.status}，${result.lastSeq} 帧，${result.items.length} 个 item`;
      } catch (caught) {
        error = caught;
        outcomeText = `抛出：${caught.message}`;
        same = false;
      }
      rows.push({ 办法: name, 做法: what, 结果: outcomeText, "与一直在线一致": error ? "—" : same ? "是" : "否", error });
    }
    return { rows, truth: live.result(), frames, outcome, CUT };
  });
}

/** 把一批帧依次喂给 collector，返回它的当前结果。 */
function feed(client, frames) {
  for (const frame of frames) client.apply(frame);
  return client.result();
}
