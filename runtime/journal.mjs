import {
  readFileSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  truncateSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { digest } from "./files.mjs";

// A single-process, synchronous, durable append log. It is deliberately not a
// multi-process database; callers serialize admission and mutations.
export class Journal {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }
  scan() {
    if (!existsSync(this.file)) return { records: [], bytes: 0, tail: false };
    const raw = readFileSync(this.file, "utf8");
    const complete = raw.endsWith("\n")
      ? raw
      : raw.slice(0, raw.lastIndexOf("\n") + 1);
    let prev = "";
    const records = [];
    for (const line of complete.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      const expected = digest({
        seq: records.length + 1,
        prev,
        value: row.value,
      });
      if (
        row.seq !== records.length + 1 ||
        row.prev !== prev ||
        row.hash !== expected
      )
        throw Error("journal integrity failure");
      records.push(row);
      prev = row.hash;
    }
    return {
      records,
      bytes: Buffer.byteLength(complete),
      tail: complete !== raw,
    };
  }
  read() {
    return this.scan().records.map((row) => structuredClone(row.value));
  }
  append(value) {
    const scan = this.scan();
    // Repair only an uncommitted final fragment. Never ignore middle corruption.
    if (scan.tail) truncateSync(this.file, scan.bytes);
    const body = {
      seq: scan.records.length + 1,
      prev: scan.records.at(-1)?.hash ?? "",
      value: structuredClone(value),
    };
    const row = { ...body, hash: digest(body) };
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(row) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return structuredClone(row);
  }
}
