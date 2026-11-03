import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { SerialDelivery } from "../../host/src/events.mjs";
import { runTurn } from "../../host/src/turns.mjs";
await lesson(2, "异步交付与最终终态", async (t) => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const delivery = new SerialDelivery(async (frame) => {
    if (frame.n === 1) await gate;
    order.push(frame.n);
  });
  delivery.send({ n: 1 });
  delivery.send({ n: 2 });
  await Promise.resolve();
  t.equal("later event cannot overtake pending first write", order, []);
  release();
  await delivery.drain();
  t.equal("serial order survives async writes", order, [1, 2]);
  const events = [],
    history = [];
  const result = await runTurn({
    sessionId: "s",
    turnId: "t",
    text: "go",
    root: t.root,
    prompt: { system: [] },
    model: async () => ({ text: "done" }),
    write: async (f) => events.push(f),
    persist: async (messages) => history.push(...messages),
  });
  t.equal(
    "terminal is the last committed event",
    events.at(-1).type,
    "turn.completed",
  );
  t.equal("canonical tail persisted before normal return", history.length, 2);
  const failed = await runTurn({
    sessionId: "s",
    turnId: "broken",
    text: "go",
    root: t.root,
    prompt: { system: [] },
    model: async () => ({ text: "visible" }),
    write: async (f) => {
      if (f.type === "item.updated") throw Error("writer unavailable");
    },
    persist: async () => {},
  });
  t.equal(
    "delivery failure cannot be reported as success",
    failed.status,
    "failed",
  );
  t.equal("failed delivery remains explicit", failed.delivered, false);
  t.observations.events = events.map((f) => ({ seq: f.seq, type: f.type }));
});
