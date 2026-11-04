// 第 8 章实验用的最小 MCP 服务器（stdio，按行传 JSON-RPC）。
//   node labs/ch08/server.mjs --version v2
// 只有一个工具 search：等 ms 毫秒（默认 0），然后回答 "<版本>:<query>"。
// 版本号让实验能看出一次调用到底是哪一代的服务器回答的；ms 用来造“一次进行中的慢调用”。
import { createInterface } from "node:readline";

const at = process.argv.indexOf("--version");
const version = at >= 0 ? process.argv[at + 1] : "v1";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return; // 通知（notifications/initialized）不需要回复
  switch (frame.method) {
    case "initialize":
      return reply(frame.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: `ch08-${version}`, version } });
    case "tools/list":
      return reply(frame.id, {
        tools: [{
          name: "search",
          description: `搜索文档（服务器版本 ${version}）`,
          inputSchema: { type: "object", properties: { query: { type: "string" }, ms: { type: "number" } }, required: ["query"] },
        }],
      });
    case "tools/call": {
      const { query, ms = 0 } = frame.params.arguments;
      return void setTimeout(() => reply(frame.id, { content: [{ type: "text", text: `${version}:${query}` }], isError: false }), ms);
    }
    default:
      return fail(frame.id, `unknown method ${frame.method}`);
  }
});
