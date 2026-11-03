import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createPlugins, mcpRuntime } from "../../host/src/plugins.mjs";
import { parseSkill } from "../../host/src/skills.mjs";
await lesson(8, "发现屏障、能力代与旧连接", async (t) => {
  const plugins = await createPlugins(),
    closed = [];
  let first, second;
  try {
    await plugins.update("r1", async () => ({
      tools: [{ name: "old" }],
      close: async () => {
        closed.push("r1");
      },
    }));
    first = await plugins.capture();
    let ready;
    const discovery = new Promise((resolve) => {
      ready = resolve;
    });
    const updating = plugins.update("r2", async () => {
      await discovery;
      return mcpRuntime(process.execPath, [
        join(ROOT, "labs/fixtures/mcp-server.mjs"),
      ]);
    });
    let captured = false;
    const pending = plugins.capture().then((view) => {
      captured = true;
      return view;
    });
    await Promise.resolve();
    t.equal("capture waits for discovery barrier", captured, false);
    ready();
    await updating;
    second = await pending;
    t.equal(
      "new turn sees completed MCP discovery",
      second.tools[0].name,
      "mcp_echo",
    );
    t.equal(
      "old turn retains its captured tool catalogue",
      first.tools[0].name,
      "old",
    );
    t.equal("replace does not close leased runtime", closed, []);
    first.release();
    t.equal("release closes retired runtime once", closed, ["r1"]);
    first.release();
    t.equal("duplicate release is harmless", closed, ["r1"]);
    const tool = second.tools[0];
    t.equal(
      "real MCP invocation works through published binding",
      (await tool.execute({ text: "first-turn-tool" })).text,
      "first-turn-tool",
    );
    t.throws(
      "duplicate Skill keys are rejected before model use",
      () => parseSkill("---\nname: a\nname: b\ndescription: x\n---\nbody"),
      /duplicate/,
    );
    t.observations = {
      oldRevision: first.revision,
      newRevision: second.revision,
      closed,
    };
  } finally {
    first?.release();
    second?.release();
    await plugins.close();
  }
});
