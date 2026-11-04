// 第 8 章的实验场景。每个函数只返回数据，由同目录的 policies / registry / gate / frozen / frontmatter
// 脚本打印成表格，也被 labs/chapters/08-plugins-mcp.mjs 用来做回归检查。全部离线、确定，不需要 API Key。
// MCP 服务器是 labs/ch08/server.mjs 起的真实子进程；generation registry 和 turn 能力生命周期是真实的上游代码。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { importSource } from "../../lab/source.mjs";
import { createPlugins, mcpRuntime } from "../../host/src/plugins.mjs";
import { Skills, parseSkill } from "../../host/src/skills.mjs";

export { sleep };
export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SERVER = join(ROOT, "labs/ch08/server.mjs");

const REGISTRY = "packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts";
const LIFECYCLE = "packages/local-runtime-v2/src/service/turn-system/agent-host/assembly/turn-capability-lifecycle.ts";

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

/** 起一个指定版本的 MCP 服务器进程，翻成 host 的候选（tools / close / pid）。 */
export const startServer = (version, options) => mcpRuntime(process.execPath, [SERVER, "--version", version], options);

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 最多等 ms 毫秒，看进程是否退出。返回最后一刻它还活着吗。 */
export async function aliveAfter(pid, ms = 400) {
  for (let waited = 0; waited < ms && isAlive(pid); waited += 10) await sleep(10);
  return isAlive(pid);
}

export const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "ch08-")));

// ─── 场景一：更新插件时，正在运行的 Turn 怎么办 ──────────────────────────────────

/**
 * 两种朴素的做法。update 把新一代发布出来；旧一代怎么处理，是 policy 决定的：
 *   close-now  替换时立刻关旧的
 *   never-close 替换时什么都不关
 */
function naiveHost(policy) {
  let current = { revision: "empty", tools: [], runtime: undefined };
  return {
    async update(revision, discover) {
      const runtime = await discover();
      const old = current;
      current = { revision, tools: runtime.tools, runtime };
      if (policy === "close-now") await old.runtime?.close();
    },
    async capture() {
      const { revision, tools } = current;
      return { revision, tools, release() {} };
    },
    async close() {
      await current.runtime?.close();
    },
  };
}

/**
 * 同一个剧本跑三种做法：
 *   v1 服务器在线 → Turn A 开始一次要 300ms 的 search → 50ms 后插件更新到 v2 → Turn B 开始并调用 search
 *   → A 的调用结束，A 释放。看 A 的调用、B 的调用，以及 v1 进程什么时候退出。
 */
export async function updatePolicies() {
  const policies = [
    ["替换时立刻关旧的", () => naiveHost("close-now")],
    ["替换时什么都不关", () => naiveHost("never-close")],
    ["租约：最后一个使用者走了才关（host）", () => createPlugins()],
  ];
  const rows = [];
  for (const [label, make] of policies) {
    const host = await make();
    const pids = [];
    const discover = (version) => async () => {
      const runtime = await startServer(version);
      pids.push(runtime.pid);
      return runtime;
    };
    try {
      await host.update("r1", discover("v1"));
      const a = await host.capture();
      const callA = a.tools[0].execute({ query: "alpha", ms: 300 }).then(
        (result) => result.text,
        (error) => `失败：${error.message}`,
      );
      await sleep(50);
      await host.update("r2", discover("v2"));
      const b = await host.capture();
      const callB = (await b.tools[0].execute({ query: "beta" })).text;
      const v1RightAfterUpdate = isAlive(pids[0]);
      const resultA = await callA;
      a.release();
      const v1AfterRelease = await aliveAfter(pids[0]);
      b.release();
      rows.push({
        做法: label,
        "A 进行中的调用": resultA,
        "B（更新后开始）的调用": callB,
        "更新刚完成时 v1 进程": v1RightAfterUpdate ? "仍在运行" : "已退出",
        "A 释放之后 v1 进程": v1AfterRelease ? "仍在运行（泄漏）" : "已退出",
      });
    } finally {
      await host.close();
      for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL"); // 朴素做法泄漏的进程，实验自己收尾
    }
  }
  return rows;
}

// ─── 场景二：真实的 generation registry，一步一步 ───────────────────────────────

const tick = () => sleep(5); // 让 registry 的后台清理跑完

/** 窥视 registry 内部：每一代的租约和退休状态（TypeScript 的 private 只在编译期存在）。 */
const describeGenerations = (registry) =>
  [...registry.generations.values()].map((g) => `${g.revision}${g.retired ? "(退休)" : "(当前)"}×${g.leaseCount}`).join(" ");

/** 把 registry 的每一种操作都走一遍，每步之后记下各代的状态和新增的日志。 */
export async function registryTour() {
  const { PluginCapabilityGenerationRegistry } = await importSource(REGISTRY);
  const log = [];
  const runtime = (name) => ({ close: async () => void log.push(`close ${name}`) });
  const registry = new PluginCapabilityGenerationRegistry("r1", runtime("r1"));
  const rows = [];
  const seen = new Set(["r1"]);
  const state = (revision) => {
    const g = registry.generations.get(revision);
    if (g) return `${g.retired ? "退休" : "当前"}，租约 ${g.leaseCount}`;
    return seen.has(revision) ? "已销毁" : "—";
  };
  const step = async (who, call, run) => {
    const before = log.length;
    let note = "";
    try {
      await run();
    } catch (error) {
      note = `抛出 ${error.code}`;
    }
    await tick();
    rows.push({ 步骤: rows.length, 谁: who, 调用: call, r1: state("r1"), r2: state("r2"), 本步新增日志: [note, ...log.slice(before)].filter(Boolean).join(" → ") || "—" });
  };
  rows.push({ 步骤: 0, 谁: "启动", 调用: 'new Registry("r1")', r1: state("r1"), r2: state("r2"), 本步新增日志: "—" });
  await step("Turn A 开始", 'retain("r1")', () => registry.retain("r1"));
  await step("Turn B 开始", 'retain("r1")', () => registry.retain("r1"));
  await step("插件更新", 'replace("r2", rt2, finalize)', () => {
    seen.add("r2");
    registry.replace("r2", runtime("r2"), async () => void log.push("finalize r1"));
  });
  await step("Turn C 开始", 'retain("r2")', () => registry.retain("r2"));
  await step("Turn A 结束", 'release("r1")', () => registry.release("r1"));
  await step("Turn B 结束", 'release("r1")', () => registry.release("r1"));
  await step("Turn B 又释放一次", 'release("r1")', () => registry.release("r1"));
  await step("迟到的 Turn 来借", 'retain("r1")', () => registry.retain("r1"));
  await step("应用关闭（C 还没结束）", "dispose()", () => registry.dispose());
  return { rows, log };
}

/**
 * replaceRevision 只换标签、不换运行时，而且新条目的租约从 0 开始。
 * 持有旧标签租约的 Turn，从此不被任何一代记账：下一次 replace 会立刻把还在用的运行时关掉。
 */
export async function relabelHazard() {
  const { PluginCapabilityGenerationRegistry } = await importSource(REGISTRY);
  const log = [];
  const runtime = (name) => ({ close: async () => void log.push(`close ${name}`) });
  const registry = new PluginCapabilityGenerationRegistry("r1", runtime("r1"));
  const rows = [];
  const step = async (call, run) => {
    const before = log.length;
    await run();
    await tick();
    rows.push({ 步骤: rows.length + 1, 调用: call, 各代状态: describeGenerations(registry), 本步新增日志: log.slice(before).join(" → ") || "—" });
  };
  await step('retain("r1")  // Turn A 开始', () => registry.retain("r1"));
  await step('replaceRevision("r1b")', () => registry.replaceRevision("r1b"));
  await step('replace("r2", rt2)  // 此时 Turn A 还在用 r1 的运行时', () => registry.replace("r2", runtime("r2")));
  await step('release("r1")  // Turn A 结束', () => registry.release("r1"));
  await registry.dispose();
  return rows;
}

// ─── 场景三：两种“系统”，同一个剧本 ─────────────────────────────────────────────

/** host 的实现，包成剧本需要的形状。 */
export async function hostSystem() {
  const plugins = await createPlugins();
  return {
    name: "host",
    update: (revision, discover, hooks) => plugins.update(revision, discover, hooks),
    async acquire() {
      const lease = await plugins.capture();
      return { revision: lease.revision, release: () => lease.release() };
    },
    dispose: () => plugins.close(),
  };
}

/**
 * 真实的 AgentHostTurnCapabilityLifecycle + 真实的 registry，加上一个只有 20 行的迷你 PluginSystem：
 * 用 tryPublish 发布、用 registry.replace 换代。它扮演 PluginSystem 的角色，生命周期和 registry 都是上游代码。
 */
export async function realSystem() {
  const { AgentHostTurnCapabilityLifecycle } = await importSource(LIFECYCLE);
  const { PluginCapabilityGenerationRegistry } = await importSource(REGISTRY);
  const lifecycle = new AgentHostTurnCapabilityLifecycle();
  const registry = new PluginCapabilityGenerationRegistry("empty", { close: async () => {} });
  let view = { revision: "empty", plugins: [], skills: [], runtimeTools: [], runtimeToolBindings: [] };
  const port = lifecycle.attach({
    waitUntilReady: async () => {},
    captureTurnCapabilities: () => view,
    retainTurnCapabilities: (capabilities) => registry.retain(capabilities.revision),
    releaseTurnCapabilities: (capabilities) => registry.release(capabilities.revision),
    onHostIdle() {},
  });
  let turns = 0;
  return {
    name: "真实生命周期",
    async update(revision, discover, { commit, finalize } = {}) {
      const candidate = await discover(); // 在旁边准备，不占发布门
      const published = port.tryPublish(async () => {
        await commit?.();
        view = { ...view, revision, runtimeTools: candidate.tools };
        registry.replace(revision, candidate, finalize);
      });
      if (!published) throw Error("发布门被占用");
      await published;
    },
    async acquire() {
      const lease = await lifecycle.acquire({ sessionId: "s", turnId: `t${++turns}` });
      return { revision: lease.capabilities.revision, release: () => lease.release() };
    },
    leases: () => describeGenerations(registry),
    dispose: () => registry.dispose(),
  };
}

/**
 * 一个插件更新，三个 Turn 先后到达：
 *   A 在更新之前开始；B 在候选还在“发现”（慢）时开始；C 在 commit（发布门关着）时开始。
 * 返回事件列表。system 只需要 update / acquire / dispose。
 */
export async function gateScenario(system) {
  const events = [];
  const leases = () => (system.leases ? { "各代租约（动作之后）": system.leases() } : {});
  /** 记一件事。先记下来再执行动作，所以动作引发的后续（比如 close）排在它后面。 */
  const act = (who, what, action) => {
    const event = { 谁: who, 发生了什么: what };
    events.push(event);
    action?.();
    Object.assign(event, leases());
  };
  const runtime = (name) => ({ tools: [{ name: `search@${name}` }], close: async () => act(`${name} 的运行时`, "close()") });

  await system.update("r1", async () => runtime("r1"));
  const a = await system.acquire();
  act("Turn A", `acquire → ${a.revision}`);

  let commitStarted;
  const committing = new Promise((resolve) => (commitStarted = resolve));
  const updating = system.update(
    "r2",
    async () => {
      act("更新", "候选 r2 开始发现：连接、tools/list（200ms）");
      await sleep(200);
      act("更新", "候选 r2 发现完成");
      return runtime("r2");
    },
    {
      commit: async () => {
        act("更新", "发布门关上，commit 开始（100ms，比如写盘）");
        commitStarted();
        await sleep(100);
        act("更新", "commit 完成");
      },
      finalize: async () => act("r1 的 finalizer", "执行（r1 已 close）"),
    },
  );
  await sleep(60);
  const b = await system.acquire();
  act("Turn B", `acquire → ${b.revision}（发现还在进行，没有被挡）`);

  await committing;
  await sleep(20);
  act("Turn C", "acquire 开始（门关着）");
  const c = await system.acquire();
  act("Turn C", `acquire 返回 → ${c.revision}（等到门打开）`);
  await updating;

  act("Turn A", "release", () => a.release());
  act("Turn B", "release（r1 的最后一个租约）", () => b.release());
  await sleep(30);
  act("Turn C", "release（r2 是当前代，不清理）", () => c.release());
  act("应用", "dispose()");
  await system.dispose();
  return events;
}

// ─── 场景四：一代带走的东西 ────────────────────────────────────────────────────

const SKILL_V1 = "---\nname: summarize\ndescription: 总结一篇文档\n---\n总结时先列三个要点。\n";
const SKILL_V2 = "---\nname: summarize\ndescription: 总结一篇文档\n---\n总结时先列五个要点，再写一句结论。\n";
const lastLine = (text) => text.trim().split("\n").at(-1);

/** 读插件目录，翻成一代候选：真实的 MCP 子进程 + SKILL.md 的正文（整个文件）。 */
async function loadPlugin(pluginDir, version) {
  const file = join(pluginDir, "skills/summarize/SKILL.md");
  const content = readFileSync(file, "utf8");
  const { name, description } = parseSkill(content, { dirName: "summarize" });
  const runtime = await startServer(version);
  return { ...runtime, skills: [{ plugin: basename(pluginDir), name, description, content, location: file }] };
}

/**
 * 插件更新两次：SKILL.md 和 MCP 服务器一起从 v1 升到 v2，然后插件被卸载。
 *   reads    更新之后，Turn A（r1）、Turn B（r2）、独立 Skill 各读到什么
 *   removal  卸载时，目录、隔离区、进程、B 手里的东西的变化
 */
export async function frozenScenario() {
  const base = tempDir();
  const pluginDir = join(base, "plugins/research-kit");
  const skillFile = join(pluginDir, "skills/summarize/SKILL.md");
  mkdirSync(join(pluginDir, "skills/summarize"), { recursive: true });
  writeFileSync(skillFile, SKILL_V1);
  const quarantine = join(base, "uninstall-quarantine");
  const plugins = await createPlugins();
  const standalone = new Skills(pluginDir, ["skills/summarize/SKILL.md"]); // 独立 Skill：load 时当场读文件
  const pids = [];
  try {
    const load = (version) => async () => {
      const candidate = await loadPlugin(pluginDir, version);
      pids.push(candidate.pid);
      return candidate;
    };
    await plugins.update("r1", load("v1"));
    const a = await plugins.capture();

    writeFileSync(skillFile, SKILL_V2); // 开发者改了 SKILL.md，同时发布了新版服务器
    await plugins.update("r2", load("v2"));
    const b = await plugins.capture();

    const skillOf = (lease) => lease.skills.find((skill) => skill.name === "research-kit:summarize");
    const answer = async (lease) => (await lease.tools[0].execute({ query: "q" })).text;
    const reads = [
      { 读取者: "Turn A（更新前开始，持有 r1）", "Skill 运行时名字": skillOf(a).name, "Skill 正文最后一行": lastLine(skillOf(a).content), "search 的回答": await answer(a) },
      { 读取者: "Turn B（更新后开始，持有 r2）", "Skill 运行时名字": skillOf(b).name, "Skill 正文最后一行": lastLine(skillOf(b).content), "search 的回答": await answer(b) },
      { 读取者: "独立 Skill（load 时当场读文件）", "Skill 运行时名字": "summarize", "Skill 正文最后一行": lastLine(standalone.load("summarize").body), "search 的回答": "—" },
    ];
    a.release();

    // 卸载：commit 把目录挪进隔离区（可以撤销），finalize 才真正删除
    const probe = async (moment) => ({
      时刻: moment,
      插件目录: existsSync(pluginDir) ? "在" : "不在",
      隔离区: existsSync(quarantine) ? "在" : "不在",
      "r2 的 MCP 进程": isAlive(pids[1]) ? "运行中" : "已退出",
      "B 手里的 Skill 正文": lastLine(skillOf(b).content),
      "B 调用 search": await b.tools[0].execute({ query: "q" }).then((r) => r.text, () => "失败"),
    });
    const removal = [await probe("卸载之前")];
    await plugins.update("r3", async () => ({ tools: [], skills: [], close: async () => {} }), {
      commit: async () => {
        mkdirSync(quarantine);
        renameSync(pluginDir, join(quarantine, "research-kit"));
      },
      rollback: async () => {
        if (existsSync(join(quarantine, "research-kit"))) renameSync(join(quarantine, "research-kit"), pluginDir);
      },
      finalize: async () => rmSync(quarantine, { recursive: true, force: true }),
    });
    removal.push(await probe("卸载已提交（B 还没结束）"));
    b.release();
    for (let i = 0; i < 100 && (existsSync(quarantine) || isAlive(pids[1])); i++) await sleep(10);
    removal.push({ ...(await probe("B 释放租约之后")), "B 手里的 Skill 正文": "—（B 已结束）", "B 调用 search": "—（B 已结束）" });
    return { reads, removal };
  } finally {
    await plugins.close();
    for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
}

// ─── 场景五：同一份 SKILL.md，三种读法 ───────────────────────────────────────────

const CASES = [
  { 输入: "正常", text: "---\nname: summarize\ndescription: 总结文档\n---\n# 总结\n\n把文档压成三个要点。\n" },
  { 输入: "name 写了两次", text: "---\nname: summarize\nname: other\ndescription: 总结文档\n---\n# 总结\n\n把文档压成三个要点。\n" },
  { 输入: "frontmatter 没闭合", text: "---\nname: summarize\ndescription: 总结文档\n\n# 总结\n\n把文档压成三个要点。\n" },
  { 输入: "缺 description", text: "---\nname: summarize\n---\n# 总结\n\n# 总结\n\n把文档压成三个要点。\n" },
  { 输入: "name 和目录名不同", text: "---\nname: summary\ndescription: 总结文档\n---\n# 总结\n\n把文档压成三个要点。\n" },
  { 输入: "没有 frontmatter", text: "# 总结\n\n# 总结\n\n把文档压成三个要点。\n" },
];

/** 每种输入放进 skills/summarize/SKILL.md，用三种态度各读一遍，一格一句话。 */
export function skillPolicies() {
  const root = tempDir();
  try {
    const path = "skills/summarize/SKILL.md";
    mkdirSync(join(root, "skills/summarize"), { recursive: true });
    const read = (policy) => {
      try {
        const skills = new Skills(root, [path], { policy });
        const [entry] = skills.descriptions();
        const codes = skills.diagnostics.map((d) => d.code).join("、");
        if (!entry) return `跳过；诊断 ${codes}`;
        const described = entry.description ? `描述「${entry.description.slice(0, 12)}」` : "描述为空";
        return `收录 ${entry.name}，${described}${codes ? `；诊断 ${codes}` : ""}`;
      } catch (error) {
        return `整个包被拒绝：${error.message.replace(/^SKILL_SCHEMA_INVALID: /, "")}`;
      }
    };
    return CASES.map(({ 输入, text }) => {
      writeFileSync(join(root, path), text);
      return { 输入, "严格（官方包）": read("strict"), "跳过坏的（Agent Skills 包）": read("skip"), "宽松（用户自己的目录）": read("lenient") };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
