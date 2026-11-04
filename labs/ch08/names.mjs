// 实验：MCP 工具给模型看的名字。真实的 buildMcpToolRuntimeName。
//   node labs/ch08/names.mjs
import assert from "node:assert/strict";
import { importSource } from "../../lab/source.mjs";
import { markdownTable } from "./scenarios.mjs";

const { buildMcpToolRuntimeName, MCP_RUNTIME_TOOL_NAME_MAX_LENGTH } = await importSource("packages/agent-modules/mcp/src/runtime/tool-name.ts");

const cases = [
  ["github", "create_issue"],
  ["docs server", "read file"],
  ["my.server/v2", "search:full-text"],
  ["文档库", "search"],
  ["知识库", "search"],
  ["a".repeat(60), "x".repeat(60)],
];
const rows = cases.map(([server, tool]) => {
  const name = buildMcpToolRuntimeName(server, tool);
  return {
    服务器名: server.length > 20 ? `${server.slice(0, 6)}…（${server.length} 个字符）` : server,
    工具名: tool.length > 20 ? `${tool.slice(0, 6)}…（${tool.length} 个字符）` : tool,
    "模型看到的名字": `\`${name.length > 40 ? `${name.slice(0, 30)}…` : name}\``,
    长度: name.length,
  };
});
console.log(markdownTable(rows));

const names = cases.map(([server, tool]) => buildMcpToolRuntimeName(server, tool));
assert.equal(names[0], "mcp__github__create_issue");
assert.equal(names[1], "mcp__docs_server__read_file");
assert.equal(names[3], names[4], "两个中文名字的服务器，名字撞在一起");
assert.ok(names.every((name) => name.length <= MCP_RUNTIME_TOOL_NAME_MAX_LENGTH));
console.log(`\n“文档库”和“知识库”都变成了 \`${names[3]}\`：名字的唯一性要由上一层按服务器身份去分配，这个函数只负责把一个名字洗成合法的样子（分配由上游的 McpNameRegistry 负责）。`);
