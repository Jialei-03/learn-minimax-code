// 实验：同一个任务，模型直接读 30 个文件，和写一段 run_code 程序，上下文里各留下多少东西。
//   node labs/ch04/context.mjs
// “常驻上下文”用 MiniMax 真实的 measureToolContext（pi-turn-runner/tool-context-size.ts）来量：
// 它统计历史里所有工具调用的参数和结果，每次请求模型时这些都要再发一遍。
import assert from "node:assert/strict";
import { markdownTable, residency } from "./scenarios.mjs";

const { rows, direct, program, programText, code, childCalls } = await residency();

console.log("任务：统计 30 个模块里的 TODO 注释（每个文件约 5 KiB）。两种做法结束之后，工具相关的内容在上下文里占多少：\n");
console.log(markdownTable(rows));
console.log("\n逐个工具看（measureToolContext 的 byTool）：");
console.log(
  markdownTable(
    [["直接调用", direct], ["run_code", program]].flatMap(([做法, m]) =>
      [...m.byTool].map(([工具, c]) => ({ 做法, 工具, "参数": `${c.argumentBytes} 字节`, "结果": `${c.resultBytes} 字节` })),
    ),
  ),
);
console.log(`\n模型写的程序（${Buffer.byteLength(code)} 字节，进入上下文的是它）：\n\n${code}\n`);
console.log(`程序的返回值（${Buffer.byteLength(programText)} 字节，进入上下文的另一半）：\n\n${programText}\n`);
console.log(`程序里发出的 ${childCalls.length} 次 read 没有消失：每一次都有自己的编号和状态，记在这次 run_code 的 details.ptc.child_calls 里（给界面和恢复用，不进模型）：`);
console.log(childCalls.slice(0, 3).map((c) => `  ${JSON.stringify(c)}`).join("\n") + "\n  ……");

assert.equal(direct.itemCount, 60);
assert.equal(program.itemCount, 2);
assert.ok(direct.resultBytes > 100 * program.resultBytes);
assert.equal(childCalls.length, 30);
assert.ok(childCalls.every((c) => c.status === "completed"));
