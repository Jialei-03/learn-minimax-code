// 第 8 章：插件、Skill 与 MCP 的“代”。
//
// 对应 MiniMax Code 0.7.2 的四处代码：
//   1. plugin-system/mcp/generation-registry.ts 的 PluginCapabilityGenerationRegistry
//      —— 每一代能力一个条目，Turn 来借租约（retain），还租约（release）；
//         旧代“退休”之后，要等最后一个租约还掉才清理。这一块直接装载真实代码来跑，host 不重写。
//   2. turn-system/agent-host/assembly/turn-capability-lifecycle.ts 的 acquire / tryPublish
//      —— 抓取当前代和加租约是一个不能被打断的整体；发布新一代时有一道“门”，门关着的时候新 Turn 要等。
//   3. plugin-system/plugin-system.ts 的 publishPreparedRuntime 与 publication.ts 的 prepareIsolatedPluginPublication
//      —— 新一代的候选运行时先在旁边准备好（连接、列工具），期间旧代照常服务；
//         准备成功，才“提交 → 切换”；任何一步失败，候选被关掉，旧代原样保留。
//   4. plugin-system/mcp/runtime.ts 的 PluginMcpRuntime
//      —— 一个运行时拥有自己的连接和工具清单；这里用 mcpRuntime 起一个真实的 stdio 子进程。
//
// 简化：
//   - MiniMax 的 revision 由系统自己数（plugin-snapshot-N），这里由调用方给，并拒绝重复。
//   - MiniMax 的“准备”分两段（先用缓存的工具清单快速发布，再在后台联网发现、发布下一代）；
//     这里把它们统一成“调用方准备好候选，host 负责发布”。后台发现就是再调用一次 update。
//   - 没有文件监视器、官方插件同步和账号作用域，只保留了“代”本身的规则。
//
// 对外的 API 和之前一致：createPlugins() → { update, capture, close }，mcpRuntime(command, args)。
// 新增的只有可选参数（update 的第三个参数、mcpRuntime 的第三个参数）和 capture() 返回值里的 skills。
import { importSource } from "../../lab/source.mjs";
import { StdioRpc } from "../../runtime/rpc.mjs";

const REGISTRY = "packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts";
const SKILL_NAME = "packages/shared/src/plugin-skill-name.ts";
const TOOL_NAME = "packages/agent-modules/mcp/src/runtime/tool-name.ts";

/**
 * 一代能力的“视图”：某个 Turn 从开始到结束看到的全部插件能力。
 * 冻结之后谁也改不了，所以拿到它的 Turn 不会看到工具表或 Skill 正文在中途变化
 * （对应 AgentHostTurnCapabilityView，snapshot-builder.ts 里每一层都 Object.freeze）。
 */
function freezeView(revision, candidate, skillRuntimeName) {
  const skills = (candidate.skills ?? []).map((skill) =>
    Object.freeze({
      plugin: skill.plugin,
      // 插件里的 Skill 在运行时叫 `插件名:Skill 名`，不会和独立 Skill 或别的插件撞名
      name: skillRuntimeName(skill.plugin, skill.name),
      description: skill.description,
      content: skill.content, // 正文随这一代一起冻结：磁盘上的 SKILL.md 之后再怎么改，这一代都不受影响
      location: skill.location,
    }),
  );
  return Object.freeze({
    revision,
    tools: Object.freeze([...candidate.tools]),
    skills: Object.freeze(skills),
  });
}

/** 收尾动作失败不能盖住原来的错误（对应 MiniMax 的 ignoreFailure）。 */
const quietly = (action) => Promise.resolve().then(action).catch(() => {});

/** 注册表只认 close()；候选没给 close 时补一个空的，免得清理旧代时中途报错、finalize 跑不到。 */
const runtime = (candidate) => ({ ...candidate, close: async () => candidate.close?.() });

/**
 * @typedef {object} Candidate  discover() 的返回值：一代新能力
 * @property {Array}   tools    这一代的工具定义
 * @property {() => Promise<void>} close  关掉这一代拥有的资源（比如 MCP 子进程）
 * @property {Array=}  skills   这一代的插件 Skill：{ plugin, name, description, content, location }
 *
 * @typedef {object} PublishHooks  update 的第三个参数，对应 PreparedPluginPublication 的三个回调
 * @property {() => Promise<void>=} commit    切换之前做：写磁盘、写数据库。门关着，新 Turn 在等
 * @property {() => Promise<void>=} rollback  切换之前任何一步失败（包括 commit 只做了一半），撤销 commit；要能空转
 * @property {() => Promise<void>=} finalize  旧代的运行时关掉之后做：真正删除旧代留下的文件
 */
export async function createPlugins() {
  const { PluginCapabilityGenerationRegistry } = await importSource(REGISTRY);
  const { buildPluginSkillRuntimeName } = await importSource(SKILL_NAME);

  let currentView = freezeView("empty", { tools: [] }, buildPluginSkillRuntimeName);
  const registry = new PluginCapabilityGenerationRegistry("empty", { close: async () => {} });
  const published = new Set(["empty"]); // 用过的 revision 不许再用：租约是按 revision 记的
  let updates = Promise.resolve(); // 更新一件一件做，对应 PluginSystem.runExclusive
  let gate; // 发布门：commit + 切换进行时是一个 Promise，否则是 undefined
  let closed = false;

  /** 关门。返回开门的函数。 */
  function closeGate() {
    let open;
    gate = new Promise((resolve) => (open = resolve));
    return () => {
      gate = undefined;
      open();
    };
  }

  async function applyUpdate(revision, discover, { commit, rollback, finalize } = {}) {
    if (closed) throw Error("plugins closed");
    if (published.has(revision)) throw Error(`duplicate capability revision: ${revision}`);

    // ① 在旁边准备候选。连接、列工具可能很慢也可能失败，这段时间 currentView 不动，
    //    新来的 Turn 照常拿到旧的一代（对应 prepareIsolatedPluginPublication）。
    //    discover 失败就直接抛出：没有东西被发布，旧代原样保留。
    const candidate = await discover();

    // ② 关门，提交，切换。
    const openGate = closeGate();
    try {
      if (closed) throw Error("plugins closed"); // 准备期间系统被关了
      await commit?.();
      if (closed) throw Error("plugins closed"); // 提交期间系统被关了：提交过的要撤销
      currentView = freezeView(revision, candidate, buildPluginSkillRuntimeName);
      published.add(revision);
      // 旧代退休。finalize 是这次更新带来的：等旧代的运行时关掉之后再执行
      registry.replace(revision, runtime(candidate), finalize);
    } catch (error) {
      // 候选没能上位：关掉它，撤销提交（commit 可能只做了一半，所以 rollback 要能重复、能空转）。
      // 旧代一直没动过。
      await quietly(() => candidate.close?.());
      await quietly(() => rollback?.());
      throw error;
    } finally {
      openGate();
    }
  }

  return {
    /**
     * 发布新的一代。discover() 负责准备候选（起 MCP 进程、列工具），可以很慢，期间 capture() 不被它挡住。
     * 更新一件一件串行执行；返回的 Promise 在新一代成为“当前”之后才完成。
     */
    update(revision, discover, hooks) {
      const result = updates.then(() => applyUpdate(revision, discover, hooks));
      updates = result.catch(() => {});
      return result;
    },

    /**
     * 为一个 Turn 抓取当前代并加租约。返回 { revision, tools, skills, release }。
     * 只在发布门关着的时候等；“读取当前代”和“加租约”之间没有 await，
     * 所以 Turn 拿到的 revision 一定还没被清理（对应 acquire 里的同步临界区）。
     */
    async capture() {
      while (gate) await gate; // 开门之后可能又有新的发布把门关上，所以是循环
      if (closed) throw Error("plugins closed");
      // —— 以下没有 await ——
      const view = currentView;
      registry.retain(view.revision);
      let released = false;
      return {
        ...view,
        release() {
          if (released) return; // 重复释放不能多还一份租约
          released = true;
          registry.release(view.revision);
        },
      };
    },

    /** 系统级收尾：等进行中的更新做完，再清理所有代，不管还有没有租约。Turn 自己绝不该调用它。 */
    async close() {
      closed = true;
      try {
        await updates;
      } finally {
        await registry.dispose();
      }
    },
  };
}

/** 工具参数里可能有的内容块，转成给模型看的文本（对应 mcpContentToText）。 */
function contentToText(result) {
  const text = result.content
    .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
    .filter(Boolean)
    .join("\n");
  return text || (result.isError ? "MCP tool returned an error." : "MCP tool returned no content.");
}

/**
 * 起一个真实的 MCP stdio 子进程，握手、列工具，把清单翻成 host 的工具定义。
 * 返回的 { tools, close, pid } 就是 update 里 discover() 要交出来的“候选”；
 * 初始化失败时子进程会被关掉，不留下孤儿进程。
 *
 * 默认工具名是 `mcp_<工具名>`；传 { server } 则用 MiniMax 的运行时命名 `mcp__<服务器>__<工具>`
 * （真实的 buildMcpToolRuntimeName：非法字符变下划线、限长）。
 */
export async function mcpRuntime(command, args, { server } = {}) {
  const peer = new StdioRpc(command, args);
  try {
    await peer.initialize();
    const { tools } = await peer.request("tools/list");
    const { buildMcpToolRuntimeName } = server ? await importSource(TOOL_NAME) : {};
    return {
      pid: peer.child.pid,
      close: () => peer.close(),
      tools: tools.map((tool) => ({
        name: server ? buildMcpToolRuntimeName(server, tool.name) : `mcp_${tool.name}`,
        source: "configured",
        description: tool.description,
        schema: tool.inputSchema, // 参数由工具流水线按这份 schema 校验，和内置工具走同一道关
        async execute(input) {
          const result = await peer.request("tools/call", { name: tool.name, arguments: input });
          return { text: contentToText(result), isError: result.isError };
        },
      })),
    };
  } catch (error) {
    await peer.close();
    throw error;
  }
}
