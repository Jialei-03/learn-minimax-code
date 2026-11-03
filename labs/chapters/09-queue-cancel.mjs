import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { WorkQueue } from "../../host/src/queue.mjs";
import { createApplication } from "../../host/src/app.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
import { forkTask } from "../../host/src/fork.mjs";
await lesson(9, "持久意图、接纳与恢复边界", async (t) => {
  const file = join(t.temp, "queue.jsonl"),
    queue = new WorkQueue(file, () => 100);
  const first = queue.enqueue("s", "one", {
      clientRequestId: "same",
      model: "p/old",
    }),
    again = queue.enqueue("s", "changed", {
      clientRequestId: "same",
      model: "p/new",
    });
  t.equal("client retry preserves original identity", again.id, first.id);
  t.equal("client retry preserves resolved model", again.model, "p/old");
  t.throws(
    "expiry is checked before commit",
    () => queue.enqueue("s", "bad", { expiresAt: 100 }),
    /expiry/,
  );
  const claimed = queue.claim("s");
  t.throws(
    "consume needs durable acceptance",
    () => queue.consume(claimed.id),
    /acceptance/,
  );
  const restarted = new WorkQueue(file, () => 100);
  t.equal("unaccepted claim can be requeued", restarted.recover(), []);
  t.equal("recovered item is pending", restarted.items()[0].state, "pending");
  const next = restarted.claim("s");
  restarted.accept(next.id, "turn-A");
  t.equal(
    "accepted work is reported for reconciliation",
    new WorkQueue(file).recover()[0].turnId,
    "turn-A",
  );
  const app = await createApplication(join(t.temp, "data"));
  const session = app.sessions.create(t.root);
  writeFileSync(join(t.root, "a"), "safe");
  try {
    const child = await forkTask(app, session.id, "explore", {
      model: scriptedKernel([
        { calls: [{ id: "r", name: "read", input: { path: "a" } }] },
        {
          calls: [
            {
              id: "w",
              name: "edit",
              input: { path: "a", old: "safe", next: "bad" },
            },
          ],
        },
        { text: "done" },
      ]),
    });
    t.equal(
      "child uses a separate session",
      child.sessionId === session.id,
      false,
    );
    t.equal(
      "child cannot call removed edit tool",
      child.messages.find((m) => m.id === "w").error,
      true,
    );
    t.equal("parent history stays empty", app.sessions.history(session.id), []);
  } finally {
    await app.close();
  }
  t.observations.queue = restarted.items();
});
