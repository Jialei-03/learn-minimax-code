// 第 4 章的回归实验：host/src/tools.mjs 的每一条机制各检查一遍。
//   node labs/chapters/04-tools.mjs
// 想看单个机制的完整输出，运行 labs/ch04/ 下的脚本（context / channels / failures / prepare / schedule / readcap / program）。
import { lesson } from "./harness.mjs";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import {
  batchMode,
  callTool,
  localTools,
  modelView,
  ptcCatalogue,
  resolveWallClock,
  toolCatalogue,
  wrapTool,
} from "../../host/src/tools.mjs";
import { channels, failures, prepare, programs, readCaps, residency, schedules, statuses } from "../ch04/scenarios.mjs";

await lesson(4, "工具：一份定义，三个读者", async (t) => {
  // ── 一、返回值分流 ────────────────────────────────────────────────────────
  t.log("一、返回值有三个读者：模型、界面、run_code 里的程序");
  let observed, contextSeen;
  const definition = {
    name: "x",
    source: "configured",
    readOnly: true,
    execute: async (_, context) => {
      contextSeen = context;
      return { text: "visible", programmatic: { secretChannel: "internal" }, isError: false, details: { ok: true } };
    },
  };
  const result = await wrapTool(definition, { root: t.root, sessionId: "s", turnId: "t", assistantMessageId: "a" }, { observe: (raw) => (observed = raw) })({
    id: "call",
    name: "x",
    input: {},
  });
  t.equal("programmatic 只留在 observer 里", observed.programmatic.secretChannel, "internal");
  t.equal("交回的 tool 消息没有 programmatic", Object.hasOwn(result, "programmatic"), false);
  t.equal("模型视图只有文本和错误标记", Object.keys(modelView(result)), ["role", "id", "text", "error"]);
  t.equal("每次调用的上下文带着这次调用的 toolCallId", contextSeen.toolCallId, "call");
  t.equal("每次调用的上下文带着所属的 assistant 消息", contextSeen.assistantMessageId, "a");
  const failed = await wrapTool({ ...definition, execute: async () => ({ text: "bad", details: { ok: false } }) }, { root: t.root })({ id: "e", name: "x", input: {} });
  t.equal("details.ok === false 被归一成错误", failed.error, true);
  t.equal("工具自己报错没有 failure 分类", failed.failure, undefined);
  t.throws("重名的工具在执行前就报错", () => toolCatalogue([definition, definition]), /duplicate/);
  const { rows: channelRows } = await channels();
  t.table(channelRows);

  // ── 二、八种失败各停在哪一关 ──────────────────────────────────────────────
  t.log("二、一次调用要过的关");
  const { rows: failureRows } = await failures();
  const kind = Object.fromEntries(failureRows.map((r) => [r.场景, r]));
  t.table(failureRows.map(({ message, ...row }) => row));
  t.equal("工具不存在", kind["工具不存在"]["failure.kind"], "tool_not_found");
  t.equal("修参数抛出", kind["修参数时抛出"]["failure.kind"], "argument_preparation");
  t.equal("缺少必填参数", kind["缺少必填参数"]["failure.kind"], "argument_validation");
  t.equal("参数问题发生在任何 Hook 之前", [kind["缺少必填参数"].前置Hook, kind["缺少必填参数"].execute], ["没跑", "没跑"]);
  t.equal("limit: \"20\" 被修正后继续执行", kind["limit 写成字符串 \"20\""]["模型收到的文字（首行）"], "peek a.txt limit=20");
  t.equal("取消信号已触发", kind["取消信号已触发"]["failure.kind"], "cancelled");
  t.equal("前置 Hook 抛出", kind["前置 Hook 抛出"]["failure.kind"], "before_hook");
  t.equal("前置 Hook 拦下", [kind["前置 Hook 拦下"]["failure.kind"], kind["前置 Hook 拦下"].拦下者], ["blocked", "hook"]);
  t.equal("Hook 改写成合法参数后用的是改写的值", kind["Hook 把参数改写成合法值"]["模型收到的文字（首行）"], "peek b.txt");
  t.equal("Hook 改写成非法参数被再次校验拦下", kind["Hook 把参数改写成非法值"]["failure.kind"], "before_hook");
  t.equal("权限拒绝：execute 没跑", [kind["权限拒绝（edit 没有放行）"].拦下者, kind["权限拒绝（edit 没有放行）"].execute], ["permission", "没跑"]);
  t.equal("工具抛出时后置 Hook 照样运行", [kind["工具抛出"]["failure.kind"], kind["工具抛出"].后置Hook], ["execution", "跑了"]);
  t.equal("后置 Hook 抛出", kind["后置 Hook 抛出"]["failure.kind"], "after_hook");
  const prepared = await prepare();
  t.equal("真实的 prepareEditArguments 把字符串 edits 还原成数组", prepared[1].输出, prepared[0].输出);

  // 磁盘上的效果：没放行的 edit 不会改文件。
  writeFileSync(join(t.root, "a.txt"), "old");
  const edit = localTools(t.root).find((d) => d.name === "edit");
  const denied = await wrapTool(edit, { root: t.root })({ id: "w", name: "edit", input: { path: "a.txt", old: "old", next: "new" } });
  t.equal("没放行的 edit 被拦下", [denied.error, denied.failure.blockedBy], [true, "permission"]);
  t.equal("被拦下的调用没有改文件", readFileSync(join(t.root, "a.txt"), "utf8"), "old");
  const allowed = await wrapTool(edit, { root: t.root }, { rules: { allow: ["edit"] } })({ id: "w2", name: "edit", input: { path: "a.txt", old: "old", next: "new" } });
  t.equal("放行之后 edit 执行了", [allowed.error, readFileSync(join(t.root, "a.txt"), "utf8")], [false, "new"]);

  // ── 三、一批调用怎么排 ────────────────────────────────────────────────────
  t.log("三、一批调用怎么排");
  const { rows: scheduleRows } = await schedules();
  const plan = Object.fromEntries(scheduleRows.map((r) => [r.做法, r]));
  t.table(scheduleRows.map(({ log, ...row }) => row));
  const catalogue = toolCatalogue(localTools(t.root));
  const reads = [{ name: "read" }, { name: "read" }];
  t.equal("只有读：整批并行", batchMode(reads, catalogue), "parallel");
  t.equal("里面有一个 edit：整批串行", batchMode([...reads, { name: "edit" }], catalogue), "sequential");
  t.equal("没有声明 executionMode 的工具按串行算", batchMode([{ name: "u" }], toolCatalogue([{ name: "u", execute() {} }])), "sequential");
  t.equal("查不到的工具不参与判断", batchMode([...reads, { name: "ghost" }], catalogue), "parallel");
  t.equal("host 的调度队列与 MiniMax 的 PtcSubcallScheduler 顺序一致", plan["run_code：host 的 SubcallScheduler"].log, plan["run_code：MiniMax 的 PtcSubcallScheduler"].log);
  t.equal("屏障队列：edit 之后的读读到新内容", plan["run_code：MiniMax 的 PtcSubcallScheduler"]["末尾 read 读到"], "new");
  t.equal("edit 误标成 parallel 的反例：读到旧内容", plan["反例：edit 误标成 parallel，全部同时开始"]["末尾 read 读到"], "old");

  // ── 四、同一个 read 的两种上限 ────────────────────────────────────────────
  t.log("四、模型读 24 KiB，程序读全文");
  const caps = await readCaps();
  t.table(caps.rows);
  t.equal("子调用的判断只看 parentToolCallId", [caps.flags.direct, caps.flags.child], [false, true]);
  t.equal("模型直接读：逐页读完整个文件", caps.upstream.sum, caps.totalLines);
  t.equal("host 的 read 与 MiniMax 的上限给出同样的页数", caps.host.direct.length, caps.upstream.pages);
  t.equal("程序一次拿到全文", caps.host.childLines, caps.totalLines);

  // ── 五、run_code ──────────────────────────────────────────────────────────
  t.log("五、run_code：让模型写程序");
  const { rows: statusRows, table } = await statuses();
  t.table(statusRows);
  const status = Object.fromEntries(table.map((r) => [r.name, r]));
  t.equal("内置工具报告了没截断：complete", status["read 整个文件"].status, "complete");
  t.equal("按 limit 读到一半：complete，并给出续读位置", [status["read 前 50 行"].status, status["read 前 50 行"].more], ["complete", 51]);
  t.equal("收据类输出自己报告没截断：complete", status["edit（收据，自己报告没截断）"].status, "complete");
  t.equal("内置工具没有报告：unverified", status["silent（内置，但没有报告）"].status, "unverified");
  t.equal("第三方工具自称完整也只是 unverified", status["第三方工具 mcp_echo"].status, "unverified");
  t.equal("后置 Hook 改写之后，工具自带的 data 被扣下", [status["lookup（后置 Hook 改写了文本）"].status, status["lookup（后置 Hook 改写了文本）"].data], ["unverified", "{}"]);

  const { rows: programRows, clocks } = await programs();
  t.table(programRows.map(({ message, ...row }) => row));
  const program = Object.fromEntries(programRows.map((r) => [r.场景, r]));
  t.equal("程序里的 edit 被拒绝只影响这一次调用", [program["程序里的 edit 也要过权限"].模型收到的文字.includes("PTC_PERMISSION_DENIED"), program["程序里的 edit 也要过权限"].实际执行的子调用], [true, "read:f0.txt"]);
  t.equal("前置 Hook 同样拦下子调用", program["同一个 Hook 也拦程序里的子调用"].实际执行的子调用, "—");
  t.equal("超出调用预算的调用不执行", program["调用预算（这里设成 4 次）"].实际执行的子调用.split(", ").length, 4);
  t.ok("返回值太大被截短并注明", program["返回值太大（上限设成 2000 字节）"].模型收到的文字.includes("run_code result truncated"));
  t.ok("提前返回时模型被告知有子调用没结束", program["没等子调用就返回"].模型收到的文字.includes("PTC_INCOMPLETE"));
  t.ok("超过 wall clock", program["超过 wall clock（timeout_ms: 80）"].模型收到的文字.includes("wall_clock_exceeded"));
  t.equal("访客拿不到宿主的全局", program["访客拿不到宿主"].模型收到的文字, "`\"undefined,undefined,undefined,undefined\"`");
  for (const { requested, real } of clocks) t.equal(`timeout_ms=${JSON.stringify(requested)} 与 MiniMax 的 resolvePtcWallClock 一致`, resolveWallClock(requested), real);

  const [runCode] = ptcCatalogue(localTools(t.root));
  t.ok("run_code 的描述里列出被藏起来的工具和签名", runCode.description.includes('"read": (args: { path: string; offset?: number; limit?: number })'));
  t.equal("PTC 目录里模型只看得到 run_code", ptcCatalogue(localTools(t.root)).map((d) => d.name), ["run_code"]);

  // ── 六、上下文里的账 ──────────────────────────────────────────────────────
  t.log("六、同一个任务的上下文账本");
  const book = await residency();
  t.table(book.rows);
  t.equal("直接调用：30 次调用 + 30 份结果", book.direct.itemCount, 60);
  t.equal("run_code：1 次调用 + 1 份结果", book.program.itemCount, 2);
  t.ok("工具结果的体量差两个数量级以上", book.direct.resultBytes > 100 * book.program.resultBytes);
  t.equal("30 次子调用都有记录", book.childCalls.length, 30);

  t.observations.modelResult = result;
  t.observations.residency = book.rows;
});
