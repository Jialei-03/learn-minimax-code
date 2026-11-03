import { Journal } from "../../runtime/journal.mjs";
export class SerialDelivery {
  constructor(write) {
    this.write = write;
    this.tail = Promise.resolve();
    this.error = undefined;
    this.count = 0;
  }
  send(frame) {
    this.tail = this.tail.then(async () => {
      if (this.error) return;
      try {
        await this.write(structuredClone(frame));
        this.count++;
      } catch (error) {
        this.error = error;
      }
    });
    return this.tail;
  }
  async drain() {
    await this.tail;
    if (this.error) throw this.error;
  }
}
export class EventStore {
  constructor(file) {
    this.log = new Journal(file);
  }
  append(frame) {
    const rows = this.log.read(),
      same = rows.filter((row) => row.turnId === frame.turnId);
    if (!frame.sessionId || !frame.turnId || frame.seq !== same.length + 1)
      throw Error("invalid event identity or sequence");
    if (same.at(-1)?.type === "turn.completed")
      throw Error("event after terminal");
    this.log.append(frame);
  }
  replay(turnId) {
    return this.log.read().filter((row) => !turnId || row.turnId === turnId);
  }
}
