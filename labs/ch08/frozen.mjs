// 实验：一代带走的东西——工具、Skill 正文、目录。
//   node labs/ch08/frozen.mjs
import assert from "node:assert/strict";
import { frozenScenario, markdownTable } from "./scenarios.mjs";

const { reads, removal } = await frozenScenario();

console.log("插件 research-kit 的 SKILL.md 和 MCP 服务器一起从 v1 升到 v2。更新之后三个读取者各读到什么：\n");
console.log(markdownTable(reads));
console.log("\n随后插件被卸载：commit 把目录挪进隔离区，finalizer 才真正删除。Turn B 一直握着 r2：\n");
console.log(markdownTable(removal));

assert.match(reads[0]["Skill 正文最后一行"], /三个要点/);
assert.match(reads[1]["Skill 正文最后一行"], /五个要点/);
assert.match(reads[2]["Skill 正文最后一行"], /五个要点/);
assert.deepEqual(reads.map((row) => row["search 的回答"]), ["v1:q", "v2:q", "—"]);
assert.deepEqual(removal.map((row) => [row.插件目录, row.隔离区, row["r2 的 MCP 进程"]]), [
  ["在", "不在", "运行中"],
  ["不在", "在", "运行中"],
  ["不在", "不在", "已退出"],
]);
assert.equal(removal[1]["B 调用 search"], "v2:q");
