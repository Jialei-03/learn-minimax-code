import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { runProcess } from "../../runtime/process.mjs";
import { collector } from "../../host/src/sdk.mjs";
await lesson(10, "流事件的身份、顺序和归并", async (t) => {
  const sink = await collector("T");
  let seq = 0;
  const frame = (type, item) => ({
    sessionId: "s",
    turnId: "T",
    seq: ++seq,
    type,
    item,
  });
  sink.apply(frame("item.started", { id: "a", type: "agent_message" }));
  sink.apply(
    frame("item.updated", {
      id: "a",
      type: "agent_message",
      contentDelta: "ha",
    }),
  );
  sink.apply(
    frame("item.updated", { id: "b", type: "agent_message", content: "other" }),
  );
  sink.apply(
    frame("item.updated", {
      id: "a",
      type: "agent_message",
      contentDelta: "ha",
    }),
  );
  const snap = frame("item.updated", {
    id: "a",
    type: "agent_message",
    content: "haha",
  });
  sink.apply(snap);
  t.equal("duplicate transport frame is idempotent", sink.apply(snap), false);
  const repeated = frame("item.updated", {
    id: "a",
    type: "agent_message",
    content: "haha",
  });
  t.equal(
    "upstream accumulator drops repeated snapshot",
    sink.apply(repeated),
    false,
  );
  sink.apply(
    frame("item.completed", {
      id: "a",
      type: "agent_message",
      content: "haha",
    }),
  );
  sink.apply({ ...frame("turn.completed"), status: "completed" });
  t.equal("equal deltas are retained", sink.result().items[0].text, "haha");
  t.equal(
    "unfinished item is preserved as incomplete",
    sink.result().items[1].incomplete,
    true,
  );
  t.equal(
    "old turn events cannot contaminate current turn",
    sink.apply({ turnId: "other", seq: 1, type: "item.updated" }),
    false,
  );
  const gap = await collector("G");
  t.throws(
    "event loss is visible rather than silently merged",
    () => gap.apply({ turnId: "G", seq: 2, type: "turn.started" }),
    /sequence/,
  );
  const child = await runProcess(
    process.execPath,
    [join(ROOT, "host/src/cli.mjs"), t.root, join(t.temp, "cli-data")],
    {
      cwd: t.root,
      input:
        JSON.stringify({
          type: "user",
          text: "hello",
          replies: [{ text: "child done" }],
        }) + "\n",
      maxBytes: 100000,
    },
  );
  t.equal("real host CLI exits after EOF", child.code, 0);
  const frames = child.stdout.trim().split("\n").map(JSON.parse);
  t.equal(
    "real child protocol ends completed",
    frames.at(-1).status,
    "completed",
  );
  t.observations.childProtocol = frames.map((f) => ({
    type: f.type,
    status: f.status,
  }));
  t.observations.result = sink.result();
});
