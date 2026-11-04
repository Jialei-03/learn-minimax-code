// 第 5 章回归实验：一个 Turn 开始前，提示是怎样拼出来的。
//   node labs/chapters/05-context-memory.mjs          打印实验过程和每项检查
//   node labs/chapters/05-context-memory.mjs --json   构建模式
// 场景本身在 labs/ch05/scenarios.mjs，正文里嵌入的是 labs/ch05/*.mjs 打印的表格。
import { lesson } from "./harness.mjs";
import {
  Templates,
  preparePrompt,
  projectMessages,
  promptRegistry,
  buildUserMessage,
  genuineUserText,
  fingerprintPrompt,
  assemblyStability,
} from "../../host/src/context.mjs";
import {
  assembleRequest,
  instructionCases,
  memoryDelta,
  memoryInjection,
  mixedGeneration,
  overrideCases,
  promptHandoff,
  reminderChain,
  snapshotVsLive,
} from "../ch05/scenarios.mjs";

await lesson(5, "上下文：一个 Turn 的提示怎样拼成，为什么只拍一次", async (t) => {
  // ── 一、拍照与现读 ──────────────────────────────────────────────
  t.log("一、一个 Turn 请求 4 次，中途 AGENTS.md 被改、模板刷新：现读 vs. 拍照");
  const { live, snapshot, summary, raw } = await snapshotVsLive();
  t.table(live);
  t.table(snapshot);
  t.table(summary);
  const turn1 = (rows) => rows.filter((row) => row.Turn === 1);
  t.equal(
    "拍照：同一个 Turn 里每次请求的系统提示指纹相同",
    new Set(turn1(raw.snapshot).map((row) => row.系统提示指纹)).size,
    1,
  );
  t.ok(
    "现读：同一个 Turn 里系统提示变了两次",
    new Set(turn1(raw.live).map((row) => row.系统提示指纹)).size === 3,
  );
  t.equal(
    "拍照：新版本在下一个 Turn 开始时才出现，两次变化合并成一次",
    [summary[1]["其中发生在 Turn 中途"], summary[1].提示改变的次数],
    [0, 1],
  );
  const mixed = await mixedGeneration();
  t.table(mixed);
  t.equal("现读会读到两代材料，拍照不会", [mixed[0].同一代, mixed[1].同一代], ["否", "是"]);

  // ── 二、拼装 ────────────────────────────────────────────────────
  t.log("\n二、系统提示的配方与用户消息");
  const assembled = await assembleRequest();
  t.table(assembled.rows);
  t.equal(
    "系统提示各部分的顺序",
    [...new Set(assembled.prompt.sections)],
    ["identity", "preamble", "global", "project", "environment", "memory", "skills"],
  );
  t.ok("系统提示里没有日期", !/2026-11-04/.test(assembled.prompt.text));
  t.ok("日期在用户消息的 reminder 里", /date: 2026-11-04/.test(assembled.userMessage.text));
  t.equal(
    "canonicalTextRange 切出用户原话",
    genuineUserText(assembled.userMessage),
    "把失败的测试修好",
  );
  t.throws("拼好的提示是冻结的，中途改不了", () => assembled.prompt.system.push("x"), TypeError);
  t.ok(
    "按范围分账：MEMORY 的字符数等于三个记忆块之和",
    assembled.kindTotals.MEMORY ===
      assembled.prompt.system
        .filter((_, i) => assembled.prompt.sections[i] === "memory")
        .reduce((sum, part) => sum + part.length, 0),
  );
  const message = buildUserMessage({ prefixes: [undefined, "  ", "<r/>"], userText: "hi" });
  t.equal("空前缀被忽略", message.text, "<r/>\n\nhi");

  // ── 三、指令文件 ────────────────────────────────────────────────
  t.log("\n三、项目指令与全局指令");
  const instructions = await instructionCases();
  t.table(instructions.rows);
  t.table(instructions.globalRows);
  t.ok("CLAUDE.md 先到先得", instructions.bothFound.content.includes("old name"));
  t.equal("不往上找父目录", instructions.rows[3].读到的文件, "（没有）");
  t.ok("项目指令超限：截断在预算内", Buffer.byteLength(instructions.bigFound.content) <= instructions.limit);
  t.ok("中文截断没有乱码", !instructions.cjkFound.content.includes("�"));
  t.equal("全局指令超限整份丢弃", instructions.globalRows[1].注入字节, 0);

  // ── 四、记忆 ────────────────────────────────────────────────────
  t.log("\n四、记忆块与记忆增量");
  const injection = await memoryInjection();
  t.table(injection.rows);
  t.equal("host 与上游的记忆块顺序一致", injection.tagsHost, injection.tagsUpstream);
  const delta = await memoryDelta();
  t.table(delta.rows);
  t.equal(
    "末尾追加只送新增的一段",
    delta.rows[1].内容,
    "- release branch is main",
  );
  t.equal("什么都没变就什么都不送", [delta.rows[0].送出的增量, delta.rows[4].送出的增量], ["（无）", "（无）"]);

  // ── 五、覆盖系统提示 ────────────────────────────────────────────────
  t.log("\n五、覆盖系统提示");
  const overrides = await overrideCases();
  t.table(overrides.rows);
  const [, replaced, appended, child] = overrides.rows;
  t.equal("换掉身份以后，运行时规则、项目指令、记忆、能力清单都还在", [replaced.运行时规则, replaced.项目指令, replaced.记忆块, replaced.能力清单], ["有", "有", "有", "有"]);
  t.equal("追加的文字出现在提示里", appended.追加的文字, "有");
  t.equal("后台任务的子 Agent 不受启动参数影响", [child.身份提示, child.追加的文字], ["内置", "无"]);
  t.ok("host 的 addRuntimeRules 与上游逐字一致", overrides.parity.every((row) => row.逐字一致 === "是"));

  // ── 六、Registry 与整包回退 ────────────────────────────────────────
  t.log("\n六、提前渲染的提示怎样交给 Turn");
  const handoff = await promptHandoff();
  t.table(handoff.handoffRows);
  t.table(handoff.ops);
  t.table(handoff.bundleRows);
  t.equal("经 Registry 取走的快照和渲染时一致", handoff.viaHandoff, "SYSTEM v1");
  t.equal("不经 Registry 重新拍，会读到新一代", handoff.viaFresh, "SYSTEM v2");
  t.equal("take 只能取一次", handoff.takenAgain, undefined);
  t.equal(
    "预留同样占容量，rebind 不覆盖已有的预留",
    handoff.ops.filter((op) => ["reserve(c)", "rebind(a, b)"].includes(op.操作)).map((op) => op.结果),
    ["false", "false"],
  );
  t.equal(
    "整包回退：缺一个受管的模板，两个都读内置，不拼新旧两代",
    [handoff.bundleRows[1]["goal/continuation.md"], handoff.bundleRows[1]["goal/recovery.md"]],
    ["GOAL builtin", "RECOVERY builtin"],
  );

  // ── 七、reminder 链 ────────────────────────────────────────────────
  t.log("\n七、reminder 链（运行上游真实的 provider）");
  const reminders = await reminderChain();
  t.table(reminders.rows);
  t.equal("第 1 轮触发的 provider", reminders.fired[0], ["agentContext", "mediaOutputReminder", "asyncAudit"]);
  t.equal("第 2 轮只剩精简的 agent-context", reminders.fired[1], ["agentContext"]);
  t.equal("只跑 critical", reminders.fired[3], ["mediaOutputReminder", "asyncAudit"]);

  // ── 八、向后兼容的 API ────────────────────────────────────────────────
  t.log("\n八、第 5 章最初的接口仍然可用");
  const templates = new Templates({ system: "R1" });
  const first = templates.capture();
  templates.update("system", "R2");
  t.equal("旧快照仍读到 R1", templates.read(first, "system"), "R1");
  t.ok("preparePrompt(templates, snapshot).system[0] 以身份模板开头", preparePrompt(templates, first).system[0].startsWith("R1"));
  t.ok("新拍的快照读到 R2", preparePrompt(templates, templates.capture()).system[0].startsWith("R2"));
  t.throws("读不存在的键抛错", () => templates.read(first, "nope"), /prompt snapshot invalid/);
  const withMemory = preparePrompt(templates, first, [{ path: "/m/MEMORY.md", text: "- note" }]);
  t.ok("旧的 memories 参数仍然生效", withMemory.text.includes("/m/MEMORY.md") && withMemory.text.includes("- note"));
  const registry = await promptRegistry(1);
  const scope = { source: templates, snapshot: first };
  t.equal("预留占容量", registry.reserve("A"), true);
  t.equal("没填值的预留挡住 B", registry.reserve("B"), false);
  registry.remember("A", scope);
  t.equal("rebind 移动已存的 scope", registry.rebind("A", "C"), true);
  t.equal("take 保持对象身份", registry.take("C"), scope);
  t.equal("take 只能取一次", registry.take("C"), undefined);
  registry.close();

  const history = [
    { role: "tool", id: "orphan", text: "bad" },
    { role: "user", text: "image", images: ["old", "new"] },
  ];
  const projected = projectMessages(history, { maxImages: 1 });
  t.equal("孤儿工具结果不进请求", projected.length, 1);
  t.equal("原历史里的图片不动", history[1].images, ["old", "new"]);
  t.equal("请求副本里旧图换成占位", projected[0].images, ["[older image omitted]", "new"]);

  const fp = fingerprintPrompt("same", [{ name: "read", schema: {} }]);
  t.equal("指纹对相同输入稳定", assemblyStability(fp, fingerprintPrompt("same", [{ name: "read", schema: {} }])), {
    systemPrompt: "stable",
    tools: "stable",
  });
  t.observations.sections = assembled.prompt.sections;
});
