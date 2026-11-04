// 第 12 章实验的场景。每个函数只返回数据，由同目录的 story / trace / fixes 脚本打印，
// 也被 labs/chapters/12-comparison-interview.mjs 拿去做回归检查。
//
// 这里没有任何“演示专用”的宿主：全部跑在 host/src/app.mjs 的 createApplication 上，
// 工具是真的子进程（长任务、失败的测试、MCP 服务），文件是真的写盘，队列和事件是真的日志。
// 只有模型是脚本化的（scriptedKernel）。离线、确定、不需要 API Key。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createApplication } from "../../host/src/app.mjs";
import { Templates } from "../../host/src/context.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
import { mcpRuntime } from "../../host/src/plugins.mjs";
import { collector } from "../../host/src/sdk.mjs";
import { Sessions } from "../../host/src/sessions.mjs";
import { runProcess } from "../../runtime/process.mjs";
import { compactionBudget } from "../../host/src/history.mjs";

const ROOT = realpathSync(join(import.meta.dirname, "../.."));
const MCP_SERVER = join(ROOT, "labs/fixtures/mcp-server.mjs");

// ─── 小工具 ────────────────────────────────────────────────────────────────

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

/** 在临时目录里运行，结束后删除。 */
export async function withTemp(run) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ch12-")));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
async function waitFor(condition, ms = 1500) {
  for (let waited = 0; waited < ms && !(await condition()); waited += 10) await sleep(10);
  return condition();
}
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const call = (id, name, input) => ({ calls: [{ id, name, input }] });
const flat = (text, n = 60) => {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};

/** 工作区：一个有 bug 的 slug 函数、一个会失败的测试、一个永不结束的长任务、一个 Skill、一份项目指令。 */
function seedWorkspace(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "slug.cjs"), "module.exports=s=>s.trim().replace(/ /g,'-');\n");
  writeFileSync(
    join(root, "test.cjs"),
    [
      "const slug = require('./slug.cjs');",
      "const got = slug('a  b');",
      "if (got !== 'a-b') { console.log('FAIL: slug(\"a  b\") = ' + JSON.stringify(got) + ', want \"a-b\"'); process.exit(1); }",
      "console.log('tests passed');",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "slow.cjs"), "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)");
  writeFileSync(join(root, "SKILL.md"), "---\nname: verify\ndescription: Verify repairs\n---\nRun test.cjs before reporting success.");
  writeFileSync(join(root, "CLAUDE.md"), "Project rules v1: keep every change small.");
}

/** 起一个真实的 MCP 子进程，包成 plugins.update 要的“候选”。`closed` 记下每一代被关闭的时刻。 */
function candidate(name, closed, extra = {}) {
  return async () => {
    const runtime = await mcpRuntime(process.execPath, [MCP_SERVER]);
    return {
      ...runtime,
      ...extra,
      close: async () => {
        closed.push(name);
        await runtime.close();
      },
    };
  };
}

// ═══ 一、主线：长任务 A → 插件更新 → B 排队 → 取消 A → B 修好测试 → SDK 还原 ═══════════════════

/**
 * 返回 { rows, steps, repair, sdk, facts }：
 *   rows    逐步表格（人读）
 *   steps   @trace 的回放数据
 *   repair  B 的修复过程（每一步的工具和结果）
 *   sdk     三个 SDK 客户端各自还原出什么
 *   facts   给回归检查用的原始事实
 */
export async function mainStory() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    seedWorkspace(root);

    // ── 观察手段：每一步记一行状态，同时记一步回放 ──
    const labels = new Map(); // turnId → A、B
    const label = (turnId) => labels.get(turnId) ?? labels.set(turnId, String.fromCharCode(65 + labels.size)).get(turnId);
    const closed = [];
    const pids = {};
    const sinks = new Map(); // turnId → 直播的 collector
    const received = new Map(); // turnId → 直播收到的帧
    let item; // B 的队列项
    let session;
    let app;

    const rows = [];
    const steps = [];
    const log = []; // 回放里累积的消息
    let logged = 0;
    const say = (role, text, extra = {}) => log.push({ role, text, ...extra });
    const processState = (name) => (pids[name] === undefined ? "—" : alive(pids[name]) ? "运行中" : "已退出");
    const snapshot = () => {
      const holder = session ? app.sessions.holder(session.id) : undefined;
      const queued = item ? app.queue.get(item.id) : undefined;
      const paused = session && item ? app.queue.paused(session.id) : undefined;
      return {
        会话: holder ? `${label(holder.turnId)} 占用` : "空闲",
        "R1 进程": processState("r1"),
        "R2 进程": processState("r2"),
        "B 在队列里": queued ? `${queued.state}${paused ? "（暂停）" : ""}` : "—",
      };
    };
    const mark = (title, explain, { kind = "tool", row = true } = {}) => {
      const state = snapshot();
      if (row) rows.push({ 步骤: rows.length + 1, 发生了什么: title, ...state });
      steps.push({
        kind,
        label: `${steps.length + 1}. ${title}`,
        explain: escapeHtml(explain),
        messages: log.map((message) => ({ ...message })),
        fresh: log.map((_, i) => i).filter((i) => i >= logged),
        wire: state,
        wireSummary: "查看这一步的宿主状态",
      });
      logged = log.length;
    };

    // ── 装配应用：事件写给“客户端”（collector），终态帧故意写得慢 ──
    const templates = new Templates({ system: "Repair the project and verify the change. [template v1]" });
    app = await createApplication(join(dir, "data"), {
      templates,
      writer: async (frame) => {
        if (!sinks.has(frame.turnId)) {
          sinks.set(frame.turnId, await collector(frame.turnId));
          received.set(frame.turnId, []);
        }
        received.get(frame.turnId).push(frame);
        sinks.get(frame.turnId).apply(frame);
        if (frame.type === "turn.completed") {
          await sleep(60);
          say("system", `客户端收到终态帧 turn.completed(${frame.status})`);
          mark(`终态帧 turn.completed(${frame.status}) 送达客户端（${label(frame.turnId)}）`, "终态是 Turn 的最后一帧：它写完之前，会话仍然是 A 占用。", { kind: "end" });
        }
      },
    });
    session = app.sessions.create(root);
    let closedByStory = false;

    try {
      // 1. 发布 R1
      await app.plugins.update("r1", async () => {
        const made = await candidate("r1", closed)();
        pids.r1 = made.pid;
        return made;
      });
      mark("发布 R1（MCP 子进程起来了）", "插件系统发布第一代能力：一个真的 MCP 子进程，工具 mcp_echo。");

      // 2. A 开始：长任务
      const requestsA = [];
      const kernelA = scriptedKernel([call("slow", "test", { path: "slow.cjs" })]);
      say("user", "A：跑一个很长的任务（slow.cjs）");
      const jobA = app.run(session.id, "run the slow job", {
        model: async (request, signal) => (requestsA.push(request), kernelA(request, signal)),
        rules: { allow: ["test"] },
      });
      for (let i = 0; i < 300 && !existsSync(join(root, "started")); i++) await sleep(10);
      say("assistant", "", { calls: [{ name: "test", args: { path: "slow.cjs" } }] });
      say("toolResult", "（工具还在跑：slow.cjs 每秒一次心跳，不会自己结束）", { name: "test" });
      mark("用户发来 A；A 接纳，抓走 R1 和模板 v1，长任务在真进程里跑起来", "A 持有会话租约、R1 的能力租约，系统提示在这一刻拍照（模板 v1，CLAUDE.md v1）。工具是 slow.cjs 启动的真进程。", { kind: "response" });

      // 3. 插件更新
      await app.plugins.update(
        "r2",
        async () => {
          const made = await candidate("r2", closed, {
            skills: [{ plugin: "course", name: "repair-guide", description: "How to repair this repo", content: "Run test.cjs first, change the smallest thing, run it again.", location: "plugin://course/repair-guide" }],
          })();
          pids.r2 = made.pid;
          return made;
        },
      );
      say("system", "插件更新：R2 发布（多了 Skill course:repair-guide）");
      mark("插件更新：R2 发布；A 手里仍握着 R1 的租约", "R2 在旁边备好、整体切换；新来的 Turn 拿 R2。R1 还有一个租约（A），所以进程不能关。");

      // 4. B 排队（重发同一个 clientRequestId）
      item = app.queue.enqueue(session.id, "fix the slug bug and run the tests", { clientRequestId: "repair" });
      const retried = app.queue.enqueue(session.id, "fix the slug bug and run the tests", { clientRequestId: "repair" });
      say("user", "B：修好 slug 的 bug，跑一遍测试（会话在忙，排队）");
      mark("用户发来 B：会话在忙，写进队列（重发一次，拿回同一行）", "排队的承诺在 enqueue 返回的那一刻兑现：日志里已经有这一行。重发同一个 clientRequestId 不会变成两份工作。");

      // 5. 改模板和 CLAUDE.md
      templates.update("system", "Repair the project and verify the change. [template v2]");
      writeFileSync(join(root, "CLAUDE.md"), "Project rules v2: always run test.cjs after editing.");
      say("system", "有人改了系统提示模板（v2）和 CLAUDE.md（v2）");
      mark("改了模板和 CLAUDE.md：A 已经拍过照，不受影响", "快照在 Turn 开头拍一次。运行中的 A 继续用 v1；B 接纳时再拍，读到 v2。");

      // 6. 取消
      say("user", "（用户按了停止）");
      const cancelled = app.cancel(session.id);
      mark("用户按停止：app.cancel（只是发出意愿）", "取消只是把信号送到 A 的控制器；A 要等工具进程退出、事件送达、历史写完，才算放手。");

      // 7. 立刻 next
      const early = await app.next(session.id, { model: scriptedKernel([{ text: "too early" }]) }).then(
        () => "通过（不应该）",
        (error) => error.message,
      );
      mark(`立刻 app.next()：被拒绝（${early}）`, "B 不能越过 A 的收尾提前开始：会话的“忙”还在，next 在取走队列项之前就被挡下。");

      // 8. A 收尾
      const resultA = await jobA;
      await waitFor(() => !alive(pids.r1));
      say("system", `A 的 run 返回：${resultA.status}；队列暂停；R1 关闭`);
      mark("A 放手：run 返回 cancelled；队列暂停（user-stop）；R1 的最后一个租约还掉，进程关闭；会话空闲", "收尾的次序：工具进程退出 → 终态帧送达 → 暂停队列 → 还插件租约（R1 关闭）→ 释放会话。", { kind: "end" });

      // 9. 暂停期间 next
      const whilePaused = await app.next(session.id, { model: scriptedKernel([{ text: "should not run" }]) });
      mark(`app.next()：队列暂停，没有运行（返回 ${whilePaused === undefined ? "undefined" : "?"}）`, "用户刚按过停止，排队的指令不该自己跑起来。要等用户明确说“继续”。");

      // 10. 继续：B 运行
      const requestsB = [];
      const names = new Map(); // 工具调用 id → 工具名，回放里给 toolResult 标名字
      const reply = (id, name, input) => (names.set(id, name), call(id, name, input));
      const scriptB = scriptedKernel([
        reply("t1", "test", { path: "test.cjs" }),
        reply("r1", "read", { path: "slug.cjs" }),
        reply("s1", "skill", { name: "course:repair-guide" }),
        reply("e1", "edit", { path: "slug.cjs", old: "/ /g", next: "/ +/g" }),
        reply("t2", "test", { path: "test.cjs" }),
        reply("m1", "mcp_echo", { text: "verified" }),
        { text: "slug fixed, tests pass" },
      ]);
      const kernelB = async (request, signal) => {
        requestsB.push(request);
        const n = requestsB.length;
        if (n === 1) {
          say("system", "B 接纳：新的快照（模板 v2、CLAUDE.md v2），抓到 R2");
          mark("用户点“继续”：B 接纳；抓到 R2、模板 v2 和新的 CLAUDE.md", "continuePaused 先解除暂停再取走队列项；Turn 接纳时队列写回执，B 的快照是 A 取消之后才拍的。", { kind: "response" });
        } else {
          const last = request.messages.at(-1);
          if (last.role === "tool") say("toolResult", flat(last.text, 80), { name: names.get(last.id), error: last.error });
        }
        const next = await scriptB(request, signal);
        say("assistant", next.text ?? "", { calls: (next.calls ?? []).map((c) => ({ name: c.name, args: c.input })) });
        mark(`B 第 ${n} 步：${next.calls ? next.calls[0].name : "回答"}`, next.calls ? `模型请求 ${next.calls[0].name}。` : "没有工具调用，回答写完，Turn 收尾。", { kind: "response", row: false });
        return next;
      };
      say("user", "（用户点了继续）");
      const resultB = await app.next(session.id, {
        model: kernelB,
        rules: { allow: ["edit", "test", "mcp_echo"] },
        skillPaths: ["SKILL.md"],
        continuePaused: true,
      });
      say("toolResult", "（最后一步：模型给出总结，Turn 收尾）", { name: "turn" });
      mark("B 完成：completed；测试通过；队列项 consumed", "B 的 Turn 在事件送达、历史落盘之后才返回；队列此时才把这一项记为 consumed。", { kind: "end" });

      // 11. SDK 客户端
      const idA = resultA.turnId;
      const idB = resultB.turnId;
      const liveA = sinks.get(idA).result();
      const liveB = sinks.get(idB).result();
      const summarize = (result) =>
        result.items
          .map((it) => {
            if (it.type === "tool_call") return `${it.toolCall?.name}${it.toolCall?.status === "failed" ? "(失败)" : ""}${it.incomplete ? "✗" : ""}`;
            return `${it.type === "agent_message" ? "消息" : it.type}${it.incomplete ? "✗" : ""}`;
          })
          .join(" · ");
      const replayInto = async (turnId, frames) => {
        const client = await collector(turnId);
        for (const frame of frames) client.apply(frame);
        return client;
      };
      const cut = 9;
      const reconnectB = await replayInto(idB, [...received.get(idB).slice(0, cut), ...app.events.replay(idB, cut)]);
      const freshB = await replayInto(idB, app.events.replay(idB));
      const replayA = await replayInto(idA, app.events.replay(idA));
      let gap;
      try {
        await replayInto(idB, app.events.replay(idB, cut));
      } catch (error) {
        gap = error.message;
      }
      const same = (a, b) => JSON.stringify(a.result()) === JSON.stringify(b);
      const sdk = [
        { 客户端: "A · 一直在线", 收到帧数: received.get(idA).length, 还原的状态: liveA.status, "items（✗ = 未完成）": summarize(liveA), 与直播一致: "—" },
        { 客户端: "B · 一直在线", 收到帧数: received.get(idB).length, 还原的状态: liveB.status, "items（✗ = 未完成）": summarize(liveB), 与直播一致: "—" },
        { 客户端: `B · 第 ${cut} 帧后断线，用游标接上`, 收到帧数: reconnectB.result().lastSeq, 还原的状态: reconnectB.result().status, "items（✗ = 未完成）": summarize(reconnectB.result()), 与直播一致: same(reconnectB, liveB) ? "是" : "否" },
        { 客户端: "B · 新客户端，整段重放", 收到帧数: freshB.result().lastSeq, 还原的状态: freshB.result().status, "items（✗ = 未完成）": summarize(freshB.result()), 与直播一致: same(freshB, liveB) ? "是" : "否" },
        { 客户端: "A · 新客户端，整段重放", 收到帧数: replayA.result().lastSeq, 还原的状态: replayA.result().status, "items（✗ = 未完成）": summarize(replayA.result()), 与直播一致: same(replayA, liveA) ? "是" : "否" },
        { 客户端: `B · 新客户端，只拿第 ${cut} 帧之后的`, 收到帧数: "—", 还原的状态: "抛错", "items（✗ = 未完成）": flat(gap ?? "（不应该成功）", 40), 与直播一致: "暴露缺口" },
      ];
      say("system", "SDK 客户端：A 还原成 cancelled（item 带 incomplete），B 还原成 completed；断线重放一致");
      mark("SDK 客户端只看事件流：A 还原成 cancelled，B 还原成 completed；断线后重放一致", "客户端没有宿主的任何状态，只有帧。终态说了算：A 的未完成 item 不会被当成成功。", { kind: "end" });

      // 12. 关闭
      await app.close();
      closedByStory = true;
      await waitFor(() => !alive(pids.r2));
      say("system", "应用关闭：当前代 R2 关闭");
      mark("应用关闭：等所有 Turn 收尾，关闭当前代 R2", "close() 先拒绝新的 Turn，等 completion，最后关闭插件：R2 在这时才关。", { kind: "end" });

      // B 的修复过程：从历史里读
      const fromB = resultB.messages.slice(resultB.messages.findLastIndex((m) => m.role === "user" && m.text.startsWith("fix the slug")));
      const toolMessages = new Map(fromB.filter((m) => m.role === "tool").map((m) => [m.id, m]));
      const keep = (text, n) => {
        const one = String(text).replace(/\n/g, " ").trim();
        return one.length > n ? one.slice(0, n) + "…" : one;
      };
      const repair = fromB
        .filter((m) => m.role === "assistant" && m.calls?.length)
        .map((m, i) => {
          const c = m.calls[0];
          const r = toolMessages.get(c.id);
          return { 步: i + 1, 工具: c.name, 参数: keep(JSON.stringify(c.input), 40), 结果: `${r.error ? "失败" : "成功"}：${keep(r.text, 52)}` };
        });

      return {
        rows,
        steps,
        repair,
        sdk,
        facts: {
          session,
          root,
          cancelled,
          early,
          retriedSame: retried.id === item.id,
          resultA,
          resultB,
          whilePaused,
          closed,
          liveA,
          liveB,
          framesA: app.events.replay(idA),
          framesB: app.events.replay(idB),
          reconnectB: reconnectB.result(),
          freshB: freshB.result(),
          replayA: replayA.result(),
          gap,
          requestsA,
          requestsB,
          queue: app.queue.items(),
          queueFacts: app.queue.facts().filter((f) => f.type === "pause" || f.type === "continue").map((f) => f.type),
          pids,
          slug: readFileSync(join(root, "slug.cjs"), "utf8"),
          rowsAfter: rows.length,
          alive: { r1: alive(pids.r1), r2: alive(pids.r2) },
        },
      };
    } finally {
      if (!closedByStory) await app.close();
    }
  });
}

// ═══ 二、总装时接上的几处，各一个小场景 ═══════════════════════════════════════════════════

/** 插话：收件箱接上之后的四种去处。 */
export async function steeringCases() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "nap.cjs"), "setTimeout(()=>console.log('woke'),250)");
    writeFileSync(join(root, "slow.cjs"), "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)");
    const app = await createApplication(join(dir, "data"));
    const rows = [];
    const facts = {};
    try {
      const session = app.sessions.create(root);

      // (a) 工具运行中插话：接受，下一次请求带上它
      {
        const requests = [];
        const kernel = scriptedKernel([call("nap", "test", { path: "nap.cjs" }), { text: "done" }]);
        const job = app.run(session.id, "take a nap", {
          model: async (request, signal) => (requests.push(request), kernel(request, signal)),
          rules: { allow: ["test"] },
        });
        await sleep(80);
        const answer = app.steer(session.id, "also mention the README");
        const result = await job;
        const seen = requests[1].messages.find((m) => m.steered);
        rows.push({ 情形: "工具运行中插话", "app.steer 返回": answer.status, 结果: `第 2 次请求里多了一条用户消息：${JSON.stringify(seen?.text)}`, 去处: "进入这个 Turn（模型下一步读到）" });
        facts.running = { answer, seen, status: result.status, historyHasIt: app.sessions.history(session.id).some((m) => m.steered && m.text === "also mention the README") };
      }

      // (b) 回答写完的那一刻插话：不延长这条回答，关门后变成下一个 Turn
      {
        let steered;
        const result = await app.run(session.id, "say hello", {
          model: async () => {
            steered = app.steer(session.id, "one more thing: add a changelog");
            return { text: "hello" };
          },
        });
        const waiting = app.queue.list(session.id);
        rows.push({ 情形: "回答写完的那一刻插话", "app.steer 返回": steered.status, 结果: `这个 Turn ${result.status}，回答没有被延长；收件箱关门时交出 ${result.steering?.[0]?.count ?? 0} 条`, 去处: `队首的排队项：${JSON.stringify(waiting[0]?.text)}` });
        facts.exit = { steered, result, waiting };
        // 把它跑掉，免得影响后面的场景
        await app.next(session.id, { model: scriptedKernel([{ text: "ok" }]) });
      }

      // (c) 取消时还在等待的插话 + (d) 取消之后才来的插话
      {
        rmSyncQuiet(join(root, "started"));
        const job = app.run(session.id, "run the slow job", {
          model: scriptedKernel([call("slow", "test", { path: "slow.cjs" })]),
          rules: { allow: ["test"] },
        });
        await waitFor(() => existsSync(join(root, "started")));
        const waiting = app.steer(session.id, "also check lint");
        app.cancel(session.id);
        const afterStop = app.steer(session.id, "and then deploy");
        const result = await job;
        const history = app.sessions.history(session.id);
        const item = app.queue.list(session.id).find((i) => i.text === "and then deploy");
        rows.push({ 情形: "取消时，插话还在收件箱里", "app.steer 返回": waiting.status, 结果: `Turn ${result.status}；收件箱的出口是 ${result.steering?.[0]?.route}`, 去处: `写进会话历史（steered=${history.at(-1)?.steered}）：${JSON.stringify(history.at(-1)?.text)}` });
        rows.push({ 情形: "按了停止之后才来的插话", "app.steer 返回": afterStop.status, 结果: `收件箱已经关门；队列${app.queue.paused(session.id) ? "已暂停" : "没有暂停"}`, 去处: `排队项，不会自己跑：${JSON.stringify(item?.text)}` });
        facts.abort = { waiting, afterStop, result, history, item, paused: app.queue.paused(session.id) };
      }
      return { rows, facts };
    } finally {
      await app.close();
    }
  });
}

function rmSyncQuiet(path) {
  rmSync(path, { force: true });
}

/** 压缩：请求模型之前的钩子接进 Turn，提交落到会话历史。 */
export async function compactionCase() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    const app = await createApplication(join(dir, "data"));
    try {
      const session = app.sessions.create(root);
      // 六个来回，每个来回的工具结果有 3000 个字符
      const seed = [];
      for (let i = 1; i <= 6; i++) {
        seed.push({ role: "user", text: `第 ${i} 个任务` });
        seed.push({ role: "assistant", text: "", calls: [{ id: `c${i}`, name: "read", input: { path: `f${i}.txt` } }] });
        seed.push({ role: "tool", id: `c${i}`, text: "x".repeat(3000) });
        seed.push({ role: "assistant", text: `第 ${i} 个任务完成` });
      }
      app.sessions.append(session.id, "seed", seed);
      const sections = ["Goal", "Constraints & Preferences", "Completed Work", "Current State", "Blockers", "Key Decisions", "Pending User Asks", "Critical Context & Relevant Files"];
      const summary = sections.map((h) => `## ${h}\n(none)`).join("\n");
      const summarizeCalls = [];
      const compaction = {
        model: { id: "demo-model", contextWindow: 20_000, maxOutputTokens: 1_000 },
        summarize: async (messages) => {
          summarizeCalls.push(messages.length);
          return { text: summary, stopReason: "stop", kinds: ["text"], outputTokens: 120 };
        },
      };
      const requests = [];
      const kernel = scriptedKernel([{ text: "ok" }, { text: "ok again" }]);
      const model = async (request, signal) => (requests.push(request), kernel(request, signal));

      const first = await app.run(session.id, "继续下一个任务", { model, compaction, modelInfo: compaction.model });
      const rowsOnDisk = app.sessions.historyLog(session.id).read();
      const history = app.sessions.history(session.id);
      const second = await app.run(session.id, "再来一个", { model, compaction, modelInfo: compaction.model });

      const done = first.compactions[0];
      const { triggerAt } = compactionBudget({ contextWindow: 20_000, maxOutputTokens: 1_000 });
      const rows = [
        { 步骤: "压缩之前", 结果: `存下来的历史 ${seed.length} 条，发出去的估算约 ${done.before} token（触发线 ${triggerAt}）` },
        { 步骤: "第一个 Turn 请求之前", 结果: `钩子：${done.status}（摘要输入用的是 ${done.rung}）；摘要请求看到 ${summarizeCalls[0]} 条消息` },
        { 步骤: "模型实际收到的请求", 结果: `${requests[0].messages.length} 条：第 1 条是摘要（${JSON.stringify(flat(requests[0].messages[0].text, 40))}），第 2 条是这个 Turn 的用户消息` },
        { 步骤: "会话历史现在是", 结果: `${history.length} 条（摘要 + 用户消息 + 回答）；日志里共 ${rowsOnDisk.length} 行，被换掉的旧行还在，当存档` },
        { 步骤: "第二个 Turn", 结果: `压缩钩子：${second.compactions[0].status}；请求的第 1 条仍是摘要，没有重新请求摘要（摘要请求总共 ${summarizeCalls.length} 次）` },
      ];
      return { rows, first, second, history, rowsOnDisk, requests, summarizeCalls, seedLength: seed.length };
    } finally {
      await app.close();
    }
  });
}

/** 租约丢失：续租失败时 Turn 主动中止，而不是等到下一次写历史才被挡下。 */
export async function leaseLostCase() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "slow.cjs"), "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)");
    let clock = 1_000_000;
    const options = { now: () => clock, leaseMs: 1000 };
    const data = join(dir, "data");
    const app = await createApplication(data, { sessionOptions: { ...options, renewalMs: 20 } });
    try {
      const session = app.sessions.create(root);
      const requests = [];
      const job = app.run(session.id, "run the slow job", {
        model: async (request, signal) => (requests.push(request), scriptedKernel([call("slow", "test", { path: "slow.cjs" })])(request, signal)),
        rules: { allow: ["test"] },
      });
      await waitFor(() => existsSync(join(root, "started")));
      const holderBefore = app.sessions.holder(session.id);
      // 另一个进程（同一个数据目录）看到租约过期，回收它，自己接手
      clock += 5_000;
      const other = new Sessions(data, { ...options, instanceId: "other-process" });
      const release = other.admit(session.id, "usurper");
      const started = Date.now();
      const result = await job;
      const abortedAfterMs = Date.now() - started;
      release();
      const recoveries = other.recoveries();
      const pause = app.queue.paused(session.id);
      const history = other.history(session.id);
      const rows = [
        { 事件: "A 在跑，租约还有效", 状态: `持有者 ${holderBefore.turnId.slice(0, 8)}…` },
        { 事件: "时钟走过租约期限，另一个进程接纳新 Turn", 状态: `回收原因：${recoveries[0]?.reason}` },
        { 事件: "A 的看门狗发现自己不再持有", 状态: `主动中止，不等下一次写历史：status=${result.status}，error=${result.error}` },
        { 事件: "A 收尾时想补写历史", 状态: `被挡下（persisted=${result.persisted}）；历史里只有租约丢失之前写下的 ${history.length} 条` },
        { 事件: "队列因此暂停吗", 状态: pause ? "是（不应该）" : "否：租约丢失不是用户的意愿" },
      ];
      return { rows, result, recoveries, history, pause, abortedAfterMs };
    } finally {
      await app.close();
    }
  });
}

/** 释放的顺序：release() 抛错，close() 也不能卡住。 */
export async function releaseOrderCase() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    const closed = [];
    const app = await createApplication(join(dir, "data"));
    try {
      await app.plugins.update("r1", candidate("r1", closed));
      const session = app.sessions.create(root);
      const admit = app.sessions.admit.bind(app.sessions);
      app.sessions.admit = (sessionId, turnId) => {
        const release = admit(sessionId, turnId);
        return () => {
          release();
          throw Error("release failed");
        };
      };
      const outcome = await app.run(session.id, "hi", { model: scriptedKernel([{ text: "hello" }]) }).then(
        () => "返回了结果",
        (error) => `run 抛出：${error.message}`,
      );
      const closing = await Promise.race([app.close().then(() => "close() 正常返回"), sleep(2000).then(() => "close() 被卡住")]);
      return {
        rows: [
          { 事件: "Turn 结束，释放会话时 release() 抛错", 结果: outcome },
          { 事件: "插件租约", 结果: closed.includes("r1") ? "已经先还掉，R1 随 close 关闭" : "没关" },
          { 事件: "应用关闭", 结果: closing },
        ],
        outcome,
        closing,
        closed,
      };
    } catch (error) {
      await app.close();
      throw error;
    }
  });
}

/** 请求投影只有一个入口，批次规则来自 tools.mjs。 */
export async function requestShapeCase() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "alpha");
    writeFileSync(join(root, "b.txt"), "beta");
    const app = await createApplication(join(dir, "data"));
    try {
      const session = app.sessions.create(root);
      app.sessions.append(session.id, "seed", [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "", calls: [{ id: "c0", name: "read", input: { path: "a.txt" } }] },
        { role: "tool", id: "c0", text: "alpha", details: { secret: "only for the UI" } },
        { role: "tool", id: "ghost", text: "a result nobody asked for" },
        { role: "assistant", text: "", calls: [{ id: "c1", name: "read", input: { path: "b.txt" } }] }, // 断头：没有结果
      ]);
      let seen;
      await app.run(session.id, "continue", {
        model: async (request) => ((seen = request), { text: "ok" }),
      });
      const sent = seen.messages;
      const shape = [
        { 看什么: "存下来的历史", 结果: `${5} 条（含一个孤儿结果 ghost、一个没有结果的调用 c1）` },
        { 看什么: "孤儿结果 ghost", 结果: sent.some((m) => m.id === "ghost") ? "还在请求里" : "不在请求里（宿主丢掉）" },
        { 看什么: "没有结果的调用 c1", 结果: JSON.stringify(sent.find((m) => m.role === "tool" && m.id === "c1")) },
        { 看什么: "c0 的 details", 结果: "details" in sent.find((m) => m.id === "c0") ? "发给了模型" : "留在本机，模型只看到文本和 error" },
        { 看什么: "会话里存下来的 c0", 结果: app.sessions.history(session.id).find((m) => m.id === "c0").details ? "details 还在" : "丢了" },
      ];

      // 批次：同一条回复里两个调用
      const order = async (calls) => {
        const result = await app.run(session.id, "batch", {
          model: scriptedKernel([{ calls }, { text: "done" }]),
          rules: { allow: ["edit"] },
        });
        return app.events
          .replay(result.turnId)
          .filter((f) => f.item?.type === "tool_call")
          .map((f) => `${f.type === "item.started" ? "开始" : "结束"}:${f.item.id}`);
      };
      const reads = await order([
        { id: "p1", name: "read", input: { path: "a.txt" } },
        { id: "p2", name: "read", input: { path: "b.txt" } },
      ]);
      const mixed = await order([
        { id: "q1", name: "read", input: { path: "a.txt" } },
        { id: "q2", name: "edit", input: { path: "a.txt", old: "alpha", next: "ALPHA" } },
      ]);
      const batches = [
        { 一条回复里的调用: "read + read", 事件顺序: reads.join(" → "), 规则: "全是并行工具：整批并行" },
        { 一条回复里的调用: "read + edit", 事件顺序: mixed.join(" → "), 规则: "有一个串行工具：整批按顺序一个个跑" },
      ];
      return { shape, batches, sent, reads, mixed, stored: app.sessions.history(session.id) };
    } finally {
      await app.close();
    }
  });
}

/** 命令行：三个真实子进程，各喂一行输入，看退出码。 */
export async function cliExitCodes() {
  return withTemp(async (dir) => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    const run = (input, name) =>
      runProcess(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "host/src/cli.mjs"), root, join(dir, name)], { cwd: root, input, maxBytes: 100000 });
    const user = (extra) => JSON.stringify({ type: "user", text: "hi", ...extra }) + "\n";
    const ok = await run(user({ replies: [{ text: "done" }] }), "ok");
    const failed = await run(user({ replies: [] }), "failed");
    const garbage = await run("not json\n", "garbage");
    const last = (result) => JSON.parse(result.stdout.trim().split("\n").at(-1));
    const rows = [
      { 输入: "一次成功的运行", 最后一帧: `turn.completed(${last(ok).status})`, 退出码: ok.code, 约定: "success" },
      { 输入: "模型脚本用完：运行失败", 最后一帧: `turn.completed(${last(failed).status})`, 退出码: failed.code, 约定: "runtime" },
      { 输入: "一行不是 JSON", 最后一帧: last(garbage).type, 退出码: garbage.code, 约定: "invocation" },
    ];
    return { rows, codes: [ok.code, failed.code, garbage.code] };
  });
}
