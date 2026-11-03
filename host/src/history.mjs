import { importSource } from "../../lab/source.mjs";

export function historyCursor(initial, persist) {
  let cursor = initial,
    failed = false;
  return {
    async flush(messages) {
      if (failed || messages.length <= cursor) return;
      const delta = structuredClone(messages.slice(cursor));
      try {
        await persist(delta);
        cursor = messages.length;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    get position() {
      return cursor;
    },
    get failed() {
      return failed;
    },
  };
}
export async function checkpoint(summary) {
  const { CHECKPOINT_SYSTEM_PROMPT, parseCheckpointHeadings } =
    await importSource(
      "packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts",
    );
  const headings = parseCheckpointHeadings(CHECKPOINT_SYSTEM_PROMPT);
  const missing = headings.filter(
    (heading) => !summary.includes(`## ${heading}\n`),
  );
  if (missing.length)
    throw Error(`checkpoint missing sections: ${missing.join(", ")}`);
  return { headings, summary };
}
export function compactView(history, checkpointText, keepFrom) {
  if (
    !Number.isInteger(keepFrom) ||
    keepFrom <= 0 ||
    history[keepFrom]?.role !== "user"
  )
    throw Error("compact at a user boundary");
  return [
    { role: "user", text: `[checkpoint]\n${checkpointText}` },
    ...structuredClone(history.slice(keepFrom)),
  ];
}
