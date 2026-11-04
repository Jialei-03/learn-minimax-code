// 实验：分层不是画在文档里的，是 import 语句里数得出来的。
//   node labs/ch01/layers.mjs
// 全部数字都从固定提交的 Git 对象里读出，不看本地的未提交修改。
import assert from "node:assert/strict";
import { readSource, verifySource } from "../../lab/source.mjs";
import { LOCK, git, isTest, table } from "./scan.mjs";

verifySource();

// ─── 1. 谁导入了谁 ──────────────────────────────────────────────────────────────
const LAYERS = [
  { name: "tui", dir: "packages/tui/", pkg: /^@minimax\/code(\/|$)/ },
  { name: "local-runtime-v2", dir: "packages/local-runtime-v2/", pkg: /^@mavis\/local-runtime-v2(\/|$)/ },
  { name: "agent-core", dir: "packages/agent-core/", pkg: /^@mavis\/agent-core(\/|$)/ },
  { name: "pi-agent", dir: "third_party/pi-mono/packages/agent/", pkg: /^@earendil-works\/pi-agent-core(\/|$)/ },
  { name: "pi-ai", dir: "third_party/pi-mono/packages/ai/", pkg: /^@earendil-works\/pi-ai(\/|$)/ },
];
// 找出每个“从包名导入”的语句（单行 `from '...'`，多行导入的结尾行也是这个形状）。
const hits = git("grep", "-nE", "(from|import\\()[[:space:]]*['\"]@(mavis|minimax|earendil-works)/", LOCK.commit, "--", "packages", "third_party/pi-mono/packages")
  .trim()
  .split("\n")
  .map((line) => line.match(/^[0-9a-f]+:([^:]+):\d+:(.*)$/))
  .filter(Boolean)
  .map(([, file, text]) => ({ file, spec: text.match(/['"](@[^'"]+)['"]/)?.[1] }))
  .filter((hit) => hit.spec && !isTest(hit.file));
const edge = new Map(); // "from→to" → 文件集合
for (const hit of hits) {
  const from = LAYERS.find((l) => hit.file.startsWith(l.dir));
  const to = LAYERS.find((l) => l.pkg.test(hit.spec));
  if (!from || !to || from === to) continue;
  const key = `${from.name}→${to.name}`;
  edge.set(key, (edge.get(key) ?? new Set()).add(hit.file));
}
const count = (a, b) => edge.get(`${a}→${b}`)?.size ?? 0;

console.log(`固定提交 ${LOCK.commit.slice(0, 7)}（${LOCK.version}），不含测试。每个格子是“行里的层有多少个文件导入了列里的层”：\n`);
console.log(table(LAYERS.map((row) => Object.fromEntries([["导入方 ↓ / 被导入 →", `**${row.name}**`], ...LAYERS.map((col) => [col.name, row === col ? "·" : count(row.name, col.name)])]))));
console.log();

// 箭头只往下：下面这些“往上”的格子必须是 0。
for (const [upper, lower] of [["tui", "local-runtime-v2"], ["tui", "agent-core"], ["local-runtime-v2", "agent-core"], ["agent-core", "pi-agent"], ["pi-agent", "pi-ai"]]) {
  assert.equal(count(lower, upper), 0, `${lower} 不应该导入 ${upper}`);
}
assert.equal(count("tui", "agent-core"), 0);
assert.equal(count("tui", "pi-agent"), 0);
assert.ok(count("tui", "local-runtime-v2") > 0 && count("local-runtime-v2", "agent-core") > 0);
console.log(`- 入口层 tui 没有任何文件导入 agent-core 或 Pi 的 Agent 包：它想要的一切都得通过 local-runtime-v2。`);
console.log(`- local-runtime-v2 导入 agent-core 的文件有 ${count("local-runtime-v2", "agent-core")} 个，而 agent-core 反过来导入 local-runtime-v2 的是 ${count("agent-core", "local-runtime-v2")} 个。`);
console.log(`- Pi 的两个包不导入任何 MiniMax 的包。\n`);

// ─── 2. 入口认识运行时的哪些东西 ───────────────────────────────────────────────
const tuiFiles = git("grep", "-l", "@mavis/local-runtime-v2", LOCK.commit, "--", "packages/tui/src").trim().split("\n").map((l) => l.replace(/^[0-9a-f]+:/, "")).filter((f) => !isTest(f));
const valueImports = new Map(); // 子路径 → Map(名字 → 文件)
for (const file of tuiFiles) {
  for (const [, isType, spec, from] of readSource(file).matchAll(/import\s+(type\s+)?(\{[^}]*\}|[\w*\s]+)\s+from\s+['"](@mavis\/local-runtime-v2[^'"]*)['"]/g)) {
    if (isType) continue; // import type 只在编译时存在
    for (const name of spec.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))) {
      if (!valueImports.has(from)) valueImports.set(from, new Map());
      valueImports.get(from).set(name, file.replace("packages/tui/src/", ""));
    }
  }
}
console.log(`入口层 tui 有 ${tuiFiles.length} 个文件提到 local-runtime-v2，其中真正在运行时用到的（不是 \`import type\`）只有这些：\n`);
console.log(table([...valueImports].map(([from, names]) => ({
  子路径: `\`${from.replace("@mavis/local-runtime-v2", "") || "（根）"}\``,
  运行时导入: [...names.keys()].map((n) => `\`${n}\``).join("、"),
  所在文件: [...new Set(names.values())].map((f) => `\`${f}\``).join("、"),
}))));
console.log();
assert.ok(valueImports.get("@mavis/local-runtime-v2")?.has("createLocalRuntimeHostV2"));
assert.ok(!valueImports.get("@mavis/local-runtime-v2/cli-service")?.has("CliService"));
console.log("`CliService` 本身只以类型出现（`import type`）：入口通过工厂 `createLocalRuntimeHostV2` 拿到一个实例，之后只调用它的方法。\n");
