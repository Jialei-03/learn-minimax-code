// 实验：三个入口在哪里汇合（从固定提交的源码里数出来）。
//   node labs/ch01/entries.mjs
import assert from "node:assert/strict";
import { verifySource } from "../../lab/source.mjs";
import { LOCK, git, isTest, table } from "./scan.mjs";

verifySource();
console.log(`固定提交 ${LOCK.commit.slice(0, 7)}（${LOCK.version}），不含测试。\n`);

// ─── 3. 三个入口在哪里汇合 ─────────────────────────────────────────────────────
const SURFACE = {
  "packages/tui/src/tui/launcher.ts": "`mcode`",
  "packages/tui/src/cli/run-exec-command.ts": "`mcode exec`",
  "packages/tui/src/cli/run-acp-command.ts": "`mcode acp`",
  "packages/tui/src/cli/provider-command.ts": "`mcode provider …`",
  "packages/tui/src/cli/plugin-command.ts": "`mcode plugin …`",
};
const sites = (pattern) => git("grep", "-nE", pattern, LOCK.commit, "--", "packages/tui/src").trim().split("\n").filter(Boolean)
  .map((l) => l.match(/^[0-9a-f]+:([^:]+):(\d+):\s*(.*)$/)).filter(Boolean).map(([, file, line, text]) => ({ file, line, text }))
  .filter((s) => !isTest(s.file));
// 每个命令在创建运行时的那段代码里，写着自己的 surface。
const runtimes = sites("^[[:space:]]+surface: '(tui|headless|acp)',?$").filter((s) => SURFACE[s.file]);
console.log("汇合点一：创建运行时。会跑 Agent、或者要读写本地数据的命令，都走同一个 `createTuiRuntime`，只在 `surface` 上不同：\n");
console.log(table(runtimes.map((s) => ({ 命令: SURFACE[s.file], surface: `\`${s.text.match(/'(\w+)'/)[1]}\``, 位置: `\`${s.file.replace("packages/tui/src/", "")}:${s.line}\`` }))));
console.log();
assert.deepEqual(new Set(runtimes.map((s) => s.file)), new Set(Object.keys(SURFACE)));

const coordinators = sites("new TuiRunCoordinator\\(");
const where = { "packages/tui/src/tui/controller/chat-controller.ts": "tui", "packages/tui/src/headless/runner.ts": "exec", "packages/tui/src/acp/agent.ts": "acp" };
console.log("汇合点二：驱动一次运行。三个入口各自 `new TuiRunCoordinator(...)`，用的是同一个类：\n");
console.log(table(Object.entries(where).map(([file, surface]) => ({ 入口: surface, 位置: coordinators.filter((s) => s.file === file).map((s) => `\`${file.replace("packages/tui/src/", "")}:${s.line}\``).join("、") }))));
assert.deepEqual(new Set(coordinators.map((s) => s.file)), new Set(Object.keys(where)));

// 入口之间的差别，运行时是在哪里读到的？整个 tui 包和 local-runtime-v2 里，拿 surface 和具体取值比较的只有一个文件。
const compared = sites("surface (===|!==) '(tui|headless|acp)'").concat(
  git("grep", "-nE", "surface (===|!==) '(tui|headless|acp)'", LOCK.commit, "--", "packages/local-runtime-v2/src").trim().split("\n").filter(Boolean)
    .map((l) => l.match(/^[0-9a-f]+:([^:]+):(\d+):\s*(.*)$/)).filter(Boolean).map(([, file, line, text]) => ({ file, line, text })).filter((x) => !isTest(x.file)),
);
console.log("\n汇合点之后，入口之间的差别在哪里被读到？整个 `tui` 包和 `local-runtime-v2` 里，拿 `surface` 去比较 `'tui'`、`'headless'`、`'acp'` 的代码只有这些：\n");
console.log(table(compared.map((s) => ({ 位置: `\`${s.file.replace("packages/", "")}:${s.line}\``, 代码: `\`${s.text.replace(/\s+/g, " ")}\`` }))));
assert.ok(compared.length >= 5 && compared.every((s) => s.file === "packages/tui/src/runtime/lifecycle.ts"));

// ─── 4. MiniMax 用了 Pi 的哪些入口 ─────────────────────────────────────────────
// Pi 的 coding-agent 包自带三种运行模式（交互、print、rpc）和 AgentSessionRuntime。
// MiniMax 有自己的入口，所以这些一个都不用，只拿 coding-agent 当工具库。
const piUse = new Map();
for (const line of git("grep", "-hoE", "@earendil-works/pi-coding-agent[/a-z-]*", LOCK.commit, "--", "packages").trim().split("\n")) {
  const sub = line.replace(/^[0-9a-f]+:/, "").replace("@earendil-works/pi-coding-agent", "") || "（根）";
  piUse.set(sub, (piUse.get(sub) ?? 0) + 1);
}
const entryUse = git("grep", "-nE", "runPrintMode|runRpcMode|new InteractiveMode|createAgentSessionRuntime|AgentSessionRuntime", LOCK.commit, "--", "packages").trim().split("\n").filter((l) => l && !isTest(l));
console.log("\nMiniMax 引用 Pi 的 `coding-agent` 包时，用的是这些子路径（出现次数，含测试和注释）：\n");
console.log(table([...piUse].sort((a, b) => b[1] - a[1]).map(([sub, n]) => ({ 子路径: `\`${sub}\``, 次数: n }))));
console.log(`\nPi 的 \`runPrintMode\`、\`runRpcMode\`、\`InteractiveMode\`、\`AgentSessionRuntime\` 在 MiniMax 自己的 packages/ 里出现了 ${entryUse.length} 次。`);
assert.equal(entryUse.length, 0);
