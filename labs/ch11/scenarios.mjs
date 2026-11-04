// 第 11 章实验的共用场景：四个脚本（ledger / gates / flow / edit）和 labs/chapters/11-first-contribution.mjs 都从这里取数。
// 所有“出处行号”都是在真实文件里搜出来的，不是手写的常量；所有“复现”都执行真实的上游函数。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findEvidence, parseLedger, redGreen, summarizeLedger, upstreamCheck, verificationPlan } from "../../host/src/contribution.mjs";
import { importSource } from "../../lab/source.mjs";
import { LOCK, PI, VENDOR, loadMiniMax, loadPi, readMiniMax, readPi } from "./upstream.mjs";

export const LEDGER_FILE = `${VENDOR}MINIMAX_CHANGES.md`;
/** 读 Issue 状态的日期：这些状态是人在这一天用只读方式看到的，会变。 */
export const OBSERVED = "2026-11-04";

export function markdownTable(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${keys.join(" | ")} |`, `| ${keys.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${keys.map((k) => cell(r[k])).join(" | ")} |`)].join("\n");
}

// ───────────────────────── 台账 ─────────────────────────

export function readLedger() {
  return parseLedger(readMiniMax(LEDGER_FILE));
}

export function ledgerOverview() {
  const entries = readLedger();
  return { entries, summary: summarizeLedger(entries) };
}

// ───────────────────────── 核对上游 ─────────────────────────

const issue = (number, state, label = "") => ({ repo: "earendil-works/pi", number, state, label, observedAt: OBSERVED });

/**
 * 七条台账条目对照 Pi v1.5.0。每条的出处都是 findEvidence 在真实文件里搜出来的。
 * issues 是 2026-11-04 用只读方式在 GitHub 上看到的状态，不会随实验刷新。
 */
export function upstreamChecks() {
  const entries = readLedger();
  const entry = (needle) => {
    const found = entries.find((e) => e.title.includes(needle));
    if (!found) throw new Error(`台账里没有：${needle}`);
    return found;
  };
  const upstream = `Pi ${PI.version}`;
  const pi = (file, needle) => ({ file, ...findEvidence(readPi(file), needle) });
  const mm = (file, needle) => ({ file: `${VENDOR}${file}`, ...findEvidence(readMiniMax(`${VENDOR}${file}`), needle) });

  return [
    upstreamCheck({
      entry: entry("without a stop_reason"),
      upstream,
      verdict: "fixed",
      evidence: [
        pi("packages/ai/src/api/anthropic-messages.ts", 'stopReason: "pending"'),
        pi("packages/ai/src/api/anthropic-messages.ts", "Anthropic stream ended without a stop reason"),
      ],
      note: `做法不同：MiniMax 在迭代器末尾数 stop_reason（${mm("packages/ai/src/providers/anthropic.ts", "ended without stop_reason").line} 行），Pi 把初始值改成 pending`,
    }),
    upstreamCheck({
      entry: entry("taskkill"),
      upstream,
      verdict: "fixed",
      evidence: [
        pi("packages/coding-agent/src/utils/shell.ts", 'taskkill.exe'),
        pi("packages/coding-agent/src/utils/shell.ts", 'child.once("error"'),
      ],
    }),
    upstreamCheck({
      entry: entry("unsafe integers"),
      upstream,
      verdict: "still-present",
      evidence: [
        pi("packages/ai/src/utils/json-parse.ts", "return JSON.parse(json) as T;"),
        pi("packages/schema/src/coerce.ts", 'if (typeof value === "number" || typeof value === "boolean") return String(value);'),
      ],
      issues: [issue(8943, "closed, not planned", "no-action")],
    }),
    upstreamCheck({
      entry: entry("scope fuzzy-match normalization"),
      upstream,
      verdict: "partial",
      evidence: [
        pi("packages/coding-agent/src/core/tools/edit-diff.ts", "applyReplacementsPreservingUnchangedLines("),
        pi("packages/coding-agent/src/core/tools/edit-diff.ts", "const replacementBaseContent = usedFuzzyMatch"),
      ],
      issues: [issue(5899, "closed, completed"), issue(10655, "closed, not planned", "no-action"), issue(3554, "closed, completed")],
      note: "上游只保证没被编辑碰到的行逐字节不变；被碰到的行仍整行规范化",
    }),
    upstreamCheck({
      entry: entry("empty tools"),
      upstream,
      verdict: "different-design",
      evidence: [
        pi("packages/ai/src/api/openai-completions.ts", "} else if (hasToolHistory(context.messages)) {"),
        pi("packages/ai/src/api/openai-completions.ts", "params.tools = [];"),
      ],
      note: "上游为 LiteLLM 代理有意在有工具历史时发空数组；MiniMax 的补丁推翻了这个决定",
    }),
    upstreamCheck({
      entry: entry("BEL-terminated OSC 8"),
      upstream,
      verdict: "still-present",
      evidence: [pi("packages/tui/src/terminal-image.ts", "return `\\x1b]8;;${url}\\x1b\\\\${text}\\x1b]8;;\\x1b\\\\`;")],
      note: "问题出在 macOS Terminal 的点击命中，没有终端就写不出红测试",
    }),
    upstreamCheck({
      entry: entry("configurable text truncation limits"),
      upstream,
      verdict: "still-present",
      evidence: [pi("packages/coding-agent/src/core/tools/read.ts", "const truncation = truncateHead(selectedContent);")],
      note: "这是给宿主开的接缝（新功能），不是缺陷",
    }),
  ];
}

/**
 * 核对的另一半：台账里每条补丁都有一行 “minimax integration”，指向 MiniMax 自己的消费者。
 * stop_reason 那条在 MiniMax 一侧是 llm-error-classifier.ts 里按措辞匹配的正则；
 * 这里用 importSource 装载真实的分类器，看它认不认 Pi v1.5.0 的新措辞。
 */
export async function classifierDrift() {
  const classifier = await importSource("packages/shared/src/llm-error-classifier.ts");
  const piMessage = findEvidence(readPi("packages/ai/src/api/anthropic-messages.ts"), "Anthropic stream ended without a stop reason").text.match(/"([^"]+)"/)[1];
  const vendoredMessage = "Anthropic stream ended without stop_reason (messageDeltaCount=1; rawEventCount=9; messageEventCount=9; lastEventAtMs=1008; eofAtMs=2066)";
  return [["内置 Pi 0.79.1 加补丁", vendoredMessage], ["Pi v1.5.0", piMessage]].map(([source, message]) => ({
    来源: source,
    报错文字: message.length > 60 ? `${message.slice(0, 57)}...` : message,
    分类结果: JSON.stringify(classifier.classifyLLMErrorToCode(message)?.status_code ?? null),
    incomplete_stream信号: classifier.normalizeLLMError({ errorMessage: message }).facts.signals.has("incomplete_stream") ? "有" : "无",
  }));
}

// ───────────────────────── 门禁 ─────────────────────────

/** 把固定提交里的一个脚本原样写进临时目录（只读源码，不执行 checkout 里的工作区文件）。 */
function exportScripts(files) {
  const dir = mkdtempSync(join(tmpdir(), "mm-gates-"));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), readMiniMax(file));
  }
  return dir;
}

/** 在本机运行 MiniMax 自己的 `scripts/verify.mjs --list`，得到每一档要跑的门禁。 */
export function gateMatrix(profiles = ["full", "platform", "docs", "archive"]) {
  const dir = exportScripts(["scripts/verify.mjs"]);
  try {
    const plans = Object.fromEntries(
      profiles.map((profile) => [
        profile,
        execFileSync(process.execPath, ["scripts/verify.mjs", "--list", "--profile", profile], { cwd: dir, encoding: "utf8" })
          .split("\n")
          .filter(Boolean),
      ]),
    );
    const names = [...new Set(profiles.flatMap((p) => plans[p]))];
    const rows = names.map((name) => Object.fromEntries([["门禁", name], ...profiles.map((p) => [p, plans[p].includes(name) ? "●" : ""])]));
    return { platform: process.platform, profiles, plans, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 装载 MiniMax 自己的 classifyChanges（scripts/ci-changes.mjs）：它决定“只改文档”能不能走 docs 档。 */
export async function loadClassifier() {
  const dir = exportScripts(["scripts/ci-changes.mjs"]);
  try {
    // 写成真文件再 import，import.meta.url 才是文件地址；模块自带的“被直接运行”守卫据此不会触发。
    const module = await import(pathToFileURL(join(dir, "scripts/ci-changes.mjs")).href + `?t=${Date.now()}`);
    return module.classifyChanges;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** test/vitest-suites.json：每个门禁组登记了多少测试文件，其中有没有 third_party 下的。 */
export function suiteInventory() {
  const { suites } = JSON.parse(readMiniMax("test/vitest-suites.json"));
  const files = Object.values(suites).flat();
  return {
    groups: Object.entries(suites).map(([group, list]) => ({ 门禁组: group, 测试文件数: list.length })),
    files,
    vendorFiles: files.filter((f) => f.startsWith("third_party/")),
  };
}

export async function changePlans() {
  const classifyChanges = await loadClassifier();
  const { files } = suiteInventory();
  const scenarios = [
    ["只改 README 和 docs 下的文档", ["README.md", "docs/architecture.md"]],
    ["改了 PR 模板，顺手改了一个技能", [".github/PULL_REQUEST_TEMPLATE.md", ".agents/skills/testing-workflow/SKILL.md"]],
    ["修 json-parse（内置 Pi），带一个 Pi 自己的测试", [`${VENDOR}packages/ai/src/utils/json-parse.ts`, `${VENDOR}packages/ai/test/tool-argument-unsafe-integer.test.ts`]],
    ["改 TUI 一个单元测试，没登记", ["packages/tui/src/tui/example.ts", "packages/tui/test/unit/example-new.test.ts"]],
  ];
  return scenarios.map(([name, paths]) => ({ name, paths, plan: verificationPlan(paths, { classifyChanges, suiteFiles: files }) }));
}

// ───────────────────────── 复现：长整数 ─────────────────────────

const PARTIAL_JSON_STUB = 'export const parse = () => { throw new Error("partial-json 替身：完整 JSON 不会走到这里"); };';
const JSON_PARSE = "packages/ai/src/utils/json-parse.ts";
const PI_LOAD = { stubs: { "partial-json": PARTIAL_JSON_STUB }, aliases: { "@earendil-works/pi-schema": "packages/schema/src/index.ts", "@earendil-works/pi-schema/formats": "packages/schema/src/formats/index.ts" } };

export const ID_NUMBER = "440103198004279575";
export const RAW_ARGUMENTS = `{"id_number": ${ID_NUMBER}, "page": 3}`;
export const LOOKUP_TOOL = {
  name: "lookup_person",
  description: "Look up a person by ID number.",
  parameters: { type: "object", properties: { id_number: { type: "string" }, page: { type: "integer" } }, required: ["id_number"] },
};

/** 用 Pi v1.5.0 的真实函数走一遍：模型发来的参数文本 -> 解析 -> 校验（含类型转换）-> 工具收到的值。 */
export async function reproduceUnsafeInteger() {
  const { parseToolCallArguments } = await loadPi(PI_LOAD)(JSON_PARSE);
  const { validateToolArguments } = await loadPi(PI_LOAD)("packages/ai/src/utils/validation.ts");
  const parsed = parseToolCallArguments(RAW_ARGUMENTS);
  const received = validateToolArguments(LOOKUP_TOOL, { type: "toolCall", id: "call_1", name: LOOKUP_TOOL.name, ...parsed });
  const quoted = validateToolArguments(LOOKUP_TOOL, { name: LOOKUP_TOOL.name, ...parseToolCallArguments(`{"id_number": "${ID_NUMBER}"}`) });
  return {
    sent: ID_NUMBER,
    afterParse: parsed.arguments.id_number,
    parsedType: typeof parsed.arguments.id_number,
    received: received.id_number,
    receivedWhenQuoted: quoted.id_number,
    lost: received.id_number !== ID_NUMBER,
  };
}

/** 调用链上每一站的出处（Pi v1.5.0），行号来自真实文件。 */
export function unsafeIntegerChain() {
  const at = (file, needle, role) => {
    const e = findEvidence(readPi(file), needle);
    return { 位置: `${file}:${e.line}`, 做了什么: role, 代码: e.text };
  };
  return [
    at("packages/ai/src/api/anthropic-messages.ts", "Object.assign(block, open.arguments.finish())", "工具调用结束：取出完整参数文本，整体解析一次"),
    at("packages/ai/src/utils/streaming-json.ts", "return parseToolCallArguments(this.#text);", "finish() 把参数文本交给 parseToolCallArguments"),
    at(JSON_PARSE, "const parsed = parseJsonWithRepair<ToolCall", "parseToolCallArguments 调用 parseJsonWithRepair"),
    at(JSON_PARSE, "return JSON.parse(json) as T;", "这里：JSON.parse 把长整数舍入成最近的 double"),
    at("packages/ai/src/utils/validation.ts", ".parse(structuredClone(toolCall.arguments))", "执行工具之前，按工具的 schema 校验并转换类型"),
    at("packages/schema/src/coerce.ts", 'if (typeof value === "number" || typeof value === "boolean") return String(value);', "type 是 string 而值是数字：String(舍入后的数字)"),
  ];
}

// ───────────────────────── 补丁、红绿、Issue 草稿 ─────────────────────────

/** 对 Pi v1.5.0 的 json-parse.ts 做最小修改，得到“打了补丁的副本”的完整文本。 */
export function patchedJsonParse(baseline = readPi(JSON_PARSE)) {
  const swap = (text, from, to) => {
    if (!text.includes(from)) throw new Error(`补丁锚点不存在：${from.split("\n")[0]}`);
    return text.replace(from, to);
  };
  let next = swap(
    baseline,
    "export function parseJsonWithRepair<T>(json: string): T {\n\ttry {\n\t\treturn JSON.parse(json) as T;\n\t} catch (error) {\n\t\tconst repairedJson = repairJson(json);\n\t\tif (repairedJson !== json) {\n\t\t\treturn JSON.parse(repairedJson) as T;\n\t\t}",
    [
      "type JsonReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;",
      "",
      "const INTEGER_LITERAL = /^-?(?:0|[1-9]\\d*)$/;",
      "",
      "/** An integer literal that a double cannot hold exactly stays as its source digits (needs JSON.parse source text access, Node 21+). */",
      "const keepUnsafeIntegerSource: JsonReviver = (_key, value, context) =>",
      '\ttypeof value === "number" && !Number.isSafeInteger(value) && INTEGER_LITERAL.test(context?.source ?? "") ? context?.source : value;',
      "",
      "export function parseJsonWithRepair<T>(json: string, reviver?: JsonReviver): T {",
      "\ttry {",
      "\t\treturn JSON.parse(json, reviver) as T;",
      "\t} catch (error) {",
      "\t\tconst repairedJson = repairJson(json);",
      "\t\tif (repairedJson !== json) {",
      "\t\t\treturn JSON.parse(repairedJson, reviver) as T;",
      "\t\t}",
    ].join("\n"),
  );
  next = swap(next, 'parseJsonWithRepair<ToolCall["arguments"] | null>(json);', 'parseJsonWithRepair<ToolCall["arguments"] | null>(json, keepUnsafeIntegerSource);');
  return next;
}

/** 测试用例是数据：同一份既喂给红绿脚本，也生成英文 Issue 里的 vitest 示例。 */
export const UNSAFE_INTEGER_CASES = [
  {
    name: "a string parameter keeps the digits of an unquoted long integer",
    raw: RAW_ARGUMENTS,
    tool: LOOKUP_TOOL,
    expected: { id_number: ID_NUMBER, page: 3 },
  },
  {
    name: "an integer parameter still gets the same double as before",
    raw: '{"id_number": "x", "page": 9007199254740993}',
    tool: LOOKUP_TOOL,
    expected: { id_number: "x", page: 9007199254740992 },
  },
  {
    name: "safe integers, decimals and exponents are not rewritten",
    raw: '{"a": 12, "b": 1.5, "c": 1e21}',
    tool: { name: "any", description: "any", parameters: { type: "object" } },
    expected: { a: 12, b: 1.5, c: 1e21 },
  },
];

export async function unsafeIntegerRedGreen() {
  const baseline = await loadPi(PI_LOAD)(JSON_PARSE);
  const patched = await loadPi({ ...PI_LOAD, overlay: { [JSON_PARSE]: patchedJsonParse() } })(JSON_PARSE);
  const { validateToolArguments } = await loadPi(PI_LOAD)("packages/ai/src/utils/validation.ts");
  const run = (module, testCase) => {
    const parsed = module.parseToolCallArguments(testCase.raw);
    const actual = validateToolArguments(testCase.tool, { name: testCase.tool.name, ...parsed });
    const same = JSON.stringify(actual) === JSON.stringify(testCase.expected);
    if (!same) throw new Error(`expected ${JSON.stringify(testCase.expected)}, got ${JSON.stringify(actual)}`);
  };
  return redGreen({ cases: UNSAFE_INTEGER_CASES, baseline, patched, run });
}

const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

/** 在临时仓库里把补丁变成真正的 unified diff，并双向校验它能干净地应用/撤销。 */
export function makePatch(workdir) {
  const git = (...args) => execFileSync("git", ["-C", workdir, ...args], { encoding: "utf8", env: GIT_ENV });
  const baseline = readPi(JSON_PARSE);
  const patched = patchedJsonParse(baseline);
  const target = join(workdir, JSON_PARSE);
  mkdirSync(join(target, ".."), { recursive: true });
  git("init", "-q");
  writeFileSync(target, baseline);
  git("add", JSON_PARSE);
  writeFileSync(target, patched);
  const diff = git("diff");
  const patchFile = join(workdir, "..", "unsafe-integer.patch");
  writeFileSync(patchFile, diff);
  git("apply", "--check", "--reverse", patchFile); // 工作区是补丁之后的状态，撤销应当成功
  writeFileSync(target, baseline);
  git("apply", "--check", patchFile); // 退回基线，补丁应当能干净地应用
  const lines = diff.split("\n");
  return {
    diff,
    added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
    readBack: readFileSync(target, "utf8") === baseline,
  };
}

/** 由第一条用例生成 Pi 风格的 vitest 回归测试（Pi 的 AGENTS.md 要求在测试旁注明 Issue 编号，真实提交时再补）。 */
export function vitestSnippet() {
  const c = UNSAFE_INTEGER_CASES[0];
  return [
    `it("${c.name}", () => {`,
    `\tconst raw = '${c.raw}';`,
    `\tconst call = { name: "lookup_person", ...parseToolCallArguments(raw) };`,
    `\texpect(validateToolArguments(lookupPerson, call)).toEqual(${JSON.stringify(c.expected)});`,
    "});",
  ].join("\n");
}

// ───────────────────────── 复现：edit 的模糊匹配 ─────────────────────────

const EDIT_DIFF = "packages/coding-agent/src/core/tools/edit-diff.ts";
const DIFF_STUB = 'const stop = () => { throw new Error("diff 替身：applyEditsToNormalizedContent 用不到"); }; export const diffLines = stop; export const createTwoFilesPatch = stop;';
const PATH_UTILS_STUB = 'export const resolveToCwd = () => { throw new Error("path-utils 替身：applyEditsToNormalizedContent 用不到"); };';

export const EDIT_FILE = ["# 说明", "默认值是 “auto”，可以改成 “off”。", "第三行保持不变，全角逗号，也保持不变。", ""].join("\n");
export const EDIT_REQUEST = [{ oldText: '默认值是 "auto"', newText: '默认值是 "manual"' }];

/** 同一次 edit 请求（模型把弯引号写成了直引号）分别交给 Pi v1.5.0 和 MiniMax 内置的 Pi。 */
export async function reproduceFuzzyEdit() {
  const pi = await loadPi({ stubs: { diff: DIFF_STUB }, fileStubs: { [`packages/coding-agent/src/core/tools/path-utils.ts`]: PATH_UTILS_STUB } })(EDIT_DIFF);
  const vendored = await loadMiniMax({
    stubs: { diff: DIFF_STUB },
    fileStubs: { [`${VENDOR}packages/coding-agent/src/core/tools/path-utils.ts`]: PATH_UTILS_STUB },
  })(`${VENDOR}${EDIT_DIFF}`);
  const run = (module) => module.applyEditsToNormalizedContent(EDIT_FILE, EDIT_REQUEST, "README.md").newContent;
  const before = EDIT_FILE.split("\n");
  const rows = [];
  for (const [name, module] of [["Pi v1.5.0", pi], ["MiniMax 内置的 Pi（带补丁）", vendored]]) {
    const after = run(module).split("\n");
    // 逐行比较：哪些行变了；变了的行里，有哪些字符不在 oldText 范围内却被改写
    const changedLines = before.map((line, i) => (line === after[i] ? null : i + 1)).filter(Boolean);
    const collateral = [...(before[1] ?? "")].filter((ch) => "，“”".includes(ch) && !after[1].includes(ch));
    rows.push({ 实现: name, 改动的行: changedLines.join(", "), 被连带改写的字符: [...new Set(collateral)].join(" ") || "无", 第二行结果: after[1], 未碰的行是否原样: after[2] === before[2] ? "是" : "否" });
  }
  return rows;
}
