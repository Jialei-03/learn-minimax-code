// 第 2 章的实验场景。每个函数只返回数据，由 order.mjs / lifecycle.mjs / endings.mjs 打印成表格，
// 也被 labs/chapters/02-turn.mjs 用来做回归检查。全部离线、确定，不需要 API Key。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SerialDelivery } from "../../host/src/events.mjs";
import { runTurn } from "../../host/src/turns.mjs";
import { localTools } from "../../host/src/tools.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";

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

// ─── 场景一：同样的事件、同样的慢 writer，有队列和没队列 ─────────────────────────
//
// 一个带两个并行工具的 Turn 会在不同时刻产生下面这些事件（时刻单位毫秒）。
// writer 写一帧要花的时间并不固定：磁盘同步、网络抖动都会让个别帧特别慢。
// 这里让“工具 a 的开始”和“消息的完成”各慢 100ms，其余 3ms。
const TIMELINE = [
  { at: 0, frame: "turn.started", cost: 3 },
  { at: 20, frame: "item.started 消息", cost: 3 },
  { at: 40, frame: "item.started 工具 a", cost: 100 },
  { at: 40, frame: "item.started 工具 b", cost: 3 },
  { at: 100, frame: "item.completed 工具 b", cost: 3 },
  { at: 180, frame: "item.completed 工具 a", cost: 3 },
  { at: 200, frame: "item.completed 消息", cost: 100 },
  { at: 220, frame: "turn.completed", cost: 3 },
];

/** 按时间线产生事件，交给 `deliver(frame)`，记录每帧到达 sink 的先后。 */
async function playTimeline(makeDeliver) {
  const arrived = [];
  const writer = async (entry) => {
    await sleep(entry.cost);
    arrived.push(entry.frame);
  };
  const deliver = makeDeliver(writer);
  const started = performance.now();
  await Promise.all(
    TIMELINE.map(async (entry) => {
      await sleep(Math.max(0, entry.at - (performance.now() - started)));
      deliver.send(entry);
    }),
  );
  await deliver.settle();
  return arrived;
}

export async function deliveryOrder() {
  // 朴素做法：事件一产生就直接调 writer，不排队，也不等前一个写完。
  const naive = await playTimeline((writer) => {
    const inflight = [];
    return {
      send: (entry) => inflight.push(writer(entry)),
      settle: () => Promise.all(inflight),
    };
  });
  // MiniMax 的做法：所有事件先进同一条队列，队列一个一个写。
  const serial = await playTimeline((writer) => {
    const queue = new SerialDelivery(writer);
    return { send: (entry) => queue.send(entry), settle: () => queue.drain() };
  });
  const rows = TIMELINE.map((entry, index) => ({
    产生顺序: index + 1,
    "产生时刻(ms)": entry.at,
    帧: entry.frame,
    朴素直写的到达名次: naive.indexOf(entry.frame) + 1,
    串行队列的到达名次: serial.indexOf(entry.frame) + 1,
  }));
  return { rows, naive, serial, produced: TIMELINE.map((entry) => entry.frame) };
}

// ─── 场景二：一个带两个并行工具的真实 Turn，事件和历史写入的先后 ────────────────────
function sleepingTool(name, ms) {
  return {
    name,
    source: "builtin",
    readOnly: true,
    executionMode: "parallel",
    async execute() {
      await sleep(ms);
      return { text: `${name} 的结果` };
    },
  };
}

const describeItem = (item) =>
  item.type === "tool_call"
    ? `工具 ${item.toolCall.name} → ${item.toolCall.status}`
    : `消息 ${item.id.split(":").pop()}${item.toolCalls ? `（${item.toolCalls.map((c) => `${c.name}:${c.status}`).join(" ")}）` : ""}`;

const describeFrame = (frame) =>
  frame.type === "turn.started"
    ? "turn.started"
    : frame.type === "turn.completed"
      ? `turn.completed（${frame.status}）`
      : `${frame.type} ${describeItem(frame.item)}`;

const describeRows = (messages) =>
  messages
    .map((m) => (m.role === "assistant" ? `assistant${m.calls?.length ? `（${m.calls.length} 个调用）` : ""}` : m.role === "tool" ? `tool ${m.id}` : m.role))
    .join("、");

export async function lifecycle() {
  const timeline = [];
  const result = await runTurn({
    sessionId: "s",
    turnId: "T",
    text: "读 a 和 b，然后总结",
    root: tmpdir(),
    prompt: { system: [] },
    tools: [sleepingTool("slow_a", 60), sleepingTool("fast_b", 5)],
    model: scriptedKernel([
      { text: "先读两个文件。", calls: [{ id: "a", name: "slow_a", input: {} }, { id: "b", name: "fast_b", input: {} }] },
      { text: "两个文件都读完了。" },
    ]),
    write: async (frame) => timeline.push({ 通道: "事件帧", 内容: `#${frame.seq} ${describeFrame(frame)}` }),
    persist: async (messages) => timeline.push({ 通道: "历史写入", 内容: describeRows(messages) }),
  });
  const rows = timeline.map((row, index) => ({ 步骤: index + 1, ...row }));
  return { rows, result };
}

// ─── 场景三：七种结局 ─────────────────────────────────────────────────────────
async function withWorkspace(work) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch02-")));
  const root = join(temp, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "old");
  try {
    return await work(root);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const editCall = { id: "e", name: "edit", input: { path: "a.txt", old: "old", next: "new" } };

/** 跑一个 Turn：记录送达的帧、写入历史的批次、实际执行过的工具。 */
async function observe({ name, replies, write, persist, hooks, abortAfterMs }) {
  return withWorkspace(async (root) => {
    const frames = [];
    const history = [];
    const ran = [];
    const controller = new AbortController();
    const tools = [
      // 在每个真实工具外面包一层，记下它有没有被执行过。
      ...localTools(root).map((tool) => ({
        ...tool,
        execute: (input, context) => {
          ran.push(tool.name);
          return tool.execute(input, context);
        },
      })),
      {
        name: "wait",
        source: "builtin",
        readOnly: true,
        // 一个只有收到取消信号才会返回的长工具。
        execute: (input, context) =>
          new Promise((resolve) => {
            ran.push("wait");
            context.signal.addEventListener("abort", () => resolve({ text: "已中断", isError: true }), { once: true });
          }),
      },
    ];
    if (abortAfterMs) setTimeout(() => controller.abort(Error("user cancelled")), abortAfterMs);
    const result = await runTurn({
      sessionId: "s",
      turnId: "T",
      text: "把 a.txt 里的 old 改成 new",
      root,
      prompt: { system: [] },
      tools,
      rules: { allow: ["edit"] },
      signal: controller.signal,
      hooks,
      model: typeof replies === "function" ? replies : scriptedKernel(replies),
      write: async (frame) => {
        await write?.(frame);
        frames.push(frame);
      },
      persist: async (messages) => {
        await persist?.(messages);
        history.push(...messages);
      },
    });
    const last = frames.at(-1);
    return {
      name,
      result,
      frames,
      history,
      ran: [...new Set(ran)],
      fileChanged: readFileSync(join(root, "a.txt"), "utf8") !== "old",
      last: last ? (last.type === "turn.completed" ? `turn.completed(${last.status})` : last.type) : "（没有）",
    };
  });
}

const withEdit = [{ text: "我来改。", calls: [editCall] }, { text: "改好了。" }];

export async function endings() {
  const runs = [
    await observe({ name: "正常结束", replies: withEdit }),
    await observe({ name: "用户在工具运行时取消", replies: [{ calls: [{ id: "w", name: "wait", input: {} }] }], abortAfterMs: 30 }),
    await observe({
      name: "模型请求失败",
      replies: async () => {
        throw Error("503 upstream unavailable");
      },
    }),
    await observe({
      name: "writer 在第一段文字上失败",
      replies: withEdit,
      write: (frame) => {
        if (frame.type === "item.updated") throw Error("writer unavailable");
      },
    }),
    await observe({
      name: "历史写不进去",
      replies: withEdit,
      persist: () => {
        throw Error("disk full");
      },
    }),
    await observe({
      name: "afterModel 钩子否决回复",
      replies: withEdit,
      hooks: { afterModel: () => ({ type: "fail", reason: "edit is not allowed in this turn" }) },
    }),
    await observe({
      name: "终态帧写不出去",
      replies: [{ text: "好了。" }],
      write: (frame) => {
        if (frame.type === "turn.completed") throw Error("writer closed");
      },
    }),
  ];
  const rows = runs.map(({ name, result, ran, fileChanged, last }) => ({
    结局: name,
    status: result.status,
    最后送达的帧: last,
    执行过的工具: ran.join("、") || "—",
    文件被改: fileChanged ? "是" : "否",
    "persisted / delivered": `${result.persisted} / ${result.delivered}`,
    失败归因: result.failure ? `${result.failure.source} / ${result.failure.kind}` : "—",
  }));
  return { rows, runs };
}
