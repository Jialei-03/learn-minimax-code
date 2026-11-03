import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export async function lesson(chapter, title, execute) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "agent-course-"))),
    root = join(temp, "workspace");
  mkdirSync(root);
  const checks = [],
    observations = {};
  const t = {
    root,
    temp,
    observations,
    equal(name, actual, expected) {
      assert.deepEqual(actual, expected, name);
      checks.push({ name, passed: true });
    },
    ok(name, actual) {
      assert(actual, name);
      checks.push({ name, passed: true });
    },
    throws(name, fn, pattern) {
      assert.throws(fn, pattern, name);
      checks.push({ name, passed: true });
    },
    async rejects(name, promise, pattern) {
      await assert.rejects(promise, pattern, name);
      checks.push({ name, passed: true });
    },
  };
  try {
    await execute(t);
    assert(
      checks.length >= 3,
      "each chapter needs at least three concrete checks",
    );
    const report = {
      chapter,
      title,
      status: "passed",
      checks,
      observations: t.observations,
      evidence:
        "course implementation + isolated filesystem/process/explicit test ports",
    };
    process.stdout.write(JSON.stringify(report) + "\n");
    return report;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
