// 实验：PTC 打开之后，模型看到的工具目录变成什么样。
//   node labs/ch04/catalog.mjs
import assert from "node:assert/strict";
import { callTool, localTools, ptcCatalogue, toolCatalogue } from "../../host/src/tools.mjs";
import { markdownTable, withWorkspace } from "./scenarios.mjs";

await withWorkspace(async (root) => {
  const tools = [
    ...localTools(root),
    { name: "ask_user", source: "builtin", readOnly: true, execute: () => ({ text: "（等用户回答）" }) },
  ];
  const visible = ptcCatalogue(tools);
  const [runCode] = visible;
  console.log(markdownTable([
    { 模式: "PTC 关闭", "模型看到的工具": tools.map((t) => t.name).join(", ") },
    { 模式: "PTC 打开", "模型看到的工具": visible.map((t) => t.name).join(", ") },
  ]));
  console.log(`\nrun_code 的子工具（只有程序能调用）：${runCode.children.map((t) => t.name).join(", ")}`);
  console.log("ask_user 要和用户交互，不能藏进程序里，所以仍然是模型直接调用的工具。\n");

  const hidden = await callTool(toolCatalogue(visible), { id: "d1", name: "read", input: { path: "a.txt" } }, { root, sessionId: "s", turnId: "t" });
  console.log(`模型绕过 run_code 直接调用 read：${hidden.text}（failure.kind = ${hidden.failure.kind}）\n`);
  console.log("模型看到的 run_code 描述（每个子工具的签名都是从它的 schema 渲染出来的）：\n");
  console.log(runCode.description.split("\n").map((line) => `  ${line}`).join("\n"));

  assert.deepEqual(visible.map((t) => t.name), ["run_code", "ask_user"]);
  assert.deepEqual(runCode.children.map((t) => t.name), ["read", "edit", "test"]);
  assert.equal(hidden.failure.kind, "tool_not_found");
});
