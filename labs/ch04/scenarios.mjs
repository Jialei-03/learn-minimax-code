// 第 4 章的实验场景。每个函数只返回数据，由同目录的脚本打印成表格，
// 也被 labs/chapters/04-tools.mjs 用来做回归检查。全部离线、确定，不需要 API Key。
//
// 其中几处直接运行 MiniMax Code 0.7.2 的真实代码（lab/source.mjs 的 importSource）：
//   tool-context-size.ts   measureToolContext：上下文里有多少是工具的参数和结果
//   output-limit.ts        limitDesktopPrefixLines、isPtcChildCall：给模型的读上限，和子调用豁免
//   subcall-scheduler.ts   PtcSubcallScheduler：run_code 子调用的屏障队列
//   edit-prepare-arguments.ts  prepareEditArguments：模型的固定坏习惯
//   ptc.ts                 resolvePtcWallClock：timeout_ms 怎样变成 wall clock
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { importSource } from "../../lab/source.mjs";
import {
  SubcallScheduler,
  batchMode,
  callTool,
  localTools,
  modelView,
  ptcCatalogue,
  toolCatalogue,
  wrapTool,
} from "../../host/src/tools.mjs";

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

export async function withWorkspace(work) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch04-")));
  const root = join(temp, "workspace");
  mkdirSync(root);
  try {
    return await work(root);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const context = (root, extra = {}) => ({ root, sessionId: "s", turnId: "t", assistantMessageId: "a", ...extra });
const kib = (bytes) => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MiB` : `${(bytes / 1024).toFixed(1)} KiB`);
/** 长文本在表格里只留头尾，中间用 … 代替。 */
const abbreviate = (text, head = 120, tail = 160) => (text.length <= head + tail + 20 ? text : `${text.slice(0, head)} …（共 ${text.length} 字符）… ${text.slice(-tail)}`);

// ─── 场景一：同一个任务，直接读 30 个文件 vs 一个 run_code ─────────────────────────
//
// 任务：统计 30 个模块里的 TODO。模型要么发 30 个 read 调用，要么写一段程序。
// 两种做法各自留在上下文里的工具参数和工具结果，用 MiniMax 真实的 measureToolContext 来量。

const assistantCall = (call) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.input }],
});
const toolResult = (call, text) => ({
  role: "toolResult",
  toolCallId: call.id,
  content: [{ type: "text", text }],
});

/** 粗估：每 4 个字节算 1 个 token。实验只用来对比两种做法的量级。 */
const estimator = { estimateTextTokens: (text) => Math.ceil(Buffer.byteLength(text) / 4), estimateVisualTokens: () => 0 };

export async function residency() {
  const { measureToolContext } = await importSource("packages/agent-core/src/pi-turn-runner/tool-context-size.ts");
  return withWorkspace(async (root) => {
    const files = Array.from({ length: 30 }, (_, i) => `mod${String(i).padStart(2, "0")}.js`);
    files.forEach((file, i) => {
      const lines = Array.from({ length: 90 }, (_, n) => `export const value_${i}_${n} = compute(${n}); // module ${i}, line ${n}`);
      if (i % 4 === 0) lines[10] += " // TODO: remove";
      if (i % 8 === 0) lines[50] += " // TODO: cache";
      writeFileSync(join(root, file), lines.join("\n"));
    });
    const tools = localTools(root);
    const catalogue = toolCatalogue(tools);
    const ctx = context(root);

    // 做法一：模型直接发 30 个 read，30 份文件全文进入上下文。
    const directMessages = [];
    for (const [i, file] of files.entries()) {
      const call = { id: `call_${i}`, name: "read", input: { path: file } };
      const result = await callTool(catalogue, call, ctx);
      directMessages.push(assistantCall(call), toolResult(call, result.text));
    }

    // 做法二：PTC。read 被藏进 run_code，模型写一段程序，只有程序的返回值回到上下文。
    const [runCode] = ptcCatalogue(tools);
    const code = [
      `const files = ${JSON.stringify(files)};`,
      "const rs = await Promise.all(files.map((path) => tools.read({ path })));",
      "const counts = rs.map((r, i) => ({ file: files[i], todo: (r.output.match(/TODO/g) ?? []).length }));",
      "return { total: counts.reduce((n, c) => n + c.todo, 0), files: counts.filter((c) => c.todo > 0) };",
    ].join("\n");
    const call = { id: "call_run", name: "run_code", input: { code, description: "Count TODO comments in 30 modules" } };
    const result = await wrapTool(runCode, ctx)(call);
    const programMessages = [assistantCall(call), toolResult(call, result.text)];

    const direct = measureToolContext(directMessages, estimator);
    const program = measureToolContext(programMessages, estimator);
    const row = (name, calls, children, m) => ({
      做法: name,
      "模型发出的调用": calls,
      "程序发出的子调用": children,
      "参数": kib(m.argumentBytes),
      "结果": kib(m.resultBytes),
      "常驻上下文合计": kib(m.argumentBytes + m.resultBytes),
      "估算 token": m.argumentTokens + m.resultTokens,
    });
    return {
      rows: [
        row("直接调用 read", 30, 0, direct),
        row("run_code 里调用 read", 1, result.details.ptc.child_calls.length, program),
      ],
      direct,
      program,
      programText: result.text,
      childCalls: result.details.ptc.child_calls,
      code,
    };
  });
}

// ─── 场景二：一个返回值，三个读者 ───────────────────────────────────────────────

/** 一个工具的返回值里每个字段最后去了哪里。 */
export async function channels() {
  return withWorkspace(async (root) => {
    const secret = { token: "sk-live-0000" };
    const probe = {
      name: "probe",
      source: "builtin",
      readOnly: true,
      execute: () => ({
        text: "3 matches in 2 files",
        details: { matches: ["a.js:1", "a.js:9", "b.js:4"], is_error_hint: false },
        programmatic: { data: { matches: ["a.js:1", "a.js:9", "b.js:4"], secret }, completeness: { truncated: false } },
        isError: false,
      }),
    };
    let observed;
    const message = await wrapTool(probe, context(root), { observe: (raw) => (observed = raw) })({ id: "c1", name: "probe", input: {} });
    const view = modelView(message);
    const has = (object, path) => (path.split(".").reduce((o, k) => o?.[k], object) !== undefined ? "有" : "—");
    const rows = [
      { 字段: "text", "给模型（进历史）": has(view, "text"), "给界面和日志（details）": "—", "给 observer（run_code 的执行器）": has(observed, "text") },
      { 字段: "details", "给模型（进历史）": has(view, "details"), "给界面和日志（details）": has(message, "details.matches"), "给 observer（run_code 的执行器）": has(observed, "details.matches") },
      { 字段: "isError", "给模型（进历史）": has(view, "error"), "给界面和日志（details）": has(message, "details.is_error"), "给 observer（run_code 的执行器）": has(observed, "isError") },
      { 字段: "programmatic", "给模型（进历史）": has(view, "programmatic"), "给界面和日志（details）": has(message, "programmatic"), "给 observer（run_code 的执行器）": has(observed, "programmatic.data") },
    ];
    return { rows, message, view, observed };
  });
}

/** 程序里一次子调用的 status：谁有资格说“complete”。 */
export async function statuses() {
  return withWorkspace(async (root) => {
    writeFileSync(join(root, "a.txt"), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
    writeFileSync(join(root, "e.txt"), "old text");
    const echo = (name, source, text = "hello") => ({ name, source, readOnly: true, execute: () => ({ text, programmatic: { data: { claimed: "complete" }, completeness: { truncated: false } } }) });
    const children = [
      ...localTools(root),
      { name: "silent", source: "builtin", readOnly: true, execute: () => ({ text: "ok" }) }, // 内置工具，但没有报告 completeness
      echo("mcp_echo", "configured"), // 第三方工具：自称完整，但来源不是 builtin
      echo("lookup", "builtin", "key=sk-live-0000"), // 内置工具，结果会被后置 Hook 改写
      { name: "boom", source: "builtin", readOnly: true, execute: () => { throw Error("disk on fire"); } },
    ];
    const redact = async (call, result) => (call.name === "lookup" ? { text: result.text.replace(/sk-live-\w+/, "[redacted]") } : undefined);
    const [runCode] = ptcCatalogue(children);
    const code = `
const calls = {
  "read 整个文件": () => tools.read({ path: "a.txt" }),
  "read 前 50 行": () => tools.read({ path: "a.txt", limit: 50 }),
  "edit（收据，自己报告没截断）": () => tools.edit({ path: "e.txt", old: "old", next: "new" }),
  "silent（内置，但没有报告）": () => tools.silent({}),
  "第三方工具 mcp_echo": () => tools.mcp_echo({}),
  "lookup（后置 Hook 改写了文本）": () => tools.lookup({}),
  "boom（工具抛出）": () => tools.boom({}),
  "read 不存在的文件": () => tools.read({ path: "nope.txt" }),
};
const out = [];
for (const [name, call] of Object.entries(calls)) {
  const r = await call();
  out.push({ name, status: r.status, truncated: String(r.truncation.truncated), more: r.truncation.nextOffset ?? "", data: Object.keys(r.data).join(",") || "{}", code: r.error?.code ?? "" });
}
return out;`;
    const message = await wrapTool(runCode, context(root), { rules: { allow: ["edit"] }, after: [redact] })({
      id: "p1",
      name: "run_code",
      input: { code, description: "probe statuses" },
    });
    const table = JSON.parse(message.text);
    return {
      rows: table.map((r) => ({
        子调用: r.name,
        status: r.status,
        "truncation.truncated": r.truncated,
        "续读位置": r.more,
        "data 字段": r.data,
        "error.code": r.code,
      })),
      table,
    };
  });
}

// ─── 场景三：八种失败各停在哪一关 ───────────────────────────────────────────────

export async function failures() {
  return withWorkspace(async (root) => {
    writeFileSync(join(root, "a.txt"), "hello");
    writeFileSync(join(root, "b.txt"), "other");
    const ran = [];
    const stages = () => ({ before: ran.includes("before"), execute: ran.includes("execute"), after: ran.includes("after") });
    const base = {
      name: "peek",
      source: "builtin",
      readOnly: true,
      schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] },
      execute: (input, ctx) => {
        ran.push("execute");
        return { text: `peek ${input.path}${input.limit ? ` limit=${input.limit}` : ""}` };
      },
    };
    const scenario = async (name, { tool = base, input = { path: "a.txt" }, signal, before, after, rules, catalogue, call: callName = "peek" }) => {
      ran.length = 0;
      const hooks = {
        before: [() => void ran.push("before"), ...(before ?? [])],
        after: [() => void ran.push("after"), ...(after ?? [])],
        rules,
      };
      const ctx = context(root, { signal });
      const call = { id: name, name: callName, input };
      const message = catalogue
        ? await callTool(catalogue, call, ctx, hooks)
        : await wrapTool(tool, ctx, hooks)(call);
      return {
        场景: name,
        "failure.kind": message.failure?.kind ?? (message.error ? "（工具自己报错）" : "—"),
        拦下者: message.failure?.blockedBy ?? "",
        前置Hook: stages().before ? "跑了" : "没跑",
        execute: stages().execute ? "跑了" : "没跑",
        后置Hook: stages().after ? "跑了" : "没跑",
        "模型收到的文字（首行）": message.text.split("\n")[0],
        message,
      };
    };
    const aborted = new AbortController();
    aborted.abort(Error("user cancelled"));
    const rows = [
      await scenario("正常调用", { input: { path: "a.txt" } }),
      await scenario("limit 写成字符串 \"20\"", { input: { path: "a.txt", limit: "20" } }),
      await scenario("工具不存在", { catalogue: toolCatalogue([base]), call: "nope" }),
      await scenario("修参数时抛出", { tool: { ...base, prepareArguments: () => { throw Error("cannot repair arguments"); } } }),
      await scenario("缺少必填参数", { input: {} }),
      await scenario("limit 不是整数", { input: { path: "a.txt", limit: "abc" } }),
      await scenario("取消信号已触发", { signal: aborted.signal }),
      await scenario("前置 Hook 抛出", { before: [() => { throw Error("hook crashed"); }] }),
      await scenario("前置 Hook 拦下", { before: [() => ({ block: true, reason: "not on a Friday" })] }),
      await scenario("Hook 把参数改写成合法值", { before: [() => ({ updatedInput: { path: "b.txt" } })] }),
      await scenario("Hook 把参数改写成非法值", { before: [() => ({ updatedInput: { path: 42, limit: "abc" } })] }),
      await scenario("权限拒绝（edit 没有放行）", {
        tool: { ...base, name: "edit", readOnly: false, execute: () => { ran.push("execute"); return { text: "edited" }; } },
        call: "edit",
        rules: {},
      }),
      await scenario("工具抛出", { tool: { ...base, execute: () => { ran.push("execute"); throw Error("disk on fire"); } } }),
      await scenario("工具返回 isError", { tool: { ...base, execute: () => { ran.push("execute"); return { text: "exit code 1", isError: true }; } } }),
      await scenario("后置 Hook 抛出", { after: [() => { throw Error("redactor crashed"); }] }),
    ];
    return { rows };
  });
}

/** 真实的 prepareEditArguments 怎样处理模型的固定坏习惯。 */
export async function prepare() {
  const { prepareEditArguments } = await importSource("packages/agent-core/src/tools/edit-prepare-arguments.ts");
  const cases = [
    ["规范输入", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }],
    ["edits 被序列化成 JSON 字符串（MiniMax-M3 / GLM-5.1）", { path: "a.ts", edits: '[{"oldText":"x","newText":"y"}]' }],
    ["旧格式：oldText / newText 在顶层", { path: "a.ts", oldText: "x", newText: "y" }],
    ["字符串不是合法 JSON", { path: "a.ts", edits: "[{oops" }],
  ];
  return cases.map(([name, input]) => ({ 场景: name, 输入: JSON.stringify(input), 输出: JSON.stringify(prepareEditArguments(structuredClone(input))) }));
}

// ─── 场景四：同一批调用，三种排法 ───────────────────────────────────────────────

/** Claude Code 的做法：只把相邻的并发安全调用并成一批，写操作自己一批（课程里自己写的版本）。 */
export function partitionAdjacent(calls, catalogue) {
  const batches = [];
  for (const call of calls) {
    const safe = catalogue.get(call.name)?.executionMode === "parallel";
    if (safe && batches.at(-1)?.safe) batches.at(-1).calls.push(call);
    else batches.push({ safe, calls: [call] });
  }
  return batches.map((b) => b.calls);
}

export async function schedules() {
  const { PtcSubcallScheduler } = await importSource(
    "packages/local-runtime-v2/src/service/turn-system/agent-host/execution/ptc/subcall-scheduler.ts",
  );
  return withWorkspace(async (root) => {
    writeFileSync(join(root, "a.txt"), "old");
    writeFileSync(join(root, "b.txt"), "other");
    // 四个调用，每个都要花点时间（模拟磁盘和进程）。读在开始时读文件，edit 在结束时才写。
    const cost = { A: 30, B: 60, E: 40, C: 50 };
    const plan = [
      { id: "A", label: "read a.txt", name: "read", input: { path: "a.txt" } },
      { id: "B", label: "read b.txt", name: "read", input: { path: "b.txt" } },
      { id: "E", label: "edit a.txt", name: "edit", input: { path: "a.txt", old: "old", next: "new" } },
      { id: "C", label: "read a.txt（再读一次）", name: "read", input: { path: "a.txt" } },
    ];

    /** 在真实工具外面包一层：记下开始、结束的先后，并制造耗时。 */
    const instrument = (log, seen) =>
      localTools(root).map((tool) => ({
        ...tool,
        readOnly: true,
        execute: async (input, ctx) => {
          const id = ctx.toolCallId;
          log.push(`${id}+`);
          let result;
          if (tool.name === "read") {
            result = await tool.execute(input, ctx); // 开始时读文件
            seen[id] = result.text;
            await sleep(cost[id]);
          } else {
            await sleep(cost[id]); // 写在结束时才生效
            result = await tool.execute(input, ctx);
          }
          log.push(`${id}-`);
          return result;
        },
      }));

    /** 事件序列里同时在跑的调用数峰值。 */
    const peak = (log) => {
      let now = 0, max = 0;
      for (const event of log) {
        now += event.endsWith("+") ? 1 : -1;
        max = Math.max(max, now);
      }
      return max;
    };

    const run = async (name, drive, { markEditParallel = false } = {}) => {
      writeFileSync(join(root, "a.txt"), "old");
      const log = [];
      const seen = {};
      const tools = instrument(log, seen).map((t) => (markEditParallel && t.name === "edit" ? { ...t, executionMode: "parallel" } : t));
      const catalogue = toolCatalogue(tools);
      const exec = (call) => callTool(catalogue, { id: call.id, name: call.name, input: call.input }, context(root), { rules: { allow: ["edit"] } });
      await drive(plan, catalogue, exec);
      return {
        做法: name,
        "事件顺序（X+ 开始，X- 结束）": log.join(" "),
        同时在跑的峰值: peak(log),
        "末尾 read 读到": seen.C,
        log,
      };
    };

    const rows = [
      await run("Pi / MiniMax 整批规则", async (calls, catalogue, exec) => {
        if (batchMode(calls, catalogue) === "sequential") for (const call of calls) await exec(call);
        else await Promise.all(calls.map(exec));
      }),
      await run("Claude Code：相邻分批", async (calls, catalogue, exec) => {
        for (const batch of partitionAdjacent(calls, catalogue)) await Promise.all(batch.map(exec));
      }),
      await run("run_code：host 的 SubcallScheduler", async (calls, catalogue, exec) => {
        const scheduler = new SubcallScheduler(16);
        await Promise.all(calls.map((call) => scheduler.run(catalogue.get(call.name).executionMode, () => exec(call))));
      }),
      await run("run_code：MiniMax 的 PtcSubcallScheduler", async (calls, catalogue, exec) => {
        const scheduler = new PtcSubcallScheduler(16);
        await Promise.all(calls.map((call) => scheduler.run(catalogue.get(call.name).executionMode, () => exec(call))));
      }),
      await run("反例：edit 误标成 parallel，全部同时开始", async (calls, catalogue, exec) => {
        await Promise.all(calls.map(exec));
      }, { markEditParallel: true }),
    ];
    return { rows, plan };
  });
}

// ─── 场景五：同一个 read，模型看到 24 KiB，程序看到全文 ───────────────────────────

export async function readCaps() {
  const upstream = await importSource("packages/agent-tools/src/desktop/output-limit.ts");
  const { limitDesktopPrefixLines, isPtcChildCall, DESKTOP_READ_TEXT_MAX_BYTES, PTC_CHILD_FULL_OUTPUT_MAX_BYTES } = upstream;
  const lines = Array.from({ length: 3000 }, (_, i) => `${String(i + 1).padStart(5)}  export const symbol_${i} = lookup("module/${i}"); // generated`);
  const text = lines.join("\n");

  // MiniMax 的函数：给模型的读，逐页翻，直到读完。
  const pagesUpstream = [];
  for (let from = 0; from < lines.length; ) {
    const rest = lines.slice(from).join("\n");
    const limited = limitDesktopPrefixLines(rest, {
      maxBytes: DESKTOP_READ_TEXT_MAX_BYTES,
      notice: ({ returnedBodyLines }) => `[truncated: showing ${returnedBodyLines} lines. Continue with offset=${from + returnedBodyLines + 1}.]`,
    });
    pagesUpstream.push(limited.returnedBodyLines);
    from += limited.returnedBodyLines;
  }

  // host 的 read：同一个文件，模型直接调用 vs run_code 子调用。
  const hostResult = await withWorkspace(async (root) => {
    writeFileSync(join(root, "big.txt"), text);
    const catalogue = toolCatalogue(localTools(root));
    const direct = [];
    for (let offset = 1; offset <= lines.length; ) {
      const result = await callTool(catalogue, { id: `d${offset}`, name: "read", input: { path: "big.txt", offset } }, context(root));
      const shown = Number(result.text.match(/showing (\d+) of/)?.[1] ?? result.text.split("\n").length);
      direct.push(shown);
      offset += shown;
    }
    const child = await callTool(catalogue, { id: "child", name: "read", input: { path: "big.txt" } }, context(root, { parentToolCallId: "call_run" }));
    return { direct, childLines: child.text.split("\n").length, childBytes: Buffer.byteLength(child.text) };
  });

  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  return {
    totalBytes: Buffer.byteLength(text),
    totalLines: lines.length,
    upstream: { pages: pagesUpstream.length, first: pagesUpstream[0], sum: sum(pagesUpstream) },
    host: hostResult,
    flags: {
      direct: isPtcChildCall({}),
      child: isPtcChildCall({ parentToolCallId: "call_run" }),
    },
    limits: { model: DESKTOP_READ_TEXT_MAX_BYTES, child: PTC_CHILD_FULL_OUTPUT_MAX_BYTES },
    rows: [
      { 调用方: "模型直接调用 read（MiniMax 的 limitDesktopPrefixLines）", "单次上限": kib(DESKTOP_READ_TEXT_MAX_BYTES), "读完要几次": pagesUpstream.length, "第一次拿到": `${pagesUpstream[0]} 行`, "结果去哪": "模型的上下文" },
      { 调用方: "模型直接调用 read（host 的 read）", "单次上限": kib(24 * 1024), "读完要几次": hostResult.direct.length, "第一次拿到": `${hostResult.direct[0]} 行`, "结果去哪": "模型的上下文" },
      { 调用方: "run_code 里的子调用（host 的 read）", "单次上限": kib(PTC_CHILD_FULL_OUTPUT_MAX_BYTES), "读完要几次": 1, "第一次拿到": `${hostResult.childLines} 行`, "结果去哪": "程序的变量" },
    ],
  };
}

// ─── 场景六：run_code 的几条边界 ────────────────────────────────────────────────

export async function programs() {
  const upstream = await importSource("packages/agent-core/src/tools/ptc.ts");
  return withWorkspace(async (root) => {
    for (let i = 0; i < 6; i++) writeFileSync(join(root, `f${i}.txt`), `file ${i}`);
    writeFileSync(join(root, "secret.txt"), "classified");
    writeFileSync(join(root, "big.txt"), "x".repeat(100_000));
    const executed = []; // 真正执行过的子调用
    const tools = [
      ...localTools(root).map((tool) => ({
        ...tool,
        execute: (input, ctx) => {
          executed.push(`${tool.name}:${input.path}`);
          return tool.execute(input, ctx);
        },
      })),
      {
        // 永远不会自己结束的工具：只有收到取消信号才返回。
        name: "stall",
        source: "builtin",
        readOnly: true,
        execute: (_, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ text: "aborted", isError: true }), { once: true })),
      },
    ];
    const blockSecret = (call) => (call.input?.path === "secret.txt" ? { block: true, reason: "secret.txt is off limits" } : undefined);

    const run = async (name, code, { limits, rules = {}, timeout_ms, before = [] } = {}) => {
      executed.length = 0;
      const [runCode] = ptcCatalogue(tools, limits ? { limits } : undefined);
      const message = await wrapTool(runCode, context(root), { rules, before })({
        id: name,
        name: "run_code",
        input: { code, description: name, ...(timeout_ms ? { timeout_ms } : {}) },
      });
      return {
        场景: name,
        // 文字里有 <ptc_error> 这样的标签，包进反引号，网页上才不会被当成 HTML。
        "模型收到的文字": "`" + abbreviate(message.text.replace(/\n/g, " ⏎ ")) + "`",
        "实际执行的子调用": executed.join(", ") || "—",
        "记录的子调用": message.details.ptc.child_calls.map((c) => `${c.tool_name}:${c.status}`).join(", ") || "—",
        message,
      };
    };

    const limits = { maxToolCalls: 4, maxConcurrentToolCalls: 16, maxOuterResultBytes: 2000, maxConsoleBytes: 1000, maxBridgeMessageBytes: 1 << 20, defaultWallClockMs: 120_000, maxWallClockMs: 3_600_000 };
    const rows = [
      await run("子调用失败不抛异常", `const r = await tools.read({ path: "nope.txt" }); return { status: r.status, code: r.error.code };`),
      await run("程序里的 edit 也要过权限", `const a = await tools.edit({ path: "f0.txt", old: "file", next: "FILE" }); const b = await tools.read({ path: "f0.txt" }); return { edit: a.error?.code, readAfter: b.output };`),
      await run("放行 edit 之后", `const a = await tools.edit({ path: "f1.txt", old: "file", next: "FILE" }); return { edit: a.status, readAfter: (await tools.read({ path: "f1.txt" })).output };`, { rules: { allow: ["edit"] } }),
      await run("同一个 Hook 也拦程序里的子调用", `const r = await tools.read({ path: "secret.txt" }); return { code: r.error.code, message: r.error.message };`, { before: [blockSecret] }),
      await run("调用预算（这里设成 4 次）", `const rs = []; for (let i = 0; i < 6; i++) rs.push(await tools.read({ path: "f" + i + ".txt" })); return rs.map((r) => r.error?.code ?? r.status);`, { limits }),
      await run("返回值太大（上限设成 2000 字节）", `return "y".repeat(5000);`, { limits }),
      await run("console 输出", `console.log("starting"); console.warn({ n: 1 }); return "done";`),
      await run("没等子调用就返回", `tools.stall({}); return "returned early";`),
      await run("超过 wall clock（timeout_ms: 80）", `await tools.stall({}); return "never";`, { timeout_ms: 80 }),
      await run("访客拿不到宿主", `return [typeof process, typeof require, typeof __call, typeof globalThis.fetch].join(",");`),
      await run("访客代码抛出", `throw new Error("bad plan");`),
    ];
    const clocks = [undefined, 500, 0, -1, "60000", 7_200_000].map((requested) => {
      const real = upstream.resolvePtcWallClock(requested);
      return { requested, real };
    });
    return { rows, clocks };
  });
}
