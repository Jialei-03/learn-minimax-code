// 在固定提交的 Git 对象上做扫描的小工具，layers.mjs 和 entries.mjs 共用。
import { execFileSync } from "node:child_process";
import { LOCK, SOURCE } from "../../lab/source.mjs";

export { LOCK };
/** 在固定提交的仓库里跑一条 git 命令（git grep 没有匹配时退出码是 1，这里当作空结果）。 */
export function git(...args) {
  try {
    return execFileSync("git", ["-C", SOURCE, ...args], { encoding: "utf8", maxBuffer: 64e6 });
  } catch (error) {
    if (error.status === 1 && args[0] === "grep") return "";
    throw error;
  }
}
export const isTest = (file) => /\.test\.|\/test\/|\/tests\/|__tests__/.test(file);
export const table = (rows) => {
  const keys = Object.keys(rows[0]);
  return [`| ${keys.join(" | ")} |`, `| ${keys.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${keys.map((k) => r[k]).join(" | ")} |`)].join("\n");
};
