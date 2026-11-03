import { randomUUID } from "node:crypto";
import { Journal } from "../../runtime/journal.mjs";

export class WorkQueue {
  constructor(file, now = Date.now) {
    this.log = new Journal(file);
    this.now = now;
  }
  items() {
    const rows = new Map();
    for (const fact of this.log.read()) {
      if (fact.type === "enqueue")
        rows.set(fact.item.id, { ...fact.item, state: "pending" });
      else if (rows.has(fact.id)) Object.assign(rows.get(fact.id), fact.patch);
    }
    return [...rows.values()];
  }
  enqueue(
    sessionId,
    text,
    { clientRequestId = randomUUID(), expiresAt, model } = {},
  ) {
    if (
      expiresAt !== undefined &&
      (!Number.isFinite(expiresAt) || expiresAt <= this.now())
    )
      throw Error("expiry-invalid");
    const old = this.items().find(
      (i) => i.sessionId === sessionId && i.clientRequestId === clientRequestId,
    );
    if (old) return old;
    const item = {
      id: randomUUID(),
      sessionId,
      text,
      clientRequestId,
      expiresAt,
      model,
    };
    this.log.append({ type: "enqueue", item });
    return { ...item, state: "pending" };
  }
  transition(id, state, extra = {}) {
    if (!this.items().some((i) => i.id === id))
      throw Error("queue item missing");
    this.log.append({ type: "transition", id, patch: { ...extra, state } });
  }
  claim(sessionId) {
    for (const item of this.items().filter(
      (i) => i.sessionId === sessionId && i.state === "pending",
    )) {
      if (item.expiresAt !== undefined && item.expiresAt <= this.now()) {
        this.transition(item.id, "expired");
        continue;
      }
      this.transition(item.id, "claimed");
      return { ...item, state: "claimed" };
    }
  }
  accept(id, turnId) {
    if (this.items().find((i) => i.id === id)?.state !== "claimed")
      throw Error("claim required");
    this.transition(id, "accepted", { turnId });
  }
  consume(id) {
    if (this.items().find((i) => i.id === id)?.state !== "accepted")
      throw Error("durable acceptance required");
    this.transition(id, "consumed");
  }
  recover() {
    for (const item of this.items())
      if (item.state === "claimed") this.transition(item.id, "pending");
    // Accepted work is not blindly retried: effects may already have happened.
    return this.items().filter((i) => i.state === "accepted");
  }
}
