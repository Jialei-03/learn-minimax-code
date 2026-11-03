import path from "node:path";
import { workspacePath } from "../../runtime/files.mjs";
import { runSandboxed } from "../../runtime/sandbox.mjs";

export const absoluteClientPath = (value) =>
  typeof value === "string" &&
  (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
export function localCheck(call, root) {
  if (call.input.path) {
    try {
      workspacePath(root, call.input.path);
    } catch {
      return { behavior: "deny", kind: "bypass-immune" };
    }
  }
  if (call.name === "network") return { behavior: "ask", kind: "policy" };
  return undefined;
}
export function authorize(
  call,
  definition,
  { root, rules = {}, mode = "default" },
) {
  const local = localCheck(call, root);
  if (local?.kind === "bypass-immune" || rules.deny?.includes(call.name))
    return false;
  if (rules.ask?.includes(call.name)) return false; // This teaching host has no implicit UI approval.
  if (local?.behavior === "ask") return false;
  return (
    definition.readOnly ||
    rules.allow?.includes(call.name) ||
    (mode === "acceptEdits" && ["edit", "write"].includes(call.name))
  );
}
export function sandboxTool(root, file) {
  return runSandboxed(root, process.execPath, [workspacePath(root, file)]);
}
