import { importSource } from "../../lab/source.mjs";
import { digest } from "../../runtime/files.mjs";

export async function collector(turnId) {
  const { ItemAccumulator } = await importSource(
    "packages/code-sdk/src/items.ts",
  );
  const accumulator = new ItemAccumulator();
  let seq = 0,
    terminal,
    previousHash;
  return {
    apply(frame) {
      if (frame.turnId !== turnId) return false;
      const hash = digest(frame);
      if (frame.seq === seq && hash === previousHash) return false;
      if (frame.seq !== seq + 1 || terminal)
        throw Error("event sequence violation");
      seq = frame.seq;
      previousHash = hash;
      if (frame.type === "turn.completed") terminal = frame.status;
      return accumulator.apply(frame);
    },
    result() {
      return {
        status: terminal ?? "incomplete",
        items: accumulator.items(),
        lastSeq: seq,
      };
    },
  };
}
