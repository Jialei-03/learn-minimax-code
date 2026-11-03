import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { investigation } from "../../host/src/contribution.mjs";
import { parseModelKey } from "../../host/src/models.mjs";
import { LOCK } from "../../lab/source.mjs";
import { execFileSync } from "node:child_process";
await lesson(11, "可审查的本地 red-green 材料", async (t) => {
  const input = "provider/org/model",
    before = input.split("/")[1],
    after = parseModelKey(input).modelId;
  t.ok(
    "deliberate broken baseline violates expected identity",
    before !== "org/model",
  );
  t.equal("course implementation preserves identity", after, "org/model");
  const report = investigation({
    version: LOCK.version,
    commit: LOCK.commit,
    symptom: "Teaching baseline loses a model namespace",
    input,
    before,
    after,
    checks: [{ name: "preserve slash suffix", passed: true }],
    boundary:
      "Course regression exercise; not evidence of a current upstream defect or submitted PR.",
  });
  t.equal(
    "contribution state is truthful",
    report.status,
    "local-evidence-only",
  );
  t.throws(
    "missing source version cannot produce evidence",
    () => investigation({ ...report, commit: "main" }),
    /versioned/,
  );
  const git = (...args) =>
    execFileSync("git", ["-C", t.root, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  git("init", "-q");
  const file = join(t.root, "model.mjs");
  writeFileSync(file, "export const parse=s=>s.split('/')[1];\n");
  git("add", "model.mjs");
  writeFileSync(file, "export const parse=s=>s.slice(s.indexOf('/')+1);\n");
  const patch = git("diff");
  const patchFile = join(t.temp, "change.patch");
  writeFileSync(patchFile, patch);
  git("apply", "--check", "--reverse", patchFile);
  t.ok(
    "actual patch can be reviewed and reverse-checked",
    patch.includes("diff --git"),
  );
  t.observations = { report, patch };
});
