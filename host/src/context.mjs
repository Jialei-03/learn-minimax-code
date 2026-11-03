import { importSource } from "../../lab/source.mjs";
import { digest } from "../../runtime/files.mjs";

export class Templates {
  constructor(values = {}) {
    this.revision = 0;
    this.values = { ...values };
  }
  update(key, text) {
    this.values[key] = text;
    this.revision++;
  }
  capture() {
    return Object.freeze({
      revision: this.revision,
      values: Object.freeze({ ...this.values }),
    });
  }
  read(snapshot, key) {
    if (!snapshot || !Object.hasOwn(snapshot.values, key))
      throw Error("prompt snapshot invalid");
    return snapshot.values[key];
  }
}
export async function promptRegistry(capacity = 128) {
  const { BoundedInternalTurnPromptReadRegistry } = await importSource(
    "packages/agent-core/src/prompt-read.ts",
  );
  return new BoundedInternalTurnPromptReadRegistry(capacity);
}
export function projectMessages(history, { maxImages = 2 } = {}) {
  const output = [],
    pending = new Map();
  for (const message of structuredClone(history)) {
    if (message.role === "assistant")
      for (const call of message.calls ?? []) pending.set(call.id, call);
    if (message.role === "tool" && !pending.has(message.id)) continue;
    if (message.role === "tool") pending.delete(message.id);
    output.push(message);
  }
  for (const [id] of pending)
    output.push({
      role: "tool",
      id,
      error: true,
      text: "interrupted tool call",
    });
  let remaining = maxImages;
  for (let i = output.length - 1; i >= 0; i--) {
    if (!output[i].images) continue;
    for (let j = output[i].images.length - 1; j >= 0; j--)
      if (remaining-- <= 0) output[i].images[j] = "[older image omitted]";
  }
  return output;
}
export function preparePrompt(templates, snapshot, memories = []) {
  const system = [
    templates.read(snapshot, "system"),
    ...memories.map((m) => `Memory from ${m.path}:\n${m.text}`),
  ];
  return { system, revision: snapshot.revision, hash: digest(system) };
}
