// 第 9 章：子任务与分叉。
//
// MiniMax Code 里有两种“从一个会话长出另一个会话”，源码也在两个地方：
//
//   1. 子任务（Task 工具启动的子 Agent）——local-runtime/src/api/local-task-runner.ts 的 runForegroundLocalTask
//      和 injected-conversation-task-turn.ts。子任务是一个新的隐藏会话（sessionKind: 'task'，带 parentSessionId），
//      它的工作和普通用户消息走同一条路：先进子会话的队列（clientRequestId = `task-turn:${turnId}`），再被派发。
//      父任务被取消时做两件事：撤销还在排队的那一项；再取消那一个确切的 Turn。
//      内置的 explore 角色只读，源码里是 forceReadOnlyFilesystem（local-turn-execution-preparation.ts）。
//      → host 的 `forkTask`。
//
//   2. 会话分叉（/fork，以及 /btw 的旁路会话）——application/session/conversation-fork-service.ts。
//      把一个会话到某个“已经收尾”的位置为止的历史复制到一个新会话里。它是一个分阶段、能续跑的工作流：
//      validated → session-created → history-published → … → child-visible，
//      每一阶段落盘；用同一个 operationId 重试，要么直接拿回上次的结果，要么从上次停下的阶段接着做，
//      不会造出第二个子会话。失败时由 compensate* 清理已经创建的资源。
//      → host 的 `forkSession`。
//
// 简化：host 的 Sessions 不能删除会话，所以 forkSession 没有补偿步骤；分叉点只做“历史已收尾”这一项检查；
// forkTask 的新会话是空的，不带父会话的历史（MiniMax 的 Task 子会话同样从子任务的提示词开始）。
import { join } from "node:path";
import { Journal } from "../../runtime/journal.mjs";

// ─── 子任务 ─────────────────────────────────────────────────────────────────

/**
 * 在新会话里运行一个子任务，只给 `allowTools` 里的工具（默认只有 read）；`rules` 是权限规则，原样交给 app.run。
 * 返回 `{ sessionId, ...app.run 的结果 }`，与之前一致；另外多了 `queueItemId`。
 *
 * 隔离的边界要说清楚：新会话隔离的是历史和任务身份，工具目录里真的没有 edit，
 * 但工作目录仍然是父会话的——这不是 worktree，也不是系统沙箱。
 */
export async function forkTask(app, parentSessionId, task, { model, signal, allowTools = ["read"], rules } = {}) {
  const parent = app.sessions.get(parentSessionId);
  const child = app.sessions.create(parent.workspaceDir);

  // 子任务也走队列：身份是 `task-turn:<子会话>`。以后无论“它在不在排队”，都能用这个身份找到它。
  const item = app.queue.enqueue(child.id, task, { clientRequestId: `task-turn:${child.id}` });

  // 父任务取消 → 子任务取消。分两步，顺序不能反（injected-conversation-task-turn.ts 的 cancelAcceptedTask）：
  //   ① 还在排队就撤销排队项，它就不会再被派发；
  //   ② 再取消子会话里正在跑的那个 Turn（没有在跑就什么也没发生）。
  // 注释里写得很明白：即使队列那一步失败，也不能跳过第二步——被 claim 的子 Turn 可能已经在执行。
  const cancelChild = () => {
    const failures = [];
    try {
      app.queue.cancel(item.id);
    } catch (error) {
      failures.push(error);
    }
    app.cancel(child.id);
    if (failures.length) throw failures[0];
  };

  if (signal?.aborted) {
    cancelChild();
    return { sessionId: child.id, queueItemId: item.id, status: "cancelled", error: "Operation aborted", messages: [] };
  }
  // app.next 取走子会话队列里的这一项，接纳之后才运行。signal 被同步转交给 app.run，
  // 所以 Turn 已经开始之后的取消会先到达那个 Turn 的 controller（带着父任务给的原因）；
  // 下面的 cancelChild 再补上“还在排队”这一种情况。
  const running = app.next(child.id, { model, signal, allowTools, rules });
  signal?.addEventListener("abort", cancelChild, { once: true });
  try {
    const result = await running;
    return { sessionId: child.id, queueItemId: item.id, ...result };
  } finally {
    signal?.removeEventListener("abort", cancelChild);
  }
}

// ─── 会话分叉 ───────────────────────────────────────────────────────────────

/**
 * 最长的“已收尾”前缀的长度：前缀里每个 assistant 消息请求的工具调用，都有对应的结果。
 * 把分叉点切在一个没有执行完的工具调用中间，子会话里的历史会有“有调用、没结果”的断头——
 * 这是分叉的服务在复制之前要先拒绝的（对应 inspectCanonicalHistorySequence 的 settled 判断）。
 * 返回值不超过 `limit`。
 */
export function settledPrefix(messages, limit = messages.length) {
  let open = new Set();
  let settled = 0;
  for (let i = 0; i < Math.min(limit, messages.length); i++) {
    const message = messages[i];
    if (message.role === "assistant") open = new Set((message.calls ?? []).map((call) => call.id));
    else if (message.role === "tool") open.delete(message.id);
    if (open.size === 0) settled = i + 1;
  }
  return settled;
}

/**
 * 把 `sourceId` 会话的历史前缀复制到一个新会话。
 *
 * 每一个阶段都先写进 forks.jsonl 再往下做。用同一个 operationId 再调用：
 *   - 已经完成：直接返回上次的结果，status 是 duplicate；
 *   - 停在中间（上次崩溃了）：从停下的那一阶段继续，沿用同一个子会话；
 *   - 同一个 operationId 但请求不同：request-conflict——这个 id 已经属于另一个请求。
 *
 * @param options.throughLength 复制前 N 条消息（默认：能复制的最长已收尾前缀）
 * @param options.stopAfter    实验用：在某个阶段落盘之后抛错，模拟进程在这里崩溃
 */
export function forkSession(app, sourceId, { operationId, throughLength, stopAfter } = {}) {
  if (!operationId) throw Error("operationId required");
  const ledger = new Journal(join(app.sessions.dataDir, "forks.jsonl"));
  const rows = ledger.read().filter((row) => row.operationId === operationId);
  const last = rows.at(-1);
  const request = { sourceId, throughLength: throughLength ?? null };

  if (last && JSON.stringify(last.request) !== JSON.stringify(request)) throw Error("request-conflict");
  if (last?.stage === "published") return { status: "duplicate", childId: last.childId, length: last.length };

  // 记一个阶段并（实验里）可以在这里“崩溃”。
  const record = (stage, extra) => {
    ledger.append({ operationId, request, stage, ...extra });
    if (stage === stopAfter) throw Error(`crashed after ${stage}`);
  };

  // ① validated：来源会话存在，分叉点落在已收尾的位置。
  let state = { ...last };
  if (!last) {
    const source = app.sessions.get(sourceId);
    const messages = app.sessions.history(sourceId);
    const length = settledPrefix(messages, throughLength ?? messages.length);
    if (throughLength !== undefined && length !== throughLength) throw Error("assistant-not-settled");
    if (length === 0) throw Error("invalid-boundary");
    state = { length, workspaceDir: source.workspaceDir };
    record("validated", { length, workspaceDir: source.workspaceDir });
  }

  // ② session-created：只创建一次。停在这之后再来，就沿用 childId。
  if (!state.childId) {
    const child = app.sessions.create(state.workspaceDir);
    state.childId = child.id;
    record("session-created", { length: state.length, workspaceDir: state.workspaceDir, childId: child.id });
  }

  // ③ history-published：复制前缀。子会话已经有历史就跳过——重复复制会让每条消息出现两次。
  if (app.sessions.history(state.childId).length === 0) {
    const prefix = app.sessions.history(sourceId).slice(0, state.length);
    app.sessions.append(state.childId, `fork:${operationId}`, prefix);
  }
  if (last?.stage !== "history-published") {
    record("history-published", { length: state.length, childId: state.childId });
  }

  // ④ published：结果落盘，之后的重试都直接拿回这个结果。
  record("published", { length: state.length, childId: state.childId });
  return { status: "created", childId: state.childId, length: state.length };
}
