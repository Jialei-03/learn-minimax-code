// 实验：一个工具的返回值有三个读者——模型、界面、run_code 里的程序。
//   node labs/ch04/channels.mjs
import assert from "node:assert/strict";
import { channels, markdownTable, statuses } from "./scenarios.mjs";

const { rows, message, view, observed } = await channels();
console.log("一个内置工具返回 { text, details, programmatic, isError }。经过 newRuntimeTool 之后，每个字段各去了哪里：\n");
console.log(markdownTable(rows));
console.log(`\nwrapTool 交回的 tool 消息有这些键：${Object.keys(message).join("、")}（没有 programmatic）；`);
console.log(`其中模型真正看到的只有 modelView 取出的：${Object.keys(view).join("、")}。`);
console.log(`其中 programmatic 里的 secret 只有 observer 看过：${JSON.stringify(observed.programmatic.data.secret)}\n`);

const result = await statuses();
console.log("同一段程序依次调用八个子调用，程序拿到的 status（先看它，再用 output 或 data）：\n");
console.log(markdownTable(result.rows));
console.log(`
- “complete” 必须是内置工具自己报告过“没截断”，并且结果没被 Hook 改过；
- 没有报告（silent）、来源不是内置（mcp_echo）、结果被后置 Hook 改写（lookup）都只能是 unverified；
- 这三类的 data 是空的：被 Hook 隐去的内容，不能从工具自带的数据里绕回来。`);

assert.equal(Object.hasOwn(message, "programmatic"), false);
assert.deepEqual(observed.programmatic.data.secret, { token: "sk-live-0000" });
const by = Object.fromEntries(result.table.map((r) => [r.name, r]));
assert.equal(by["read 整个文件"].status, "complete");
assert.equal(by["read 前 50 行"].more, 51);
assert.equal(by["edit（收据，自己报告没截断）"].status, "complete");
assert.equal(by["silent（内置，但没有报告）"].status, "unverified");
assert.equal(by["第三方工具 mcp_echo"].status, "unverified");
assert.equal(by["lookup（后置 Hook 改写了文本）"].data, "{}");
assert.equal(by["boom（工具抛出）"].code, "PTC_TOOL_EXECUTION_FAILED");
