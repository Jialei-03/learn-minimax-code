import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const plan = JSON.parse(
  readFileSync(resolve(root, "course/progression.json"), "utf8"),
);
const requested = process.argv[2];
const chapters =
  requested === undefined
    ? plan.chapters
    : plan.chapters.filter(
        (c) =>
          String(c.n) === String(Number(requested)) || c.slug === requested,
      );
if (!chapters.length) throw Error("unknown lesson");
let assertions = 0;
for (const chapter of chapters) {
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        resolve(root, chapter.experiment),
      ],
      { cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 2e6 },
    ),
  );
  if (report.status !== "passed" || report.checks.length < 3)
    throw Error("lesson failed");
  assertions += report.checks.length;
  console.log(
    `${String(chapter.n).padStart(2, "0")} ${chapter.slug}: ${report.checks.length} checks PASS`,
  );
}
console.log(
  `${plan.name}: ${chapters.length} chapters, ${assertions} checks PASS`,
);
