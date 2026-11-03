import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
export function sourceNotes(root, refs, read) {
  const specs = JSON.parse(
      readFileSync(resolve(root, "course/source-notes.json"), "utf8"),
    ),
    html = new Map();
  for (const [key, steps] of Object.entries(specs)) {
    const ref = refs[key];
    if (!ref) throw Error("unknown source note " + key);
    const lines = read(ref.file).split("\n");
    const entries = steps.map((step) => {
      const range = lines.slice(ref.start - 1, ref.end);
      const index = range.findIndex((line) => line.includes(step.find));
      if (index < 0)
        throw Error(
          `source note ${key}: anchor not inside citation: ${step.find}`,
        );
      const line = ref.start + index,
        url = ref.url.replace(/#.*$/, "") + "#L" + line;
      return `<li><a href="${url}" target="_blank" rel="noopener">L${line}</a><span>${esc(step.note)}</span></li>`;
    });
    html.set(key, `<ol class="source-reading">${entries.join("")}</ol>`);
  }
  return (key) => html.get(key) ?? "";
}
