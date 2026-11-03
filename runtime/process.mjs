import { spawn } from "node:child_process";

export function runProcess(
  command,
  args = [],
  { cwd, input, signal, timeout = 3000, maxBytes = 8192, env = {} } = {},
) {
  if (signal?.aborted)
    return Promise.resolve({
      code: null,
      reason: "aborted",
      stdout: "",
      stderr: "",
      pid: null,
    });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      reason = "exit",
      settled = false;
    const collect = (prior, data) =>
      Buffer.concat([prior, data]).subarray(-maxBytes);
    child.stdout.on("data", (data) => {
      stdout = collect(stdout, data);
    });
    child.stderr.on("data", (data) => {
      stderr = collect(stderr, data);
    });
    const kill = (why) => {
      reason = why;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const abort = () => kill("aborted");
    const timer = setTimeout(() => kill("timeout"), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        reason,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        pid: child.pid,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    if (signal?.aborted) abort();
  });
}
