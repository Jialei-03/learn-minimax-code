import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { wrapTool, toolCatalogue, localTools } from "../../host/src/tools.mjs";
await lesson(4, "模型结果与程序通道的边界", async (t) => {
  let observed, contextSeen;
  const definition = {
    name: "x",
    source: "configured",
    readOnly: true,
    execute: async (_, context) => {
      contextSeen = context;
      return {
        text: "visible",
        programmatic: { secretChannel: "internal" },
        isError: false,
        details: { ok: true },
      };
    },
  };
  const result = await wrapTool(
    definition,
    { root: t.root, sessionId: "s", turnId: "t", assistantMessageId: "a" },
    {
      observe: (raw) => {
        observed = raw;
      },
    },
  )({ id: "call", name: "x", input: {} });
  t.equal(
    "programmatic payload stays in observer",
    observed.programmatic.secretChannel,
    "internal",
  );
  t.equal(
    "model view has no programmatic payload",
    Object.hasOwn(result, "programmatic"),
    false,
  );
  t.equal(
    "per-call context has stable tool id",
    contextSeen.toolCallId,
    "call",
  );
  const error = await wrapTool(
    {
      ...definition,
      execute: async () => ({ text: "bad", details: { ok: false } }),
    },
    { root: t.root },
  )({ id: "e", name: "x", input: {} });
  t.equal("structured failure is normalized", error.error, true);
  t.throws(
    "duplicate tool identities fail before execution",
    () => toolCatalogue([definition, definition]),
    /duplicate/,
  );
  writeFileSync(join(t.root, "a.txt"), "old");
  const edit = localTools(t.root).find((d) => d.name === "edit");
  t.equal(
    "unapproved effect is blocked",
    (
      await wrapTool(edit, { root: t.root })({
        id: "w",
        name: "edit",
        input: { path: "a.txt", old: "old", next: "new" },
      })
    ).error,
    true,
  );
  t.equal(
    "blocked call leaves original bytes",
    readFileSync(join(t.root, "a.txt"), "utf8"),
    "old",
  );
  t.observations.modelResult = result;
});
