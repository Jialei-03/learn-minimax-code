import { readFileSync } from "node:fs";
import { workspacePath, atomicWrite } from "../../runtime/files.mjs";
import { runSandboxed } from "../../runtime/sandbox.mjs";
import { runProcess } from "../../runtime/process.mjs";
import { authorize } from "./permissions.mjs";

export function toolCatalogue(definitions) {
  const map = new Map();
  for (const definition of definitions) {
    if (map.has(definition.name)) throw Error("duplicate tool name");
    map.set(definition.name, definition);
  }
  return map;
}
export function wrapTool(
  definition,
  context,
  { before = [], after = [], observe = () => {}, rules = {}, mode } = {},
) {
  return async (call) => {
    try {
      const input = structuredClone(call.input);
      definition.validate?.(input);
      context.signal?.throwIfAborted();
      for (const hook of before)
        if (
          (await hook({ ...call, source: definition.source }, context))?.block
        )
          throw Error("blocked by hook");
      if (
        !authorize({ ...call, input }, definition, {
          root: context.root,
          rules,
          mode,
        })
      )
        throw Error("permission denied");
      const raw = await definition.execute(input, {
        ...context,
        toolCallId: call.id,
      });
      observe(raw); // The programmatic channel is private to this observer.
      let result = {
        text: raw.text ?? "",
        details: {
          ...raw.details,
          ...(raw.isError !== undefined ? { is_error: raw.isError } : {}),
        },
        terminate: raw.terminate,
      };
      for (const hook of after)
        result = { ...result, ...(await hook(call, result)) };
      return {
        role: "tool",
        id: call.id,
        ...result,
        error:
          result.details?.is_error === true || result.details?.ok === false,
      };
    } catch (error) {
      return {
        role: "tool",
        id: call.id,
        text: String(error.message ?? error),
        error: true,
      };
    }
  };
}
export function localTools(root) {
  const validPath = (input) => {
    if (typeof input.path !== "string") throw Error("path required");
    workspacePath(root, input.path);
  };
  return [
    {
      name: "read",
      source: "builtin",
      readOnly: true,
      executionMode: "parallel",
      validate: validPath,
      execute: (input) => ({
        text: readFileSync(workspacePath(root, input.path), "utf8"),
      }),
    },
    {
      name: "edit",
      source: "builtin",
      validate: (input) => {
        validPath(input);
        if (!input.old || typeof input.next !== "string")
          throw Error("edit strings required");
      },
      execute: (input) => {
        const file = workspacePath(root, input.path),
          before = readFileSync(file, "utf8");
        if (before.split(input.old).length !== 2)
          throw Error("edit target not unique");
        atomicWrite(file, before.replace(input.old, input.next));
        return { text: "edited", details: { before }, programmatic: { file } };
      },
    },
    {
      name: "test",
      source: "builtin",
      validate: validPath,
      execute: async (input, context) => {
        const result = context.sandboxRequired
          ? await runSandboxed(
              root,
              process.execPath,
              [workspacePath(root, input.path)],
              { signal: context.signal },
            )
          : await runProcess(
              process.execPath,
              [workspacePath(root, input.path)],
              { cwd: root, signal: context.signal },
            );
        return {
          text: result.stdout + result.stderr,
          isError: result.code !== 0,
          details: result,
        };
      },
    },
  ];
}
