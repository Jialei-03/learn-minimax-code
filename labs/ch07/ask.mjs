// 实验：一个 ask 怎么交给用户、用户的回复怎么落地。
//   node labs/ch07/ask.mjs             全部
//   node labs/ch07/ask.mjs flow        host 的 askUser：七种情形
//   node labs/ch07/ask.mjs contracts   真实的 request-contracts.ts：事件的形状、回复的别名、模式的默认值
// flow 对应 LocalTurnPermissionGate.requestApproval + 审批服务的 reply；
// contracts 是固定提交里的原文，用 importSource 直接运行。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import { addRule, askUser, decide } from "../../host/src/permissions.mjs";
import { isMain, label, markdownTable } from "./scenarios.mjs";

export async function run(log = console.log, part) {
  const printer = (name) => (text = "") => (part === undefined || part === name) && log(text);
  const flowOut = printer("flow");
  const contractsOut = printer("contracts");

  // ── flow：host 的 askUser ────────────────────────────────────────────────────
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch07-ask-")));
  const root = join(temp, "proj");
  mkdirSync(root);

  const call = { name: "edit", input: { path: "a.txt" } };
  const definition = {};
  const aborted = new AbortController();
  aborted.abort(Error("user pressed Esc"));
  const situations = [
    { 情形: "exec：宿主没有审批通道", ask: {} },
    { 情形: "用户选“允许（本次会话）”", ask: { approve: async () => "allowOnce" } },
    { 情形: "用户选“总是允许”", ask: { approve: async () => "allowAlways" } },
    { 情形: "用户选“拒绝”", ask: { approve: async () => "deny" } },
    { 情形: "审批通道抛错（ACP 连接断了）", ask: { approve: async () => { throw Error("connection closed"); } } },
    { 情形: "等待期间用户取消了 Turn", ask: { approve: async () => "allowAlways", signal: aborted.signal } },
    { 情形: "通道回了个不认识的值", ask: { approve: async () => "yes" } },
  ];

  const first = decide(call, definition, { root, rules: {} });
  assert.equal(first.behavior, "ask");

  const rows = [];
  for (const situation of situations) {
    let outcome;
    try {
      outcome = await askUser(first, call, situation.ask);
    } catch (error) {
      rows.push({
        情形: situation.情形,
        这次调用: "不执行（抛出）",
        落下的规则: "—",
        同样的调用再来一次: `异常：${error.message.split(":")[0]}`,
      });
      continue;
    }
    const second = decide(call, definition, { root, rules: addRule({}, outcome.rule) });
    rows.push({
      情形: situation.情形,
      这次调用: outcome.allowed ? "执行" : "不执行",
      落下的规则: outcome.rule
        ? `${outcome.rule.scope === "global" ? "全局" : "会话"} ${outcome.rule.behavior} ${outcome.rule.tool}`
        : "—（不是用户的决定）",
      同样的调用再来一次: `${label(second.behavior)}（${second.stage}）`,
    });
  }
  flowOut("同一个调用 `edit a.txt`，没有任何规则，所以 decide 给出“询问”。下面是不同情形下 askUser 的结果。\n");
  flowOut(markdownTable(rows));
  flowOut("\n“同样的调用再来一次”：把落下的规则合并进规则表，再 decide 一次。");
  assert.deepEqual(
    rows.map((row) => row.这次调用),
    ["不执行（抛出）", "执行", "执行", "不执行", "不执行", "不执行", "不执行（抛出）"],
  );
  rmSync(temp, { recursive: true, force: true });

  // ── contracts：真实的 request-contracts.ts ───────────────────────────────────
  const contracts = await importSource("packages/local-runtime-v2/src/service/permission/request-contracts.ts");
  const record = (extra) => ({
    sessionId: "s1",
    turnId: "t1",
    agentName: "main",
    toolName: "edit",
    createdAt: 0,
    waiters: new Set(),
    resolve() {},
    cleanup() {},
    ...extra,
  });
  const payload = contracts.serializePermissionRequest(
    record({
      requestId: "perm_1",
      ruleContents: ["/Users/me/other/**"],
      toolInput: '{"path":"/Users/me/other/a.txt"}',
      toolDescription: "edit /Users/me/other/a.txt",
      reason: "edit path escapes workspace",
    }),
  );
  const ptc = contracts.serializePermissionRequest(
    record({
      requestId: "perm_2",
      ruleContents: [],
      persistWholeToolRuleOnReply: true,
      reason: "edit path escapes workspace",
      parentToolCallId: "call_9",
      parentToolDescription: "run_code: 批量改名",
    }),
  );
  contractsOut("真实的 `serializePermissionRequest` 产生的 `permission.ask` 事件（TUI 和 ACP 收到的就是这个形状）：\n");
  contractsOut("```json\n" + JSON.stringify(payload, null, 2) + "\n```\n");
  contractsOut(`run_code 的子调用多两个字段，reason 前面加前缀：\`${ptc.reason}\`，工具描述：\`${ptc.toolDescription}\`。\n`);

  const aliasRows = ["allow", "allow-always", "allow-for-agent", "deny", "yes"].map((value) => ({
    "回复里的 decision": `\`${value}\``,
    readPermissionDecision: contracts.readPermissionDecision({ decision: value }) ?? "undefined（不认识，请求保持挂起）",
  }));
  const modeRows = [undefined, "default", "acceptEdits", "bypassPermissions", "off", "dontAsk", "plan"].map((value) => ({
    "配置里的 permissionMode": value === undefined ? "（没配）" : `\`${value}\``,
    readLocalPermissionMode: contracts.readLocalPermissionMode(value),
  }));
  contractsOut(markdownTable(aliasRows));
  contractsOut();
  contractsOut(markdownTable(modeRows));

  assert.equal(payload.allowAlwaysSupported, true);
  assert.equal(ptc.allowAlwaysSupported, true); // ruleContents 为空时，persistWholeToolRuleOnReply 让“总是允许”仍然可用
  assert.equal(ptc.reason, "来自 PTC：edit path escapes workspace");
  assert.equal(ptc.toolDescription, "PTC: run_code: 批量改名");
  assert.equal(contracts.readLocalPermissionMode(undefined), "auto");
  assert.equal(contracts.readLocalPermissionMode("dontAsk"), "auto");
  assert.equal(contracts.readPermissionDecision({ decision: "yes" }), undefined);
  return { rows };
}

if (isMain(import.meta.url)) await run(console.log, process.argv[2]);
