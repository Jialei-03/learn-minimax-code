// 第 2 章：一个 Turn 的一生。
//
// 对应 MiniMax Code 0.7.2 的三层代码：
//   1. agent-core/src/pi-turn-runner/pi-turn-runner.ts 的 `PiTurnRunner.runTurn`（Step 1～8）：
//      装配一个 Turn 需要的全部状态，交给 Pi 的 Agent 去跑，再把结局交付出去。
//   2. agent-core/src/pi-turn-runner/events.ts、history.ts 和 event-bridge/bridge.ts：
//      一条串行事件队列、按消息边界写历史的游标、工具全部结束后才发出的 completed 消息。
//   3. local-runtime-v2/.../agent-host/local-agent-host.ts：宿主先把终态“暂存”，
//      等队列排空、历史对齐之后才提交，并确认提交出去的终态和结局一致。
//
// 本文件把这三层压成同一个 `runTurn`，保留它们的先后顺序和失败归因，去掉不影响顺序的部分。
// MiniMax 的八步和本文件的对应关系：
//   Step 1 newTurn                    → newTurn()
//   Step 2 emitRunning                → announceRunning()
//   Step 3 newAgent / newHistory      → host 没有 Pi Agent；历史游标在 newTurn() 里创建，发给模型的请求副本在 askModel() 里生成
//   Step 4 setToolHooks / setLLMHook  → invokeTool() 里的 wrapTool 钩子，以及 applyAfterModelHook()
//   Step 5 subscribeEvents            → turn.delivery（SerialDelivery）和 emit()
//   Step 6 接取消信号                 → 每个边界处的 signal.throwIfAborted()
//   Step 7 runAgent                   → driveTurn() 里的循环
//   Step 8 drain / flushTail / 终态   → settleTurn()
//
// 简化：
//   - Pi 的 Agent 循环在 MiniMax 里是内核；这里用一个 `for` 循环代替（完整的循环见 Learn Pi Agent 第 3 章）。
//   - Pi 事件经 EventBridge 翻译成 RuntimeEvent；这里循环直接产出帧，但保留 EventBridge 的两个行为：
//     每个工具各发开始/结束帧，assistant 消息的 completed 等所有工具结束后才发。
//   - 取消时 MiniMax 会在终态前补发挂起的 completed 消息；这里直接丢弃，让 SDK 把这条消息标成 incomplete。
//
// 对外的 API（参数、返回值、帧的类型）和之前一致：新增的只有返回值里的 `failure`、
// 工具的 `item.*` 帧和 `hooks.afterModel`。其他章节、`app.mjs` 和实验照常使用。
//
// 第 12 章总装时，这个文件把前面几章的零件接了进来（都是可选输入，不传就和以前一样）：
//   - 第 4 章：一批工具调用怎么排，改用 `batchMode`（Pi 的整批规则，不再自己做相邻分组）；
//     调用一律走 `callTool`，找不到的工具、参数错误、权限拒绝由同一条流水线分类；
//     模型只看到 tool 消息的 `modelView`，`details` / `failure` 留给界面和日志；
//   - 第 6 章：请求副本由 `projectOutbound` 生成（第 5 章的 `projectMessages` 是它的初版，不再被 Turn 使用）；
//     每次请求模型之前先过 `compactBeforeModelCall`（`input.compaction`）；
//   - 第 9 章：每一步结束后向插话收件箱 `input.steering` 要一次插话，回答写完时“关门”。
import { SerialDelivery } from "./events.mjs";
import { historyCursor, projectOutbound, compactBeforeModelCall } from "./history.mjs";
import { toolCatalogue, callTool, batchMode, modelView } from "./tools.mjs";

// 工具输出写进事件帧时只留前 300 个字符：完整结果在历史里，事件流不需要再抄一份。
const OUTPUT_PREVIEW = 300;

/**
 * 运行一个 Turn，返回它的结局。
 *
 * 结局的 `status` 取值：
 *   completed  模型没有再请求工具，正常结束
 *   budget     用完 maxTurns 步，模型仍在请求工具
 *   cancelled  signal 被取消（对应 MiniMax 的 `aborted`）
 *   failed     模型、事件交付、历史写入或钩子出了问题；`failure` 说明是哪一个先出的问题
 */
export async function runTurn(input) {
  // Step 1：先建好这一次运行私有的全部状态。
  const turn = newTurn(input);
  let loopStatus = "completed";
  try {
    // Step 2、7：宣布开始，然后驱动模型和工具，直到循环自己停下。
    loopStatus = await driveTurn(turn);
  } catch (caught) {
    // 对应 `runAgent` 的 catch：循环里抛出的任何错误都不往外传，记下来，由 Step 8 统一给出结局。
    recordFailure(turn, "runner", "exception", caught);
  }
  // Step 8：收尾，宣布结局。
  return settleTurn(turn, loopStatus);
}

// ─── Step 1：newTurn ────────────────────────────────────────────────────────
// MiniMax 的 `newTurn(input, deps)` 为每个 Turn 新建 EventBridge、事件序号计数器、
// 工具列表和历史游标，`PiTurnRunner` 对象本身只保存进程级默认值。
// 这些东西不能跨 Turn 复用：序号会接着上一个 Turn 数，游标会指向别人的历史，取消状态会串台。
function newTurn(input) {
  const { sessionId, turnId, history = [], tools = [], write, persist, signal } = input;
  const messages = structuredClone(history);
  const turn = {
    input,
    sessionId,
    turnId,
    signal,
    messages, // 这个 Turn 看到的完整历史：先是旧历史，然后是本轮产生的消息
    catalogue: toolCatalogue(tools),
    // 历史游标从旧历史的末尾开始：旧历史属于调用方，不会再通知它一遍（history.ts 的 lastSnapshotLength）。
    cursor: historyCursor(messages.length, persist),
    seq: 0, // 帧序号由 host 这一侧生成，writer 写得再快再慢也不能重排它
    failure: undefined, // 第一个失败（根因），见 recordFailure
    stopped: false, // 对应 `forcedTermination`：某个钩子要求本 Turn 在当前这一步之后停下
    compactions: [], // 本 Turn 里每次请求前压缩钩子的结果（没配置压缩就一直是空的）
  };
  // 事件和历史写入共用这一条队列：队列坏了，历史也不再写（见 persistTail）。
  turn.delivery = new SerialDelivery(write, {
    onFailure: (error) => recordFailure(turn, "event_writer", "delivery", error),
  });
  return turn;
}

/** 给帧补上身份和序号，排进队列。帧一旦产生就拿到序号，后面的写入顺序只由队列决定。 */
function emit(turn, frame, options) {
  return turn.delivery.send(
    { ...frame, sessionId: turn.sessionId, turnId: turn.turnId, seq: ++turn.seq },
    options,
  );
}

/**
 * 记录失败归因：`source` 是哪个部件，`kind` 是哪类问题。
 * 和 MiniMax 的 `tryRecordTerminalFailure({ errorSource, errorKind })` 一样，第一个失败是根因，
 * 后面的失败都是连带的；取消不算失败。
 */
function recordFailure(turn, source, kind, error) {
  if (turn.failure || turn.signal?.aborted) return;
  turn.failure = { source, kind, message: String(error?.message ?? error) };
}

/** 运行一段工作；它抛出的错误先记下归因再原样抛出。 */
async function guard(turn, source, kind, work) {
  try {
    return await work();
  } catch (error) {
    recordFailure(turn, source, kind, error);
    throw error;
  }
}

// ─── Step 2、7：宣布开始、驱动循环 ───────────────────────────────────────────

async function driveTurn(turn) {
  const { text, maxTurns = 8 } = turn.input;
  turn.messages.push({ role: "user", text });

  // Step 2：先宣布“开始了”，再请求模型，这样界面不用等到第一个字才有反应。
  await announceRunning(turn);

  // Step 7：Pi 的 Agent 在这里循环：请求模型 → 执行工具 → 把结果交回去。
  // 默认结局是 budget（跑满 maxTurns 仍没停）；每一条“正常停下”的出路都显式改成 completed。
  for (let iteration = 1; iteration <= maxTurns; iteration++) {
    const calls = await runStep(turn, iteration);
    if (turn.stopped) return "completed";
    if (calls.length) {
      await takeSteering(turn, "tool"); // 工具回合之后，模型下一步就能读到用户递来的纸条
      continue;
    }
    // 这一步没有工具调用：回答写完了，想收尾。先看有没有必须处理的插话，再“关门”。
    if ((await takeSteering(turn, "exit")) > 0) continue;
    const door = turn.input.steering?.tryBeginClose();
    if (!door || door.closed || door.reason !== "steer-pending") return "completed";
    // 有一条插话正在被消费：不能关，再跑一圈。
  }
  return "budget";
}

/**
 * 每一步结束后问收件箱要插话（第 9 章的 `SteeringBuffer.poll`，对应 Pi 的 getSteeringMessages）。
 * 取到的插话变成历史里的用户消息，立刻写盘，然后下一次请求模型就带上它们。
 * 回答写完（exit）的边界上，用户的插话不会延长这条回答：poll 把它们留着，等关门时变成下一个 Turn。
 */
async function takeSteering(turn, boundary) {
  const inbox = turn.input.steering;
  if (!inbox) return 0;
  const taken = inbox.poll(boundary);
  if (!taken.length) return 0;
  for (const message of taken) turn.messages.push({ role: "user", text: message.text, steered: true });
  await persistTail(turn);
  return taken.length;
}

async function announceRunning(turn) {
  await emit(turn, { type: "turn.started" });
  // MiniMax 的 `emitRunning` 在 writer 失败时直接抛出：连“开始了”都说不出去，就不该开始。
  if (turn.delivery.error) throw turn.delivery.error;
}

/** 一步：一次模型回复，加上它请求的所有工具。返回这次回复里实际保留的工具调用。 */
async function runStep(turn, iteration) {
  const { signal } = turn;
  signal?.throwIfAborted();
  const reply = await askModel(turn, iteration);
  const calls = reply.calls ?? [];

  // message_start / message_update：assistant 消息开始，文字作为增量送出。
  const item = { id: `${turn.turnId}:${iteration}`, type: "agent_message" };
  await emit(turn, { type: "item.started", item });
  if (reply.text) {
    await emit(turn, { type: "item.updated", item: { ...item, contentDelta: reply.text } });
  }
  turn.messages.push({ role: "assistant", text: reply.text ?? "", calls });

  // message_end：没有工具要等，消息立刻完成；然后把这条回复写进历史。
  // 有工具调用时，历史先写：回复和它请求的调用必须先留下记录，才能去动手执行。
  if (!calls.length) {
    await emit(turn, { type: "item.completed", item: { ...item, content: reply.text ?? "" } });
  }
  await persistTail(turn);
  if (!calls.length) return calls;

  // tool_execution_start / end：每个工具各发一对帧，并行的工具会从不同的分支同时往队列里送。
  const results = await executeCalls(turn, item, calls);
  turn.messages.push(...results);
  await persistTail(turn);
  signal?.throwIfAborted();

  // assistant 消息的 completed 等所有工具结束后才发，带上每个调用的最终状态
  // （bridge.ts 的 pendingToolCount 和 flushPendingCompletedMessage）。
  // results 和 calls 的顺序一一对应。
  await emit(turn, {
    type: "item.completed",
    item: {
      ...item,
      content: reply.text ?? "",
      toolCalls: calls.map((call, i) => ({
        id: call.id,
        name: call.name,
        status: results[i].error ? "failed" : "completed",
      })),
    },
  });
  return calls;
}

/**
 * 发给模型的请求副本：存下来的历史经 `projectOutbound` 投影（第 6 章），再补上缺失的工具结果。
 * 历史本身一个字节都不动。
 *
 * 分工和 MiniMax / Pi 一致：宿主丢掉孤儿的工具结果（`projectAgentMessagesForModel`）；
 * “有调用却没有结果”的断头由 Pi 在发送前补一条（`transform-messages.ts` 的 No result provided），这里是 `fillMissingResults`。
 * 工具结果只给模型 `modelView`：文本和错误标记，`details`、`failure` 不出本机。
 */
function requestMessages(turn) {
  const model = turn.input.modelInfo ?? turn.input.compaction?.model ?? { id: "host" };
  const { messages } = projectOutbound(turn.messages, model);
  return fillMissingResults(messages).map((message) => (message.role === "tool" ? modelView(message) : message));
}

function fillMissingResults(messages) {
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.id));
  const filled = [];
  for (const message of messages) {
    filled.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.calls ?? []) {
      if (!answered.has(call.id)) {
        filled.push({ role: "tool", id: call.id, error: true, text: "interrupted tool call" });
      }
    }
  }
  return filled;
}

/**
 * 请求模型之前的压缩钩子（对应 Pi 循环里的 `transformContext` + `createAutomaticContextCompactionHook`）。
 * 摘要这一半失败，钩子自己返回 skipped，Turn 照旧用压缩前的历史；提交这一半失败，钩子抛错，
 * 这里记成 history 的失败，Turn 以 failed 结束——带着没存下来的新历史去请求模型，下次恢复就对不上了。
 */
async function compactIfNeeded(turn, iteration) {
  const options = turn.input.compaction;
  if (!options) return;
  const outcome = await guard(turn, "history", "compaction", () =>
    compactBeforeModelCall({
      ...options,
      messages: turn.messages, // 原地替换：turn.messages 始终是同一个数组
      cursor: turn.cursor,
      compactionId: `${turn.turnId}:${iteration}`,
    }),
  );
  turn.compactions.push({ iteration, status: outcome.status, before: outcome.before, after: outcome.after, rung: outcome.rung, reason: outcome.reason });
}

/** 请求模型，再让 afterModel 钩子有机会否决这条回复。 */
async function askModel(turn, iteration) {
  const { model, prompt, signal } = turn.input;
  await compactIfNeeded(turn, iteration);
  const request = {
    system: prompt.system,
    messages: requestMessages(turn),
    tools: [...turn.catalogue.values()].map((t) => ({ name: t.name, schema: t.schema })),
  };
  const reply = await guard(turn, "model", "request", async () => {
    const reply = await model(request, signal);
    signal?.throwIfAborted();
    if (reply.stop === "length") throw Error("truncated kernel response");
    return reply;
  });
  return applyAfterModelHook(turn, reply);
}

/**
 * 对应 events.ts 的 `applyAfterLlmControl`：回复交给下游之前，钩子可以整条否决。
 * 否决 = 回复里的工具调用一个都不能执行（Pi 在监听器返回之后才从这条消息里取工具调用，
 * 所以必须当场把它们剥掉），并且让整个 Turn 在这一步之后以 failed 结束。
 * 钩子自己抛错按否决处理：宁可停下，也不放行一条没有被检查过的回复。
 */
async function applyAfterModelHook(turn, reply) {
  const hook = turn.input.hooks?.afterModel;
  if (!hook) return reply;
  let verdict;
  try {
    verdict = await hook({ sessionId: turn.sessionId, turnId: turn.turnId, reply: structuredClone(reply) });
  } catch (error) {
    verdict = { type: "fail", reason: `after_llm_call_failed: ${error.message}` };
  }
  if (verdict?.type !== "fail") return reply;
  recordFailure(turn, "after_llm_hook", "rejected", Error(verdict.reason));
  turn.stopped = true;
  return { ...reply, calls: [] };
}

// ─── 工具执行 ──────────────────────────────────────────────────────────────

/**
 * 一条回复里的多个调用怎么排，由 `batchMode` 决定（第 4 章，Pi 的整批规则）：
 * 批次里只要有一个串行工具，整批按顺序一个个跑；否则整批并行。
 * 并行时 Promise.all 按调用顺序返回结果，所以历史里的顺序和完成的先后无关。
 */
async function executeCalls(turn, item, calls) {
  if (batchMode(calls, turn.catalogue) === "parallel") {
    return Promise.all(calls.map((call) => runCall(turn, item, call)));
  }
  const results = [];
  for (const call of calls) results.push(await runCall(turn, item, call));
  return results;
}

/** 一个工具调用：开始帧 → 执行 → 结束帧。结束帧里带上最终状态。 */
async function runCall(turn, item, call) {
  const entry = { id: call.id, type: "tool_call" };
  await emit(turn, {
    type: "item.started",
    item: { ...entry, toolCall: { id: call.id, name: call.name, status: "started", input: call.input } },
  });
  const result = await invokeTool(turn, item, call);
  await emit(turn, {
    type: "item.completed",
    item: {
      ...entry,
      toolCall: {
        id: call.id,
        name: call.name,
        status: result.error ? "failed" : "completed",
        output: String(result.text ?? "").slice(0, OUTPUT_PREVIEW),
      },
    },
  });
  return result;
}

/** 一次调用交给第 4 章的流水线（`callTool`）；任何一关失败都变成一条 isError 的结果，不抛异常。 */
function invokeTool(turn, item, call) {
  const { root, signal, rules = {}, mode, hooks = {}, sandboxRequired = false } = turn.input;
  const context = {
    root,
    signal,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    assistantMessageId: item.id, // 这个调用属于哪条 assistant 消息
    sandboxRequired,
  };
  return callTool(turn.catalogue, call, context, { ...hooks, rules, mode });
}

// ─── 历史 ──────────────────────────────────────────────────────────────────

/**
 * 把游标之后的新消息写进历史（`history.flushTail()`）。在两类边界调用：
 * assistant 消息结束之后、工具结果回来之后；Step 8 再补一次，写下没有边界回调的消息。
 *
 * 事件和历史在 MiniMax 里排在同一条 `OrderedAgentEventLane` 里：队列一旦出过错，
 * 后面的历史写入直接被挡下，抛出第一个错误，Pi 的循环随之停止。这里用同样的规则：
 * 事件已经送不出去，就不再往历史里写，也不再往下执行。
 */
function persistTail(turn) {
  return guard(turn, "history", "persistence", async () => {
    if (turn.delivery.error) throw turn.delivery.error;
    await turn.cursor.flush(turn.messages);
  });
}

// ─── Step 8：收尾 ──────────────────────────────────────────────────────────

/**
 * 循环已经停下，不会再产生新事件（MiniMax 此时先 `unsubscribe`）。
 * 顺序固定：排空队列 → 补写历史尾巴 → 决定结局 → 最后发出终态帧。
 * 终态帧是整个 Turn 的提交点：它前面的事件和历史都已经落地，它后面不能再有任何帧。
 */
async function settleTurn(turn, loopStatus) {
  // a) drain：让已经入队的帧全部写完。循环里的每个 emit 都被 await，这里通常已经是空的，是兜底；
  //    失败不在这里抛，onFailure 已经记下了归因。
  await turn.delivery.drain().catch(() => {});
  // b) flushTail：写下 Pi 追加、但没有对应边界回调的消息；失败同样已经记录。
  await persistTail(turn).catch(() => {});

  // c) 决定结局：`reason ?? forcedTermination ?? completed` 的 host 版本。
  const status = decideStatus(turn, loopStatus);
  const error = status === "cancelled" ? abortReason(turn.signal) : turn.failure?.message;

  // d) emitTerminal：失败和取消的终态允许越过已经断掉的队列（`continueAfterFailure`），
  //    让客户端知道这个 Turn 结束了；正常的终态不能越过，因为前面的帧缺了一块。
  const abnormal = status === "failed" || status === "cancelled";
  await emit(turn, { type: "turn.completed", status, ...(error ? { error } : {}) }, { force: abnormal });

  // e) 确认：终态也必须送到。一个没有送达的 completed 不能算成功。
  await turn.delivery.drain().catch(() => {});
  const finalStatus = turn.delivery.error && !abnormal ? "failed" : status;

  return {
    status: finalStatus,
    error: finalStatus === "cancelled" ? error : turn.failure?.message,
    failure: turn.failure, // { source, kind, message }：谁先出的问题
    messages: turn.messages,
    persisted: !turn.cursor.failed && turn.cursor.position === turn.messages.length,
    delivered: !turn.delivery.error,
    seq: turn.seq,
    ...(turn.compactions.length ? { compactions: turn.compactions } : {}),
  };
}

/** 对应 `runAgent`：先看取消，再看失败，都没有才是循环自己的结局。 */
function decideStatus(turn, loopStatus) {
  if (turn.signal?.aborted) return "cancelled";
  if (turn.failure) return "failed";
  return loopStatus;
}

const abortReason = (signal) => String(signal?.reason?.message ?? signal?.reason ?? "cancelled");
