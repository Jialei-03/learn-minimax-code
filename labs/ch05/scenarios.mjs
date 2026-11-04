// 第 5 章的实验场景。每个函数只返回数据，由 snapshot.mjs / assemble.mjs / instructions.mjs /
// memory.mjs / override.mjs / handoff.mjs / reminders.mjs 打印成表格，
// 也被 labs/chapters/05-context-memory.mjs 用来做回归检查。全部离线、确定，不需要 API Key。
//
// 凡是标注“上游”的地方，运行的都是固定提交里的真实代码（lab/source.mjs 的 importSource），
// 不是课程的模仿：prompt-blocks.ts、runtime-prompt-rules.ts、整包回退、Registry、reminder 链。
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { importSource } from "../../lab/source.mjs";
import {
  BLOCK_BUILDERS,
  INSTRUCTION_LIMIT,
  MemoryBaselines,
  RUNTIME_RULES,
  Templates,
  addRuntimeRules,
  assemblyStability,
  buildReminder,
  buildUserMessage,
  diffMemory,
  genuineUserText,
  loadPromptLayers,
  memoryBlocks,
  preparePrompt,
  promptRegistry,
  promptSource,
  readGlobalInstructions,
  readPromptBundle,
  readProjectInstructions,
  buildSystemPrompt,
} from "../../host/src/context.mjs";

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

async function withTemp(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ch05-")));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 两段文字从头开始有多少字符相同——提示缓存按前缀匹配，这就是能被复用的部分。 */
export function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const upstreamBlocks = () =>
  importSource(
    "packages/local-runtime-v2/src/service/turn-system/agent-host/preparation/prompt-blocks.ts",
  );
const upstreamRules = () =>
  importSource(
    "packages/local-runtime-v2/src/service/turn-system/agent-host/preparation/config/runtime-prompt-rules.ts",
  );

// ─── 场景一：每次请求现读 vs. Turn 开始时拍照 ─────────────────────────────────────

/**
 * 一个 Turn 里模型被请求 4 次。第 2 次之前，有人改了 AGENTS.md（用户在编辑器里改，
 * 或者 Agent 自己的写文件工具改的）；第 3 次之前，一次提示刷新落地，身份模板换了新版。
 * 两种做法各跑一遍：每次请求都重新读，和 Turn 开始时读一次。再看下一个 Turn。
 */
export async function snapshotVsLive() {
  const environment = { workspaceDir: "/work/app", platform: "darwin", shell: "zsh", model: "demo-model", isGit: true };
  const OLD_RULE = "- Package manager: pnpm. Verify with `pnpm test`.\n";
  const NEW_RULE = "- Package manager: npm. Verify with `npm test`.\n";
  const V1 = "You are a coding agent. Fix the task, then verify it.";
  const V2 = "You are a coding agent. Fix the task, verify it, and report the evidence.";

  async function play(strategy) {
    return withTemp(async (root) => {
      const workspace = join(root, "app");
      mkdirSync(workspace);
      const agents = join(workspace, "AGENTS.md");
      writeFileSync(agents, OLD_RULE);
      const templates = new Templates({ system: V1 });
      const render = (snapshot) =>
        preparePrompt(templates, snapshot, [], {
          ...loadPromptLayers({ workspaceDir: workspace }),
          environment, // 环境块里的路径只是个标签，用固定值，输出才能逐次一致
        });
      const midTurn = {
        2: ["有人改了 AGENTS.md", () => writeFileSync(agents, NEW_RULE)],
        3: ["提示刷新落地，身份模板换新版", () => templates.update("system", V2)],
      };

      const prompts = [];
      const describe = (turn, request, what, prompt) => {
        const previous = prompts.at(-1);
        prompts.push(prompt);
        const stability = previous && assemblyStability(previous.fingerprint, prompt.fingerprint);
        const shared = previous ? commonPrefix(previous.text, prompt.text) : 0;
        return {
          Turn: turn,
          请求: request,
          这次请求之前发生了: what,
          身份模板: `v${prompt.revision >= 1 ? 2 : 1}`,
          包管理规则: prompt.text.match(/Package manager: (\w+)/)[1],
          系统提示指纹: prompt.fingerprint.systemPrompt.slice(0, 8),
          相对上一次请求: !previous
            ? "（第一次）"
            : `${stability.systemPrompt}，前缀复用 ${Math.round((shared / prompt.text.length) * 100)}%`,
          lost: previous ? prompt.text.length - shared : 0,
          changed: previous ? stability.systemPrompt === "changed" : false,
        };
      };

      const rows = [];
      // Turn 1：snapshot 做法在 Turn 开始时拍一次，live 做法每次请求都重新拍
      const frozen = strategy === "snapshot" ? render(templates.capture()) : undefined;
      for (let request = 1; request <= 4; request++) {
        const [what, apply] = midTurn[request] ?? ["（无）", () => {}];
        apply();
        rows.push(describe(1, request, what, frozen ?? render(templates.capture())));
      }
      // Turn 2 开始：两种做法都会重新读
      rows.push(describe(2, 1, "新的 Turn 开始", render(templates.capture())));
      return rows.map((row) => ({ 做法: strategy === "live" ? "每次请求现读" : "Turn 开始时拍照", ...row }));
    });
  }

  const live = await play("live");
  const snapshot = await play("snapshot");
  const summary = [
    ["每次请求现读", live],
    ["Turn 开始时拍照", snapshot],
  ].map(([name, rows]) => ({
    做法: name,
    "Turn 1 里模型见过几个版本": new Set(rows.filter((r) => r.Turn === 1).map((r) => r.系统提示指纹)).size,
    提示改变的次数: rows.filter((r) => r.changed).length,
    "其中发生在 Turn 中途": rows.filter((r) => r.changed && r.Turn === 1).length,
    没能复用前缀的字符数合计: rows.reduce((sum, r) => sum + r.lost, 0),
  }));
  const strip = ({ lost, changed, 做法, ...row }) => row;
  return { live: live.map(strip), snapshot: snapshot.map(strip), summary, raw: { live, snapshot } };
}

/**
 * 一份提示由两个模板拼成，渲染要读两次（中间要等一次磁盘或网络）。
 * 等待期间一次整包刷新落地。现读：开头是旧版、结尾是新版；快照：两段同一代。
 */
export async function mixedGeneration() {
  const make = () =>
    new Templates({ system: "SYSTEM v1", footer: "FOOTER v1" });
  const refreshSoon = (templates) =>
    setTimeout(() => templates.replaceAll({ system: "SYSTEM v2", footer: "FOOTER v2" }), 5);

  const liveTemplates = make();
  const timerA = refreshSoon(liveTemplates);
  const liveHead = liveTemplates.read(liveTemplates.capture(), "system");
  await sleep(20);
  const liveTail = liveTemplates.read(liveTemplates.capture(), "footer");
  clearTimeout(timerA);

  const snapTemplates = make();
  const timerB = refreshSoon(snapTemplates);
  const snap = snapTemplates.capture();
  const snapHead = snapTemplates.read(snap, "system");
  await sleep(20);
  const snapTail = snapTemplates.read(snap, "footer");
  clearTimeout(timerB);

  return [
    { 做法: "每次读都现拍", 开头: liveHead, 结尾: liveTail, 同一代: liveHead.endsWith("v1") === liveTail.endsWith("v1") ? "是" : "否" },
    { 做法: "拍一次，反复读", 开头: snapHead, 结尾: snapTail, 同一代: snapHead.endsWith("v1") === snapTail.endsWith("v1") ? "是" : "否" },
  ];
}

// ─── 场景二：一个 Turn 的请求长什么样 ────────────────────────────────────────────

const SOURCE_OF = {
  identity: "模板 system + 运行时规则",
  append: "--append-system-prompt",
  preamble: "固定前言（有指令才出现）",
  global: "<dataDir>/AGENTS.md",
  project: "<workspace>/AGENTS.md",
  environment: "环境块（没有日期）",
  memory: "USER.md / MEMORY.md / 主题清单",
  skills: "<available_skills> 目录",
};

export async function assembleRequest() {
  return withTemp(async (root) => {
    const workspace = join(root, "app");
    const dataDir = join(root, "data");
    mkdirSync(workspace);
    mkdirSync(dataDir);
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "# Project\n- Package manager: pnpm.\n- Run `pnpm test` before claiming a fix works.\n",
    );
    writeFileSync(join(dataDir, "AGENTS.md"), "- Reply in the user's language.\n");

    const memory = {
      user: "name: Lin\nprefers short answers",
      main: "- 2026-11-01 flaky test lives in test/slug.test.js\n- 2026-11-03 CI needs Node 22",
      mainPath: "/data/memory/MEMORY.md", // 路径只是标签，用固定值
      topics: [{ name: "release", description: "release checklist", path: "/data/memory/release.md" }],
    };
    const templates = new Templates({ system: "You are a coding agent. Fix the task, then verify it." });
    const snapshot = templates.capture();
    const prompt = preparePrompt(templates, snapshot, [], {
      ...loadPromptLayers({ workspaceDir: workspace, dataDir, memory }),
      environment: { workspaceDir: "/work/app", isGit: true, platform: "darwin", shell: "zsh", model: "demo-model" },
      skillsCatalog: "<available_skills>\n- code-review: review local changes\n- verify: run the project's checks\n</available_skills>",
    });

    const reminder = buildReminder({
      turnCount: 1,
      sessionId: "sess-1",
      workspaceDir: "/work/app",
      date: "2026-11-04",
    });
    const userMessage = buildUserMessage({ prefixes: [reminder], userText: "把失败的测试修好" });

    // 每个 part 对应的来源和字符数；记忆是好几块，按标签标出各自来自哪个文件
    const memorySource = (text) =>
      text.startsWith("<user_profile") ? "USER.md（用户档案）"
        : text.startsWith("<agent_memory_tail") ? "MEMORY.md（尾部）"
          : text.startsWith("<available_memory_topics") ? "主题清单（只有元数据）"
            : SOURCE_OF.memory;
    const rows = prompt.sections.map((name, index) => ({
      顺序: index + 1,
      位置: "系统提示",
      部分: name,
      来源: name === "memory" ? memorySource(prompt.system[index]) : SOURCE_OF[name],
      字符数: prompt.system[index].length,
    }));
    rows.push({
      顺序: rows.length + 1,
      位置: "这一轮的用户消息",
      部分: "reminder + 用户原话",
      来源: "reminder 链 + 用户输入",
      字符数: userMessage.text.length,
    });
    const kindTotals = Object.fromEntries(
      ["MEMORY", "SKILLS", "OTHER"].map((kind) => [
        kind,
        prompt.ranges
          .filter((r) => r.kind === kind)
          .reduce((sum, r) => sum + (r.endOffset - r.startOffset), 0),
      ]),
    );
    return { prompt, userMessage, reminder, rows, kindTotals };
  });
}

// ─── 场景三：项目指令与全局指令 ─────────────────────────────────────────────────

export async function instructionCases() {
  return withTemp(async (root) => {
    const dir = (name) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const longLines = (count) =>
      Array.from({ length: count }, (_, i) => `- rule ${String(i).padStart(4, "0")}: keep the diff small and explain the reason`).join("\n");
    const rows = [];
    const project = (scenario, workspace, note) => {
      const found = readProjectInstructions(workspace);
      rows.push({
        场景: scenario,
        读到的文件: found ? found.path.slice(root.length + 1) : "（没有）",
        注入字节: found ? Buffer.byteLength(found.content) : 0,
        是否截断: found ? (found.truncated ? "是" : "否") : "-",
        说明: note,
      });
      return found;
    };

    const onlyAgents = dir("only-agents");
    writeFileSync(join(onlyAgents, "AGENTS.md"), "- use pnpm\n");
    project("只有 AGENTS.md", onlyAgents, "直接使用");

    const both = dir("both");
    writeFileSync(join(both, "CLAUDE.md"), "- from the old name\n");
    writeFileSync(join(both, "AGENTS.md"), "- from AGENTS.md\n");
    const bothFound = project("CLAUDE.md 和 AGENTS.md 都有", both, "先到先得，AGENTS.md 整个被忽略，不合并");

    const emptyFirst = dir("empty-first");
    writeFileSync(join(emptyFirst, "CLAUDE.md"), "  \n\n");
    writeFileSync(join(emptyFirst, "AGENTS.md"), "- from AGENTS.md\n");
    project("CLAUDE.md 是空文件", emptyFirst, "空文件不算找到，退到 AGENTS.md");

    const parent = dir("monorepo");
    writeFileSync(join(parent, "AGENTS.md"), "- repo-wide rule\n");
    const child = dir("monorepo/packages/web");
    project("在子目录 packages/web 里工作，父目录有 AGENTS.md", child, "不往上找：读不到父目录的规则");

    const big = dir("big");
    writeFileSync(join(big, "AGENTS.md"), longLines(900));
    const bigFound = project("AGENTS.md 超过 32KB", big, "按完整行截断，末尾加一条说明");

    const cjk = dir("cjk");
    writeFileSync(join(cjk, "AGENTS.md"), "规则：保持改动最小。".repeat(4000));
    const cjkFound = project("中文内容超过 32KB", cjk, "按 UTF-8 字符边界截断，不会出现乱码");

    const globalOk = dir("global-ok");
    writeFileSync(join(globalOk, "AGENTS.md"), "- reply in the user's language\n");
    const globalBig = dir("global-big");
    writeFileSync(join(globalBig, "AGENTS.md"), longLines(900));
    const globalRows = [
      { 场景: "全局 AGENTS.md 在预算内", 注入字节: Buffer.byteLength(readGlobalInstructions(globalOk)), 说明: "直接使用" },
      { 场景: "全局 AGENTS.md 超过 32KB", 注入字节: Buffer.byteLength(readGlobalInstructions(globalBig)), 说明: "整份丢弃，不截断" },
    ];
    return { rows, globalRows, bothFound, bigFound, cjkFound, limit: INSTRUCTION_LIMIT };
  });
}

// ─── 场景四：记忆 ──────────────────────────────────────────────────────────────

const tagsOf = (blocks) => blocks.map((block) => block.match(/^<([a-z_]+)/)[1]);

export async function memoryInjection() {
  const upstream = await upstreamBlocks();
  const upstreamBuilders = {
    userProfile: upstream.buildUserProfileBlock,
    summary: upstream.buildMemorySummaryBlock,
    tail: upstream.buildMemoryTailBlock,
    note: upstream.buildMemoryNoteBlock,
    topics: upstream.buildAvailableMemoryTopicsBlock,
  };
  const entries = (count) =>
    Array.from({ length: count }, (_, i) => `- 2026-10-${String((i % 28) + 1).padStart(2, "0")} note ${i}: something worth remembering`).join("\n");
  const small = entries(40);
  const large = entries(500);
  const topics = [{ name: "release", description: "release checklist", path: "/data/memory/release.md" }];
  const cases = [
    ["MEMORY.md 很小", { main: small, mainPath: "/data/memory/MEMORY.md", topics }],
    ["MEMORY.md 很大，有摘要索引", { main: large, summary: "- L1-L200: infra notes\n- L201-L500: release notes", mainPath: "/data/memory/MEMORY.md", topics }],
    ["MEMORY.md 很大，没有摘要", { main: large, mainPath: "/data/memory/MEMORY.md", topics }],
  ];
  const rows = cases.map(([name, memory]) => {
    const real = memoryBlocks(memory, upstreamBuilders);
    const mine = memoryBlocks(memory);
    return {
      情形: name,
      "MEMORY.md 字符数": memory.main.length,
      注入的块: tagsOf(real).join(" + "),
      块的字符数合计: real.reduce((sum, block) => sum + block.length, 0),
      "host 与上游的块顺序一致": tagsOf(real).join() === tagsOf(mine).join() ? "是" : "否",
    };
  });
  const sample = memoryBlocks(cases[1][1], upstreamBuilders);
  return { rows, sample, tagsHost: tagsOf(memoryBlocks(cases[1][1])), tagsUpstream: tagsOf(sample) };
}

/** 记忆在会话中途变了：下一个 Turn 开始时，增量以 reminder 的形式送出。 */
export async function memoryDelta() {
  const providers = await importSource("packages/agent-modules/system-reminder/src/providers.ts");
  const baselines = new MemoryBaselines();
  const turn1 = { main: "- prefers pnpm\n- CI needs Node 22", user: "name: Lin" };
  const appended = { main: `${turn1.main}\n- release branch is main`, user: "name: Lin" };
  const rewritten = { main: "- prefers npm\n- CI needs Node 22\n- release branch is main", user: "name: Lin" };
  const userChanged = { ...rewritten, user: "name: Lin\nprefers short answers" };

  const steps = [
    ["Turn 1：第一次看到记忆", turn1],
    ["Turn 2：MEMORY.md 末尾追加了一条", appended],
    ["Turn 3：有人改写了 MEMORY.md 里已有的一行", rewritten],
    ["Turn 4：用户档案变了", userChanged],
    ["Turn 5：什么都没变", userChanged],
  ];
  const rows = steps.map(([step, current]) => {
    const update = baselines.advance("s-delta", current);
    return {
      发生了什么: step,
      送出的增量: Object.keys(update).join(" + ") || "（无）",
      增量字符数: Object.values(update).reduce((sum, text) => sum + text.length, 0),
      内容: Object.values(update).join(" | ").replace(/\n/g, "↵") || "-",
    };
  });
  const realBlock = providers.agentMemoryUpdateProvider({ agentMemoryUpdate: "- release branch is main" });
  return { rows, realBlock };
}

// ─── 场景五：覆盖系统提示 ──────────────────────────────────────────────────────

export async function overrideCases() {
  const rules = await upstreamRules();
  const blocks = await upstreamBlocks();
  const upstreamRuleText = {
    systemReminder: blocks.SYSTEM_REMINDER_DESCRIPTION,
    fileOperations: blocks.FILE_OPERATION_RULES,
    language: blocks.LANGUAGE_RULES,
    preamble: blocks.TOOL_CALL_PREAMBLE_REMINDER,
  };

  const templates = new Templates({ system: "You are the packaged MiniMax identity." });
  const base = {
    projectInstructions: "- Package manager: pnpm.",
    environment: { workspaceDir: "/work/app", platform: "darwin" },
    memoryBlocks: ["<agent_memory_tail path=\"/m\">\n- note\n</agent_memory_tail>"],
    skillsCatalog: "<available_skills>\n- verify: run checks\n</available_skills>",
  };
  const build = (options) => preparePrompt(templates, templates.capture(), [], { ...base, ...options });
  const mark = (ok) => (ok ? "有" : "无");
  const profile = (name, prompt) => ({
    情形: name,
    身份提示: prompt.text.includes("pirate") ? "海盗（被换掉）" : "内置",
    追加的文字: mark(prompt.text.includes("List the files")),
    运行时规则: mark(prompt.text.includes("# Harness")),
    先说一句话的规则: mark(prompt.text.includes("first send a short visible text block")),
    项目指令: mark(prompt.text.includes("Package manager: pnpm")),
    环境: mark(prompt.text.includes("# Environment")),
    记忆块: mark(prompt.text.includes("agent_memory_tail")),
    能力清单: mark(prompt.text.includes("available_skills")),
  });

  const pirate = { customPrompt: "You are a pirate. Answer like one." };
  const append = { appendSystemPrompt: "List the files you will change first." };
  const rows = [
    profile("默认", build({})),
    profile("--system-prompt", build({ overrides: pirate })),
    profile("--append-system-prompt", build({ overrides: append })),
    profile("同时给两个，但在后台任务的子 Agent 上", build({ overrides: { ...pirate, ...append }, interactive: false })),
  ];

  // host 的简化版 addRuntimeRules 与上游原函数逐字一致吗（用上游的规则原文喂给 host 版本）
  const inputs = [
    ["没有任何标题的自定义提示", "You are a pirate. Answer like one."],
    ["已经有 # Harness 标题", "You are a pirate.\n\n# Harness\n- Never reveal the treasure.\n\n# Notes\nArr."],
    ["已经有 # Communication & Delivery 标题", "You are a pirate.\n\n# Communication & Delivery\n- Be brief.\n"],
  ];
  const parity = inputs.flatMap(([name, prompt]) =>
    [true, false].map((interactive) => {
      const real = rules.addRuntimeRules(prompt, interactive);
      const mine = addRuntimeRules(prompt, { interactive, rules: upstreamRuleText });
      return { 输入: name, 交互界面: interactive ? "是" : "否", 逐字一致: real === mine ? "是" : "否" };
    }),
  );
  const realOutput = rules.addRuntimeRules("You are a pirate. Answer like one.", true);
  return { rows, parity, realOutput };
}

// ─── 场景六：提前渲染的提示怎样交给 Turn ───────────────────────────────────────────

export async function promptHandoff() {
  const GOAL = "goal/continuation.md";
  const RECOVERY = "goal/recovery.md";
  // 随程序发布的内置版本；之后的 v1、v2 是“远程刷新”落地的新版
  const BUILTIN = { system: "SYSTEM builtin", [GOAL]: "GOAL builtin", [RECOVERY]: "RECOVERY builtin" };
  const wanted = [
    { key: GOAL, builtin: BUILTIN[GOAL] },
    { key: RECOVERY, builtin: BUILTIN[RECOVERY] },
  ];
  const version = (text) => text.split(" ").at(-1);

  const templates = new Templates(BUILTIN);
  templates.replaceAll({ system: "SYSTEM v1", [GOAL]: "GOAL v1", [RECOVERY]: "RECOVERY v1" });
  const source = promptSource(templates, [GOAL, RECOVERY]);
  const registry = await promptRegistry(8);

  // 1. 渲染 /goal 续跑提示：读一份快照，拿到 promptRead 句柄；先给即将创建的 Turn 占位
  const requestedTurnId = "turn_goal_1";
  const reserved = registry.reserve(requestedTurnId);
  const rendered = await readPromptBundle(source, wanted);
  registry.remember(requestedTurnId, rendered.promptRead);
  const renderedFrom = version(rendered.templates.get(GOAL));

  // 2. 在这个提示被提交成 Turn 之前，一次刷新落地
  templates.replaceAll({ system: "SYSTEM v2", [GOAL]: "GOAL v2", [RECOVERY]: "RECOVERY v2" });

  // 3. Turn 被接纳，编号和占位时不同
  const admittedTurnId = "turn_9";
  const rebound = registry.rebind(requestedTurnId, admittedTurnId);

  // 4. preflight 取走快照，用它组装系统提示；对照：不走 Registry，重新拍一份
  const taken = registry.take(admittedTurnId);
  const viaHandoff = templates.read(taken.snapshot, "system");
  const viaFresh = templates.read(templates.capture(), "system");
  const takenAgain = registry.take(admittedTurnId);

  const handoffRows = [
    { 步骤: "渲染续跑提示，Registry 占位", 提示用的版本: renderedFrom, 系统提示用的版本: "-", 一致: "-" },
    { 步骤: "刷新落地（模板换成 v2）", 提示用的版本: "-", 系统提示用的版本: "-", 一致: "-" },
    {
      步骤: "preflight 经 Registry 取走快照",
      提示用的版本: renderedFrom,
      系统提示用的版本: version(viaHandoff),
      一致: renderedFrom === version(viaHandoff) ? "是" : "否",
    },
    {
      步骤: "（对照）preflight 重新拍一份",
      提示用的版本: renderedFrom,
      系统提示用的版本: version(viaFresh),
      一致: renderedFrom === version(viaFresh) ? "是" : "否",
    },
  ];

  // Registry 自身的规则（上游真实实现，容量 2）
  const small = await promptRegistry(2);
  const scope = { source, snapshot: templates.capture() };
  const ops = [];
  const step = (操作, 结果, 说明) => ops.push({ 操作, 结果: String(结果), 说明 });
  step("reserve(a)", small.reserve("a"), "占一个名额");
  step("reserve(a)", small.reserve("a"), "同一个编号不能占两次");
  step("reserve(b)", small.reserve("b"), "第二个名额");
  step("reserve(c)", small.reserve("c"), "满了：a 和 b 都还没存值，预留同样算数");
  small.remember("a", scope);
  step("remember(a)", "（存入）", "只能填入已有的预留");
  step("rebind(a, b)", small.rebind("a", "b"), "目标 b 已有预留，拒绝；a 仍在原处");
  step("rebind(a, x)", small.rebind("a", "x"), "移动到新编号，句柄原样不变");
  step("take(a)", small.take("a") === undefined ? "undefined" : "scope", "a 已经被搬走了");
  const identity = small.take("x") === scope;
  step("take(x)", identity, "取走的就是存进去的那个对象");
  step("take(x)", small.take("x") === undefined ? "undefined" : "scope", "只能取一次");
  small.discard("b");
  step("discard(b) 后 reserve(c)", small.reserve("c"), "放弃预留，名额回来了");
  small.close();
  step("close() 后 reserve(d)", small.reserve("d"), "关闭以后不再接纳");

  // 整包回退：一次成功的刷新之后，又来一次不完整的刷新
  const bundleTemplates = new Templates(BUILTIN);
  bundleTemplates.replaceAll({ system: "SYSTEM b1", [GOAL]: "GOAL b1", [RECOVERY]: "RECOVERY b1" });
  const bundleSource = promptSource(bundleTemplates, [GOAL, RECOVERY]);
  const complete = await readPromptBundle(bundleSource, wanted);
  // 不完整的刷新：新的一套里缺了 recovery
  bundleTemplates.replaceAll({ system: "SYSTEM b2", [GOAL]: "GOAL b2" });
  const partial = await readPromptBundle(bundleSource, wanted);
  const live = bundleTemplates.capture();
  const perKey = wanted.map((w) => live.values[w.key] ?? w.builtin);
  const bundleRows = [
    {
      情形: "第一次刷新（完整）之后",
      [GOAL]: complete.templates.get(GOAL),
      [RECOVERY]: complete.templates.get(RECOVERY),
      读自: "刷新后的快照",
    },
    {
      情形: "第二次刷新缺了 recovery：整包回退",
      [GOAL]: partial.templates.get(GOAL),
      [RECOVERY]: partial.templates.get(RECOVERY),
      读自: partial.promptRead.snapshot.values === bundleTemplates.builtin ? "内置快照（整包）" : "刷新后的快照",
    },
    {
      情形: "（对照）逐键回退会拼出什么",
      [GOAL]: perKey[0],
      [RECOVERY]: perKey[1],
      读自: "新旧两代混在一份提示里",
    },
  ];
  return { handoffRows, ops, bundleRows, reserved, rebound, identity, takenAgain, viaHandoff, viaFresh, rendered, partial };
}

// ─── 场景七：reminder 链（运行上游的真实 provider）─────────────────────────────────

export async function reminderChain() {
  const P = "packages/agent-modules/system-reminder/src";
  const providers = await importSource(`${P}/providers.ts`);
  const types = await importSource(`${P}/types.ts`);
  const registry = providers.createDefaultRegistry((ms) => new Date(ms).toISOString());
  const chain = registry.resolve(types.AgentFrameworkType.PiAgent);
  const critical = registry.resolveCritical(types.AgentFrameworkType.PiAgent);
  const env = (sessionId) => ({
    agentName: "mavis",
    agentRole: "orchestrator",
    sessionId,
    sessionType: 1,
    platform: "darwin",
    date: "2026-11-04",
    workspaceDir: "/work/app",
    isDefaultWorkspace: false,
    agentConfigDir: "/data/agents/mavis",
    scene: "local",
    environmentInSystemPrompt: true,
  });
  const input = (sessionId, extra) => ({
    env: env(sessionId),
    teamModeOff: true,
    workspaceDir: "/work/app",
    isGitWorkspace: false,
    ...extra,
  });

  // 有些 provider 带进程内状态（“第 1 轮提醒，之后按 5、10、20 轮的间隔退避”），
  // 所以每一行只跑一次，并且同一个会话的几行按 Turn 顺序跑。
  const run = (list, data) => {
    const names = [];
    const text = buildReminder(
      data,
      list.map(({ name, fn }) => ({
        name,
        fn: (d) => {
          const out = fn(d);
          if (out?.trim()) names.push(name.replace(/Provider$/, ""));
          return out;
        },
      })),
    );
    return { names, text };
  };
  const cases = [
    ["会话 A · Turn 1", chain, input("sess-a", { turnCount: 1 })],
    ["会话 A · Turn 2", chain, input("sess-a", { turnCount: 2 })],
    [
      "会话 A · Turn 3，记忆有更新",
      chain,
      input("sess-a", {
        turnCount: 3,
        agentMemoryUpdate: "- release branch is main",
        userMemoryUpdate: "name: Lin\nprefers short answers",
      }),
    ],
    ["会话 B · Turn 1，这个模型关掉了 reminder（只跑 critical）", critical, input("sess-b", { turnCount: 1 })],
  ];
  const results = cases.map(([name, list, data]) => ({ name, list, ...run(list, data) }));
  const rows = results.map(({ name, list, names, text }) => ({
    情形: name,
    "跑了几个 provider": list.length,
    触发的: names.join(" + ") || "（无）",
    "reminder 字符数": text?.length ?? 0,
  }));
  return {
    rows,
    all: chain.length,
    criticalNames: critical.map((p) => p.name.replace(/Provider$/, "")),
    texts: results.map((r) => r.text),
    fired: results.map((r) => r.names),
  };
}

export { BLOCK_BUILDERS, RUNTIME_RULES, buildSystemPrompt, genuineUserText, tagsOf };
