import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { verifySource, readSource, LOCK } from "../../lab/source.mjs";
import { workspacePath } from "../../runtime/files.mjs";
await lesson(0, "源代码、发行边界与研究对象", async (t) => {
  verifySource();
  const scope = JSON.parse(readSource("release/extraction.json"));
  t.ok(
    "published scope includes runtime",
    scope.packageRoots.includes("packages/local-runtime-v2"),
  );
  t.equal(
    "version is pinned rather than latest",
    JSON.parse(readSource("package.json")).version,
    LOCK.version,
  );
  t.throws(
    "a read path cannot be a filesystem escape",
    () => workspacePath(t.root, "../outside"),
    /outside/,
  );
  t.ok(
    "public boundary is explicit",
    readSource("docs/architecture.md").includes("Source boundaries"),
  );
  t.observations = {
    version: LOCK.version,
    commit: LOCK.commit,
    packageRoots: scope.packageRoots.length,
    scope: "public CLI/runtime; no inferred Desktop/cloud implementation",
  };
});
