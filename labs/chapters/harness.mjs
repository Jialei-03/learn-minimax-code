// 逐章回归实验的小框架。
//   node labs/chapters/03-tools.mjs          读者模式：打印实验过程和每项检查
//   node labs/chapters/03-tools.mjs --json   构建模式：最后一行输出 JSON 报告
// 每个实验在临时目录里运行，结束后删除；检查失败会抛出异常，进程以非零状态退出。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const JSON_MODE = process.argv.includes("--json");

export async function lesson(chapter, title, execute) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "agent-course-")));
  const root = join(temp, "workspace");
  mkdirSync(root);
  const checks = [];
  const observations = {};
  const say = (line = "") => { if (!JSON_MODE) process.stdout.write(line + "\n"); };
  const pass = (name) => { checks.push({ name, passed: true }); say(`  ✓ ${name}`); };
  const t = {
    root,
    temp,
    observations,
    /** 打印一行实验过程（读者模式才显示）。 */
    log: say,
    /** 打印一张 Markdown 表格：rows 是对象数组，列名取第一行的键。 */
    table(rows) {
      if (!rows.length) return;
      const keys = Object.keys(rows[0]);
      const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      say(`| ${keys.join(" | ")} |`);
      say(`| ${keys.map(() => "---").join(" | ")} |`);
      for (const row of rows) say(`| ${keys.map((k) => cell(row[k])).join(" | ")} |`);
      say();
    },
    equal(name, actual, expected) { assert.deepEqual(actual, expected, name); pass(name); },
    ok(name, actual) { assert(actual, name); pass(name); },
    throws(name, fn, pattern) { assert.throws(fn, pattern, name); pass(name); },
    async rejects(name, promise, pattern) { await assert.rejects(promise, pattern, name); pass(name); },
  };
  say(`第 ${chapter} 章 · ${title}`);
  say();
  try {
    await execute(t);
    const report = { chapter, title, status: "passed", checks, observations: t.observations };
    if (JSON_MODE) process.stdout.write(JSON.stringify(report) + "\n");
    else say(`\n${checks.length} 项检查全部通过。`);
    return report;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
