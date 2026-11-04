// 实验：规则台阶对账。同一批“规则 × 模式 × 本地检查”的组合，真实的 reducePermissionDecision 怎么判，host 的 decide 怎么判。
//   node labs/ch07/ladder.mjs
// MiniMax 一侧：真实的 reducePermissionDecision + modeToAskPolicy + applyAskGate，
//              加上 facade.checkPermissionRaw 里“本地硬检查 / policy 降级”的几行转写。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import { decide } from "../../host/src/permissions.mjs";
import { loadPermissionContext, loadPermissionCore } from "./upstream.mjs";
import { isMain, label, markdownTable, rule } from "./scenarios.mjs";

export async function run(log = console.log) {
  const { reducePermissionDecision } = await loadPermissionCore();
  const { createToolPermissionContext } = await loadPermissionContext();
  const { modeToAskPolicy } = await importSource("packages/agent-modules/permission/src/ask-policy.ts");
  const { applyAskGate } = await importSource("packages/local-runtime/src/permissions/ask-gate.ts");

  // host 的物理边界要碰真实文件系统，所以工作区是一个真实存在的临时目录
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch07-ladder-")));
  const ROOT = join(temp, "proj");
  mkdirSync(ROOT);

  /** MiniMax 一侧。local 是本地硬检查的结果：undefined | "policy" | "immune"。 */
  function upstream({ tool, readOnly, rules, mode, local }) {
    const engineMode = mode === "acceptEdits" ? "default" : mode;
    // acceptEdits 在 facade 入口归一成 default，效果靠启动时种下的“edit / write 整工具 allow”规则
    const seeded = mode === "acceptEdits" ? [rule("allow", "edit"), rule("allow", "write")] : [];
    const all = [
      ...Object.entries(rules).flatMap(([behavior, tools]) => tools.map((name) => rule(behavior, name))),
      ...seeded,
    ];
    if (local === "immune") return "deny";
    const context = createToolPermissionContext({
      mode: engineMode,
      rules: all,
      workingDirectory: ROOT,
      dataDir: "/Users/me/.minimax",
      homeDir: "/Users/me",
    });
    const checkerResult = readOnly ? { behavior: "allow", reason: { type: "workingDirectory", path: ROOT } } : undefined;
    const decision = reducePermissionDecision({ toolName: tool, input: {}, context, checkerRegistered: true, checkerResult });
    if (local === "policy" && modeToAskPolicy(engineMode) !== "never" && decision.behavior === "allow" && decision.reason.type !== "rule") {
      return "ask";
    }
    return applyAskGate({ behavior: decision.behavior, reason: "" }, engineMode).behavior;
  }

  /** host 一侧：用同样的组合构造一次调用。本地检查通过路径参数触发。 */
  function host({ tool, readOnly, rules, mode, local }) {
    const input = local === "immune" ? { path: "//srv/share/x" } : local === "policy" ? { path: ".env" } : {};
    return decide({ name: tool, input }, { readOnly }, { root: ROOT, rules, mode }).behavior;
  }

  const cases = [
    { 场景: "只读工具，没有规则", tool: "read", readOnly: true, rules: {}, mode: "default" },
    { 场景: "只读工具 + deny 规则", tool: "read", readOnly: true, rules: { deny: ["read"] }, mode: "default" },
    { 场景: "只读工具 + ask 规则", tool: "read", readOnly: true, rules: { ask: ["read"] }, mode: "default" },
    { 场景: "写工具，没有规则", tool: "edit", rules: {}, mode: "default" },
    { 场景: "写工具 + allow 规则", tool: "edit", rules: { allow: ["edit"] }, mode: "default" },
    { 场景: "写工具 + deny 和 allow 规则", tool: "edit", rules: { allow: ["edit"], deny: ["edit"] }, mode: "default" },
    { 场景: "写工具 + ask 和 allow 规则", tool: "edit", rules: { allow: ["edit"], ask: ["edit"] }, mode: "default" },
    { 场景: "写工具，acceptEdits", tool: "edit", rules: {}, mode: "acceptEdits" },
    { 场景: "写工具，完全访问", tool: "edit", rules: {}, mode: "bypassPermissions" },
    { 场景: "写工具 + ask 规则，完全访问", tool: "edit", rules: { ask: ["edit"] }, mode: "bypassPermissions" },
    { 场景: "写工具 + deny 规则，完全访问", tool: "edit", rules: { deny: ["edit"] }, mode: "bypassPermissions" },
    { 场景: "读凭据（policy），没有规则", tool: "read", readOnly: true, rules: {}, mode: "default", local: "policy" },
    { 场景: "读凭据（policy），完全访问", tool: "read", readOnly: true, rules: {}, mode: "bypassPermissions", local: "policy" },
    { 场景: "读凭据（policy）+ allow 规则", tool: "read", readOnly: true, rules: { allow: ["read"] }, mode: "default", local: "policy" },
    { 场景: "读凭据（policy）+ deny 规则", tool: "read", readOnly: true, rules: { deny: ["read"] }, mode: "default", local: "policy" },
    { 场景: "网络共享（immune），allow 规则 + 完全访问", tool: "read", readOnly: true, rules: { allow: ["read"] }, mode: "bypassPermissions", local: "immune" },
  ];

  const describeRules = (rules) =>
    Object.entries(rules).map(([behavior, tools]) => `${behavior}:${tools.join(",")}`).join(" ") || "—";
  const rows = cases.map((testCase) => {
    const { readOnly = false } = testCase;
    const expected = upstream({ ...testCase, readOnly });
    const actual = host({ ...testCase, readOnly });
    assert.equal(actual, expected, `${testCase.场景}：host 和 MiniMax 应该给出同样的结果`);
    return {
      场景: testCase.场景,
      规则: describeRules(testCase.rules),
      模式: testCase.mode,
      本地检查: { policy: "policy", immune: "bypass-immune" }[testCase.local] ?? "—",
      "MiniMax（真实 reducer）": label(expected),
      "host（decide）": label(actual),
    };
  });

  log("左边是固定提交里真实的 reducePermissionDecision（加 facade 的几行胶水），右边是 host/src/permissions.mjs 的 decide。\n");
  log(markdownTable(rows));
  log(`\n${rows.length} 个组合，两边的结果逐行一致。`);

  rmSync(temp, { recursive: true, force: true });
  return { rows };
}

if (isMain(import.meta.url)) await run();
