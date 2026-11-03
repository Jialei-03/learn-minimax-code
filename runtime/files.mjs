import {
  realpathSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function workspacePath(root, input) {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    /^[A-Za-z]:|^\\\\/.test(input)
  )
    throw Error("invalid path");
  const base = realpathSync(root);
  const target = resolve(base, input);
  const inside = (path) => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
  };
  if (!inside(target)) throw Error("outside workspace");
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw Error("unresolvable path");
    ancestor = parent;
  }
  const physical = resolve(realpathSync(ancestor), relative(ancestor, target));
  if (!inside(physical)) throw Error("symlink outside workspace");
  return physical;
}
export function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
export function fileVersion(file) {
  const text = readFileSync(file, "utf8");
  return { text, hash: digest(text), mtime: statSync(file).mtimeMs };
}
