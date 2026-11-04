// 第 11 章回归实验：把四个小实验（labs/ch11/）的结论都检查一遍。
//   node labs/chapters/11-first-contribution.mjs
import { lesson } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { VERDICTS, findEvidence, investigation, issueDraft, redGreen } from "../../host/src/contribution.mjs";
import { LOCK, PI } from "../ch11/upstream.mjs";
import {
  changePlans,
  classifierDrift,
  gateMatrix,
  ledgerOverview,
  makePatch,
  reproduceFuzzyEdit,
  reproduceUnsafeInteger,
  suiteInventory,
  unsafeIntegerRedGreen,
  upstreamChecks,
} from "../ch11/scenarios.mjs";

await lesson(11, "从台账线索到可审查的材料", async (t) => {
  // 1. 读台账
  const { summary } = ledgerOverview();
  t.log(`台账 ${summary.entries} 条；自认通用 ${summary.generic} 条；写着没开过上游 PR 的 ${summary.prNotOpened} 条。\n`);
  t.ok("台账里多数条目没有开过上游 PR", summary.prNotOpened > summary.entries / 2);

  // 2. 核对上游
  const checks = upstreamChecks();
  t.table(checks.map((c) => ({ 台账条目: c.entry.slice(0, 50), 结论: VERDICTS[c.verdict], 出处: c.evidence.map((e) => `${e.file.split("/").pop()}:${e.line}`).join("；") })));
  t.equal("七条核对的结论", checks.map((c) => c.verdict), ["fixed", "fixed", "still-present", "partial", "different-design", "still-present", "still-present"]);
  t.throws("找不到出处就不能下结论", () => findEvidence("a\nb", "c"), /找不到出处/);

  const drift = await classifierDrift();
  t.table(drift);
  t.equal("MiniMax 的分类器认旧措辞、不认 Pi v1.5.0 的新措辞", drift.map((d) => d.分类结果), ["50113", "null"]);

  // 3. 复现：长整数
  const repro = await reproduceUnsafeInteger();
  t.log(`模型发出 ${repro.sent}，工具收到 ${repro.received}；加了引号则收到 ${repro.receivedWhenQuoted}。\n`);
  t.equal("v1.5.0 里长整数被舍入成另一个数", repro.received, "440103198004279550");
  t.equal("加引号的对照没有被改", repro.receivedWhenQuoted, repro.sent);

  // 4. 红绿 + 补丁
  const rows = await unsafeIntegerRedGreen();
  t.table(rows.map((r) => ({ 用例: r.name, 修复前: r.before.passed ? "通过" : "失败", 修复后: r.after.passed ? "通过" : "失败", 作用: r.role })));
  t.equal("三条用例的作用", rows.map((r) => r.role), ["抓住问题", "不退化", "不退化"]);
  t.throws(
    "一组在修复前就全部通过的用例会被拒绝",
    () => redGreen({ cases: [{ name: "always" }], baseline: {}, patched: {}, run: () => {} }),
    /red\/green evidence required/,
  );
  const workdir = join(t.temp, "pi");
  mkdirSync(workdir);
  const patch = makePatch(workdir);
  t.log(`补丁 +${patch.added} -${patch.removed} 行，git apply --check 双向通过。\n`);
  t.ok("补丁只动一个文件、改动很小", patch.diff.match(/^diff --git/gm).length === 1 && patch.added + patch.removed < 30);

  // 5. 复现：edit 的模糊匹配
  const edits = await reproduceFuzzyEdit();
  t.table(edits);
  t.ok("Pi v1.5.0 把被碰到的行里没被指名的字符也改了", edits[0].被连带改写的字符 !== "无");
  t.equal("内置 Pi 的补丁只替换匹配的片段", edits[1].被连带改写的字符, "无");

  // 6. 门禁
  const matrix = gateMatrix();
  const inventory = suiteInventory();
  const plans = await changePlans();
  t.table(plans.map((p) => ({ 改动: p.name, 验证档: p.plan.profile })));
  t.ok("docs 档比 full 档少门禁", matrix.plans.docs.length < matrix.plans.full.length);
  t.equal("third_party 下没有任何测试登记在门禁里", inventory.vendorFiles, []);
  t.equal("四种改动的验证档", plans.map((p) => p.plan.profile), ["docs", "full", "full", "full"]);

  // 7. 材料
  const input = {
    version: `Pi ${PI.version}`,
    commit: PI.commit,
    symptom: "Unsafe integer in tool arguments loses digits",
    input: repro.sent,
    before: repro.received,
    after: repro.sent,
    checks: rows.map((r) => ({ name: r.name, passed: r.after.passed })),
    boundary: "Local reproduction; nothing submitted.",
    notRun: ["Bun binary"],
  };
  const report = investigation(input);
  t.equal("材料的状态是本地证据", report.status, "local-evidence-only");
  t.ok("材料里写明了没跑的东西", report.markdown.includes("## Not run"));
  t.throws("没有固定提交的材料被拒绝", () => investigation({ ...input, commit: "main" }), /versioned/);
  t.throws("修复前后没有差别的材料被拒绝", () => investigation({ ...input, after: input.before }), /red\/green/);
  t.equal("Issue 草稿永远是草稿", issueDraft({ title: "x", version: "v", happened: "h", steps: "s", expected: "e" }).status, "draft");
  t.ok("清单里的版本固定", LOCK.commit.length === 40);
});
