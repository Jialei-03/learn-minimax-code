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
import { adapters } from "../../host/src/adapters.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
await lesson(1, "三个入口共用一个状态 owner", async (t) => {
  const app = await createApplication(join(t.temp, "data")),
    session = app.sessions.create(t.root),
    api = adapters(app);
  try {
    const outputs = [];
    outputs.push(
      await api.tui(session.id, "tui", {
        model: scriptedKernel([{ text: "T" }]),
      }),
    );
    outputs.push(
      await api.exec(
        { sessionId: session.id, prompt: "exec" },
        { model: scriptedKernel([{ text: "E" }]) },
      ),
    );
    outputs.push(
      await api.acp(
        {
          method: "session/prompt",
          params: { sessionId: session.id, text: "acp" },
        },
        { model: scriptedKernel([{ text: "A" }]) },
      ),
    );
    t.equal(
      "all adapters reach same application completion",
      outputs.map((r) => r.status),
      ["completed", "completed", "completed"],
    );
    t.equal(
      "one canonical history contains all entries",
      app.sessions
        .history(session.id)
        .filter((m) => m.role === "user")
        .map((m) => m.text),
      ["tui", "exec", "acp"],
    );
    t.throws(
      "relative workspace is rejected at lifecycle boundary",
      () => app.sessions.create("./relative"),
      /absolute/,
    );
    t.equal(
      "all admissions release their busy ownership",
      app.sessions.active.size,
      0,
    );
    t.observations.terminalIds = outputs.map((r) => r.turnId);
  } finally {
    await app.close();
  }
});
