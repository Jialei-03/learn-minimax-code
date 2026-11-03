import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Journal } from "../../runtime/journal.mjs";

export class Sessions {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.meta = new Journal(join(dataDir, "sessions.jsonl"));
    this.active = new Map();
  }
  create(workspaceDir) {
    if (!isAbsolute(workspaceDir)) throw Error("absolute workspace required");
    const session = {
      id: randomUUID(),
      workspaceDir: realpathSync(workspaceDir),
    };
    this.meta.append(session);
    return session;
  }
  get(id) {
    const session = this.meta.read().find((s) => s.id === id);
    if (!session) throw Error("session not found");
    return session;
  }
  historyLog(id) {
    this.get(id);
    return new Journal(join(this.dataDir, `${id}.history.jsonl`));
  }
  history(id) {
    return this.historyLog(id)
      .read()
      .flatMap((row) => row.messages);
  }
  append(id, turnId, messages) {
    this.historyLog(id).append({ turnId, messages: structuredClone(messages) });
  }
  admit(id, turnId) {
    this.get(id);
    if (this.active.has(id)) throw Error("session busy");
    this.active.set(id, turnId);
    let released = false;
    return () => {
      if (released) return;
      if (this.active.get(id) !== turnId) throw Error("active owner changed");
      this.active.delete(id);
      released = true;
    };
  }
}
