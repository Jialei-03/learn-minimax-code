// 实验：同一份 SKILL.md，三种读法。
//   node labs/ch08/frontmatter.mjs
import assert from "node:assert/strict";
import { markdownTable, skillPolicies } from "./scenarios.mjs";

const rows = skillPolicies();
console.log("每一行是一个 skills/summarize/SKILL.md 的内容，三列是三种格式不对时的态度：\n");
console.log(markdownTable(rows));

const by = (name) => rows.find((row) => row.输入 === name);
assert.match(by("正常")["严格（官方包）"], /^收录 summarize/);
for (const bad of ["name 写了两次", "frontmatter 没闭合", "缺 description", "name 和目录名不同", "没有 frontmatter"]) {
  assert.match(by(bad)["严格（官方包）"], /^整个包被拒绝/, bad);
  assert.match(by(bad)["跳过坏的（Agent Skills 包）"], /^跳过/, bad);
  assert.match(by(bad)["宽松（用户自己的目录）"], /^收录/, bad);
}
assert.match(by("name 写了两次")["宽松（用户自己的目录）"], /frontmatter_invalid/);
assert.match(by("name 和目录名不同")["宽松（用户自己的目录）"], /^收录 summary/);
