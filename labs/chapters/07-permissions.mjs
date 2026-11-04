// 第 7 章回归实验：权限门与沙箱。
//   node labs/chapters/07-permissions.mjs          读者模式：依次运行五个小实验，打印每张表，再做 host 的兼容检查
//   node labs/chapters/07-permissions.mjs --json   构建模式
// 五个小实验在 labs/ch07/，各回答一个问题；它们自己带断言，任何一个不成立就会抛出。
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lesson } from "./harness.mjs";
import { importSource } from "../../lab/source.mjs";
import {
  absoluteClientPath,
  authorize,
  detectSandboxBackend,
  localCheck,
} from "../../host/src/permissions.mjs";
import { localTools, wrapTool } from "../../host/src/tools.mjs";
import { run as runAsk } from "../ch07/ask.mjs";
import { run as runLadder } from "../ch07/ladder.mjs";
import { run as runModes } from "../ch07/modes.mjs";
import { run as runPaths } from "../ch07/paths.mjs";
import { run as runSandbox } from "../ch07/sandbox.mjs";

await lesson(7, "权限门与沙箱：谁放行，放行之后能做多少", async (t) => {
  // ── 五个小实验 ─────────────────────────────────────────────────────────────
  t.log("【1/5】同一批调用，三种模式\n");
  const modes = await runModes(t.log);
  t.equal("modes：13 种情形都有结果，断言全部成立", modes.rows.length, 13);

  t.log("\n【2/5】规则台阶：真实的 reducePermissionDecision 对账 host\n");
  const ladder = await runLadder(t.log);
  t.equal("ladder：16 个组合 host 与 MiniMax 逐行一致", ladder.rows.length, 16);

  t.log("\n【3/5】一个 ask 怎么交给用户\n");
  const ask = await runAsk(t.log);
  t.equal("ask：七种情形", ask.rows.length, 7);

  t.log("\n【4/5】沙箱\n");
  const sandbox = await runSandbox(t.log);
  t.equal("sandbox：有后端才进沙箱，没后端就拒绝", sandbox.admissionRows[3].结果, "拒绝执行：SANDBOX_UNSUPPORTED_PLATFORM");

  t.log("\n【5/5】路径的三层\n");
  const paths = await runPaths(t.log);
  t.equal("paths：十一个字符串", paths.rows.length, 11);

  // ── host 的兼容与集成 ──────────────────────────────────────────────────────
  t.log("\n【host】导出的 API 与第 4 章流水线的衔接\n");
  const { isTuiAcpAbsolutePath } = await importSource("packages/tui/src/acp/paths.ts");
  const inputs = ["/tmp/a", "C:\\work\\a", "\\\\server\\share", "./relative", "C:relative", "~/a"];
  t.equal("absoluteClientPath 与上游的写法判断一致", inputs.map(absoluteClientPath), inputs.map(isTuiAcpAbsolutePath));
  t.equal(
    "写法上是绝对路径，不等于获得许可",
    authorize({ name: "edit", input: { path: "/tmp/a" } }, {}, { root: t.root, rules: { allow: ["edit"] } }),
    false,
  );

  writeFileSync(join(t.temp, "secret"), "outside");
  symlinkSync(join(t.temp, "secret"), join(t.root, "link"));
  writeFileSync(join(t.root, ".env"), "TOKEN=1");
  writeFileSync(join(t.root, "a.txt"), "old");
  const escaped = { name: "read", input: { path: "link" } };
  t.equal("符号链接越界：bypass-immune", localCheck(escaped, t.root).kind, "bypass-immune");
  t.equal("凭据路径：policy 级", localCheck({ name: "read", input: { path: ".env" } }, t.root).kind, "policy");
  t.equal(
    "allow 规则改不了 bypass-immune",
    authorize(escaped, { readOnly: true }, { root: t.root, rules: { allow: ["read"] }, mode: "bypassPermissions" }),
    false,
  );
  t.equal("没有人可问时，ask 等于拦下", authorize({ name: "edit", input: { path: "a.txt" } }, {}, { root: t.root }), false);

  // 在第 4 章的流水线里：权限门拦下的调用，失败来源是 permission
  const tools = localTools(t.root);
  const call = (name, input) => ({ id: name, name, input });
  const read = tools.find((tool) => tool.name === "read");
  const edit = tools.find((tool) => tool.name === "edit");
  const blocked = await wrapTool(read, { root: t.root })(call("read", { path: ".env" }));
  t.equal("流水线：读 .env 被权限门拦下", [blocked.error, blocked.failure?.blockedBy], [true, "permission"]);
  const allowedRead = await wrapTool(read, { root: t.root }, { rules: { allow: ["read"] } })(call("read", { path: ".env" }));
  t.equal("流水线：用户写过 allow 规则就能读", allowedRead.error, false);
  const edited = await wrapTool(edit, { root: t.root }, { mode: "acceptEdits" })(call("edit", { path: "a.txt", old: "old", next: "new" }));
  t.equal("流水线：acceptEdits 自动接受工作区内的修改", edited.error, false);

  // 沙箱：要求沙箱的 test 工具，有后端就在笼子里跑，没有就拒绝，不退回无隔离执行
  writeFileSync(join(t.root, "ok.cjs"), "console.log('tests passed')");
  const test = tools.find((tool) => tool.name === "test");
  const sandboxed = await wrapTool(test, { root: t.root, sandboxRequired: true }, { rules: { allow: ["test"] } })(
    call("test", { path: "ok.cjs" }),
  );
  if (detectSandboxBackend(t.root)) {
    t.ok("沙箱要求 + 有后端：测试在沙箱里通过", !sandboxed.error && sandboxed.text.includes("tests passed"));
  } else {
    t.ok("沙箱要求 + 没有后端：拒绝执行", sandboxed.error && /sandbox unavailable/.test(sandboxed.text));
  }
  t.observations.sandboxBackend = sandbox.backend ?? null;
});
