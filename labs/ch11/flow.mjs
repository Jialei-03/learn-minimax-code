// 实验：从一条台账线索走完“复现 → 定位 → 红绿测试 → 补丁 → Issue 草稿”。
// 补丁只存在于临时目录，Issue 草稿只打印，不提交任何东西。
//   node labs/ch11/flow.mjs [repro|trace|redgreen|patch|draft]   不带参数就按顺序全部打印
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { investigation, issueDraft } from "../../host/src/contribution.mjs";
import { LOCK, PI } from "./upstream.mjs";
import { makePatch, markdownTable, reproduceUnsafeInteger, unsafeIntegerChain, unsafeIntegerRedGreen, vitestSnippet } from "./scenarios.mjs";

const only = process.argv[2];
const show = (name) => !only || only === name;

// 1. 复现
const repro = await reproduceUnsafeInteger();
if (show("repro")) {
  console.log("Pi v1.5.0 的真实函数，原样输入：\n");
  console.log(
    markdownTable([
      { 阶段: "模型发出的 id_number（无引号）", 值: repro.sent, 类型: "JSON 数字" },
      { 阶段: "parseToolCallArguments 之后", 值: repro.afterParse, 类型: repro.parsedType },
      { 阶段: "validateToolArguments 之后，工具收到", 值: repro.received, 类型: "string" },
      { 阶段: "对照：模型加了引号", 值: repro.receivedWhenQuoted, 类型: "string" },
    ]),
  );
}

// 2. 定位
if (show("trace")) {
  console.log("参数文本经过的每一站（位置里的行号来自 Pi v1.5.0 的真实文件）：\n");
  console.log(markdownTable(unsafeIntegerChain()));
}

// 3. 红绿
const rows = await unsafeIntegerRedGreen();
if (show("redgreen")) {
  console.log("同一组用例，修复前后各跑一遍：\n");
  console.log(markdownTable(rows.map((r) => ({ 用例: r.name, 修复前: r.before.passed ? "通过" : "失败", 修复后: r.after.passed ? "通过" : "失败", 作用: r.role }))));
  for (const r of rows.filter((x) => !x.before.passed)) console.log(`修复前失败的原因：${r.before.error}`);
}

// 4. 补丁
const temp = mkdtempSync(join(tmpdir(), "mm-patch-"));
const workdir = join(temp, "pi");
mkdirSync(workdir);
let patch;
try {
  patch = makePatch(workdir);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (show("patch")) {
  console.log(`临时仓库里生成的真实 diff：+${patch.added} -${patch.removed} 行；git apply --check 在基线上正向通过、在补丁后反向通过。\n`);
  console.log(patch.diff.trimEnd());
}

// 5. 材料与 Issue 草稿
const report = investigation({
  version: `Pi ${PI.version}`,
  commit: PI.commit,
  symptom: "Unquoted integers beyond Number.MAX_SAFE_INTEGER in tool-call arguments reach string parameters with different digits",
  input: repro.sent,
  before: repro.received,
  after: repro.sent,
  checks: rows.map((r) => ({ name: r.name, passed: r.after.passed })),
  location: "packages/ai/src/utils/json-parse.ts: parseJsonWithRepair, called by parseToolCallArguments",
  rootCause: "JSON.parse rounds the literal to a double; coercePrimitive then calls String() on the rounded number.",
  proposal: "Pass a reviver that keeps unsafe integer literals as their source text (JSON.parse source text access).",
  notRun: ["Bun-compiled binary (build-binaries.yml uses Bun)", "Other providers' stream paths"],
  boundary: "Local reproduction against the pinned Pi checkout; nothing was submitted.",
});
const draft = issueDraft({
  title: "ai: unquoted integers beyond Number.MAX_SAFE_INTEGER in tool-call arguments reach string parameters with different digits",
  version: `Pi ${PI.version} (${PI.commit.slice(0, 7)}), Node 22.19 or newer (the engines range of the package)`,
  happened: `A model sent \`{"id_number": ${repro.sent}}\` with the 18-digit ID unquoted. \`parseToolCallArguments\` returns \`${repro.afterParse}\`, and a \`type: "string"\` parameter receives "${repro.received}".`,
  steps: "```ts\nconst parsed = parseToolCallArguments('{\"id_number\": 440103198004279575}');\nvalidateToolArguments(tool, { name: tool.name, ...parsed }); // tool: id_number is a string\n```",
  expected: `The string parameter receives "${repro.sent}"; integer and number parameters keep the value they get today.`,
  location: report.location,
  evidence: [
    "Related: earendil-works/pi#8943 (closed as not planned). This report adds a trace through v1.5.0 and a regression test.",
    `Test with a reviver that uses JSON.parse source text access: ${rows.filter((r) => r.role === "抓住问题").length} case fails before and passes after; ${rows.filter((r) => r.role === "不退化").length} others pass both times.`,
  ],
  notVerified: report.notRun,
});
if (show("draft")) {
  console.log("status: draft（没有发送，也没有任何联网动作）\n");
  console.log(`Title: ${draft.title}\n`);
  console.log(draft.body);
  console.log("随 Issue 附上的测试（由第一条用例生成）：\n");
  console.log(vitestSnippet());
}

assert.ok(repro.lost);
assert.equal(repro.afterParse, 440103198004279550);
assert.equal(report.status, "local-evidence-only");
assert.equal(draft.status, "draft");
assert.equal(LOCK.version, "0.7.2");
