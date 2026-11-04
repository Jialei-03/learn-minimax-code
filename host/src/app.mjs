// 第 12 章：总装——把前十一章的零件装成一个应用。
//
// 对应 MiniMax Code 0.7.2 的四层装配（第 12 章逐段读过）：
//   1. local-runtime-v2/src/services.ts 的 `createRuntimeServices`
//      先建会话、模型、插件、提示这些“服务”，再把它们交给 Turn 系统。→ createApplication() 的上半部分
//   2. service/turn-system/initialize.ts 的 `initializeTurnSystem`
//      Turn 的仓库、控制器、队列分发器、释放信号。→ sessions / queue / runs 和 next()
//   3. service/turn-system/production-composition.ts 的 `createLocalAgentHost`
//      一个 Turn 要的全部依赖：工具、权限、提示、压缩、历史、用量、事件。→ run() 里交给 runTurn 的那一包参数
//   4. agent-host/local-agent-host.ts 的 `run` 与 execution.coordinator.ts 的 `settleAndRelease`
//      接纳 → 抓能力租约 → 装配 → 执行 → 收尾（暂停队列）→ 释放 → 才轮到下一个。→ run() 的前后两半
//
// 一次 `run()` 按下面的顺序走，每一步对应前面某一章：
//   ① 接纳（第 1 章）     sessions.admit：拿会话租约，这个会话从此“忙”
//   ② 拍照（第 5、8 章）  模板快照 + 项目指令/记忆（loadPromptLayers）+ 插件能力代的租约，同一个时刻
//   ③ 装配（第 4、5、8 章）工具目录 = 内置 + 本代插件 + skill；系统提示 = preparePrompt(快照, 磁盘材料, 能力清单)
//   ④ 回执（第 9 章）     如果这条消息来自队列，Turn 接纳它，队列才确认
//   ⑤ 执行（第 2、3、4、6、9 章） runTurn：压缩钩子、模型、工具、历史游标、串行交付、插话收件箱
//   ⑥ 收尾（第 8、9 章）  先还插件租约（host.run 的 finally）；再结算：剩下的插话各回各家，
//                        用户停止或失败 → 暂停队列，Turn 已送达已落盘 → 队列消费
//   ⑦ 释放（第 1 章）     放会话的“忙”，最后才让 close() 等到的 completion 兑现
//
// 总装时处理的跨章节问题（每一条在下面的代码里都有对应）：
//   - 第 5 章：项目指令、全局指令、记忆以前没人传，现在由 loadPromptLayers 读进来
//   - 第 6 章：压缩钩子在 runTurn 的每次请求之前调用；压缩提交通过 Sessions.replace 持久化
//   - 第 9 章：用户停止（和 Turn 失败）时暂停队列；app.steer 接上 SteeringBuffer；next 可以“继续”
//   - 第 1 章：释放租约的每一步都放进 try/finally，release() 抛错也不会让 close() 永远等下去；
//             租约被别人回收时，watchdog 主动中止 Turn，而不是等到下一次写历史才被挡下
//   - 第 4 章（turns.mjs）：批次调度和调用流水线改用 tools.mjs 的 batchMode 和 callTool
//   - 第 5/6 章（turns.mjs）：请求副本只剩一个入口 projectOutbound，不再有第二份 projectMessages
//
// 简化：
//   - MiniMax 的队列分发器在会话释放的那一刻自动派发下一条（`released.publish → dispatcher.dispatch`）；
//     host 把“派发”留给调用方的 `next()`，由调用方决定什么时候拉。
//   - MiniMax 的 Turn 状态在数据库里，崩溃后由 recover 收尾；host 只有日志和租约，崩溃恢复靠 Sessions 的回收和 WorkQueue.recover。
//
// 对外的 API 与之前一致：createApplication(dataDir, { writer, templates }) 返回
// { sessions, events, queue, plugins, templates, run, cancel, next, close }；
// 新增的都是可选项：createApplication 的 sessionOptions / memory，run 的 modelInfo / compaction / mode，
// next 的 continuePaused，以及新方法 steer。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Sessions } from "./sessions.mjs";
import { EventStore } from "./events.mjs";
import { WorkQueue, SteeringBuffer, routeDiscardedSteering } from "./queue.mjs";
import { createPlugins } from "./plugins.mjs";
import { Templates, promptRegistry, preparePrompt, loadPromptLayers } from "./context.mjs";
import { Skills } from "./skills.mjs";
import { localTools } from "./tools.mjs";
import { runTurn } from "./turns.mjs";

/**
 * 用户在 Turn 运行期间还在不在“盯着它”：决定停止之后要不要暂停队列。
 * 对应 queue-pause-on-abort.ts 的 `pausesQueueOnAbort`：只有用户亲手停止才暂停；
 * 应用关闭、租约丢失这类中止和用户的意愿无关，不能让队列从此不动。
 */
const USER_STOP = "user-stop";

/**
 * `skill` 工具：独立 Skill 每次当场读磁盘，插件 Skill 读这一代冻结的正文（第 8 章）。
 * 同名时插件 Skill 带着“插件名:”前缀，所以不会撞。
 */
function skillTool(skills, pluginSkills) {
  const known = (name) => {
    const key = String(name).trim().replace(/^\//, "");
    return { key, plugin: pluginSkills.find((skill) => skill.name === key) };
  };
  const load = (name) => {
    const { key, plugin } = known(name);
    if (plugin) return { body: plugin.content, allowedTools: undefined, fork: undefined };
    if (!skills) throw Error("unknown skill");
    return skills.load(key);
  };
  return {
    name: "skill",
    source: "configured",
    readOnly: true,
    description: "Load the full instructions of a skill listed in the system prompt.",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    validate(input) {
      load(input.name); // 名字不存在就在准入阶段被拦下，不会走到 execute
    },
    execute(input) {
      const skill = load(input.name);
      return { text: skill.body, details: { allowedTools: skill.allowedTools, fork: skill.fork } };
    },
  };
}

/** 能力清单：模型在系统提示里看到的 Skill 名字和描述。 */
function skillsCatalog(skills, pluginSkills) {
  const lines = [...(skills?.descriptions() ?? []), ...pluginSkills].map((skill) => `- ${skill.name}: ${skill.description}`);
  return lines.length ? ["# Available skills", ...lines].join("\n") : "";
}

export async function createApplication(
  dataDir,
  {
    writer,
    templates = new Templates({
      system: "Repair the project and verify the change.",
    }),
    sessionOptions, // 传给 Sessions：假时钟、短租约（实验用）
    memory, // 记忆材料，或者 (session) => 材料；形状见 context.mjs 的 memoryBlocks
  } = {},
) {
  // ─── 上半部分：服务（createRuntimeServices）────────────────────────────────
  const sessions = new Sessions(dataDir, sessionOptions),
    events = new EventStore(join(dataDir, "events.jsonl")),
    queue = new WorkQueue(join(dataDir, "queue.jsonl"));
  const plugins = await createPlugins(),
    prompts = await promptRegistry();

  // ─── 中间：Turn 系统的内存部分（initializeTurnSystem 的 controller）──────────
  // 每个正在跑的 Turn 在这里有一项：取消句柄、插话收件箱、停止的原因。Turn 结束就删。
  const runs = new Map(); // sessionId → { controller, steering, state }
  const completions = new Map(); // turnId → Promise：close() 等的就是它们
  let closing = false;

  const app = {
    sessions,
    events,
    queue,
    plugins,
    templates,

    /**
     * 跑一个 Turn。永远走完 ⑦ 的释放，不管中间哪一步抛错。
     * 选项里除了 runTurn 认识的（model、rules、maxTurns、hooks、sandboxRequired、mode），还有：
     *   queueItem     这条消息来自队列（已被 claim）：接纳时写回执，送达并落盘之后消费
     *   allowTools    只把这些名字的工具交给模型
     *   skillPaths    独立 Skill 的文件（相对工作区）
     *   modelInfo     { id, contextWindow, maxOutputTokens }：请求投影要知道模型（图片规则等）
     *   compaction    { model, summarize, triggerAt }：给了才会在每次请求前尝试压缩
     *   signal        外部取消信号（入口适配器的取消句柄）
     */
    async run(
      sessionId,
      text,
      {
        model,
        rules,
        mode,
        queueItem,
        maxTurns,
        signal,
        allowTools,
        skillPaths = [],
        hooks,
        sandboxRequired = false,
        modelInfo,
        compaction,
      } = {},
    ) {
      if (closing) throw Error("application closing");

      // ① 接纳：拿会话租约。失败（会话在忙、会话不存在）直接抛出，此时还没有任何东西要释放。
      const turnId = randomUUID(),
        release = sessions.admit(sessionId, turnId),
        controller = new AbortController();
      let done;
      completions.set(
        turnId,
        new Promise((resolve) => {
          done = resolve;
        }),
      );

      // 取消句柄、插话收件箱、停止原因。收件箱被取消时要知道（它要把等待中的插话交出去）。
      const state = { cause: USER_STOP };
      const discards = []; // 收件箱交出来的插话，等 Turn 收尾之后再分流（见 ⑥）
      const steering = new SteeringBuffer({
        onDiscard: (cause, messages) => discards.push({ cause, messages }),
      });
      runs.set(sessionId, { controller, steering, state });
      controller.signal.addEventListener(
        "abort",
        () => steering.abort(String(controller.signal.reason?.message ?? controller.signal.reason ?? "aborted")),
        { once: true },
      );
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();

      // 租约看门狗：续租由 Sessions 做，但续不上的时候它够不到 Turn。这里每个续租间隔看一眼，
      // 发现持有者已经不是自己（过期被别人回收了），就主动中止——对应 Turn 控制器续租失败时的 lease-lost。
      // 原因标成 lease-lost：这不是用户的意愿，所以收尾时不会暂停队列。
      const watchdog = setInterval(() => {
        if (controller.signal.aborted || sessions.holder(sessionId)?.turnId === turnId) return;
        state.cause = "lease-lost";
        controller.abort(Error("lease lost"));
      }, sessions.renewalMs);
      watchdog.unref();

      let capabilities;
      try {
        // ② 拍照：模板快照、磁盘上的指令和记忆、插件能力代。同一个时刻，之后谁也不会再变。
        if (!prompts.reserve(turnId)) throw Error("prompt preparation capacity exhausted");
        const session = sessions.get(sessionId);
        const snapshot = templates.capture();
        prompts.remember(turnId, { source: templates, snapshot });
        const layers = loadPromptLayers({
          workspaceDir: session.workspaceDir,
          dataDir,
          memory: typeof memory === "function" ? memory(session) : memory,
        });
        capabilities = await plugins.capture(); // 发布门关着的时候在这里等；拿到的一代带着租约
        const scope = prompts.take(turnId);
        if (!scope) throw Error("prompt scope missing");

        // ③ 装配：工具目录和系统提示。
        const skills = skillPaths.length ? new Skills(session.workspaceDir, skillPaths) : undefined;
        const definitions = [...localTools(session.workspaceDir), ...capabilities.tools];
        if (skills || capabilities.skills.length) definitions.push(skillTool(skills, capabilities.skills));
        const prompt = preparePrompt(scope.source, scope.snapshot, [], {
          ...layers,
          environment: { workspaceDir: session.workspaceDir, platform: process.platform, model: modelInfo?.id },
          skillsCatalog: skillsCatalog(skills, capabilities.skills),
        });

        // ④ 回执：这条消息来自队列时，Turn 先接纳它，队列才确认。
        if (queueItem) queue.accept(queueItem.id, turnId);

        // ⑤ 执行：第 2 章的 runTurn，把前面几章的零件作为参数交给它。
        const result = await runTurn({
          sessionId,
          turnId,
          text,
          model,
          rules,
          mode,
          maxTurns,
          prompt,
          hooks,
          sandboxRequired,
          modelInfo,
          compaction,
          steering,
          signal: controller.signal,
          root: session.workspaceDir,
          history: sessions.history(sessionId),
          tools: allowTools ? definitions.filter((tool) => allowTools.includes(tool.name)) : definitions,
          // 先记下，后投递：客户端看到过的每一帧，EventStore 里一定有（第 10 章）。
          write: async (frame) => {
            events.append(frame);
            await writer?.(frame);
          },
          // 历史有两个出口：追加新消息，或者压缩之后整份替换（第 6 章）。
          persist: (messages, change) =>
            change?.reason === "replaceMessages"
              ? sessions.replace(sessionId, turnId, messages, change.metadata)
              : sessions.append(sessionId, turnId, messages),
        });

        // ⑥ 收尾。顺序和 MiniMax 一致：host.run 的 finally 先还能力租约，
        // 然后 settleAndRelease：先处理没送出去的插话，再在同一次结算里决定队列，最后才释放会话。
        capabilities.release();
        const steered = routeSteering({ result, steering, discards, sessionId, turnId });
        pauseQueue({ result, state, sessionId, turnId });
        if (queueItem && result.delivered && result.persisted) queue.consume(queueItem.id);
        return {
          turnId,
          capabilityRevision: capabilities.revision,
          ...result,
          ...(steered.length ? { steering: steered } : {}),
        };
      } finally {
        // ⑦ 释放。每一步各自 try/finally：任何一步抛错，后面的照样执行，done() 一定会被调用。
        clearInterval(watchdog);
        signal?.removeEventListener("abort", abort);
        try {
          prompts.discard(turnId);
          capabilities?.release(); // 正常路径上已经还过了（重复释放无害）；走了异常路径时在这里补上……
        } finally {
          runs.delete(sessionId);
          try {
            release(); // ……最后放会话的“忙”。这之后，别的 Turn 才可能被接纳。
          } finally {
            completions.delete(turnId);
            done();
          }
        }
      }
    },

    /**
     * 取消这个会话正在跑的 Turn。返回有没有这样一个 Turn。
     * 取消只是发出意愿：Turn 要等工具进程退出、事件送达、历史写完才算放手；
     * 之后是否暂停队列由收尾阶段按原因决定（用户停止才暂停）。
     */
    cancel(sessionId, reason = "user cancelled") {
      const run = runs.get(sessionId);
      if (!run) return false;
      run.controller.abort(Error(reason));
      return true;
    },

    /**
     * 对一个正在跑的 Turn 插话（第 9 章）。收件箱接受就返回 accepted；
     * 没有在跑的 Turn，或者收件箱已经关门（Turn 正在收尾、已被取消），就改走排队：
     * 以 producerId + idempotencyKey 为身份，重发不会变成两条。
     */
    steer(sessionId, text, { producerId = "composer-steer", idempotencyKey = randomUUID() } = {}) {
      const accepted = runs.get(sessionId)?.steering.steer({ producerId, idempotencyKey, text });
      if (accepted?.status === "accepted") return { status: "accepted" };
      const item = queue.enqueue(sessionId, text, { clientRequestId: `steer:${producerId}:${idempotencyKey}` });
      return { status: "queued", itemId: item.id };
    },

    /**
     * 取走队列里的下一条并运行。会话在忙、队列暂停（用户按过停止）、队列是空的，都不会运行。
     * `continuePaused: true` 是用户点了“继续”：先解除暂停，再派发。
     */
    async next(sessionId, options = {}) {
      if (sessions.active.has(sessionId)) throw Error("session busy");
      const { continuePaused, ...runOptions } = options;
      if (continuePaused) queue.continueQueue(sessionId);
      const item = queue.claim(sessionId);
      if (!item) return undefined;
      try {
        return await app.run(sessionId, item.text, { ...runOptions, queueItem: item });
      } catch (error) {
        // 没能开始（别的进程持有会话、应用在关闭……）：把 claim 放回去，别让它挂到租约过期。
        if (queue.get(item.id)?.state === "claimed") queue.release(item.id, "admission-failed");
        throw error;
      }
    },

    /** 停止接纳新的 Turn，中止在跑的，等它们全部收尾，最后关闭插件。 */
    async close() {
      closing = true;
      for (const run of runs.values()) {
        run.state.cause = "shutdown"; // 应用关闭不是用户的意愿：不暂停队列
        run.controller.abort(Error("application closing"));
      }
      await Promise.all([...completions.values()]);
      prompts.close();
      await plugins.close();
    },
  };

  /**
   * ⑥-a 没来得及消费的插话各回各家（第 9 章 `routeDiscardedSteering`）。
   * Turn 不是正常结束的（取消、失败、用完预算），收件箱里剩下的先“封存”；
   * 然后每一批按出口规则：正常关门的回队首，取消和失败的写进会话历史（Turn 还持有租约，写得进去）。
   */
  function routeSteering({ result, steering, discards, sessionId, turnId }) {
    if (result.status !== "completed") steering.seal();
    const routes = [];
    for (const { cause, messages } of discards.splice(0)) {
      try {
        routes.push(
          routeDiscardedSteering({
            cause,
            messages,
            sessionId,
            turnId,
            queue,
            appendToHistory: (rows) => sessions.append(sessionId, turnId, rows),
          }),
        );
      } catch (error) {
        routes.push({ route: "failed", count: messages.length, error: error.message }); // 租约丢了：写不进去，如实报告
      }
    }
    return routes;
  }

  /**
   * ⑥-b 要不要暂停队列（对应 execution.coordinator.ts 的 `terminalQueuePauseCause`）：
   * 用户停止了 → user-stop；Turn 失败了 → turn-final-failure。两种情况下队列里的话都不会自己跑起来，
   * 要等用户明确说“继续”。应用关闭、租约丢失造成的中止不算用户的意愿。
   * 这一步在释放会话之前做：释放的那一刻起，任何人拉队列都已经看到暂停。
   */
  function pauseQueue({ result, state, sessionId, turnId }) {
    if (result.status === "cancelled" && state.cause === USER_STOP && !closing) {
      queue.pauseIfPending(sessionId, USER_STOP, turnId);
    } else if (result.status === "failed") {
      queue.pauseIfPending(sessionId, "turn-final-failure", turnId);
    }
  }

  return app;
}
