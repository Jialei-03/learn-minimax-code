// 第 1 章的实验场景。busy.mjs / crash.mjs / surfaces.mjs 打印它们，
// labs/chapters/01-architecture.mjs 用同样的场景做回归检查。全部离线、确定，不需要 API Key。
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createApplication } from "../../host/src/app.mjs";
import { adapters } from "../../host/src/adapters.mjs";

/** 把对象数组打印成 Markdown 表格。 */
export function markdownTable(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${keys.join(" | ")} |`,
    `| ${keys.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(" | ")} |`),
  ].join("\n");
}

/** 一个临时世界：一个工作目录，一个数据目录。用完 `cleanup()`。 */
export function tempWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ch01-")));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  mkdirSync(workspace);
  return { root, workspace, data, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 启动一个“进程”：一个独立的 Application，加上它的三个入口适配器。
 * 两个进程用同一个数据目录，就像终端里的 mcode 和编辑器拉起的 mcode acp 共用 ~/.minimax-code。
 */
export async function startProcess(data) {
  const app = await createApplication(data);
  return { app, entries: adapters(app) };
}

/** 一个会一直等到 `release()` 才回复的模型，同时记下它开工时看到了几条消息。 */
export function gatedModel(label, seen) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  return {
    release,
    model: async (request) => {
      seen.push({ who: label, messages: request.messages.length });
      await gate;
      return { text: `${label} 的回复` };
    },
  };
}

/** 立刻回复的模型，同样记下开工时看到了几条消息。 */
export function instantModel(label, seen) {
  return async (request) => {
    seen.push({ who: label, messages: request.messages.length });
    return { text: `${label} 的回复` };
  };
}

/** 等到条件成立（最多 2 秒）。 */
export async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(10);
  if (!condition()) throw Error("等待超时");
}

/** 上一版的 `Sessions.admit`：“忙”只记在本进程的内存里。 */
export function useInMemoryFlags(sessions) {
  sessions.admit = (id, turnId) => {
    sessions.get(id);
    if (sessions.active.has(id)) throw Error("session busy");
    sessions.active.set(id, turnId);
    return () => {
      sessions.active.delete(id);
    };
  };
}

const short = (id) => String(id).slice(0, 8);

/**
 * 场景一：两个进程同时往同一个会话发消息。
 * 终端进程 P 先发（模型很慢），编辑器进程 Q 在 P 还没结束时也发。
 * `shared` 为 false 时，两个进程的 Sessions 都用上一版的内存标志；为 true 时用租约。
 */
export async function concurrentSend({ shared }) {
  const world = tempWorld();
  const seen = [];
  const P = await startProcess(world.data);
  const Q = await startProcess(world.data);
  if (!shared) {
    useInMemoryFlags(P.app.sessions);
    useInMemoryFlags(Q.app.sessions);
  }
  try {
    const session = P.app.sessions.create(world.workspace);
    const slowP = gatedModel("终端 P", seen);
    const slowQ = gatedModel("编辑器 Q", seen);

    const pRun = P.entries.tui(session.id, "重构 slug.js", { model: slowP.model });
    await until(() => seen.some((s) => s.who === "终端 P"));

    const qRun = Q.entries
      .acp({ method: "session/prompt", params: { sessionId: session.id, text: "跑一遍测试" } }, { model: slowQ.model })
      .then((result) => ({ result }), (error) => ({ error }));
    await sleep(60); // 留一点时间，让 Q 要么被接纳（模型开工），要么被拒绝
    const qAdmitted = seen.some((s) => s.who === "编辑器 Q");
    const holderWhileQSends = P.app.sessions.holder(session.id);

    slowP.release();
    const pResult = await pRun;
    let qOutcome;
    let retry;
    if (qAdmitted) {
      slowQ.release();
      qOutcome = await qRun;
    } else {
      qOutcome = await qRun; // 已经被拒绝
      // P 结束以后，Q 重试一次。
      retry = await Q.entries.acp(
        { method: "session/prompt", params: { sessionId: session.id, text: "跑一遍测试" } },
        { model: instantModel("编辑器 Q（重试）", seen) },
      );
    }
    const history = P.app.sessions.history(session.id);
    const turnIds = { P: pResult.turnId, Q: qOutcome.result?.turnId ?? retry?.turnId };
    const whoseTurn = (id) => Object.entries(turnIds).find(([, turnId]) => turnId === id)?.[0] ?? short(id);
    const lockEvents = P.app.sessions.locks.read().map((event) => ({ type: event.type, who: whoseTurn(event.turnId ?? event.ownerId.split(".").at(-1)) }));
    return {
      session,
      seen,
      qAdmitted,
      holderWhileQSends,
      pResult,
      qOutcome,
      retry,
      history,
      lockEvents,
      turnIds,
      activeAfter: [P.app.sessions.active.size, Q.app.sessions.active.size],
    };
  } finally {
    await Promise.all([P.app.close(), Q.app.close()]);
    world.cleanup();
  }
}

// ─── 场景二：同一个结局，三个入口各怎么说 ─────────────────────────────────────

/** 五种结局的触发办法。`setup` 在发请求之前布置现场，`model` 是脚本模型，`cancel` 表示要在模型开工后取消。 */
export const OUTCOME_SCENARIOS = [
  { name: "正常完成", model: async () => ({ text: "好了" }) },
  { name: "会话在别的进程里忙着", model: async () => ({ text: "好了" }), setup: (sessions, sessionId) => sessions.admit(sessionId, "turn-in-other-process") },
  {
    name: "用户取消",
    cancel: true,
    model: (_request, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  },
  { name: "模型请求出错", model: async () => { throw Error("upstream 500"); } },
  { name: "步数用完", maxTurns: 1, model: async () => ({ calls: [{ id: "c1", name: "no_such_tool", input: {} }] }) },
];

/** 在一个全新的会话上，用 `surface` 这个入口触发 `scenario`，返回这个入口给出的“说法”。 */
export async function sayIt(scenario, surface) {
  const world = tempWorld();
  const { app, entries } = await startProcess(world.data);
  try {
    const session = app.sessions.create(world.workspace);
    scenario.setup?.(new (app.sessions.constructor)(world.data), session.id); // 另一个“进程”先占住会话
    const options = { model: scenario.model, ...(scenario.maxTurns ? { maxTurns: scenario.maxTurns } : {}) };
    const controller = new AbortController();
    const started = new Promise((resolve) => {
      const inner = options.model;
      options.model = (request, signal) => (resolve(), inner(request, signal));
    });
    let reply;
    if (surface === "tui") {
      const run = entries.tui(session.id, "做点什么", { ...options, signal: controller.signal });
      if (scenario.cancel) await started, controller.abort(Error("user cancelled"));
      const result = await run;
      reply = { 说法: result.notice, result };
    } else if (surface === "exec") {
      const run = entries.exec({ sessionId: session.id, prompt: "做点什么" }, { ...options, signal: controller.signal });
      if (scenario.cancel) await started, controller.abort(Error("SIGINT"));
      const result = await run;
      reply = { 说法: `退出码 ${result.exitCode}`, result };
    } else {
      const request = { method: "session/prompt", params: { sessionId: session.id, text: "做点什么" } };
      const run = entries.acp(request, options).then((result) => ({ result }), (error) => ({ error }));
      if (scenario.cancel) await started, await entries.acp({ method: "session/cancel", params: { sessionId: session.id } });
      const { result, error } = await run;
      reply = result ? { 说法: `stopReason: ${result.stopReason}`, result } : { 说法: `JSON-RPC 错误 ${error.code}`, error };
    }
    return reply;
  } finally {
    await app.close();
    world.cleanup();
  }
}
