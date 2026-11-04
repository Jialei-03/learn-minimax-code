// 第 7 章实验的公共部分：把 MiniMax 的真实权限代码装起来，加上 facade 里那几行“胶水”。
//
// 真实运行的（固定提交 6e062ae，labs/ch07/upstream.mjs 和 lab/source.mjs 装载，原文不改）：
//   - PermissionEngine + registerDefaultCheckers   规则台阶、bash 检查器、文件检查器
//   - evaluateLocalPermissionCheck                 facade 调用的本地硬检查
//   - modeToAskPolicy、applyAskGate                模式怎样处置“要问用户”
// 转写的只有 facade.checkPermissionRaw 里把它们串起来的十几行（facade 依赖整个运行时，没法单独装载）。
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importSource } from "../../lab/source.mjs";
import {
  loadCloudClassify,
  loadDefaultCheckers,
  loadLocalChecks,
  loadPermissionContext,
  loadPermissionEngine,
} from "./upstream.mjs";

export const WORKSPACE = "/Users/me/proj";
const HOME = "/Users/me";

/** 这个文件是不是被直接运行的（`node labs/ch07/xxx.mjs`），而不是被别的实验 import。 */
export const isMain = (url) => process.argv[1] !== undefined && url === pathToFileURL(resolve(process.argv[1])).href;

/** Markdown 表格（读者模式和网页嵌入用同一份输出）。 */
export function markdownTable(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${keys.join(" | ")} |`,
    `| ${keys.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(" | ")} |`),
  ].join("\n");
}

/** 用户写的规则，形状和规则库里存的一样。 */
export const rule = (ruleBehavior, toolName, ruleContent) => ({
  source: "global",
  ruleBehavior,
  ruleValue: { toolName, ...(ruleContent ? { ruleContent } : {}) },
});

const BEHAVIOR = { allow: "放行", ask: "询问", deny: "拒绝" };
export const label = (behavior) => BEHAVIOR[behavior] ?? behavior;

const SAFETY_LABELS = {
  pureReadFastAllow: "bash 检查器：首词不是删除类，默认快速放行",
  envFile: "安全检查：.env 文件",
  "ssh-credential": "安全检查：SSH 凭据",
};

/** 把引擎给的结构化原因翻成一句话，表格里用。 */
function explain(decision) {
  const { reason } = decision;
  switch (reason.type) {
    case "rule": return "规则";
    case "mode": return "模式（bypassPermissions）";
    case "workingDirectory": return decision.behavior === "ask" ? "路径检查：越出工作区" : "路径检查：工作区内";
    case "tempDirectory": return "路径检查：临时目录";
    case "rmRewrite": return "rm 改写成回收站";
    case "safetyCheck": return SAFETY_LABELS[reason.category] ?? `安全检查：${reason.category ?? reason.description.slice(0, 40)}`;
    case "subcommandResults": {
      const [first] = [...reason.reasons.values()];
      return explain({ reason: first.reason });
    }
    default: return reason.type;
  }
}

export async function loadUpstream() {
  const { PermissionEngine } = await loadPermissionEngine();
  const { registerDefaultCheckers } = await loadDefaultCheckers();
  const { createToolPermissionContext } = await loadPermissionContext();
  const { evaluateLocalPermissionCheck } = await loadLocalChecks();
  const { shouldUseCloudClassify } = await loadCloudClassify();
  const { modeToAskPolicy } = await importSource("packages/agent-modules/permission/src/ask-policy.ts");
  const { applyAskGate } = await importSource("packages/local-runtime/src/permissions/ask-gate.ts");

  const engine = new PermissionEngine();
  registerDefaultCheckers(engine);

  /**
   * facade.checkPermission 的主干：本地硬检查 → 引擎 → policy 降级 → 按模式处置 ask → ask 闸门。
   * 返回 { behavior, by }：by 说明是哪一站拍的板。
   */
  function check({ tool, input, mode = "default", rules = [] }) {
    const engineMode = mode === "acceptEdits" ? "default" : mode; // acceptEdits 在 facade 入口就归一成 default
    const askPolicy = modeToAskPolicy(engineMode);

    const local = evaluateLocalPermissionCheck({
      toolName: tool,
      input,
      workspaceDir: WORKSPACE,
      platform: "darwin",
      shellFamily: "posix",
      recoverableRm: tool === "bash",
    });
    if (local?.behavior === "deny" && local.denyKind === "bypass-immune") {
      return { behavior: "deny", by: "本地硬检查：bypass-immune", reason: local.reason };
    }

    const context = createToolPermissionContext({
      mode: engineMode,
      rules,
      workingDirectory: WORKSPACE,
      dataDir: `${HOME}/.minimax`,
      homeDir: HOME,
      platform: "darwin",
      shellFamily: "posix",
    });
    const decision = engine.checkPermission(tool, input, context, { policyOwner: "core" });
    const rewritten = decision.rewrittenInput?.command;

    if (
      askPolicy !== "never" &&
      local?.behavior === "deny" &&
      local.denyKind === "policy" &&
      decision.behavior === "allow" &&
      decision.reason.type !== "rule"
    ) {
      return { behavior: "ask", by: "本地硬检查：policy，降成询问", reason: local.reason };
    }
    if (decision.behavior !== "ask") {
      return { behavior: decision.behavior, by: `引擎：${explain(decision)}`, rewritten };
    }
    // ask：交给模式。deny 策略直接拒；on-request-llm（auto）要先问云端分类器，离线时它不可用，退回询问；
    // never（完全访问）先保持 ask，再由闸门改成 allow
    if (askPolicy === "on-request-llm" && (decision.skipAutoClassifier || !shouldUseCloudClassify())) {
      return { behavior: "ask", by: `引擎：${explain(decision)}（分类器不可用，退回询问）`, rewritten };
    }
    const folded = askPolicy === "deny"
      ? { behavior: "deny", reason: decision.reason }
      : { behavior: "ask", reason: decision.reason };
    const gated = applyAskGate({ ...folded, reason: String(decision.reason.type) }, engineMode);
    return gated.behavior === folded.behavior
      ? { behavior: gated.behavior, by: `引擎：${explain(decision)}`, rewritten }
      : { behavior: gated.behavior, by: `ask 闸门：原本是“${explain(decision)}”`, rewritten };
  }

  return { check, modeToAskPolicy, applyAskGate };
}
