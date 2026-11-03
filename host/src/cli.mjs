import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createApplication } from "./app.mjs";
import { scriptedKernel } from "./models.mjs";

const root = resolve(process.argv[2] ?? "."),
  data = resolve(process.argv[3] ?? ".host-data");
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const app = await createApplication(data, { writer: write }),
  session = app.sessions.create(root);
const jobs = [];
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.type === "cancel") {
    app.cancel(session.id);
    continue;
  }
  if (command.type !== "user") {
    write({ type: "protocol_error" });
    continue;
  }
  const job = app
    .run(session.id, command.text, {
      model: scriptedKernel(command.replies ?? [{ text: "ready" }]),
      rules: command.rules ?? {},
    })
    .catch((error) => write({ type: "error", error: error.message }));
  jobs.push(job);
}
await Promise.all(jobs);
await app.close();
