// 第 11 章：贡献工作台（host 里的“从线索到可审查材料”）。
//
// 对应 MiniMax Code 仓库里的几份材料，而不是某个运行时模块：
//   - third_party/pi-mono/MINIMAX_CHANGES.md   给内置 Pi 打的本地补丁台账（每条：原因、影响、是否可回馈上游、PR 状态、验证）
//   - .github/PULL_REQUEST_TEMPLATE.md          PR 必须写清楚：改了什么、跑了什么、没跑什么
//   - scripts/verify.mjs、scripts/ci-changes.mjs  验证门禁，以及“只改文档可以走 docs 档”的判断
//
// 这里把贡献的几个动作写成小函数，实验里一步一步用：
//   parseLedger / summarizeLedger   读台账，数一数哪些条目值得核对
//   findEvidence / upstreamCheck    在上游源码里找出处，记录核对结论（行号来自真实文件，不是手写）
//   redGreen                        同一组用例分别跑在“修复前”和“修复后”上，红绿必须都成立
//   verificationPlan                改了哪些路径，该走哪一档门禁、测试该放在哪里
//   investigation / issueDraft      把以上证据装配成可审查的材料；草稿不等于已提交
//
// 简化：台账解析只认 MINIMAX_CHANGES.md 现有的“## / ### 日期 + 标题，条目内 `- 字段: 内容`”格式；
// 核对和复现本身是人读代码、跑代码做出来的，这里只负责把结论固定成带出处的记录，防止凭印象下结论。
import { digest } from "../../runtime/files.mjs";

// ───────────────────────── 一、读台账 ─────────────────────────

const HEADING = /^(#{2,3}) (\d{4}-\d{2}-\d{2})\s*(?:—|:|-)\s*(.+)$/;
const FIELD = /^- ([A-Za-z][^:]{0,80}?):\s*(.*)$/;

/**
 * 把 MINIMAX_CHANGES.md 切成条目。每条：日期、标题、字段表、整段原文，
 * 以及三个判断：可否回馈上游（kind）、上游 PR 状态（prStatus）、有没有写验证（hasValidation）。
 */
export function parseLedger(markdown) {
  const entries = [];
  let current;
  for (const line of markdown.split("\n")) {
    const heading = line.match(HEADING);
    if (heading) {
      current = { date: heading[2], title: heading[3].trim(), fields: {}, lines: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const field = line.match(FIELD);
    if (field) current.fields[field[1].trim().toLowerCase()] = field[2];
  }
  return entries.map(describeEntry);
}

/** 按字段名的前缀取值：`affected package` 也能取到 `affected packages`、`affected package: …`。 */
function fieldStartingWith(entry, ...prefixes) {
  for (const key of Object.keys(entry.fields)) {
    if (prefixes.some((p) => key.startsWith(p))) return entry.fields[key];
  }
  return undefined;
}

function describeEntry(entry) {
  const body = entry.lines.join("\n");
  const changeType = fieldStartingWith(entry, "change type", "type") ?? "";
  const upstreamPr = fieldStartingWith(entry, "upstream pr") ?? "";
  const scope = changeType || body;
  // “No MiniMax-specific runtime dependency” 说的是通用，所以只认以 MiniMax-specific 开头的类型
  const kind = /^\s*minimax-specific/i.test(changeType)
    ? "minimax-specific"
    : /generic|upstreamable|upstream material/i.test(scope)
      ? "generic"
      : "unmarked";
  const prStatus = /already merged/i.test(upstreamPr)
    ? "merged"
    : /not (opened|created)/i.test(upstreamPr)
      ? "not-opened"
      : "unrecorded";
  return {
    date: entry.date,
    title: entry.title,
    reason: fieldStartingWith(entry, "reason") ?? "",
    affected: fieldStartingWith(entry, "affected") ?? "",
    changeType,
    upstreamPr,
    validation: fieldStartingWith(entry, "validation", "regression coverage") ?? "",
    kind,
    prStatus,
    hasValidation: fieldStartingWith(entry, "validation", "regression coverage") !== undefined,
    // 台账里点名的回归测试文件，例如 `packages/ai/test/xxx.test.ts`
    testFiles: [...new Set([...body.matchAll(/`([\w./-]+\.test\.(?:ts|mjs))`/g)].map((m) => m[1]))],
    body,
  };
}

/** 台账的整体画像：多少条、多少条自认通用、多少条没开过上游 PR、多少条写了验证。 */
export function summarizeLedger(entries) {
  const count = (pred) => entries.filter(pred).length;
  return {
    entries: entries.length,
    generic: count((e) => e.kind === "generic"),
    minimaxSpecific: count((e) => e.kind === "minimax-specific"),
    unmarked: count((e) => e.kind === "unmarked"),
    prNotOpened: count((e) => e.prStatus === "not-opened"),
    prMerged: count((e) => e.prStatus === "merged"),
    prUnrecorded: count((e) => e.prStatus === "unrecorded"),
    withValidation: count((e) => e.hasValidation),
    withNamedTest: count((e) => e.testFiles.length > 0),
  };
}

// ───────────────────────── 二、核对上游 ─────────────────────────

/** 核对的四种结论。台账说“可回馈上游”，只是 MiniMax 自己的判断；上游怎么想，要看上游的代码和讨论。 */
export const VERDICTS = Object.freeze({
  fixed: "上游已修复",
  "still-present": "上游仍是原样",
  partial: "上游只修了一部分",
  "different-design": "上游有意采用另一种做法",
});

/**
 * 在源码文本里找出处：返回第一处匹配的 { line, text }（行号从 1 开始）。
 * 找不到就抛错：结论必须落在真实存在的一行上。
 */
export function findEvidence(sourceText, needle, label = String(needle)) {
  const lines = sourceText.split("\n");
  const index = lines.findIndex((line) => (needle instanceof RegExp ? needle.test(line) : line.includes(needle)));
  if (index < 0) throw new Error(`找不到出处：${label}`);
  return { line: index + 1, text: lines[index].trim() };
}

/**
 * 记录一次核对：台账条目 + 上游版本 + 结论 + 出处（文件和行号）+ 读到的上游讨论。
 * issues 是“某日读到的 Issue 状态”，不是常量：Issue 会重开、会关闭，写进草稿之前要再看一次。
 */
export function upstreamCheck({ entry, upstream, verdict, evidence, issues = [], note = "" }) {
  if (!(verdict in VERDICTS)) throw new Error(`未知结论：${verdict}`);
  if (!evidence?.length || evidence.some((e) => !e.file || !(e.line > 0))) {
    throw new Error("核对结论需要出处：文件和行号");
  }
  return { entry: entry.title, date: entry.date, upstream, verdict, evidence, issues, note };
}

// ───────────────────────── 三、红绿 ─────────────────────────

/**
 * 同一组用例，分别跑在修复前（baseline）和修复后（patched）。
 *   - 至少有一条用例在 baseline 上失败（红）：否则这组测试没有抓住问题；
 *   - 所有用例在 patched 上通过（绿）；
 *   - 在 baseline 上本来就通过的用例是“不退化”用例，照常记录。
 * run(impl, testCase) 通过就正常返回，失败就抛错。
 */
export function redGreen({ cases, baseline, patched, run }) {
  const attempt = (impl, testCase) => {
    try {
      run(impl, testCase);
      return { passed: true, error: "" };
    } catch (error) {
      return { passed: false, error: String(error.message ?? error).split("\n")[0] };
    }
  };
  const rows = cases.map((testCase) => {
    const before = attempt(baseline, testCase);
    const after = attempt(patched, testCase);
    const role = !before.passed && after.passed ? "抓住问题" : before.passed && after.passed ? "不退化" : "失败";
    return { name: testCase.name, before, after, role };
  });
  if (!rows.some((r) => r.role === "抓住问题")) throw new Error("red/green evidence required：没有一条用例在修复前失败");
  const broken = rows.find((r) => !r.after.passed);
  if (broken) throw new Error(`red/green evidence required：修复后仍失败：${broken.name}`);
  return rows;
}

// ───────────────────────── 四、选门禁 ─────────────────────────

/**
 * 改了这些路径，该走哪一档验证、测试放在哪里。
 *   classifyChanges  MiniMax 自己的 scripts/ci-changes.mjs（实验里从固定提交装载）
 *   suiteFiles       test/vitest-suites.json 里登记的全部测试文件
 * 规则来自 CONTRIBUTING.md 和 testing-workflow：只改文档才走 docs 档；其余都跑完整门禁；
 * third_party 下的测试不在任何门禁里，要验证就得有一个 MiniMax 自己登记的测试走到那段代码。
 */
export function verificationPlan(paths, { classifyChanges, suiteFiles }) {
  const { docsOnly } = classifyChanges(paths);
  const vendor = paths.filter((p) => p.startsWith("third_party/"));
  const registered = new Set(suiteFiles);
  const advice = [];
  if (vendor.length) {
    advice.push("third_party 下的测试不在 test/vitest-suites.json 里：需要一个登记过的测试从 MiniMax 自己的入口走到这段代码");
  }
  const tests = paths.filter((p) => /\.test\.(ts|mjs)$/.test(p));
  for (const t of tests.filter((p) => !p.startsWith("third_party/") && !registered.has(p))) {
    advice.push(`新测试 ${t} 要登记到 test/vitest-suites.json，不要写进 package.json`);
  }
  return { profile: docsOnly ? "docs" : "full", docsOnly, vendor, advice };
}

// ───────────────────────── 五、装配材料 ─────────────────────────

/**
 * 把一次调查装配成可审查的材料。保持旧签名：version、commit、symptom、input、before、after、checks、boundary。
 * 缺固定提交、或没有“修复前后行为不同”且检查全部通过的证据，直接拒绝。
 * 新增可选字段：location（根因所在的函数）、rootCause、proposal、notRun（没跑的东西）。
 */
export function investigation({
  version,
  commit,
  symptom,
  input,
  before,
  after,
  checks,
  boundary,
  location = "",
  rootCause = "",
  proposal = "",
  notRun = [],
}) {
  if (!/^[0-9a-f]{40}$/.test(commit) || !symptom || !boundary) throw Error("versioned evidence required");
  if (digest(before) === digest(after) || !checks.length || checks.some((c) => c.passed !== true)) {
    throw Error("red/green evidence required");
  }
  const show = (v) => JSON.stringify(v);
  return {
    title: symptom,
    version,
    commit,
    input,
    before,
    after,
    checks,
    boundary,
    location,
    rootCause,
    proposal,
    notRun,
    status: "local-evidence-only",
    markdown: [
      `## Problem\n${symptom}`,
      `## Reproduction\n${show(input)}`,
      `## Change\nBefore: ${show(before)}\nAfter: ${show(after)}`,
      location && `## Location\n${location}`,
      rootCause && `## Root cause\n${rootCause}`,
      proposal && `## Proposal\n${proposal}`,
      `## Validation\n${checks.map((c) => "- " + c.name).join("\n")}`,
      notRun.length && `## Not run\n${notRun.map((n) => "- " + n).join("\n")}`,
      `## Scope\n${boundary}`,
    ]
      .filter(Boolean)
      .join("\n\n") + "\n",
  };
}

/**
 * 英文 Issue 草稿的骨架，字段对应 Pi 的 bug 模板（What happened / Steps to reproduce / Expected behavior / Version）。
 * 它只放事实：现象、最小复现、位置、已经验证和没有验证的东西。最后一段写你自己的话。
 * 草稿本身永远是 draft：这个函数不联网，也不提交任何东西。
 */
export function issueDraft({ title, version, happened, steps, expected, location, evidence = [], notVerified = [] }) {
  if (!title || !version || !happened || !steps || !expected) throw new Error("issue draft needs title, version, happened, steps and expected");
  return {
    status: "draft",
    title,
    body: [
      `### What happened?\n${happened}`,
      `### Steps to reproduce\n${steps}`,
      `### Expected behavior\n${expected}`,
      location && `### Where\n${location}`,
      evidence.length && `### Evidence\n${evidence.map((e) => "- " + e).join("\n")}`,
      notVerified.length && `### Not verified\n${notVerified.map((n) => "- " + n).join("\n")}`,
      `### Version\n${version}`,
    ]
      .filter(Boolean)
      .join("\n\n") + "\n",
  };
}
