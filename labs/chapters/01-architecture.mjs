// 第 1 章：三个入口，一份状态。
//   node labs/chapters/01-architecture.mjs
// 先让三个入口依次往同一个会话发消息，看它们各自怎么说；再看“忙”在两个进程之间怎么被拒绝、
// 持有者崩了以后怎么被回收；最后核对 host 的退出码和 MiniMax 真实的 exitCodeForExecResult 一致。
import { lesson } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../../host/src/app.mjs";
import { adapters, exitCodeOf } from "../../host/src/adapters.mjs";
import { Sessions } from "../../host/src/sessions.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
import { importSource } from "../../lab/source.mjs";
import { concurrentSend, sayIt, OUTCOME_SCENARIOS } from "../ch01/scenarios.mjs";

await lesson(1, "三个入口，一份状态", async (t) => {
  // ── 1. 三个入口依次往同一个会话发消息 ─────────────────────────────────────────
  const app = await createApplication(join(t.temp, "data"));
  const api = adapters(app);
  try {
    const session = app.sessions.create(t.root);
    const reply = (text) => ({ model: scriptedKernel([{ text }]) });

    t.log("同一个会话，依次从 tui、exec、acp 三个入口各发一条消息：");
    t.log();
    const tui = await api.tui(session.id, "来自 tui", reply("T"));
    const exec = await api.exec({ sessionId: session.id, prompt: "来自 exec" }, reply("E"));
    const acp = await api.acp({ method: "session/prompt", params: { sessionId: session.id, text: "来自 acp" } }, reply("A"));
    t.table([
      { 入口: "tui", 请求: "(会话, 文本)", 运行时结局: tui.outcome.status, 入口的说法: tui.notice },
      { 入口: "exec", 请求: "{ prompt, sessionId }", 运行时结局: exec.outcome.status, 入口的说法: `退出码 ${exec.exitCode}` },
      { 入口: "acp", 请求: "{ method: session/prompt, params }", 运行时结局: acp.outcome.status, 入口的说法: `stopReason: ${acp.stopReason}` },
    ]);
    t.equal("三个入口都走到同一个应用，各是一次完成的 Turn", [tui, exec, acp].map((r) => r.status), ["completed", "completed", "completed"]);
    t.equal("三个 Turn 是三次独立的运行", new Set([tui, exec, acp].map((r) => r.turnId)).size, 3);
    t.equal("历史只有一份，按发送顺序包含三个入口的输入", app.sessions.history(session.id).filter((m) => m.role === "user").map((m) => m.text), ["来自 tui", "来自 exec", "来自 acp"]);
    t.equal("每次接纳都释放了租约", [app.sessions.active.size, app.sessions.holder(session.id)], [0, undefined]);
    t.equal("锁日志里是三对 acquire / release", app.sessions.locks.read().map((e) => e.type), ["acquire", "release", "acquire", "release", "acquire", "release"]);

    // exec 的会话解析：--continue 接上这个目录最近的会话；不给会话就新建，相对路径在入口解析成绝对路径。
    const resumed = await api.exec({ prompt: "接着做", continueSession: true, cwd: t.root }, reply("C"));
    t.equal("exec --continue 接上这个目录最近创建的会话", app.sessions.history(session.id).filter((m) => m.role === "user").at(-1).text, "接着做");
    t.equal("--continue 的回合没有新建会话", app.sessions.list(t.root).length, 1);
    const fresh = await api.exec({ prompt: "新会话", cwd: "." }, reply("N"));
    t.ok("exec 不给会话就新建，工作目录在入口被解析成绝对路径", fresh.outcome.status === "succeeded" && app.sessions.list().at(-1).workspaceDir.startsWith("/"));
    mkdirSync(join(t.temp, "empty"));
    const missing = await api.exec({ prompt: "x", continueSession: true, cwd: join(t.temp, "empty") }, reply("X"));
    t.equal("exec --continue 在没有会话的目录里，是退出码 4 而不是崩溃", [missing.exitCode, missing.outcome.error.message.startsWith("No active Session exists")], [4, true]);

    t.throws("运行时拒绝相对路径：入口必须先解析", () => app.sessions.create("./relative"), /absolute/);
    const badNew = await api.acp({ method: "session/new", params: { cwd: "./relative" } }).catch((e) => e);
    t.equal("ACP 的 session/new 把相对 cwd 报成 invalid params", badNew.code, -32602);
    await t.rejects("不认识的 ACP 方法被拒绝", api.acp({ method: "session/other", params: {} }), /unsupported/);
    t.observations.history = app.sessions.history(session.id).map((m) => `${m.role}: ${m.text}`);
    t.observations.resumedTurn = resumed.turnId;
  } finally {
    await app.close();
  }

  // ── 2. 两个进程抢同一个会话 ──────────────────────────────────────────────────
  t.log("两个进程（同一个数据目录）：终端 P 正在跑，编辑器 Q 发来第二条消息。");
  t.log();
  const naive = await concurrentSend({ shared: false });
  const leased = await concurrentSend({ shared: true });
  t.table([
    { 做法: "忙只记在各自的内存里（上一版）", "Q 被接纳": naive.qAdmitted ? "是，和 P 同时在跑" : "否", "Q 的模型看到的消息数": naive.seen.find((s) => s.who === "编辑器 Q").messages, 锁日志: naive.lockEvents.length ? naive.lockEvents.map((e) => e.type).join(" → ") : "空" },
    { 做法: "租约写在共享的锁日志里", "Q 被接纳": leased.qAdmitted ? "是" : "否：-32603 session busy", "Q 的模型看到的消息数": `重试后 ${leased.seen.find((s) => s.who === "编辑器 Q（重试）").messages}`, 锁日志: leased.lockEvents.map((e) => `${e.type}(${e.who})`).join(" → ") },
  ]);
  t.equal("内存标志挡不住另一个进程", naive.qAdmitted, true);
  t.equal("租约让第二个进程在入口就被拒绝", [leased.qAdmitted, leased.qOutcome.error.code, leased.qOutcome.error.data.code], [false, -32603, "local_session_busy"]);
  t.equal("P 结束以后 Q 重试成功，并且看得到 P 的历史", leased.seen.find((s) => s.who === "编辑器 Q（重试）").messages, 3);
  t.equal("两个进程最后都不再持有租约", leased.activeAfter, [0, 0]);

  // ── 3. 持有者崩了：租约过期，或者持有者的进程已经不在 ──────────────────────────
  let clock = 0;
  const options = (extra) => ({ now: () => clock, leaseMs: 1000, ...extra });
  const A = new Sessions(join(t.temp, "lease"), options());
  const B = new Sessions(join(t.temp, "lease"), options());
  const leased1 = A.create(t.root);
  A.admit(leased1.id, "turn-A");
  clock = 500;
  t.throws("租约没到期，B 被拒绝", () => B.admit(leased1.id, "turn-B"), /busy/);
  t.ok("续租成功把到期时间往后推", A.renew(leased1.id, "turn-A") && A.holder(leased1.id).expiresAt === 1500);
  clock = 1400;
  t.throws("续过租的持有者没到期，B 仍被拒绝", () => B.admit(leased1.id, "turn-B"), /busy/);
  clock = 1600;
  B.admit(leased1.id, "turn-B");
  t.equal("到期之后 B 接管，并留下回收记录", B.recoveries(), [{ sessionId: leased1.id, turnId: "turn-A", reason: "expired-lease" }]);
  t.throws("被回收的 Turn 不能再写历史（僵尸写入）", () => A.append(leased1.id, "turn-A", [{ role: "assistant", text: "x" }]), /lease lost/);

  // 持有者的进程已经不在了：不用等租约到期。用伪造的“进程是否存活”让这个场景确定。
  const alive = new Set([111]);
  const dead = new Sessions(join(t.temp, "pids"), { pid: 111, isProcessAlive: (pid) => alive.has(pid) });
  const watcher = new Sessions(join(t.temp, "pids"), { pid: 222, isProcessAlive: (pid) => alive.has(pid) });
  const pidSession = dead.create(t.root);
  dead.admit(pidSession.id, "turn-D");
  t.throws("持有者的进程还活着，租约还在期内：被拒绝", () => watcher.admit(pidSession.id, "turn-W"), /busy/);
  alive.delete(111);
  watcher.admit(pidSession.id, "turn-W");
  t.equal("持有者的进程没了，立刻被回收，不用等 30 分钟", watcher.recoveries()[0].reason, "owner-dead");
  t.table([
    { 情形: "租约到期（持有者的进程还活着）", 回收原因: B.recoveries()[0].reason, 什么时候能接手: "要等租约到期" },
    { 情形: "持有者的进程已不在", 回收原因: watcher.recoveries()[0].reason, 什么时候能接手: "立刻" },
  ]);

  // ── 4. 同一个结局，三个入口各怎么说；退出码和真实函数一致 ────────────────────────
  const rows = [];
  for (const scenario of OUTCOME_SCENARIOS) {
    const said = {};
    for (const surface of ["tui", "exec", "acp"]) said[surface] = (await sayIt(scenario, surface)).说法;
    rows.push({ 结局: scenario.name, tui: said.tui, exec: said.exec, acp: said.acp });
  }
  t.log("同一个运行时结局，三个入口的说法：");
  t.log();
  t.table(rows);
  t.equal("exec 对五种结局的退出码", rows.map((r) => r.exec), ["退出码 0", "退出码 4", "退出码 130", "退出码 4", "退出码 7"]);
  t.equal("acp 对五种结局的回复", rows.map((r) => r.acp), ["stopReason: end_turn", "JSON-RPC 错误 -32603", "stopReason: cancelled", "JSON-RPC 错误 -32603", "stopReason: max_turn_requests"]);

  const real = await importSource("packages/tui/src/headless/exit-policy.ts");
  const outcomes = [
    { status: "succeeded" },
    { status: "failed", error: { category: "runtime" } },
    { status: "failed", error: { category: "config" } },
    { status: "failed", error: { category: "internal" } },
    { status: "timeout" },
    { status: "cancelled" },
    { status: "limit_exceeded" },
  ];
  t.equal("host 的退出码映射和 MiniMax 的 exitCodeForExecResult 逐项一致", outcomes.map(exitCodeOf), outcomes.map((o) => real.exitCodeForExecResult(o)));
  t.observations.exitCodes = outcomes.map((o) => ({ status: o.status, category: o.error?.category, exit: exitCodeOf(o) }));
  t.observations.surfaces = rows;
});
