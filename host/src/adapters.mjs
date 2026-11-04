// 第 1 章：三个入口。
//
// 对应 MiniMax Code 0.7.2 里 packages/tui/src 下的三个“表面”（surface）：
//   tui   ← tui/controller/chat-controller.ts      交互：回车发送，Esc 取消，状态行显示结局
//   exec  ← cli/run-exec-command.ts + headless/runner.ts   一次性：参数进，退出码出
//   acp   ← acp/agent.ts                           编辑器协议：session/new、session/prompt、session/cancel
//
// 三个入口做同样三件事：
//   1. 把自己的请求形状翻译成同一个调用。MiniMax 调 `CliService.sendMessage`，这里调 `app.run`。
//   2. 用同一个 `RunCoordinator`（MiniMax 的 `TuiRunCoordinator`，application/run-coordinator.ts）驱动一次运行：
//      取消句柄、“这个客户端同一时刻只有一次运行”都放在这里，三个入口各 new 一个，谁也不重写。
//   3. 把同一个结局翻译成自己的语言：tui 是状态行文字，exec 是退出码，acp 是 stopReason。
//
// 入口自己不保存历史，也不保存“会话在忙”：这两样状态在 Sessions 里（sessions.mjs）。
// 入口里只有“一次连接”的状态：ACP 连接对会话的附着、一次运行的取消句柄，进程退出就没了。
//
// 简化：真实的 exec 还有输出格式（text / json / stream-json）、超时、--output-schema 等，
// 真实的 ACP 还有模式切换、权限请求、会话历史回放；这里只留“翻译”本身。
//
// 失败路径和上一版不同：会话不存在、会话正在忙这类“预期内的拒绝”不再抛出异常，
// 而是和 MiniMax 的 `TuiTurnRunOutcome` 一样变成 `outcome.status === "failed"`，
// 由各个入口按自己的语言说出来；成功路径的返回值只是多了几个字段。
import { resolve } from "node:path";

// ─── 一次运行的结局（对应 application/turn-run-outcome.ts）──────────────────────

/** host 的 Turn 状态 → 入口看到的结局状态。 */
const OUTCOME_OF = {
  completed: "succeeded",
  budget: "limit_exceeded",
  cancelled: "cancelled",
  failed: "failed",
};

/** exec 的退出码，数值和 headless/exit-policy.ts 的 `MINIMAX_CODE_EXEC_EXIT_CODES` 一致。 */
export const EXIT_CODES = Object.freeze({
  success: 0,
  invocation: 2,
  config: 3,
  runtime: 4,
  timeout: 6,
  limit: 7,
  internal: 70,
  cancelled: 130,
  brokenPipe: 141,
});

/** 对应 `exitCodeForExecResult`：失败按类别分，其余一种结局一个码。 */
export function exitCodeOf(outcome) {
  switch (outcome.status) {
    case "succeeded":
      return EXIT_CODES.success;
    case "failed":
      if (outcome.error?.category === "config") return EXIT_CODES.config;
      if (outcome.error?.category === "internal") return EXIT_CODES.internal;
      return EXIT_CODES.runtime;
    case "timeout":
      return EXIT_CODES.timeout;
    case "cancelled":
      return EXIT_CODES.cancelled;
    case "limit_exceeded":
      return EXIT_CODES.limit;
  }
  return EXIT_CODES.internal;
}

/** ACP 的协议错误码：JSON-RPC 的 internal error，对应 `acp.RequestError.internalError`。 */
export const ACP_INTERNAL_ERROR = -32603;

/**
 * 对应 acp/agent.ts 里 session/prompt 处理函数的结尾：
 * succeeded → end_turn，cancelled → cancelled，limit_exceeded → max_turn_requests，其余抛出内部错误。
 */
export function stopReasonOf(outcome) {
  if (outcome.status === "succeeded") return "end_turn";
  if (outcome.status === "cancelled") return "cancelled";
  if (outcome.status === "limit_exceeded") return "max_turn_requests";
  throw Object.assign(
    Error(`host runtime failed: ${outcome.error?.message ?? outcome.status}`),
    { code: ACP_INTERNAL_ERROR, data: outcome.error },
  );
}

/** tui 的状态行文字。 */
function statusLine(outcome) {
  switch (outcome.status) {
    case "succeeded":
      return "本轮已完成";
    case "cancelled":
      return "已取消";
    case "limit_exceeded":
      return "达到步数上限，已停止";
    default:
      return `失败：${outcome.error?.message ?? "未知错误"}`;
  }
}

// ─── RunCoordinator：三个入口共用的“驱动一次运行” ──────────────────────────────

/** 把运行时抛出的任何错误变成结局里的 error（对应 run-coordinator.ts 的 `execError`）。 */
function errorOf(error) {
  return {
    category: error.category ?? "runtime",
    code: error.code,
    message: error.message,
  };
}

/** Turn 自己的失败归因 `{ source, kind, message }`（第 2 章）也变成同样形状。 */
function errorOfFailure({ source, kind, message }) {
  return { category: "runtime", code: `${source}.${kind}`, message };
}

export class RunCoordinator {
  constructor(app) {
    this.app = app;
    this.activeRun = undefined; // { sessionId, controller }：只在这个客户端的内存里
  }

  /**
   * 跑一次。永远返回结果，不抛出“预期内的失败”：
   *   - 运行时接纳并跑完了：`status` 是 Turn 的状态，`outcome` 是翻译后的结局；
   *   - 没能开始（会话在忙、会话不存在……）：`status` 是 "rejected"，`outcome.status` 是 "failed"。
   */
  async execute(sessionId, text, options = {}) {
    // 这个客户端自己的保护。真正跨进程的保护是 Sessions 里的租约，两者互不替代。
    if (this.activeRun) {
      return this.rejected(Object.assign(Error("A run is already active."), { code: "client_run_active" }));
    }
    const controller = new AbortController();
    const forward = () => controller.abort(options.signal.reason);
    options.signal?.addEventListener("abort", forward, { once: true });
    if (options.signal?.aborted) forward();
    this.activeRun = { sessionId, controller };
    try {
      const result = await this.app.run(sessionId, text, { ...options, signal: controller.signal });
      const status = OUTCOME_OF[result.status] ?? "failed";
      const error = result.failure ? errorOfFailure(result.failure) : { category: "runtime", message: result.error ?? "failed" };
      return { ...result, outcome: { status, ...(status === "failed" ? { error } : {}) } };
    } catch (error) {
      return this.rejected(error);
    } finally {
      options.signal?.removeEventListener("abort", forward);
      this.activeRun = undefined;
    }
  }

  rejected(error) {
    return { status: "rejected", outcome: { status: "failed", error: errorOf(error) } };
  }

  /** 取消正在跑的那次运行；没有在跑的就返回 false。 */
  abort(reason = "user cancelled") {
    if (!this.activeRun) return false;
    this.activeRun.controller.abort(Error(reason));
    return true;
  }
}

// ─── 三个入口 ────────────────────────────────────────────────────────────────

/** exec 选会话：--session 指定的 / --continue 接上这个目录最近的 / 都没有就新建。 */
function resolveExecSession(app, { sessionId, continueSession, cwd }) {
  if (sessionId) return app.sessions.get(sessionId).id;
  // 相对路径在入口这一层就解析成绝对路径，Sessions.create 不替入口猜“当前目录”。
  const workspace = resolve(cwd ?? process.cwd());
  if (continueSession) {
    const latest = app.sessions.latest(workspace);
    if (!latest) {
      throw Object.assign(Error(`No active Session exists for workspace ${workspace}; omit --continue to start a new Session.`), { category: "runtime" });
    }
    return latest.id;
  }
  return app.sessions.create(workspace).id;
}

export function adapters(app) {
  // tui：整个终端进程一个协调器，像 ChatController 持有一个 TuiRunCoordinator。
  const terminal = new RunCoordinator(app);
  // acp：一条连接里，每个附着的会话一个协调器（acp/agent.ts 的 `sessions` Map）。
  const attached = new Map();
  const attach = (sessionId) => {
    if (!attached.has(sessionId)) attached.set(sessionId, new RunCoordinator(app));
    return attached.get(sessionId);
  };

  return {
    /** 交互终端：`(会话, 文本, 选项)`。返回运行结果，多一个 `notice` 给状态行。 */
    tui: async (sessionId, text, options) => {
      const result = await terminal.execute(sessionId, text, options);
      return { ...result, notice: statusLine(result.outcome) };
    },

    /**
     * 一次性命令：`({ prompt, sessionId?, continueSession?, cwd? }, 选项)`。
     * 返回运行结果，多一个 `exitCode`；失败时多一行 `stderr`，对应 `mcode exec failed: ...`。
     */
    exec: async (request, options) => {
      const run = new RunCoordinator(app); // 一个进程只跑一次，用完即弃
      let result;
      try {
        const sessionId = resolveExecSession(app, request);
        result = await run.execute(sessionId, request.prompt, options);
      } catch (error) {
        result = run.rejected(error);
      }
      const exitCode = exitCodeOf(result.outcome);
      const failed = result.outcome.status !== "succeeded";
      return { ...result, exitCode, ...(failed ? { stderr: `mcode exec ${result.outcome.status}: ${result.outcome.error?.message ?? ""}` } : {}) };
    },

    /**
     * 编辑器协议：`({ method, params }, 选项)`。
     *   session/new     {cwd}            新建会话，返回 { sessionId }
     *   session/prompt  {sessionId,text} 跑一次，返回 { stopReason }；失败抛出 -32603
     *   session/cancel  {sessionId}      取消这个会话上正在跑的 prompt
     */
    acp: async (request, options) => {
      const { method, params } = request;
      if (method === "session/new") {
        let session;
        try {
          session = app.sessions.create(params.cwd);
        } catch (error) {
          // ACP 规定 cwd 必须是绝对路径：这是调用方的参数错误（JSON-RPC 的 invalid params）。
          throw Object.assign(error, { code: -32602 });
        }
        attach(session.id);
        return { sessionId: session.id };
      }
      if (method === "session/cancel") {
        return { cancelled: attached.get(params.sessionId)?.abort("ACP session cancelled.") ?? false };
      }
      if (method !== "session/prompt") throw Error("unsupported ACP method");
      // 真实 ACP 要先 new 或 load 才能 prompt；这里 prompt 时顺手附着，方便沿用旧的调用方式。
      const result = await attach(params.sessionId).execute(params.sessionId, params.text, options);
      return { ...result, stopReason: stopReasonOf(result.outcome) };
    },
  };
}
