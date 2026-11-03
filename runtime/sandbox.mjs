import { spawnSync } from "node:child_process";
import { runProcess } from "./process.mjs";

export function sandboxCommand(root, command, args) {
  const quote = (value) => JSON.stringify(value);
  if (process.platform === "darwin")
    return {
      command: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${quote(root)}))(deny network*)`,
        command,
        ...args,
      ],
      backend: "seatbelt",
    };
  if (
    process.platform === "linux" &&
    spawnSync("which", ["bwrap"]).status === 0
  )
    return {
      command: "bwrap",
      args: [
        "--die-with-parent",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        root,
        root,
        "--chdir",
        root,
        "--",
        command,
        ...args,
      ],
      backend: "bubblewrap",
    };
  return undefined;
}
export async function runSandboxed(root, command, args, options = {}) {
  const wrapped = sandboxCommand(root, command, args);
  if (!wrapped)
    throw Error("sandbox unavailable: refusing unsandboxed fallback");
  return {
    ...(await runProcess(wrapped.command, wrapped.args, {
      ...options,
      cwd: root,
    })),
    backend: wrapped.backend,
  };
}
