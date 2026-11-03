import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve, dirname } from 'node:path';
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

// Only self-contained modules are eligible. No imports are mocked or implementations rewritten.
// Node erases types/transforms parameter properties, then executes the complete upstream module.
const PURE_MODULES = new Set([
  'packages/code-sdk/src/items.ts',
  'packages/agent-core/src/prompt-read.ts',
  'packages/local-runtime-v2/src/service/session-system/usage/service.ts',
  'packages/tui/src/acp/paths.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts',
]);
export async function importSource(file) {
  if (!PURE_MODULES.has(file)) throw new Error(`未审核的离线模块：${file}`);
  const code = stripTypeScriptTypes(readSource(file), { mode: 'transform', sourceUrl: sourceUrl(file) });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
