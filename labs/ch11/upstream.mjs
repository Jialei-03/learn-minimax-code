// 第 11 章实验的小工具：从固定提交里读取、装载上游的单个模块，拿它的真实函数做复现。
//
// 和 lab/source.mjs 的 importSource 是同一个思路（读 Git 对象、去掉类型、直接执行完整的模块），
// 区别是这里要装载两类 importSource 不收的文件：
//   1. Pi v1.5.0（../pi-v1.5.0）里的模块；
//   2. 依赖 npm 包或 Node 内置模块的模块（json-parse 依赖 partial-json，edit-diff 依赖 diff）。
// 对第二类，调用方必须逐个声明替身（stubs / fileStubs），替身只放在复现用不到的代码路径上，
// 并在实验输出里写明；没有声明的外部依赖一律报错，不会悄悄放行。
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { posix, resolve } from "node:path";
import { LOCK, ROOT, readSource } from "../../lab/source.mjs";

/** Pi v1.5.0：与 site/build.mjs 里 @pi 指令用的是同一个提交。 */
export const PI = {
  version: "v1.5.0",
  commit: "f9a26365568127461c47a07a37dcb42c140a3ac5",
  dir: process.env.PI_SRC ?? resolve(ROOT, "../pi-v1.5.0"),
};

/** MiniMax 内置的 Pi（pi-mono v0.79.1 加本地补丁）里的路径前缀。 */
export const VENDOR = "third_party/pi-mono/";

/** 读 Pi v1.5.0 的文件内容。 */
export function readPi(file) {
  return execFileSync("git", ["-C", PI.dir, "show", `${PI.commit}:${file}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** 读 MiniMax Code 0.7.2 固定提交里的文件内容。 */
export const readMiniMax = readSource;

const NODE_BUILTINS = new Set(["fs", "fs/promises", "path", "os"]);
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/**
 * 造一个模块装载器。
 *   read       读取文件文本的函数（readPi 或 readMiniMax）
 *   stubs      外部包名 -> 替身模块源码，例如 { diff: "export const diffLines = ..." }
 *   aliases    外部包名 -> 同一个仓库里的文件，例如 pi-schema 指向 packages/schema/src/index.ts
 *   fileStubs  仓库内文件路径 -> 替身源码，用来切断复现不需要的依赖链
 *   overlay    仓库内文件路径 -> 替换后的文本，用来装载“打了补丁的副本”
 */
export function createLoader({ read, stubs = {}, aliases = {}, fileStubs = {}, overlay = {} }) {
  const urls = new Map();

  function urlOf(file, pending = new Set()) {
    if (urls.has(file)) return urls.get(file);
    if (pending.has(file)) throw new Error(`模块循环依赖：${file}`);
    const next = new Set([...pending, file]);
    const text = overlay[file] ?? read(file);
    let code = stripTypeScriptTypes(text, { mode: "transform", sourceUrl: file });
    const imports = [...code.matchAll(/(?:\bfrom\s+|\bimport\s*)(['"])([^'"]+)\1/g)];
    for (const match of imports) {
      const [, quote, specifier] = match;
      let target;
      if (specifier.startsWith(".")) {
        const path = posix.normalize(posix.join(posix.dirname(file), specifier.replace(/\.js$/, ".ts")));
        target = fileStubs[path] !== undefined ? dataUrl(fileStubs[path]) : urlOf(path, next);
      } else if (aliases[specifier] !== undefined) {
        target = urlOf(aliases[specifier], next);
      } else if (stubs[specifier] !== undefined) {
        target = dataUrl(stubs[specifier]);
      } else if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
        continue;
      } else {
        throw new Error(`未声明替身的外部依赖：${specifier}（在 ${file}）`);
      }
      code = code.replace(`${quote}${specifier}${quote}`, `${quote}${target}${quote}`);
    }
    const url = dataUrl(code);
    urls.set(file, url);
    return url;
  }

  return (file) => import(urlOf(file));
}

/** 装载 Pi v1.5.0 的模块。 */
export const loadPi = (options = {}) => createLoader({ read: readPi, ...options });
/** 装载 MiniMax 固定提交里的模块（含 third_party/pi-mono 下的内置 Pi）。 */
export const loadMiniMax = (options = {}) => createLoader({ read: readMiniMax, ...options });

export { LOCK };
