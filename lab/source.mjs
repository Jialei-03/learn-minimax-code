import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK = JSON.parse(readFileSync(resolve(ROOT, 'source.lock.json'), 'utf8'));
export const SOURCE = resolve(process.env.MINIMAX_SRC ?? resolve(ROOT, LOCK.directory));
const git = args => execFileSync('git', ['-C', SOURCE, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
let verified = false;

export function verifySource() {
  if (verified) return;
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== LOCK.commit) throw new Error(`源码版本不符：${head}；需要 ${LOCK.commit}。运行 npm run setup:source，或设置 MINIMAX_SRC。`);
  const pkg = JSON.parse(git(['show', `${LOCK.commit}:package.json`]));
  if (pkg.version !== LOCK.version) throw new Error('源码版本号与 source.lock.json 不符');
  verified = true;
}

// Read committed content. A separate contribution checkout can change without changing lessons.
export function readSource(file) {
  verifySource();
  if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`非法源码路径：${file}`);
  return git(['show', `${LOCK.commit}:${file}`]);
}

export function sourceUrl(file, first, last = first) {
  return `${LOCK.repo}/blob/${LOCK.commit}/${file}${first ? `#L${first}-L${last}` : ''}`;
}

// Only audited modules and their listed pure dependencies are eligible. No
// imports are mocked or algorithms rewritten. Node erases types/transforms
// parameter properties, then executes the complete upstream modules.
const PURE_MODULES = new Set([
  // 第 3 章：错误分类与重试判定、输出预算公式（含它依赖的默认设置）、凭证模式推断、用量落账
  'packages/shared/src/llm-error-classifier.ts',
  'packages/agent-modules/context-manager/src/provider-budget.ts',
  'packages/agent-modules/context-manager/src/settings.ts',
  'packages/config/src/provider-auth-mode.ts',
  'packages/local-runtime-v2/src/service/session-system/usage/pi-usage.ts',
  'packages/code-sdk/src/items.ts',
  // 第 10 章：对外协议。exec 的事件投影器与退出码策略、SDK 的错误映射与逐行解析、ACP 的更新投影器。
  // 它们的 import 要么是 `import type`，要么指向下面同样列出的纯模块。
  'packages/code-sdk/src/errors.ts',
  'packages/code-sdk/src/protocol.ts',
  'packages/tui/src/headless/events.ts',
  'packages/tui/src/headless/exit-policy.ts',
  'packages/tui/src/failure.ts',
  'packages/tui/src/runtime/stream-events.ts',
  'packages/tui/src/runtime/tool-preview.ts',
  'packages/tui/src/acp/updates.ts',
  'packages/agent-core/src/prompt-read.ts',
  'packages/local-runtime-v2/src/service/session-system/usage/service.ts',
  'packages/tui/src/acp/paths.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts',
  // 第 6 章：checkpoint 的校验与组装（checkpoint-format.ts 及它依赖的纯模块）、摘要请求的输出预算、崩溃后显示行的修复
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-format.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/compat.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/contracts.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/todo-cadence.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/background-cadence.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/assistant-iteration-cadence.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/contracts.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/runner/contracts.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/execution/checkpoint-prompt.ts',
  'packages/local-runtime-v2/src/service/session-system/messages/stale-compaction-repair.ts',
  'packages/agent-core/src/pi-turn-runner/request-image-limit.ts',
  'packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts',
  'packages/local-runtime-v2/src/service/plugin-system/plugin-system-helpers.ts',
  'packages/local-runtime-v2/src/service/plugin-system/errors.ts',
  'packages/local-runtime-v2/src/service/session-system/queue/service.ts',
  'packages/local-runtime-v2/src/service/session-system/queue/policy.ts',
  'packages/local-runtime-v2/src/service/session-system/queue/repo/contract.ts',
  // 第 9 章：运行中 Turn 的所有权与插话收件箱（只依赖 wait-for-release 和只含类型的契约文件）。
  'packages/local-runtime-v2/src/service/turn-system/execution/turn-controller/turn.controller.ts',
  'packages/local-runtime-v2/src/service/turn-system/execution/turn-controller/wait-for-release.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/contracts.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/runner/contracts.ts',
  'packages/local-runtime-v2/src/service/turn-system/steering-identity.ts',
  // 第 5 章：提示块与记忆块、运行时规则、整包回退、reminder 链（都只依赖相对路径的纯模块）
  'packages/local-runtime-v2/src/service/turn-system/agent-host/preparation/prompt-blocks.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/preparation/config/runtime-prompt-rules.ts',
  'packages/local-runtime/src/runtime/prompt-read.ts',
  'packages/agent-modules/system-reminder/src/providers.ts',
  'packages/agent-modules/system-reminder/src/types.ts',
  'packages/agent-modules/system-reminder/src/evolution.ts',
  'packages/agent-modules/system-reminder/src/blocks.ts',
  'packages/agent-modules/system-reminder/src/registry.ts',
  'packages/agent-modules/system-reminder/src/todo-state.ts',
  // 第 4 章：工具与 PTC。下面几个文件的 import 全是 `import type`，类型擦除之后没有任何依赖。
  'packages/agent-core/src/tools/edit-prepare-arguments.ts',
  'packages/agent-core/src/tools/ptc.ts',
  'packages/agent-core/src/pi-turn-runner/tool-context-size.ts',
  'packages/agent-tools/src/desktop/output-limit.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/execution/ptc/contracts.ts',
  'packages/local-runtime-v2/src/service/turn-system/agent-host/execution/ptc/subcall-scheduler.ts',
  // 第 8 章：Turn 的能力租约与发布门（import 全是 `import type`）、MCP 工具给模型看的名字、Plugin Skill 的运行时名字与目录名回退
  'packages/local-runtime-v2/src/service/turn-system/agent-host/assembly/turn-capability-lifecycle.ts',
  'packages/agent-modules/mcp/src/runtime/tool-name.ts',
  'packages/shared/src/plugin-skill-name.ts',
  'packages/local-runtime-v2/src/service/plugin-system/skill/identity.ts',
  // 第 7 章：模式到询问策略的映射、bypass 的 ask 闸门、沙箱默认值与有效策略编译、后端选择与准入的错误码、审批回复与请求序列化
  // （下面的文件 import 全是 `import type` 或相对路径的纯模块；selector.ts 依赖 sandbox-errors.ts）
  'packages/agent-modules/permission/src/ask-policy.ts',
  'packages/local-runtime/src/permissions/ask-gate.ts',
  'packages/config/src/sandbox-settings.ts',
  'packages/local-runtime-v2/src/service/sandbox/effective-policy.ts',
  'packages/local-runtime-v2/src/service/sandbox/backend/selector.ts',
  'packages/local-runtime-v2/src/service/sandbox/sandbox-errors.ts',
  'packages/local-runtime-v2/src/service/permission/request-contracts.ts',
  // 第 1 章：exec 的退出码映射（exit-policy.ts 只依赖 failure.ts；其余是 `import type`）
  'packages/tui/src/headless/exit-policy.ts',
  'packages/tui/src/failure.ts',
]);
const moduleUrls = new Map();
function sourceModuleUrl(file, pending = new Set()) {
  if (!PURE_MODULES.has(file)) throw new Error(`未审核的离线模块：${file}`);
  if (moduleUrls.has(file)) return moduleUrls.get(file);
  if (pending.has(file)) throw new Error(`离线模块存在循环依赖：${file}`);
  const next = new Set([...pending, file]);
  let code = stripTypeScriptTypes(readSource(file), { mode: 'transform', sourceUrl: sourceUrl(file) });
  // Preserve complete upstream modules; only link audited relative imports to
  // other complete modules read from the same pinned Git object database.
  const imports = [...code.matchAll(/(?:\bfrom\s+|\bimport\s*)(['"])([^'"]+)\1/g)];
  for (const match of imports) {
    const specifier = match[2];
    if (specifier === 'node:path') continue;
    if (!specifier.startsWith('.')) throw new Error(`离线模块包含未经审核的外部依赖：${specifier}`);
    const target = posix.normalize(posix.join(posix.dirname(file), specifier.replace(/\.js$/, '.ts')));
    const url = sourceModuleUrl(target, next);
    code = code.replace(`${match[1]}${specifier}${match[1]}`, `${match[1]}${url}${match[1]}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  moduleUrls.set(file, url);
  return url;
}
export async function importSource(file) { return import(sourceModuleUrl(file)); }
