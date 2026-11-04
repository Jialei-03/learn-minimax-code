// 实验：一个工具调用从参数到结果要过几道关，每种失败停在哪一关、模型会收到什么。
//   node labs/ch04/failures.mjs
import assert from "node:assert/strict";
import { failures, markdownTable } from "./scenarios.mjs";

const { rows } = await failures();
const show = rows.map(({ message, ...row }) => row);
console.log("同一个工具 peek（读类，参数 path 必填、limit 是整数）。在流水线的不同位置放进一个问题，看谁拦下了它：\n");
console.log(markdownTable(show));

const by = Object.fromEntries(rows.map((row) => [row.场景, row]));
console.log(`
- 参数问题（修参数、缺字段、类型不对）在准入之前就拦下了，前置 Hook 一次都没跑；
- “limit 写成 \\"20\\"” 不是错误：意图没有歧义，修成 20 继续；
- Hook 改写参数之后会再校验一次，非法就拦下；
- 权限拒绝排在前置 Hook 之后，execute 没跑；
- 工具抛出时后置 Hook 照样会看到这条错误结果——所以它们要能处理 isError。`);

assert.equal(by["工具不存在"]["failure.kind"], "tool_not_found");
assert.equal(by["缺少必填参数"].前置Hook, "没跑");
assert.equal(by["limit 写成字符串 \"20\""]["模型收到的文字（首行）"], "peek a.txt limit=20");
assert.equal(by["前置 Hook 拦下"].拦下者, "hook");
assert.equal(by["权限拒绝（edit 没有放行）"].拦下者, "permission");
assert.equal(by["权限拒绝（edit 没有放行）"].execute, "没跑");
assert.equal(by["工具抛出"].后置Hook, "跑了");
assert.equal(by["后置 Hook 抛出"]["failure.kind"], "after_hook");
