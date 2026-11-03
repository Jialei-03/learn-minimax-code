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
  Templates,
  promptRegistry,
  preparePrompt,
  projectMessages,
} from "../../host/src/context.mjs";
await lesson(5, "一份快照与一次性交接", async (t) => {
  const templates = new Templates({ system: "R1" }),
    snapshot = templates.capture();
  templates.update("system", "R2");
  t.equal(
    "captured template remains R1",
    preparePrompt(templates, snapshot).system,
    ["R1"],
  );
  t.equal(
    "new capture sees R2",
    preparePrompt(templates, templates.capture()).system,
    ["R2"],
  );
  const registry = await promptRegistry(1),
    scope = { source: templates, snapshot };
  t.equal("reservation consumes capacity", registry.reserve("A"), true);
  t.equal("unfilled reservation blocks B", registry.reserve("B"), false);
  registry.remember("A", scope);
  t.equal("rebind moves existing scope", registry.rebind("A", "C"), true);
  t.equal("take preserves identity", registry.take("C"), scope);
  t.equal("take is one-shot", registry.take("C"), undefined);
  registry.close();
  const history = [
    { role: "tool", id: "orphan", text: "bad" },
    { role: "user", text: "image", images: ["old", "new"] },
  ];
  const projected = projectMessages(history, { maxImages: 1 });
  t.equal("orphan result removed from request view", projected.length, 1);
  t.equal("canonical image remains intact", history[1].images, ["old", "new"]);
  t.equal("older images omitted in request copy", projected[0].images, [
    "[older image omitted]",
    "new",
  ]);
  t.observations.projected = projected;
});
