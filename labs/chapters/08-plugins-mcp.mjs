// 第 8 章回归实验：插件、Skill 与 MCP 的“代”。
//   node labs/chapters/08-plugins-mcp.mjs          读者模式：打印过程和每项检查
//   node labs/chapters/08-plugins-mcp.mjs --json   构建模式
// 正文里嵌入的五个实验（labs/ch08/*.mjs）各回答一个问题；这里把它们的场景再跑一遍，
// 并补上正文没有展开的失败路径：发现失败、commit 失败、串行更新、关闭。
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lesson, ROOT } from "./harness.mjs";
import { createPlugins, mcpRuntime } from "../../host/src/plugins.mjs";
import { SkillError, parseSkill, inspectSkill } from "../../host/src/skills.mjs";
import {
  frozenScenario,
  gateScenario,
  hostSystem,
  isAlive,
  realSystem,
  registryTour,
  relabelHazard,
  skillPolicies,
  startServer,
  updatePolicies,
} from "../ch08/scenarios.mjs";

await lesson(8, "插件：新旧两代同堂，最后一个租约释放才拆旧的", async (t) => {
  // ── 1. 三种做法 ────────────────────────────────────────────────────────────
  t.log("1. 更新插件时，进行中的 Turn 怎么办（真实的 MCP 子进程）");
  const policies = await updatePolicies();
  t.table(policies);
  const [closeNow, neverClose, lease] = policies;
  t.ok("立刻关旧的：进行中的调用被打断", closeNow["A 进行中的调用"].startsWith("失败"));
  t.equal("不关旧的：旧进程泄漏", neverClose["A 释放之后 v1 进程"], "仍在运行（泄漏）");
  t.equal(
    "租约：A 的调用完成，B 用新版本，旧进程在 A 释放之后退出",
    [lease["A 进行中的调用"], lease["B（更新后开始）的调用"], lease["更新刚完成时 v1 进程"], lease["A 释放之后 v1 进程"]],
    ["v1:alpha", "v2:beta", "仍在运行", "已退出"],
  );

  // ── 2. 真实的 registry ─────────────────────────────────────────────────────
  t.log("2. 真实的 generation registry：每一步之后各代的状态");
  const { rows: tour, log } = await registryTour();
  t.table(tour);
  t.equal("先关运行时，再跑 finalizer，每个运行时只关一次", log, ["close r1", "finalize r1", "close r2"]);
  const hazard = await relabelHazard();
  t.equal("replaceRevision 之后租约从 0 记起：还在用的运行时被关掉", hazard[2].本步新增日志, "close r1");

  // ── 3. host 和真实生命周期，同一个剧本 ──────────────────────────────────────
  t.log("3. 同一个剧本：host 的 createPlugins 对照真实的 AgentHostTurnCapabilityLifecycle");
  const project = (events) => events.map((event) => `${event.谁}｜${event.发生了什么}`);
  const real = project(await gateScenario(await realSystem()));
  const host = project(await gateScenario(await hostSystem()));
  t.table(real.map((line, i) => ({ "#": i + 1, 真实生命周期: line, host: host[i] ?? "（缺）" })));
  t.equal("事件顺序一致", host, real);

  // ── 4. 失败路径 ────────────────────────────────────────────────────────────
  t.log("4. 失败路径：候选没能上位，旧代原样保留");
  {
    const plugins = await createPlugins();
    const closed = [];
    const candidate = (name, tools = [{ name }]) => ({ tools, close: async () => void closed.push(name) });
    await plugins.update("r1", async () => candidate("r1"));

    await t.rejects("发现失败：update 抛出", plugins.update("r2", async () => { throw Error("tools/list timed out"); }), /timed out/);
    const afterDiscovery = await plugins.capture();
    t.equal("发现失败：当前代还是 r1", afterDiscovery.revision, "r1");
    afterDiscovery.release();

    const events = [];
    await t.rejects(
      "commit 失败：update 抛出",
      plugins.update("r2", async () => candidate("r2"), {
        commit: async () => {
          events.push("commit");
          throw Error("disk full");
        },
        rollback: async () => void events.push("rollback"),
      }),
      /disk full/,
    );
    t.equal("commit 失败：候选被关掉，提交被撤销", [closed, events], [["r2"], ["commit", "rollback"]]);
    const afterCommit = await plugins.capture();
    t.equal("commit 失败：发布门重新打开，capture 不会卡住，当前代还是 r1", afterCommit.revision, "r1");
    afterCommit.release();
    await plugins.update("r2", async () => candidate("r2"));
    t.equal("失败的 revision 没有被占用，可以重试", (await plugins.capture()).revision, "r2");
    await t.rejects("成功用过的 revision 不能重用", plugins.update("r2", async () => candidate("r2")), /duplicate/);

    const view = await plugins.capture();
    t.ok("Turn 拿到的视图是冻结的", Object.isFrozen(view.tools) && Object.isFrozen(view.skills));
    view.release();
    await plugins.close();
  }

  t.log("5. 发布门只挡 capture，更新一件一件串行执行");
  {
    const plugins = await createPlugins();
    await plugins.update("r1", async () => ({ tools: [], close: async () => {} }));
    let finishCommit;
    const updating = plugins.update("r2", async () => ({ tools: [], close: async () => {} }), {
      commit: () => new Promise((resolve) => (finishCommit = resolve)),
    });
    await sleep(10);
    let captured = false;
    const waiting = plugins.capture().then((lease) => ((captured = true), lease));
    await sleep(20);
    t.equal("commit 进行中：capture 在门口等着", captured, false);
    finishCommit();
    t.equal("commit 完成：capture 拿到新一代", (await waiting).revision, "r2");
    await updating;

    const order = [];
    const slow = plugins.update("r3", async () => (await sleep(40), order.push("r3 发现完成"), { tools: [], close: async () => {} }));
    const fast = plugins.update("r4", async () => (order.push("r4 开始发现"), { tools: [], close: async () => {} }));
    await Promise.all([slow, fast]);
    t.equal("第二个更新要等第一个发布完才开始发现", order, ["r3 发现完成", "r4 开始发现"]);
    await plugins.close();
    await t.rejects("关闭之后不能再更新", plugins.update("r5", async () => ({ tools: [] })), /closed/);
    await t.rejects("关闭之后不能再 capture", plugins.capture(), /closed/);
  }

  t.log("6. 关闭：等进行中的更新收尾，不留下孤儿进程");
  {
    const plugins = await createPlugins();
    const runtime = await startServer("v1");
    const updating = plugins.update("r1", async () => (await sleep(30), runtime));
    await sleep(5); // 让发现已经开始
    const closing = plugins.close();
    await t.rejects("关闭时正在发现的更新被拒绝", updating, /closed/);
    await closing;
    t.equal("被拒绝的候选（真实 MCP 进程）已关闭", isAlive(runtime.pid), false);
  }

  // ── 7. MCP ─────────────────────────────────────────────────────────────────
  t.log("7. MCP 运行时");
  {
    const runtime = await startServer("v9", { server: "docs server" });
    try {
      t.equal("运行时名字：mcp__<服务器>__<工具>，非法字符变下划线", runtime.tools.map((tool) => tool.name), ["mcp__docs_server__search"]);
      t.equal("真实调用走通", (await runtime.tools[0].execute({ query: "ping" })).text, "v9:ping");
    } finally {
      await runtime.close();
    }
    const legacy = await mcpRuntime(process.execPath, [join(ROOT, "labs/fixtures/mcp-server.mjs")]);
    try {
      t.equal("默认名字保持 mcp_<工具>（其他章节在用）", legacy.tools[0].name, "mcp_echo");
      t.equal("旧夹具的调用结果", (await legacy.tools[0].execute({ text: "first-turn-tool" })).text, "first-turn-tool");
    } finally {
      await legacy.close();
    }
    await t.rejects("握手失败时抛出，不留进程", mcpRuntime(process.execPath, ["-e", "process.exit(1)"]), /exited|closed/);
  }

  // ── 8. 冻结的视图和目录的命运 ───────────────────────────────────────────────
  t.log("8. 一代带走的东西");
  const { reads, removal } = await frozenScenario();
  t.table(reads);
  t.table(removal);
  t.equal(
    "插件 Skill 跟着代走，独立 Skill 当场读",
    reads.map((row) => /三个/.test(row["Skill 正文最后一行"]) ? "旧" : "新"),
    ["旧", "新", "新"],
  );
  t.equal(
    "卸载：目录先挪进隔离区，旧代的最后一个租约释放之后才真正删除",
    removal.map((row) => [row.插件目录, row.隔离区, row["r2 的 MCP 进程"]]),
    [["在", "不在", "运行中"], ["不在", "在", "运行中"], ["不在", "不在", "已退出"]],
  );

  // ── 9. Skill ───────────────────────────────────────────────────────────────
  t.log("9. 同一份 SKILL.md，三种读法");
  const matrix = skillPolicies();
  t.table(matrix);
  t.ok(
    "五种坏输入：严格整包拒绝，跳过逐个记诊断，宽松全部收录",
    matrix.slice(1).every((row) => row["严格（官方包）"].startsWith("整个包被拒绝") && row["跳过坏的（Agent Skills 包）"].startsWith("跳过") && row["宽松（用户自己的目录）"].startsWith("收录")),
  );
  t.throws("重复的 frontmatter 键在加载时就被拒绝", () => parseSkill("---\nname: a\nname: b\ndescription: x\n---\nbody"), /duplicate/);
  t.throws("拒绝的是 SkillError，带稳定的 code", () => parseSkill("not a skill"), (error) => error instanceof SkillError && error.code === "SKILL_SCHEMA_INVALID");
  t.equal("name 省略时用目录名", parseSkill("---\ndescription: d\n---\nbody", { dirName: "review" }).name, "review");
  t.equal("宽松读取：没有任何线索时名字推不出来，不收录", inspectSkill("just text").skill, undefined);
  t.equal("allowed-tools 按逗号拆开", parseSkill("---\nname: a\ndescription: d\nallowed-tools: read, edit\n---\nb").allowedTools, ["read", "edit"]);
});
