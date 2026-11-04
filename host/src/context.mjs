// 第 5 章：上下文——一个 Turn 开始前，提示是怎样拼出来的，又为什么只拍一次。
//
// 对应 MiniMax Code 0.7.2 的这些位置（路径相对于源码仓库根目录）：
//   packages/local-runtime-v2/src/service/turn-system/agent-host/
//     preparation/turn-preflight.ts                      Turn 开始时一次性捕获会话、Agent、历史和提示快照
//     preparation/config/local-agent-config-builder.ts   loadPromptLayers / buildSystemPrompt / composePromptParts
//     preparation/static-prompt-reader.ts                项目指令与全局指令（32KB 预算、先到先得）
//     preparation/config/memory-prompt-composer.ts       记忆块（尾部截取、摘要索引、主题只放元数据）
//     preparation/config/runtime-prompt-rules.ts         addRuntimeRules：换掉身份提示以后，运行时规则仍然保留
//     execution/executor.ts、execution/prompt.ts          reminder 和用户原话拼成这一轮的用户消息
//   packages/agent-modules/system-reminder/              reminder 链（service.ts、registry.ts、providers.ts）
//   packages/local-runtime/src/memory/local-data-collector.ts   记忆的增量：只把新增的一段送给模型（diffMemory）
//   packages/agent-core/src/prompt-read.ts               BoundedInternalTurnPromptReadRegistry（本模块直接运行上游代码）
//   packages/local-runtime/src/runtime/prompt-read.ts    整包回退（本模块直接运行上游代码）
//   packages/agent-core/src/pi-turn-runner/assembly-fingerprint.ts   提示稳定性指纹
//
// 一个 Turn 的材料有三种“钟”，快照就是让它们各走各的：
//   进程一生   随包发布的提示文件、--system-prompt 一类启动参数：启动后读一次，之后不变。
//   一个 Turn  项目指令、全局指令、记忆、环境信息：Turn 开始时读完，拼成系统提示，然后冻住。
//   一条消息   reminder（日期、记忆增量……）：写进这一轮的用户消息，之后永远不再重算。
//
// 简化：
//   - 上游的读取全是异步的，并且在 Promise.all 里并发；这里的磁盘读取用同步 API，行为相同。
//   - 上游的系统提示是一个字符串；这里同时给出分节的数组（`system`，每节一项）和拼好的字符串（`text`）。
//   - addRuntimeRules 不处理代码围栏里的标题和标题级别对齐；规则文字是 host 自己的短版本，
//     调用方可以通过 `rules` 参数换成上游的原文（实验就是这样验证逐字一致的）。
//   - 远程提示刷新（PromptConfigService）没有实现。上游 0.7.2 的命令行也把它关了，
//     留下的只有“快照是一个句柄”这个接口，Templates 实现的就是这个接口。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import { digest } from "../../runtime/files.mjs";

// ─── 一、模板与快照 ──────────────────────────────────────────────────────────

/**
 * 可以在运行中被更新的提示模板，对应 PromptConfigService 管着的那一套文件。
 *
 * 读模板分两步：先 `capture()` 拿到一个快照，再用 `read(快照, 键)` 读内容。
 * 快照是冻结的，之后无论 `update` 多少次，它读到的永远是拍照那一刻的值。
 * `captureBuiltin()` 是随程序发布的那一份，永远完整，用作整包回退的退路。
 */
export class Templates {
  constructor(values = {}) {
    this.revision = 0;
    this.values = { ...values };
    this.builtin = Object.freeze({ ...values });
  }
  update(key, text) {
    this.values[key] = text;
    this.revision++;
  }
  capture() {
    return Object.freeze({
      revision: this.revision,
      values: Object.freeze({ ...this.values }),
    });
  }
  captureBuiltin() {
    return Object.freeze({ revision: 0, values: this.builtin });
  }
  /** 一次整包刷新落地：用新的一整套模板替换旧的（可能缺键，由 promptSource 的 invalid 兜底）。 */
  replaceAll(values) {
    this.values = { ...values };
    this.revision++;
  }
  read(snapshot, key) {
    if (!snapshot || !Object.hasOwn(snapshot.values, key))
      throw Error("prompt snapshot invalid");
    return snapshot.values[key];
  }
}

/**
 * 把 Templates 包成上游的 PromptSnapshotSource 接口（capture / captureBuiltin / read）。
 * read 有三种结果：found；missing（可选的键，没有就用内置默认）；
 * invalid（“受管”的键应该在快照里却不在，说明这一代快照不完整）。
 */
export function promptSource(templates, managedKeys = []) {
  const managed = new Set(managedKeys);
  return {
    capture: async () => templates.capture(),
    captureBuiltin: async () => templates.captureBuiltin(),
    read: async (snapshot, key) => {
      if (Object.hasOwn(snapshot.values, key))
        return { kind: "found", content: snapshot.values[key] };
      return { kind: managed.has(key) ? "invalid" : "missing" };
    },
  };
}

/**
 * 整包读取：同一个快照里读完所有模板；只要有一个 invalid，整包改读内置快照。
 * 绝不让一份提示里同时出现“新版的这一段”和“内置的那一段”。直接运行上游的实现。
 * `wanted` 是 [{ key, builtin }]；返回 { templates: Map, promptRead? }。
 */
export async function readPromptBundle(source, wanted) {
  const { readPromptBundleScopeWithBuiltinFallback } = await importSource(
    "packages/local-runtime/src/runtime/prompt-read.ts",
  );
  return readPromptBundleScopeWithBuiltinFallback(source, wanted);
}

// ─── 二、提前渲染的提示怎么交给 Turn ────────────────────────────────────────────

/**
 * 有界的“信箱”：先渲染提示、后创建 Turn 的内部流程（/goal 续跑、/review）把快照存进来，
 * Turn 的 preflight 按 turnId 取走，保证“渲染提示”和“组装系统提示”读的是同一份快照。
 * reserve → remember → (rebind) → take，或者 discard。直接运行上游的实现。
 */
export async function promptRegistry(capacity = 128) {
  const { BoundedInternalTurnPromptReadRegistry } = await importSource(
    "packages/agent-core/src/prompt-read.ts",
  );
  return new BoundedInternalTurnPromptReadRegistry(capacity);
}

// ─── 三、项目指令与全局指令 ────────────────────────────────────────────────────

export const INSTRUCTION_LIMIT = 32 * 1024; // 字节，项目指令和全局指令各自的预算
// 只看工作区根目录，不往上找；两个文件先到先得，不合并。
// 先查 CLAUDE.md（兼容老项目），再查 AGENTS.md。内容是空的不算“找到”。
const PROJECT_INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];

/** 读一个文件，不存在返回 undefined；其他错误照常抛出。 */
function readIfPresent(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** 从 buffer 开头取不超过 maxBytes 字节的完整 UTF-8 字符。 */
function utf8Prefix(buffer, maxBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const end = Math.min(buffer.length, maxBytes);
  // 一个字符最多占 4 字节，最多往回退 3 字节就能避开被截断的那一个
  for (let cut = end; cut >= Math.max(0, end - 3); cut--) {
    try {
      return decoder.decode(buffer.subarray(0, cut));
    } catch {
      // 切在了某个字符的中间，再退一字节
    }
  }
  return "";
}

/** 超过预算时：保留前面的完整行，末尾加一条说明，整体不超过 limit 字节。 */
export function truncateInstructions(text, filename, limit = INSTRUCTION_LIMIT) {
  const separator = "\n\n";
  const notice =
    `[${filename} content truncated to fit the ${limit}-byte instructions budget. ` +
    `Read the source ${filename} file directly when the omitted instructions are needed.]`;
  const budget = limit - Buffer.byteLength(separator + notice);
  const prefix = utf8Prefix(Buffer.from(text, "utf8"), budget).trimEnd();
  // 最后一个换行如果落在前缀的后 20% 里，就退到它，免得切断半行；否则硬切
  const lastNewline = prefix.lastIndexOf("\n");
  const body =
    lastNewline >= Math.floor(prefix.length * 0.8)
      ? prefix.slice(0, lastNewline).trimEnd()
      : prefix;
  return body + separator + notice;
}

/** 项目指令：返回 { path, content, truncated }，没有就返回 undefined。 */
export function readProjectInstructions(workspaceDir) {
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const path = join(workspaceDir, name);
    const raw = readIfPresent(path);
    const text = raw?.toString("utf8").trim();
    if (!text) continue; // 不存在或者是空文件：试下一个名字
    const truncated = Buffer.byteLength(text) > INSTRUCTION_LIMIT;
    return {
      path,
      content: truncated ? truncateInstructions(text, name) : text,
      truncated,
    };
  }
  return undefined;
}

/**
 * 全局指令：`<dataDir>/AGENTS.md`。和项目指令不同，超出预算就整份丢弃而不是截断：
 * 写入口（GlobalInstructions.write）本来就拒绝超限内容，读到超限的文件说明它被外面改过。
 */
export function readGlobalInstructions(dataDir) {
  const raw = readIfPresent(join(dataDir, "AGENTS.md"));
  if (!raw || raw.length > INSTRUCTION_LIMIT) return "";
  return raw.toString("utf8").trim();
}

// ─── 四、记忆块 ──────────────────────────────────────────────────────────────

export const MEMORY_TAIL_CAP = 10 * 1024; // 字符：MEMORY.md 和用户档案各自最多注入这么多（取尾部）
export const MEMORY_SUMMARY_CAP = 4 * 1024; // 字符：摘要索引最多注入这么多（取开头）

/** 块构造器。host 用短版本；实验里可以换成上游 prompt-blocks.ts 的原版，看拼装逻辑是否一致。 */
export const BLOCK_BUILDERS = {
  userProfile: (content, capNote = "") =>
    `<user_profile>\n${content}${capNote}\n</user_profile>`,
  summary: (summary, path) =>
    `<agent_memory_summary>\nIndex of ${path}; older entries are not in the tail.\n\n${summary}\n</agent_memory_summary>`,
  tail: (tail, path) =>
    `<agent_memory_tail path="${path}">\n${tail}\n</agent_memory_tail>`,
  note: (path) =>
    `<agent_memory_note>\nMemory exceeded the injection budget; read ${path} for older entries.\n</agent_memory_note>`,
  topics: (topics) =>
    [
      "<available_memory_topics>",
      "Topic bodies are NOT injected, only metadata below.",
      ...topics.flatMap((t) => [
        "  <topic>",
        `    name: ${t.name}`,
        `    desc: ${t.description}`,
        `    path: ${t.path}`,
        "  </topic>",
      ]),
      "</available_memory_topics>",
    ].join("\n"),
};

/**
 * 把记忆材料变成一组提示块，对应 collectMemoryBlocks 里的 canonical 分支：
 *   用户档案                          超过上限只保留最新的尾部，并写明截断
 *   MEMORY.md 没超限                  只放尾部块（其实就是全文）
 *   MEMORY.md 超限且有摘要            摘要索引 + 尾部块（摘要告诉模型去哪里读更早的内容）
 *   MEMORY.md 超限且没有摘要          尾部块 + 一条“预算用完了”的说明
 *   主题文件                          只放名字、描述、路径，正文由模型自己 Read
 * memory = { user, main, mainPath, summary, topics }，都可以缺省。
 */
export function memoryBlocks(memory, builders = BLOCK_BUILDERS) {
  const blocks = [];
  const user = memory.user?.trim();
  if (user) {
    const capped = user.length > MEMORY_TAIL_CAP;
    const capNote = capped
      ? `\n> Content truncated: ${user.length} chars, showing latest ${MEMORY_TAIL_CAP} chars.`
      : "";
    blocks.push(
      builders.userProfile(capped ? user.slice(-MEMORY_TAIL_CAP) : user, capNote),
    );
  }
  const main = memory.main?.trim();
  if (main) {
    const summary = memory.summary?.trim();
    const capped = main.length > MEMORY_TAIL_CAP;
    if (capped && summary)
      blocks.push(
        builders.summary(summary.slice(0, MEMORY_SUMMARY_CAP), memory.mainPath),
      );
    blocks.push(
      builders.tail(capped ? main.slice(-MEMORY_TAIL_CAP) : main, memory.mainPath),
    );
    if (capped && !summary) blocks.push(builders.note(memory.mainPath));
  }
  if (memory.topics?.length) blocks.push(builders.topics(memory.topics));
  return blocks;
}

// ─── 五、reminder 与用户消息 ───────────────────────────────────────────────────
// 系统提示在一个 Turn 里不变，所以“每一轮都不一样”的东西（日期、记忆增量……）不能放进去。
// 它们变成 <system-reminder> 块，写在这一轮用户消息的最前面。

/**
 * 记忆的增量。baseline 是上一轮看到的记忆，current 是现在的：
 *   MEMORY.md 只是在末尾追加了 → 只送新增的那一段；被改写过 → 送全文；
 *   用户档案变了 → 送全文。第一轮没有基线，什么都不送（系统提示里已经有完整内容）。
 */
export function diffMemory(baseline, current) {
  if (!baseline) return {};
  const update = {};
  if (current.main && current.main !== baseline.main) {
    const appended = baseline.main && current.main.startsWith(baseline.main);
    update.agentMemoryUpdate = (
      appended ? current.main.slice(baseline.main.length) : current.main
    ).trim();
  }
  if (current.user !== undefined && current.user !== baseline.user)
    update.userMemoryUpdate = current.user.trim();
  return update;
}

/** 每个会话记一份“上一轮看到的记忆”。每次 advance 都返回增量，并把基线推到现在。 */
export class MemoryBaselines {
  constructor() {
    this.bySession = new Map();
  }
  advance(sessionId, current) {
    const update = diffMemory(this.bySession.get(sessionId), current);
    this.bySession.set(sessionId, { main: current.main, user: current.user });
    return update;
  }
}

/**
 * reminder 链：每个 provider 是 { name, fn(data) → 文本 | undefined }，按注册顺序运行，
 * 返回的块用空行隔开，包在一个 <system-reminder> 里。data 是这一轮收集好的一份材料，
 * 所有 provider 读同一份，不会各自再去读磁盘。
 */
export const REMINDER_PROVIDERS = [
  {
    name: "agentContext",
    fn: (d) =>
      d.turnCount > 1
        ? // 第二轮起用精简版：会话和工作区在第一轮已经告诉过模型了
          `<agent-context>\n  session: ${d.sessionId}\n  date: ${d.date}\n</agent-context>`
        : `<agent-context>\n  session: ${d.sessionId}\n  workspace: ${d.workspaceDir}\n  date: ${d.date}\n</agent-context>`,
  },
  {
    name: "agentMemoryUpdate",
    fn: (d) =>
      d.agentMemoryUpdate &&
      `<agent_memory_update>\nNew entries have been appended to your memory since the last turn:\n\n${d.agentMemoryUpdate}\n</agent_memory_update>`,
  },
  {
    name: "userMemoryUpdate",
    fn: (d) =>
      d.userMemoryUpdate &&
      `<user_memory_update>\nUser memory has been updated. Latest version:\n\n${d.userMemoryUpdate}\n</user_memory_update>`,
  },
];

export function buildReminder(data, providers = REMINDER_PROVIDERS) {
  try {
    const blocks = [];
    for (const provider of providers) {
      const block = provider.fn(data)?.trim();
      if (block) blocks.push(block);
    }
    if (!blocks.length) return undefined;
    return `<system-reminder>\n${blocks.join("\n\n")}\n</system-reminder>`;
  } catch {
    // reminder 是补充材料：provider 抛错只丢掉这一轮的 reminder，不让 Turn 失败（上游同样处理）
    return undefined;
  }
}

/**
 * 这一轮的用户消息 = 前缀（reminder、插件钩子的上下文……）+ 用户原话。
 * canonicalTextRange 记下原话在整段文字里的位置，压缩和标题生成靠它把原话从前缀里切出来；
 * 发给模型之前这个字段会被去掉。对应 executor.ts 的 joinUserPrompt 和 withGenuineQueryProvenance。
 */
export function buildUserMessage({ prefixes = [], userText }) {
  const lead = prefixes
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
  const text = lead ? `${lead}\n\n${userText}` : userText;
  return {
    text,
    canonicalTextRange: {
      startOffset: text.length - userText.length,
      endOffset: text.length,
    },
  };
}

/** 从一条用户消息里取回用户原话。 */
export function genuineUserText(message) {
  const { startOffset, endOffset } = message.canonicalTextRange;
  return message.text.slice(startOffset, endOffset);
}

// ─── 六、系统提示的配方 ────────────────────────────────────────────────────────

const DEFAULT_IDENTITY =
  "You are a local coding assistant running in the user's workspace.";
const INSTRUCTIONS_PREAMBLE =
  "Codebase and user instructions are shown below. These instructions OVERRIDE default behavior and MUST be followed.";

/** 运行时规则的 host 版本。换成上游的原文：{ systemReminder, fileOperations, language, preamble }。 */
export const RUNTIME_RULES = {
  systemReminder:
    "`<system-reminder>` tags are injected by the harness, not typed by the user.",
  fileOperations:
    "- Verify a file's current state before reporting that it exists.",
  language:
    "Follow explicit user language instructions; otherwise match the conversation language.",
  preamble:
    "Before a non-trivial tool call, first send a short visible text block.",
};

/** 把一段规则放到某个标题下面；标题不存在就在末尾新建。 */
function addSection(prompt, heading, guidance, fallbackHeading = heading) {
  const lines = prompt.split("\n");
  const target = lines.includes(heading) ? heading : fallbackHeading;
  const at = lines.indexOf(target);
  if (at < 0)
    return [prompt.trim(), `${fallbackHeading}\n${guidance}`]
      .filter(Boolean)
      .join("\n\n");
  let next = at + 1;
  while (next < lines.length && !lines[next].trim()) next++; // 跳过标题后面的空行
  const added = guidance.split("\n");
  const continuesList =
    /^[-*+] /.test(added.at(-1)) && /^[-*+] /.test(lines[next] ?? "");
  const gap = next < lines.length && !continuesList ? [""] : [];
  lines.splice(at + 1, next - (at + 1), ...added, ...gap);
  return lines.join("\n");
}

/**
 * 给身份提示补上运行时规则。无论身份来自模板还是 --system-prompt，都要经过这里：
 * 用户换掉的是“你是谁”，不是“这个运行环境有哪些规矩”。
 * 非交互的界面（后台任务的子 Agent）没有“先说一句话再调工具”的规则。
 */
export function addRuntimeRules(
  prompt,
  { interactive = true, rules = RUNTIME_RULES } = {},
) {
  let result = addSection(
    prompt,
    "# Harness",
    [`- ${rules.systemReminder}`, rules.fileOperations].join("\n"),
  );
  result = addSection(
    result,
    "## Response Style",
    rules.language,
    "# Communication & Delivery",
  );
  if (interactive)
    result = addSection(
      result,
      "## Preamble messages",
      rules.preamble,
      "# Communication & Delivery",
    );
  return result;
}

/** 环境信息块。注意这里没有日期和时间：它们每天都变，属于 reminder。 */
export function environmentBlock({ workspaceDir, isGit, platform, shell, model } = {}) {
  return [
    "# Environment",
    "You have been invoked in the following environment:",
    `- Primary working directory: ${workspaceDir ?? "unavailable"}`,
    `- Is a git repository: ${isGit ?? "unavailable"}`,
    `- Platform: ${platform ?? process.platform}`,
    `- Shell: ${shell ?? "unavailable"}`,
    `- Model: ${model ?? "unavailable"}`,
  ].join("\n");
}

/**
 * 把若干段拼成系统提示，同时记下“哪一段字符属于记忆、能力清单、其他”。
 * 空段跳过；上一段只是一个标题行时，下一段紧跟其后（一个换行），否则隔一个空行。
 * parts 里的 kind（MEMORY / SKILLS / OTHER）会变成 ranges，用来按类别统计提示占了多少。
 */
export function composePromptParts(parts) {
  const kept = parts.filter((part) => part.text);
  let text = "";
  const ranges = [];
  kept.forEach((part, index) => {
    const afterHeading = /^#{1,6} [^\n]+$/u.test(kept[index - 1]?.text ?? "");
    const separator = text ? (afterHeading ? "\n" : "\n\n") : "";
    const startOffset = text.length + separator.length;
    text = text + separator + part.text;
    if (part.kind)
      ranges.push({ kind: part.kind, startOffset, endOffset: text.length });
  });
  return { text, ranges, parts: kept };
}

/**
 * 系统提示的配方（对应 buildSystemPrompt + buildIdentityPrompt）。顺序就是设计：
 *   身份（+ 运行时规则）→ 追加的提示 → 指令前言 → 全局指令 → 项目指令
 *   → 环境 → 记忆块 → 能力清单
 * overrides = { customPrompt, appendSystemPrompt }：只对交互界面生效（interactive 为 false 时忽略）。
 */
export function buildSystemPrompt({
  identity,
  overrides,
  interactive = true,
  globalInstructions = "",
  projectInstructions = "",
  environment,
  memoryBlocks: blocks = [],
  skillsCatalog = "",
}) {
  const custom = interactive ? overrides?.customPrompt?.trim() : undefined;
  const append = interactive ? (overrides?.appendSystemPrompt?.trim() ?? "") : "";
  const global = globalInstructions.trim();
  const project = projectInstructions.trim();
  const base = custom ?? (identity?.trim() || DEFAULT_IDENTITY);
  return composePromptParts([
    { name: "identity", text: addRuntimeRules(base, { interactive }) },
    { name: "append", text: append },
    // 前言只在确实有指令的时候才出现：空工作区不应该声称“下面是指令”
    { name: "preamble", text: global || project ? INSTRUCTIONS_PREAMBLE : "" },
    { name: "global", text: global, kind: "OTHER" },
    { name: "project", text: project, kind: "OTHER" },
    { name: "environment", text: environment ? environmentBlock(environment) : "" },
    ...blocks.map((text) => ({ name: "memory", text, kind: "MEMORY" })),
    { name: "skills", text: skillsCatalog.trim(), kind: "SKILLS" },
  ]);
}

// ─── 七、Turn 开始时的“拍照” ────────────────────────────────────────────────────

/**
 * 读磁盘：项目指令、全局指令、记忆块。对应 loadPromptLayers。
 * 这一步读到什么，这个 Turn 就用什么；之后文件再怎么变，都要等下一个 Turn。
 */
export function loadPromptLayers({ workspaceDir, dataDir, memory } = {}) {
  const project = workspaceDir ? readProjectInstructions(workspaceDir) : undefined;
  return {
    projectInstructions: project?.content ?? "",
    projectInstructionsPath: project?.path,
    globalInstructions: dataDir ? readGlobalInstructions(dataDir) : "",
    memoryBlocks: memory ? memoryBlocks(memory) : [],
  };
}

/**
 * 提示稳定性指纹：只看提供商看得见、并且影响缓存的两样东西——系统提示和工具声明。
 * 历史不算，否则正常的消息增长会被当成“提示变了”。上游对工具声明的键做了规范化排序，这里没做。
 */
export function fingerprintPrompt(systemText, tools = []) {
  const short = (value) => digest(value).slice(0, 16);
  return {
    systemPrompt: short(systemText),
    tools: short(tools.map((t) => ({ name: t.name, schema: t.schema }))),
  };
}

/** 两次请求之间，系统提示和工具声明各自是 stable 还是 changed。 */
export function assemblyStability(previous, current) {
  const verdict = (a, b) => (a === b ? "stable" : "changed");
  return {
    systemPrompt: verdict(previous.systemPrompt, current.systemPrompt),
    tools: verdict(previous.tools, current.tools),
  };
}

/**
 * 从快照拼出这个 Turn 的系统提示，并冻住。
 * 返回的对象是冻结的：一个 Turn 里每次请求模型都用它，谁也不能在中途改。
 *   system   分节数组，每节一项（`system[0]` 是身份提示）
 *   text     拼好的完整字符串，就是提供商收到的那一份
 *   ranges   [{ kind, startOffset, endOffset }]：哪段字符属于记忆 / 能力清单 / 其他
 * `memories` 是第 5 章最初的接口（[{ path, text }]），保留向后兼容；新代码用 options.memoryBlocks。
 * options 可以包含 loadPromptLayers 的结果，以及 environment、skillsCatalog、overrides、interactive。
 */
export function preparePrompt(templates, snapshot, memories = [], options = {}) {
  const built = buildSystemPrompt({
    ...options,
    identity: templates.read(snapshot, "system"),
    memoryBlocks: [
      ...(options.memoryBlocks ?? []),
      ...memories.map((m) => BLOCK_BUILDERS.tail(m.text, m.path)),
    ],
  });
  const system = built.parts.map((part) => part.text);
  return Object.freeze({
    system: Object.freeze(system),
    text: built.text,
    ranges: Object.freeze(built.ranges),
    sections: Object.freeze(built.parts.map((part) => part.name)),
    revision: snapshot.revision,
    hash: digest(system),
    fingerprint: fingerprintPrompt(built.text),
  });
}

// ─── 八、请求投影 ─────────────────────────────────────────────────────────────

/**
 * 发给模型的历史是存下来的历史的一份投影副本（对应 convertToLlm 里的 projectAgentMessagesForModel）：
 *   - 找不到对应调用的工具结果删掉（接口会拒绝孤儿结果）；
 *   - 有调用却没有结果的补一条“被中断”的错误结果；
 *   - 图片只保留最新的 maxImages 张，旧的换成占位文字。
 * 原历史一个字都不改。这一层的细节属于第 6 章。
 */
export function projectMessages(history, { maxImages = 2 } = {}) {
  const output = [],
    pending = new Map();
  for (const message of structuredClone(history)) {
    if (message.role === "assistant")
      for (const call of message.calls ?? []) pending.set(call.id, call);
    if (message.role === "tool" && !pending.has(message.id)) continue;
    if (message.role === "tool") pending.delete(message.id);
    output.push(message);
  }
  for (const [id] of pending)
    output.push({
      role: "tool",
      id,
      error: true,
      text: "interrupted tool call",
    });
  let remaining = maxImages;
  for (let i = output.length - 1; i >= 0; i--) {
    if (!output[i].images) continue;
    for (let j = output[i].images.length - 1; j >= 0; j--)
      if (remaining-- <= 0) output[i].images[j] = "[older image omitted]";
  }
  return output;
}
