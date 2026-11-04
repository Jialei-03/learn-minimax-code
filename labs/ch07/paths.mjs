// 实验：同一个路径字符串，三层各回答什么。
//   node labs/ch07/paths.mjs
//   写法层    ACP 的 isTuiAcpAbsolutePath（真实）：看起来像不像绝对路径，只决定审批卡片上显示不显示“位置”
//   字符串层  权限引擎的 isPathAllowed（真实）：把字符串规整成绝对路径，再和工作区做前缀比较，加上凭据路径的判断
//   物理层    host 的 workspacePath（runtime/files.mjs）：真的去解析符号链接，看最终落在哪个 inode
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../../lab/source.mjs";
import { workspacePath } from "../../runtime/files.mjs";
import { loadFsPermission } from "./upstream.mjs";
import { isMain, markdownTable } from "./scenarios.mjs";

export async function run(log = console.log) {
  const { isTuiAcpAbsolutePath } = await importSource("packages/tui/src/acp/paths.ts");
  const fsPermission = await loadFsPermission();

  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ch07-paths-")));
  const workspace = join(temp, "proj");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "a.ts"), "export {}");
  writeFileSync(join(temp, "outside.txt"), "secret");
  symlinkSync(join(temp, "outside.txt"), join(workspace, "link.txt")); // 工作区里的一个“门”，通向工作区外

  const context = {
    workingDirectory: workspace,
    allowedWorkingPaths: [],
    sandboxAllowPaths: [],
    dataDir: join(temp, "data"),
    homeDir: "/Users/me",
    trustedExactWritePaths: [],
    sessionOwnedReadablePaths: [],
  };

  /** 权限引擎对 read 这个路径的态度，翻成一句话。 */
  function engineVerdict(value) {
    const result = fsPermission.isPathAllowed(value, [], context, "read");
    if (result.allowed) return "放行（工作区内）";
    const { reason } = result;
    if (reason.type === "pathValidation") return `拒绝：${reason.error}`;
    if (reason.type === "workingDirectory") return "询问：越出工作区";
    return `询问：${reason.category ?? reason.type}`;
  }

  /** host 的物理边界。 */
  function physicalVerdict(value) {
    try {
      workspacePath(workspace, value);
      return "在工作区内";
    } catch (error) {
      return `拒绝：${error.message}`;
    }
  }

  const cases = [
    ["a.ts", "工作区里的文件"],
    ["new/dir/file.txt", "还不存在的新文件"],
    [join(workspace, "a.ts"), "绝对路径，在工作区内"],
    ["../outside.txt", "用 .. 爬出去"],
    [join(temp, "outside.txt"), "绝对路径，在工作区外"],
    ["link.txt", "工作区里的符号链接，指向工作区外"],
    [".env", "凭据文件"],
    ["~/.ssh/id_rsa", "家目录里的密钥"],
    ["$HOME/x", "带 shell 变量"],
    ["//srv/share/x", "网络共享"],
    ["C:\\work\\a", "Windows 绝对路径"],
  ].map(([value, 说明]) => ({ value, 说明 }));

  const display = (value) => `\`${value.startsWith(temp) ? value.replace(temp, "…") : value}\``;
  const rows = cases.map(({ value, 说明 }) => ({
    字符串: display(value),
    说明,
    "写法层：像绝对路径吗": isTuiAcpAbsolutePath(value) ? "是" : "否",
    "字符串层：权限引擎": engineVerdict(value),
    "物理层：host": physicalVerdict(value),
  }));

  log("工作区是一个真实的临时目录，里面有 a.ts 和一个指向工作区外的符号链接 link.txt。\n");
  log(markdownTable(rows));

  const row = (说明) => rows.find((r) => r.说明 === 说明);
  // 符号链接：字符串层放行，物理层拦下——这是为什么两层都要有
  assert.equal(row("工作区里的符号链接，指向工作区外")["字符串层：权限引擎"], "放行（工作区内）");
  assert.match(row("工作区里的符号链接，指向工作区外")["物理层：host"], /symlink outside workspace/);
  // 写法层不授予任何东西：Windows 路径“是绝对路径”，但在两个判断层都过不了
  assert.equal(row("Windows 绝对路径")["写法层：像绝对路径吗"], "是");
  assert.notEqual(row("Windows 绝对路径")["物理层：host"], "在工作区内");
  assert.equal(row("绝对路径，在工作区外")["写法层：像绝对路径吗"], "是");
  assert.equal(row("绝对路径，在工作区内")["物理层：host"], "在工作区内");
  assert.equal(row("还不存在的新文件")["物理层：host"], "在工作区内");
  assert.match(row("用 .. 爬出去")["字符串层：权限引擎"], /^拒绝：Path traversal/);
  assert.match(row("网络共享")["字符串层：权限引擎"], /^拒绝：UNC/);

  rmSync(temp, { recursive: true, force: true });
  return { rows };
}

if (isMain(import.meta.url)) await run();
