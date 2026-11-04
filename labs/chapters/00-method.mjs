// 第 0 章：给 MiniMax Code 的源码做一次“体检”。
//   node labs/chapters/00-method.mjs
// 统计固定提交里每一层有多少代码、Pi 内核占多少，以及 MiniMax 给 Pi 打了多少本地补丁。
// 所有数字都从固定提交的 Git 对象读出（不受本地未提交修改影响）。
import { execFileSync } from "node:child_process";
import { lesson } from "./harness.mjs";
import { verifySource, readSource, LOCK, SOURCE } from "../../lab/source.mjs";
import { workspacePath } from "../../runtime/files.mjs";

// 按 docs/architecture.md 的分层，把包归到六层里
const LAYERS = [
  ["入口与协议", ["packages/tui", "packages/code-sdk", "packages/protocol"]],
  ["应用与服务", ["packages/local-runtime-v2", "packages/local-runtime"]],
  ["Agent 层", ["packages/agent-core", "packages/agent-tools", "packages/agent-modules", "packages/agent-extension", "packages/agent-runtime"]],
  ["基础设施", ["packages/shared", "packages/config", "packages/oauth-core", "packages/oauth-lease-protocol", "packages/mcode-tools-host", "packages/browser-core"]],
  ["Pi 内核（third_party/pi-mono）", ["third_party/pi-mono"]],
  ["沙箱（third_party/sandbox-runtime）", ["third_party/sandbox-runtime"]],
];

await lesson(0, "MiniMax Code 的源码体检", async (t) => {
  verifySource();
  t.equal("源码固定在课程版本", JSON.parse(readSource("package.json")).version, LOCK.version);

  // ── 1. 每一层多少行（不含测试） ───────────────────────────────
  const counts = execFileSync("git", ["-C", SOURCE, "grep", "-c", "", LOCK.commit, "--", "*.ts", "*.tsx", ":!*.test.ts", ":!*.test.tsx", ":!**/test/**", ":!**/tests/**"], { encoding: "utf8", maxBuffer: 16e6 })
    .trim().split("\n").map((line) => {
      const [, file, n] = line.match(/^[0-9a-f]+:(.+):(\d+)$/);
      return { file, lines: Number(n) };
    });
  const lineOf = (prefix) => counts.filter((c) => c.file.startsWith(prefix + "/")).reduce((sum, c) => sum + c.lines, 0);
  const rows = LAYERS.map(([layer, prefixes]) => ({ 层: layer, 包: prefixes.map((p) => p.split("/").pop()).join("、"), 行数: prefixes.reduce((s, p) => s + lineOf(p), 0) }));
  const total = rows.reduce((s, r) => s + r.行数, 0);
  t.log(`固定提交 ${LOCK.commit.slice(0, 7)}（${LOCK.version}）里的 TypeScript 代码，不含测试，约 ${Math.round(total / 1000)}k 行：`);
  t.table(rows.map((r) => ({ ...r, 行数: r.行数.toLocaleString("en-US"), 占比: `${Math.round((r.行数 / total) * 100)}%` })));

  const agentKernel = lineOf("third_party/pi-mono/packages/agent");
  t.log(`其中 Pi 的 Agent 循环包（pi-agent-core）只有 ${agentKernel.toLocaleString("en-US")} 行，占全部代码的 ${((agentKernel / total) * 100).toFixed(1)}%。`);
  t.log("");
  t.ok("Pi 的循环只占很小一部分", agentKernel / total < 0.03);

  // ── 2. 内置的 Pi 是哪个版本 ─────────────────────────────────
  const piPackage = JSON.parse(readSource("third_party/pi-mono/packages/agent/package.json"));
  const ledger = readSource("third_party/pi-mono/MINIMAX_CHANGES.md");
  const baseline = ledger.match(/Ref: `([^`]+)`/)?.[1];
  t.log(`内置的 Pi：${piPackage.name}@${piPackage.version}（导入基线 ${baseline}）。Learn Pi Agent 读的是 v1.5.0，两者不是同一个版本。`);
  t.log("");
  t.ok("内置 Pi 的版本有记录", Boolean(baseline));

  // ── 3. MiniMax 给 Pi 打了多少补丁 ─────────────────────────────
  const entries = ledger.split(/\n### /).slice(1).map((block) => ({
    title: block.split("\n")[0],
    pkg: block.match(/packages\/(ai|agent|coding-agent|tui)\b/)?.[1] ?? block.match(/pi-(ai|agent-core|coding-agent|tui)/)?.[1]?.replace("agent-core", "agent") ?? "其他",
    upstreamable: /upstreamable/i.test(block),
    prOpened: !/Upstream PR: not opened/.test(block),
  }));
  const byPackage = new Map();
  for (const e of entries) byPackage.set(e.pkg, (byPackage.get(e.pkg) ?? 0) + 1);
  t.log(`MINIMAX_CHANGES.md 记录了 ${entries.length} 个本地补丁，按改动的 Pi 包分：`);
  t.table([...byPackage.entries()].sort((a, b) => b[1] - a[1]).map(([pkg, n]) => ({ "Pi 包": pkg, 补丁数: n })));
  t.log(`其中 ${entries.filter((e) => e.upstreamable).length} 个自称“可以回馈上游”（upstreamable），写着 “Upstream PR: not opened” 的有 ${entries.filter((e) => !e.prOpened).length} 个。几个例子：`);
  t.table(entries.filter((e) => e.upstreamable).slice(0, 5).map((e) => ({ 补丁: e.title })));
  t.ok("补丁台账不为空", entries.length > 20);

  // ── 4. host 的底线：文件路径不能逃出工作区 ───────────────────────
  t.throws("host 拒绝越出工作区的路径", () => workspacePath(t.root, "../outside"), /outside/);

  t.observations = { version: LOCK.version, commit: LOCK.commit, total, layers: rows, piVersion: piPackage.version, patches: entries.length };
});
