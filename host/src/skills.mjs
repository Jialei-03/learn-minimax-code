import { readFileSync } from "node:fs";
import { workspacePath } from "../../runtime/files.mjs";

// Deliberately small frontmatter dialect: scalar key:value, comma-separated
// allowed-tools. Reject duplicate keys; no implicit YAML coercion or aliases.
export function parseSkill(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw Error("skill frontmatter required");
  const fields = {};
  for (const line of match[1].split(/\r?\n/).filter(Boolean)) {
    const pair = line.match(/^([a-z-]+):\s*(.*)$/);
    if (!pair || Object.hasOwn(fields, pair[1]))
      throw Error("invalid or duplicate skill field");
    fields[pair[1]] = pair[2];
  }
  if (!fields.name || !fields.description)
    throw Error("name and description required");
  return {
    name: fields.name,
    description: fields.description,
    allowedTools: (fields["allowed-tools"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    fork: fields.context === "fork",
    userInvocable: fields["user-invocable"] !== "false",
    body: match[2].trim(),
  };
}
export class Skills {
  constructor(root, paths) {
    this.root = root;
    this.entries = new Map();
    for (const path of paths) {
      const parsed = parseSkill(
        readFileSync(workspacePath(root, path), "utf8"),
      );
      if (this.entries.has(parsed.name)) throw Error("duplicate skill name");
      this.entries.set(parsed.name, {
        path,
        name: parsed.name,
        description: parsed.description,
      });
    }
  }
  descriptions() {
    return [...this.entries.values()].map(({ name, description }) => ({
      name,
      description,
    }));
  }
  load(name) {
    const entry = this.entries.get(name.trim().replace(/^\//, ""));
    if (!entry) throw Error("unknown skill");
    return parseSkill(
      readFileSync(workspacePath(this.root, entry.path), "utf8"),
    );
  }
}
