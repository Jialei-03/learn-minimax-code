import { digest } from "../../runtime/files.mjs";
export function investigation({
  version,
  commit,
  symptom,
  input,
  before,
  after,
  checks,
  boundary,
}) {
  if (!/^[0-9a-f]{40}$/.test(commit) || !symptom || !boundary)
    throw Error("versioned evidence required");
  if (
    digest(before) === digest(after) ||
    !checks.length ||
    checks.some((c) => c.passed !== true)
  )
    throw Error("red/green evidence required");
  return {
    title: symptom,
    version,
    commit,
    input,
    before,
    after,
    checks,
    boundary,
    status: "local-evidence-only",
    markdown: `## Problem\n${symptom}\n\n## Reproduction\n${JSON.stringify(input, null, 2)}\n\n## Change\nBefore: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}\n\n## Validation\n${checks.map((c) => "- " + c.name).join("\n")}\n\n## Scope\n${boundary}\n`,
  };
}
