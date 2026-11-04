// 实验：沙箱的四个问题——默认是什么、策略怎么算、没有后端时怎么办、这台机器上真的能拦住吗。
//   node labs/ch07/sandbox.mjs            全部
//   node labs/ch07/sandbox.mjs defaults   默认值与归一化
//   node labs/ch07/sandbox.mjs policy     四种文件系统模式编译出的策略
//   node labs/ch07/sandbox.mjs admission  后端选择与准入
//   node labs/ch07/sandbox.mjs machine    在这台机器上真的试一次
// 真实运行（固定提交里的原文）：getDefaultSandboxSettings / normalizeSandboxSettings、
//   compileSandboxEffectivePolicy / withReadOnlyFilesystem、selectSandboxBackendCandidate。
// host 的 normalizeSandbox / sandboxPolicy / admitSandbox 和它们逐项对账。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import { admitSandbox, detectSandboxBackend, normalizeSandbox, sandboxPolicy } from "../../host/src/permissions.mjs";
import { runSandboxed } from "../../runtime/sandbox.mjs";
import { isMain, markdownTable } from "./scenarios.mjs";

export async function run(log = console.log, part) {
  /** 只有被选中的部分才打印；断言不管选没选都要跑。 */
  const printer = (name) => (text = "") => (part === undefined || part === name) && log(text);
  const defaultsOut = printer("defaults");
  const policyOut = printer("policy");
  const admissionOut = printer("admission");
  const machineOut = printer("machine");

  const settingsModule = await importSource("packages/config/src/sandbox-settings.ts");
  const policyModule = await importSource("packages/local-runtime-v2/src/service/sandbox/effective-policy.ts");
  const selectorModule = await importSource("packages/local-runtime-v2/src/service/sandbox/backend/selector.ts");
  const { isSandboxError } = await importSource("packages/local-runtime-v2/src/service/sandbox/sandbox-errors.ts");

  // ── 1. 默认值与归一化 ─────────────────────────────────────────────────────────
  defaultsOut("**默认值：所有平台都一样**\n");
  defaultsOut(markdownTable(["darwin", "linux", "win32"].map((platform) => {
    const defaults = settingsModule.getDefaultSandboxSettings(platform);
    return { 平台: platform, enabled: defaults.enabled, 文件系统模式: defaults.filesystemMode };
  })));

  defaultsOut("\n**归一化：写进配置的值，和实际生效的值**\n");
  const inputs = [
    { enabled: false, filesystemMode: "workspace_write" },
    { enabled: true, filesystemMode: "full_access" },
    { enabled: true, filesystemMode: "workspace_write" },
    { enabled: true, filesystemMode: "delete_guard" },
    { enabled: true, filesystemMode: "read_only" },
  ];
  defaultsOut(markdownTable(inputs.map((input) => {
    const real = settingsModule.normalizeSandboxSettings(input);
    const mine = normalizeSandbox({ enabled: input.enabled, mode: input.filesystemMode });
    assert.deepEqual({ enabled: mine.enabled, mode: mine.mode }, { enabled: real.enabled, mode: real.filesystemMode });
    return {
      配置: `enabled=${input.enabled}，${input.filesystemMode}`,
      "实际生效（MiniMax）": real.enabled ? `开启，${real.filesystemMode}` : "没有沙箱",
      "host 的 normalizeSandbox 一致": "是",
    };
  })));

  // ── 2. 有效策略 ───────────────────────────────────────────────────────────────
  const configFor = (mode) => ({
    enabled: true,
    filesystem: { policy: { mode }, denyRead: [], denyWrite: [] },
    network: { policy: { mode: "allow_all" }, deniedDomains: [] },
    localAccess: "open",
  });
  policyOut("**四种文件系统模式编译出的策略**（位置是符号，每次调用才解析成真实路径）\n");
  const modes = ["read_only", "workspace_write", "delete_guard", "full_access"];
  policyOut(markdownTable(modes.map((mode) => {
    const real = policyModule.compileSandboxEffectivePolicy(configFor(mode));
    const mine = sandboxPolicy({ enabled: true, mode });
    assert.deepEqual(mine.allowWrite, real.filesystem.allowWrite);
    assert.deepEqual(mine.unlinkAllowOnly, real.filesystem.unlinkAllowOnly);
    assert.equal(real.network.enforce, false);
    return {
      模式: `\`${mode}\``,
      "能写": real.filesystem.allowWrite.join("、"),
      "能删": real.filesystem.unlinkAllowOnly.join("、"),
      "网络是否限制": real.network.enforce ? "是" : "否",
    };
  })));
  const narrowed = policyModule.withReadOnlyFilesystem(
    policyModule.compileSandboxEffectivePolicy(configFor("workspace_write")),
  );
  policyOut(
    `\n只读子 Agent（如 explore）的 bash：全局是 workspace_write，这一次调用收窄成 ${narrowed.filesystem.mode}，` +
      `能写 ${narrowed.filesystem.allowWrite.join("、")}。`,
  );
  assert.equal(narrowed.filesystem.mode, "read_only");
  assert.deepEqual(
    narrowed.filesystem.allowWrite,
    sandboxPolicy({ enabled: true, mode: "workspace_write" }, { readOnly: true }).allowWrite,
  );

  // ── 3. 后端选择与准入 ─────────────────────────────────────────────────────────
  admissionOut("**后端：只有一个描述符（srt-macos，darwin），其他平台选不到**\n");
  admissionOut("描述符照 initialize.ts 里的 SRT_MACOS_BACKEND_DESCRIPTOR 写，create 换成空壳；选择逻辑是真实的 selectSandboxBackendCandidate。\n");
  const descriptor = { id: "srt-macos", platform: "darwin", priority: 100, create: () => ({ id: "srt-macos" }) };
  const selectionRows = ["darwin", "linux", "win32"].map((platform) => {
    try {
      const backend = selectorModule.selectSandboxBackendCandidate({ descriptors: [descriptor], platform });
      return { 平台: platform, 选择结果: `后端 ${backend.id}`, 错误码: "—" };
    } catch (error) {
      assert.ok(isSandboxError(error));
      return { 平台: platform, 选择结果: "选不到后端", 错误码: error.code };
    }
  });
  admissionOut(markdownTable(selectionRows));
  assert.equal(selectionRows[0].选择结果, "后端 srt-macos");
  assert.equal(selectionRows[1].错误码, "SANDBOX_UNSUPPORTED_PLATFORM");

  admissionOut("\n**host 的准入：开了沙箱却没有后端，是拒绝，不是悄悄退回无隔离执行**\n");
  const admission = (settings, backend) => {
    try {
      const result = admitSandbox(settings, { backend });
      return result.execution === "native" ? "原生执行（没开沙箱）" : `进沙箱（${result.backend}）`;
    } catch (error) {
      return `拒绝执行：${error.code}`;
    }
  };
  const admissionRows = [
    { 配置: "默认（没开）", 后端: "—", 结果: admission(undefined, undefined) },
    { 配置: "没开", 后端: "seatbelt", 结果: admission({ enabled: false, mode: "workspace_write" }, "seatbelt") },
    { 配置: "开启 workspace_write", 后端: "seatbelt", 结果: admission({ enabled: true, mode: "workspace_write" }, "seatbelt") },
    { 配置: "开启 workspace_write", 后端: "—", 结果: admission({ enabled: true, mode: "workspace_write" }, undefined) },
    { 配置: "开启 full_access", 后端: "—", 结果: admission({ enabled: true, mode: "full_access" }, undefined) },
  ];
  admissionOut(markdownTable(admissionRows));
  assert.equal(admissionRows[0].结果, "原生执行（没开沙箱）");
  assert.equal(admissionRows[3].结果, "拒绝执行：SANDBOX_UNSUPPORTED_PLATFORM");
  assert.equal(admissionRows[4].结果, "原生执行（没开沙箱）"); // full_access 等于没有沙箱

  // ── 4. 这台机器上真的试一次 ───────────────────────────────────────────────────
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch07-sandbox-")));
  const workspace = join(temp, "proj");
  mkdirSync(workspace);
  const outside = join(temp, "outside.txt");
  const linkTarget = join(temp, "outside-via-link.txt");
  writeFileSync(
    join(workspace, "write.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
      `try { writeFileSync(process.argv[2], "x"); console.log("wrote"); }\n` +
      `catch (error) { console.log(error.code); }\n`,
  );
  symlinkSync(linkTarget, join(workspace, "link.txt")); // 工作区里的一个“门”，通向工作区外

  const backend = detectSandboxBackend(workspace);
  machineOut(`**这台机器上的后端：${backend ?? "没有"}**\n`);
  const attempt = async (file) => {
    const result = await runSandboxed(workspace, process.execPath, [join(workspace, "write.mjs"), file]);
    return result.code === 0 ? result.stdout.trim() : `进程失败（${result.code}）`;
  };
  if (!backend) {
    await assert.rejects(
      runSandboxed(workspace, process.execPath, [join(workspace, "write.mjs"), outside]),
      /sandbox unavailable/,
    );
    machineOut("没有可用的后端：`runSandboxed` 直接抛出 `sandbox unavailable: refusing unsandboxed fallback`，脚本一行都没有执行。");
  } else {
    const rows = [];
    const tries = [
      ["写工作区里的文件 `proj/out.txt`", join(workspace, "out.txt"), "wrote"],
      ["写工作区外的文件 `outside.txt`", outside, "EPERM"],
      ["写工作区里的符号链接 `proj/link.txt`（指向工作区外）", join(workspace, "link.txt"), "EPERM"],
    ];
    for (const [what, file, expected] of tries) {
      const outcome = await attempt(file);
      if (outcome !== "wrote" && outcome !== "EPERM") {
        machineOut(`后端 ${backend} 在这里不可用（${outcome}），跳过强制性检查。`);
        rows.length = 0;
        break;
      }
      assert.equal(outcome, expected, what);
      rows.push({
        动作: what,
        沙箱里的结果: outcome === "wrote" ? "写成功" : "内核拒绝（EPERM）",
        磁盘上有这个文件: existsSync(file.endsWith("link.txt") ? linkTarget : file) ? "有" : "没有",
      });
    }
    if (rows.length) machineOut(markdownTable(rows));
  }
  rmSync(temp, { recursive: true, force: true });
  return { backend, admissionRows, selectionRows };
}

if (isMain(import.meta.url)) await run(console.log, process.argv[2]);
