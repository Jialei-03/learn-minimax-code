import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { parseModelKey, BudgetResolver } from "../../host/src/models.mjs";
await lesson(3, "身份分解与同一次重试预算", async (t) => {
  const raw = "provider/org/model",
    naive = raw.split("/")[1],
    actual = parseModelKey(raw);
  t.equal("naive split loses the model namespace", naive, "org");
  t.equal("qualified identity preserves suffix", actual.modelId, "org/model");
  t.equal(
    "invalid identities are distinct from valid refs",
    [null, "model", "/model", "provider/"].map(parseModelKey),
    [undefined, undefined, undefined, undefined],
  );
  const resolver = new BudgetResolver(),
    identity = {},
    first = resolver.resolve(
      identity,
      { system: "rules", messages: [], tools: [] },
      { window: 2000, configuredMax: 500 },
    );
  t.equal(
    "same physical retry reuses exact budget object",
    resolver.resolve(identity, { messages: ["changed"] }, { window: 1000 }),
    first,
  );
  const next = resolver.resolve(
    {},
    { messages: ["x".repeat(2000)] },
    { window: 2000 },
  );
  t.ok("new call recalculates input consumption", next.input > first.input);
  t.throws(
    "exhausted request fails before provider",
    () =>
      resolver.resolve({}, { messages: ["x".repeat(10000)] }, { window: 10 }),
    /exhausted/,
  );
  t.observations = { naive, actual, first, next };
});
