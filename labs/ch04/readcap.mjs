// 实验：同一个 3000 行的文件，模型读和 run_code 里的程序读，各要几次。
//   node labs/ch04/readcap.mjs
// 前两行用 MiniMax 真实的 limitDesktopPrefixLines 和 isPtcChildCall（agent-tools/src/desktop/output-limit.ts）。
import assert from "node:assert/strict";
import { markdownTable, readCaps } from "./scenarios.mjs";

const result = await readCaps();
console.log(`文件：${result.totalLines} 行，${(result.totalBytes / 1024).toFixed(0)} KiB。\n`);
console.log(markdownTable(result.rows));
console.log(`
isPtcChildCall({})                                  → ${result.flags.direct}
isPtcChildCall({ parentToolCallId: "call_run" })    → ${result.flags.child}

判断一个调用是不是子调用，只看上下文里有没有 parentToolCallId。它由执行器写进去，
访客程序的参数里写什么都改不了它。`);

assert.equal(result.flags.direct, false);
assert.equal(result.flags.child, true);
assert.equal(result.upstream.sum, result.totalLines);
assert.ok(result.upstream.pages > 5);
assert.equal(result.host.childLines, result.totalLines);
assert.equal(result.host.direct.reduce((a, b) => a + b, 0), result.totalLines);
