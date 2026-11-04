// 从固定提交里装载 MiniMax 的权限引擎（packages/agent-modules/permission），在实验里直接运行真实函数。
//
// lab/source.mjs 的 importSource 只放行 `node:path`。权限引擎的文件还要用 node:fs / node:os / node:crypto
// （host-utils.ts 里的 randomUUID、fs-permission.ts 里的 realpathSync……），而且 dangerous-patterns.ts 要从
// 同一个仓库的另外两个包里取一个常量。所以这里的规则比 importSource 宽一点，其余原则一样：
//   - 只装载白名单里的文件：权限引擎包的 src/ 目录（不含测试），加下面两个工作区包的入口文件；
//   - 文件内容取自固定提交的完整原文，相对 import 递归装载同一提交里的完整文件；
//   - `@mavis/...` 包名按各自 package.json 的 exports 指到源码文件，node: 内置模块原样放行；
//   - 不 mock 任何依赖，不改写任何算法（host-utils.ts 默认就是空日志，不需要替换）。
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { readSource, sourceUrl } from "../../lab/source.mjs";

const PERMISSION = "packages/agent-modules/permission/src";
/** 工作区包名 → 源码文件（package.json 的 exports 里 "types" 指向的那个 .ts）。 */
const WORKSPACE_PACKAGES = new Map([
  ["@mavis/agent-core/bash-subprocess-env", "packages/agent-core/src/bash-subprocess-env.ts"],
  ["@mavis/shared/runtime-boundary-env", "packages/shared/src/runtime-boundary-env.ts"],
  ["@mavis/shared/shell-source-stages", "packages/shared/src/shell-source-stages.ts"],
  ["@mavis/permission", `${PERMISSION}/index.ts`],
]);
/** 权限引擎包的 src/（不含测试）、上面几个包入口，以及 facade 用的本地硬检查 checkers.ts。 */
const LOCAL_CHECKERS = "packages/local-runtime/src/permissions/checkers.ts";
const allowed = (file) =>
  (file.startsWith(`${PERMISSION}/`) && !file.endsWith(".test.ts")) ||
  file === LOCAL_CHECKERS ||
  [...WORKSPACE_PACKAGES.values()].includes(file);

const urls = new Map();
function moduleUrl(file, pending = new Set()) {
  if (!allowed(file)) throw new Error(`未审核的离线模块：${file}`);
  if (urls.has(file)) return urls.get(file);
  if (pending.has(file)) throw new Error(`离线模块存在循环依赖：${file}`);
  let code = stripTypeScriptTypes(readSource(file), { mode: "transform", sourceUrl: sourceUrl(file) });
  for (const match of code.matchAll(/(?:\bfrom\s+|\bimport\s*)(['"])([^'"]+)\1/g)) {
    const specifier = match[2];
    if (specifier.startsWith("node:")) continue;
    const target = WORKSPACE_PACKAGES.get(specifier)
      ?? (specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(file), specifier.replace(/\.js$/, ".ts")))
        : undefined);
    if (!target) throw new Error(`离线模块包含未经审核的外部依赖：${specifier}`);
    const url = moduleUrl(target, new Set([...pending, file]));
    code = code.replace(`${match[1]}${specifier}${match[1]}`, `${match[1]}${url}${match[1]}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  urls.set(file, url);
  return url;
}

const load = (name) => import(moduleUrl(`${PERMISSION}/${name}`));

/** permission-core.ts：`reducePermissionDecision`，规则台阶本身。 */
export const loadPermissionCore = () => load("permission-core.ts");
/** context.ts：`createToolPermissionContext`。 */
export const loadPermissionContext = () => load("context.ts");
/** tools/fs-permission.ts：`validatePath`、`isPathAllowed` 等路径判断。 */
export const loadFsPermission = () => load("tools/fs-permission.ts");
/** engine.ts：`PermissionEngine`。 */
export const loadPermissionEngine = () => load("engine.ts");
/** tools/index.ts：`registerDefaultCheckers`（bash 与文件工具的检查器）。 */
export const loadDefaultCheckers = () => load("tools/index.ts");
/** classifier/cloud-classify-client.ts：`shouldUseCloudClassify`，auto 模式要不要去问云端分类器。 */
export const loadCloudClassify = () => load("classifier/cloud-classify-client.ts");
/** local-runtime 的 permissions/checkers.ts：`evaluateLocalPermissionCheck`，facade 调用的本地硬检查。 */
export const loadLocalChecks = () => import(moduleUrl(LOCAL_CHECKERS));
