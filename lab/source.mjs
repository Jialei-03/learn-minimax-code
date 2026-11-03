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
  'packages/code-sdk/src/items.ts',
  'packages/agent-core/src/prompt-read.ts',
  'packages/local-runtime-v2/src/service/session-system/usage/service.ts',
  'packages/tui/src/acp/paths.ts',
  'packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts',
  'packages/local-runtime-v2/src/service/plugin-system/mcp/generation-registry.ts',
  'packages/local-runtime-v2/src/service/plugin-system/plugin-system-helpers.ts',
  'packages/local-runtime-v2/src/service/plugin-system/errors.ts',
  'packages/local-runtime-v2/src/service/session-system/queue/service.ts',
  'packages/local-runtime-v2/src/service/session-system/queue/policy.ts',
  'packages/local-runtime-v2/src/service/session-system/queue/repo/contract.ts',
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
