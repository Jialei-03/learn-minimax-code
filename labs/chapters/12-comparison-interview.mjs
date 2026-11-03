import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createApplication } from "../../host/src/app.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
import { mcpRuntime } from "../../host/src/plugins.mjs";
import { collector } from "../../host/src/sdk.mjs";
import { setTimeout as sleep } from "node:timers/promises";
await lesson(12, "完整修复、取消、热更新与队列续作", async (t) => {
  writeFileSync(
    join(t.root, "slug.cjs"),
    "module.exports=s=>s.trim().replace(/ /g,'-');\n",
  );
  writeFileSync(
    join(t.root, "test.cjs"),
    "require('node:assert/strict').equal(require('./slug.cjs')('a  b'),'a-b');console.log('tests passed');\n",
  );
  writeFileSync(
    join(t.root, "slow.cjs"),
    "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)",
  );
  writeFileSync(
    join(t.root, "SKILL.md"),
    "---\nname: verify\ndescription: Verify repairs\n---\nRun test.cjs before reporting success.",
  );
  const sinks = new Map(),
    closed = [];
  const app = await createApplication(join(t.temp, "data"), {
    writer: async (frame) => {
      if (!sinks.has(frame.turnId))
        sinks.set(frame.turnId, await collector(frame.turnId));
      sinks.get(frame.turnId).apply(frame);
    },
  });
  const session = app.sessions.create(t.root),
    makeCall = (name, input, id) => ({ calls: [{ name, input, id }] });
  try {
    await app.plugins.update("r1", async () => {
      const runtime = await mcpRuntime(process.execPath, [
        join(ROOT, "labs/fixtures/mcp-server.mjs"),
      ]);
      return {
        ...runtime,
        close: async () => {
          closed.push("r1");
          await runtime.close();
        },
      };
    });
    const firstJob = app.run(session.id, "long task", {
      model: scriptedKernel([makeCall("test", { path: "slow.cjs" }, "slow")]),
      rules: { allow: ["test"] },
    });
    for (let i = 0; i < 100 && !existsSync(join(t.root, "started")); i++)
      await sleep(10);
    t.ok(
      "real tool process started before cancellation",
      existsSync(join(t.root, "started")),
    );
    app.queue.enqueue(session.id, "fix slug", { clientRequestId: "repair" });
    await app.plugins.update("r2", async () => {
      const runtime = await mcpRuntime(process.execPath, [
        join(ROOT, "labs/fixtures/mcp-server.mjs"),
      ]);
      return {
        ...runtime,
        close: async () => {
          closed.push("r2");
          await runtime.close();
        },
      };
    });
    t.equal("old MCP survives update while A owns lease", closed, []);
    app.templates.update("system", "Repair and verify using captured R2.");
    t.equal("cancel reaches active controller", app.cancel(session.id), true);
    const first = await firstJob;
    t.equal("A settles cancelled", first.status, "cancelled");
    t.equal(
      "busy releases only after A settles",
      app.sessions.active.has(session.id),
      false,
    );
    t.equal("R1 closes after cancelled turn releases lease", closed, ["r1"]);
    let captured;
    const script = scriptedKernel([
      makeCall("read", { path: "slug.cjs" }, "read"),
      makeCall("skill", { name: "verify" }, "skill"),
      makeCall(
        "edit",
        { path: "slug.cjs", old: "/ /g", next: "/ +/g" },
        "edit",
      ),
      makeCall("test", { path: "test.cjs" }, "test"),
      makeCall("mcp_echo", { text: "verified" }, "mcp"),
      { text: "repair complete" },
    ]);
    const next = await app.next(session.id, {
      model: async (request, signal) => {
        captured ??= request;
        return script(request, signal);
      },
      rules: { allow: ["edit", "test", "mcp_echo"] },
      skillPaths: ["SKILL.md"],
    });
    t.equal("queued B completes real repair", next.status, "completed");
    t.equal(
      "queue item consumed after durable execution",
      app.queue.items()[0].state,
      "consumed",
    );
    t.equal("B uses new capability revision", next.capabilityRevision, "r2");
    t.ok("B uses captured new prompt", captured.system[0].includes("R2"));
    t.ok(
      "real test tool reports pass",
      next.messages.find((m) => m.id === "test").text.includes("tests passed"),
    );
    t.equal(
      "cancelled item remains incomplete in SDK",
      sinks.get(first.turnId).result().items[0].incomplete,
      true,
    );
    t.equal(
      "B has completed SDK terminal",
      sinks.get(next.turnId).result().status,
      "completed",
    );
    t.observations = {
      first: { status: first.status, turnId: first.turnId },
      next: {
        status: next.status,
        turnId: next.turnId,
        revision: next.capabilityRevision,
      },
      closed,
      repairedFile: readFileSync(join(t.root, "slug.cjs"), "utf8"),
      toolResults: next.messages.filter((message) => message.role === "tool"),
      queue: app.queue.items(),
      sdk: {
        first: sinks.get(first.turnId).result(),
        next: sinks.get(next.turnId).result(),
      },
      events: app.events.replay(),
    };
  } finally {
    await app.close();
  }
  t.equal("current MCP closes on application disposal", closed, ["r1", "r2"]);
});
