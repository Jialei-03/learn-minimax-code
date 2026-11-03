import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  absoluteClientPath,
  localCheck,
  authorize,
} from "../../host/src/permissions.mjs";
import { importSource } from "../../lab/source.mjs";
await lesson(7, "路径分类与最终授权", async (t) => {
  const { isTuiAcpAbsolutePath } = await importSource(
    "packages/tui/src/acp/paths.ts",
  );
  const inputs = [
    "/tmp/a",
    "C:\\work\\a",
    "\\\\server\\share",
    "./relative",
    "C:relative",
    "~/a",
  ];
  t.equal(
    "client path classification agrees with upstream",
    inputs.map(absoluteClientPath),
    inputs.map(isTuiAcpAbsolutePath),
  );
  t.equal(
    "absolute classification grants no permission",
    authorize({ name: "edit", input: { path: "a" } }, {}, { root: t.root }),
    false,
  );
  t.equal(
    "explicit allow permits workspace effect",
    authorize(
      { name: "edit", input: { path: "a" } },
      {},
      { root: t.root, rules: { allow: ["edit"] } },
    ),
    true,
  );
  writeFileSync(join(t.temp, "secret"), "outside");
  symlinkSync(join(t.temp, "secret"), join(t.root, "link"));
  const escaped = { name: "read", input: { path: "link" } };
  t.equal(
    "physical escape has bypass-immune kind",
    localCheck(escaped, t.root).kind,
    "bypass-immune",
  );
  t.equal(
    "allow rule cannot override workspace boundary",
    authorize(
      escaped,
      { readOnly: true },
      { root: t.root, rules: { allow: ["read"] } },
    ),
    false,
  );
  t.observations.paths = inputs.map((path) => ({
    path,
    absolute: absoluteClientPath(path),
  }));
});
