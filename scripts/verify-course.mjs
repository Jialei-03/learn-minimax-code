// 按顺序运行贯穿项目的每一阶段实验。
//   npm run verify:course        全部
//   npm run lesson -- 3          只跑第 3 章，并打印实验过程
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const plan = JSON.parse(readFileSync(resolve(root, "course/progression.json"), "utf8"));
const requested = process.argv[2];
const chapters = requested === undefined
  ? plan.chapters
  : plan.chapters.filter((c) => String(c.n) === String(Number(requested)) || c.slug === requested);
if (!chapters.length) throw Error(`没有这一章：${requested}`);

if (requested !== undefined) {
  // 单章：直接把实验过程打到终端
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", resolve(root, chapters[0].experiment)], { cwd: root, stdio: "inherit" });
} else {
  let checks = 0;
  for (const chapter of chapters) {
    const output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", resolve(root, chapter.experiment), "--json"], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4e6 });
    const report = JSON.parse(output.trim().split("\n").at(-1));
    if (report.status !== "passed") throw Error(`${chapter.slug} 没有通过`);
    checks += report.checks.length;
    console.log(`${String(chapter.n).padStart(2, "0")} ${chapter.slug}：${report.checks.length} 项检查通过`);
  }
  console.log(`${plan.name}：${chapters.length} 个阶段，${checks} 项检查全部通过`);
}
