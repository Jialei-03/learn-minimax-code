import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class StdioRpc {
  constructor(command, args, { cwd, timeout = 2000 } = {}) {
    this.next = 0;
    this.pending = new Map();
    this.timeout = timeout;
    this.closed = false;
    this.child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      try {
        if (line.length > 1000000) throw Error("oversized RPC frame");
        const frame = JSON.parse(line);
        const waiter = this.pending.get(frame.id);
        if (!waiter) return;
        this.pending.delete(frame.id);
        clearTimeout(waiter.timer);
        frame.error
          ? waiter.reject(Error(frame.error.message))
          : waiter.resolve(frame.result);
      } catch (error) {
        this.fail(error);
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(Error("RPC peer exited")));
    this.child.stdin.on("error", (error) => this.fail(error));
  }
  fail(error) {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(Error("RPC closed"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("RPC timeout"));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  notify(method, params = {}) {
    if (!this.closed)
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
  }
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "course", version: "1" },
    });
    this.notify("notifications/initialized");
    return result;
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.fail(Error("RPC closed"));
      return;
    }
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.fail(Error("RPC closed"));
    this.lines.close();
    this.child.stdin.end();
    this.child.kill("SIGKILL");
    await exited;
  }
}
