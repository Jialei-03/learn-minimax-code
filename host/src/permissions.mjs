// 第 7 章：权限与沙箱。
//
// 对应 MiniMax Code 0.7.2 的这几处：
//   local-runtime-v2/.../runner/policy/local-turn-permission-gate.ts   权限门：挂在 Pi 的 beforeToolCall 链上，
//                                                                       决定“放行 / 拦下 / 去问用户”
//   local-runtime/src/permissions/checkers.ts                           evaluateLocalPermissionCheck：本地硬检查
//   local-runtime/src/permissions/facade.ts                             checkPermissionRaw：硬检查 → 引擎 → 模式
//   agent-modules/permission/src/permission-core.ts                     reducePermissionDecision：规则台阶
//   agent-modules/permission/src/ask-policy.ts + permissions/ask-gate.ts  模式怎样处置“要问用户”
//   local-runtime/src/api/local-permission-approval-service.ts         审批：交给用户、收回复、落规则
//   local-runtime-v2/src/service/sandbox/                               沙箱：有效策略、准入、没有后端时不降级
//
// 本文件分四块：
//   1. 路径的三个问题   absoluteClientPath（写法）、localCheck（硬边界）；“是不是工作区内的真实路径”由
//                      runtime/files.mjs 的 workspacePath 回答
//   2. 一次调用的决定   decide（台阶）、authorize（没有人可问时的布尔结果，tools.mjs 在用）
//   3. 去问用户         askUser、addRule
//   4. 沙箱            normalizeSandbox、sandboxPolicy、admitSandbox、sandboxTool
//
// 简化：
//   - MiniMax 的规则是 `工具(内容)`（bash 命令前缀、路径 glob……）；这里只有整工具规则 `{ allow, ask, deny }`。
//   - MiniMax 的 bash 检查器会拆命令、识别 rm 改写成回收站；host 没有 bash 工具，本地硬检查只看路径参数。
//   - MiniMax 的 `auto` 模式会请云端分类器，不可用时退回询问；host 没有这个模式。
//   - host 的工具没有被沙箱包着（沙箱只管 `test` 工具启动的子进程），所以越出工作区的路径在这里是硬边界；
//     MiniMax 里越界只是“问一下”，物理边界靠沙箱。
import path from "node:path";
import { workspacePath } from "../../runtime/files.mjs";
import { runSandboxed, sandboxCommand } from "../../runtime/sandbox.mjs";

// ═══ 1. 路径的三个问题 ═══════════════════════════════════════════════════════

/**
 * 这个字符串“写得像不像绝对路径”（POSIX 或 Windows 写法都算）。
 *
 * 只看字符串的形状：不碰文件系统，不判断在不在工作区，更不授予任何权限。
 * MiniMax 里同名角色是 ACP 的 `isTuiAcpAbsolutePath`：它决定审批卡片上哪些路径能作为“位置”交给编辑器显示，
 * 别的什么也不决定。
 */
export const absoluteClientPath = (value) =>
  typeof value === "string" &&
  (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));

/** 模型传来的路径参数（MiniMax 的 readFsToolPath 接受这三种写法）。 */
const pathArgument = (input) => input?.path ?? input?.filePath ?? input?.file_path;

/** `//server/share`、`\\server\share`：网络共享。光看写法就认得出来。 */
const NETWORK_SHARE = /^(?:\\\\(?!\?\\)[^\\/\s]+[\\/][^\\/\s]+|\/\/[^/\s]+\/[^/\s]+)/;

/** 凭据类路径（MiniMax 的 SENSITIVE_LOCAL_PATHS 里最有代表性的几条）。 */
const CREDENTIAL_PATHS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

/**
 * 本地硬检查，对应 `evaluateLocalPermissionCheck`。返回 undefined 表示“本检查没有意见”，
 * 不表示放行：后面还有规则和模式。
 *
 * 结果的 kind 决定后面怎么处置，这是整章最重要的区别：
 *   bypass-immune  任何模式、任何规则都改不了的拒绝（MiniMax：网络共享、递归删除根目录和家目录）。
 *   policy         产品策略级的拒绝（MiniMax：凭据路径、web_fetch）。`decide` 会把它降成“问用户”，
 *                  用户明确写过的 allow 规则和“完全访问”模式可以越过它。
 */
export function localCheck(call, root) {
  const target = pathArgument(call.input);
  if (typeof target === "string") {
    if (NETWORK_SHARE.test(target)) {
      return { behavior: "deny", kind: "bypass-immune", reason: `不支持直接访问网络共享：${target}` };
    }
    try {
      workspacePath(root, target); // 物理边界：.. 越界、符号链接指到工作区外，都会抛错
    } catch (error) {
      return { behavior: "deny", kind: "bypass-immune", reason: `路径越出工作区（${error.message}）：${target}` };
    }
    if (CREDENTIAL_PATHS.some((pattern) => pattern.test(target))) {
      return { behavior: "deny", kind: "policy", reason: `凭据路径：${target}` };
    }
  }
  if (call.name === "network") {
    return { behavior: "deny", kind: "policy", reason: "网络访问会把这台机器的网络环境暴露给请求目标" };
  }
  return undefined;
}

// ═══ 2. 一次调用的决定 ═══════════════════════════════════════════════════════

const verdict = (behavior, stage, reason) => ({ behavior, stage, reason });

/**
 * 规则台阶，对应 `reducePermissionDecision` 的缩小版。从上往下，第一个说话的台阶决定结果：
 *   整工具 deny  >  整工具 ask  >  bypass 模式  >  整工具 allow  >  工具自己说没有副作用  >  acceptEdits  >  兜底：问
 * deny 在最前面：后面不管有什么规则或模式，都翻不了它。
 */
function applyRules(tool, definition, rules, mode) {
  if (rules.deny?.includes(tool)) return verdict("deny", "deny-rule", `规则禁止 ${tool}`);
  if (rules.ask?.includes(tool)) return verdict("ask", "ask-rule", `规则要求每次确认 ${tool}`);
  if (mode === "bypassPermissions") return verdict("allow", "bypass-mode", "完全访问模式");
  if (rules.allow?.includes(tool)) return verdict("allow", "allow-rule", `规则允许 ${tool}`);
  if (definition.readOnly) return verdict("allow", "tool-check", "工具声明了只读");
  if (mode === "acceptEdits" && ["edit", "write"].includes(tool)) {
    return verdict("allow", "accept-edits", "acceptEdits：自动接受文件修改");
  }
  return verdict("ask", "fallback", `没有规则匹配 ${tool}`);
}

/**
 * 一次工具调用的决定：{ behavior: "allow" | "ask" | "deny", stage, reason }。
 * 对应 `LocalPermissionFacade.checkPermissionRaw` 加上 `applyAskGate`，顺序就是安全策略：
 *
 *   ① 本地硬检查里的 bypass-immune        任何模式都拒绝
 *   ② off 模式                           其余一律放行（MiniMax：`--permission off`）
 *   ③ 规则台阶 applyRules
 *   ④ policy 级拒绝降成询问               ③ 给的 allow 不是用户写的规则、也不在完全访问模式时，改成 ask
 *   ⑤ 完全访问模式下，ask 变 allow          deny 保持不变（MiniMax 的 ask 闸门）
 *
 * `acceptEdits` 只是 `default` 加上“edit / write 自动放行”，台阶里没有第二套逻辑。
 */
export function decide(call, definition = {}, { root, rules = {}, mode = "default" } = {}) {
  const local = localCheck(call, root);
  if (local?.kind === "bypass-immune") return verdict("deny", "bypass-immune", local.reason);
  if (mode === "off") return verdict("allow", "mode-off", "off 模式：跳过权限检查");

  let decision = applyRules(call.name, definition, rules, mode);
  if (
    local?.kind === "policy" &&
    decision.behavior === "allow" &&
    decision.stage !== "allow-rule" &&
    mode !== "bypassPermissions"
  ) {
    decision = verdict("ask", "policy-demoted", local.reason);
  }
  if (decision.behavior === "ask" && mode === "bypassPermissions") {
    return verdict("allow", "ask-gate", `完全访问模式免去了确认（原因：${decision.reason}）`);
  }
  return decision;
}

/**
 * 工具调用能不能直接执行。tools.mjs 的流水线在 Hook 之后调用它。
 *
 * 这里的“问”没有人回答：host 的 wrapTool 没有审批通道，和 `mcode exec` 一样——
 * MiniMax 的 headless 宿主没有 `permissionPrompt` 能力，要问的调用一律拦下。
 * 所以 ask 返回 false，和 deny 一样；需要的操作应该提前写进 allow 规则。
 */
export function authorize(call, definition, options) {
  return decide(call, definition, options).behavior === "allow";
}

// ═══ 3. 去问用户 ═════════════════════════════════════════════════════════════

const REPLIES = new Set(["allowOnce", "allowAlways", "deny"]);

/**
 * 把一个 ask 交给用户，对应 `LocalTurnPermissionGate.requestApproval` 和 `LocalPermissionApprovalService.reply`。
 *
 *   approve({ tool, input, reason, signal })   审批通道：TUI 的选择框、ACP 的 requestPermission……
 *                                              返回 "allowOnce" | "allowAlways" | "deny"
 *
 * 各种不顺利的情况都往“不执行”这边倒：
 *   没有审批通道          抛 HOST_CAPABILITY_UNAVAILABLE，调用被拦下（exec 这样的 headless 宿主）
 *   通道出错、信号已取消    当作 deny，但这不是用户的决定，不落规则（ACP 的 handlePermission：catch 之后 decision = 'deny'）
 *   回复不是三个合法值之一   抛错，调用被拦下（validateApprovalDecision）
 *
 * 返回 { allowed, reply, rule }。用户的回复会落成一条规则：allowOnce 是会话级 allow，allowAlways 是全局 allow，
 * deny 是会话级 deny（MiniMax 的 reply 就是这样写的），用 `addRule` 合并进 rules。
 */
export async function askUser(decision, call, { approve, signal } = {}) {
  if (typeof approve !== "function") {
    throw Error("HOST_CAPABILITY_UNAVAILABLE: this host cannot prompt for permission.");
  }
  let reply;
  let fromUser = true;
  try {
    signal?.throwIfAborted();
    reply = await approve({ tool: call.name, input: call.input, reason: decision.reason, signal });
  } catch {
    reply = "deny";
    fromUser = false;
  }
  if (!REPLIES.has(reply)) throw TypeError("approval owner returned an invalid decision");
  const rule = fromUser
    ? {
        tool: call.name,
        behavior: reply === "deny" ? "deny" : "allow",
        scope: reply === "allowAlways" ? "global" : "session",
      }
    : undefined;
  return { allowed: reply !== "deny", reply, rule };
}

/** 把 askUser 返回的规则合并进规则表（不修改原对象）。 */
export function addRule(rules, rule) {
  if (!rule) return rules;
  const { tool, behavior } = rule;
  const list = rules[behavior] ?? [];
  return { ...rules, [behavior]: list.includes(tool) ? list : [...list, tool] };
}

// ═══ 4. 沙箱 ═════════════════════════════════════════════════════════════════

/** 默认不开沙箱、完全访问（对应 getDefaultSandboxSettings：所有平台都一样）。 */
export const SANDBOX_DEFAULTS = Object.freeze({ enabled: false, mode: "full_access" });

/**
 * 对应 `normalizeSandboxSettings`：没开，或者模式是 full_access，都等于没有沙箱。
 * 配置里写了 `enabled: true` + `full_access`，实际生效的仍是“不隔离”，不会有一个半开的状态。
 */
export function normalizeSandbox(settings = {}) {
  const { enabled = SANDBOX_DEFAULTS.enabled, mode = SANDBOX_DEFAULTS.mode } = settings;
  return !enabled || mode === "full_access" ? { ...SANDBOX_DEFAULTS } : { enabled, mode };
}

/**
 * 四种文件系统模式各自能写、能删哪些“位置”，对应 `compileSandboxEffectivePolicy` 里的 compileFilesystemScopes。
 * 位置是符号，不是路径（workspace、session-temp……）；每次调用才解析成真实路径，所以策略可以提前算好。
 * 写和删是两个独立的范围：delete_guard 能写整个宿主，却只能删工作区里的东西；
 * workspace_write 额外开了回收站这个“只写不删”的目的地，否则“删除可恢复”在笼子里做不到。
 */
const FILESYSTEM_SCOPES = {
  read_only: { allowWrite: ["session-temp"], unlinkAllowOnly: ["session-temp"] },
  workspace_write: {
    allowWrite: ["workspace", "git-dir", "common-dir", "session-temp", "trash"],
    unlinkAllowOnly: ["workspace", "git-dir", "common-dir", "session-temp"],
  },
  delete_guard: {
    allowWrite: ["host-root"],
    unlinkAllowOnly: ["workspace", "git-dir", "common-dir", "session-temp"],
  },
  full_access: { allowWrite: ["host-root"], unlinkAllowOnly: ["host-root"] },
};

/**
 * 有效策略：把配置编译成每次调用都能直接用的形状。
 * `readOnly: true` 只收窄这一次调用（MiniMax 里 explore 这类只读子 Agent 的 bash），不改全局配置。
 */
export function sandboxPolicy(settings, { readOnly = false } = {}) {
  const { enabled, mode } = normalizeSandbox(settings);
  const scopes = FILESYSTEM_SCOPES[readOnly ? "read_only" : mode];
  if (!scopes) throw Error(`unknown sandbox mode: ${mode}`);
  return { enabled, mode: readOnly ? "read_only" : mode, ...structuredClone(scopes) };
}

/** 这台机器上有没有可用的沙箱后端：macOS 的 seatbelt、装了 bwrap 的 Linux；否则 undefined。 */
export const detectSandboxBackend = (root) => sandboxCommand(root, process.execPath, [])?.backend;

/**
 * 一次调用要不要进沙箱，对应 `LocalSandboxService.beginInvocation` 的准入：
 *   没开 → 原生执行；开了 → 必须有后端，没有就抛错，**绝不悄悄退回无隔离执行**。
 * 开着沙箱却在没有后端的平台上跑，拒绝执行比假装隔离了好：用户以为有笼子，其实没有。
 */
export function admitSandbox(settings, { backend, readOnly = false } = {}) {
  const normalized = normalizeSandbox(settings);
  if (!normalized.enabled) return { execution: "native", reason: "沙箱没有开启" };
  if (!backend) {
    throw Object.assign(Error("sandbox enabled but no backend on this platform: refusing unsandboxed fallback"), {
      code: "SANDBOX_UNSUPPORTED_PLATFORM",
    });
  }
  return { execution: "sandboxed", backend, policy: sandboxPolicy(normalized, { readOnly }) };
}

/** 在沙箱里运行工作区里的一个 Node 脚本（`test` 工具的 sandboxRequired 走的就是这条路）。 */
export function sandboxTool(root, file) {
  return runSandboxed(root, process.execPath, [workspacePath(root, file)]);
}
