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
  historyCursor,
  checkpoint,
  compactView,
} from "../../host/src/history.mjs";
import { importSource } from "../../lab/source.mjs";
await lesson(6, "持久提交游标与 checkpoint 协议", async (t) => {
  const received = [],
    cursor = historyCursor(1, async (rows) => received.push(...rows)),
    messages = [
      { role: "user", text: "initial" },
      { role: "assistant", text: "new" },
    ];
  await cursor.flush(messages);
  await cursor.flush(messages);
  t.equal("initial history and repeated tail are not redelivered", received, [
    messages[1],
  ]);
  t.equal("cursor advances only after persistence", cursor.position, 2);
  const broken = historyCursor(0, async () => {
    throw Error("disk failure");
  });
  await t.rejects(
    "persistence failure propagates",
    broken.flush(messages),
    /disk failure/,
  );
  t.equal("failed cursor does not advance", broken.position, 0);
  t.equal("persistence failure is sticky", broken.failed, true);
  const { CHECKPOINT_SYSTEM_PROMPT, parseCheckpointHeadings } =
    await importSource(
      "packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts",
    );
  const headings = parseCheckpointHeadings(CHECKPOINT_SYSTEM_PROMPT),
    text = headings.map((h) => `## ${h}\nfixture`).join("\n");
  t.equal(
    "all upstream protocol sections are recognized",
    (await checkpoint(text)).headings,
    headings,
  );
  await t.rejects(
    "missing sections fail validation",
    checkpoint("## Goal\nonly"),
    /missing/,
  );
  const history = [
    { role: "user", text: "old" },
    { role: "assistant", text: "done" },
    { role: "user", text: "next" },
  ];
  t.equal(
    "retained suffix starts at a user boundary",
    compactView(history, text, 2).at(-1).text,
    "next",
  );
  t.throws(
    "arbitrary index cannot cut a protocol group",
    () => compactView(history, text, 1),
    /boundary/,
  );
  t.observations.sections = headings;
});
