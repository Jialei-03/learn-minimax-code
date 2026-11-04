// 实验：一次真实的 mcode exec 输出，逐条过一遍 SDK 的 ItemAccumulator。
//   node labs/ch10/stream.mjs
import assert from "node:assert/strict";
import { foldRecording, naiveMerges, markdownTable, quote } from "./scenarios.mjs";

const { events, rows, itemRows, items, dropped, result, label } = await foldRecording("success-tools");

console.log(
  "下面是 `mcode exec --output-format stream-json` 的一次真实输出（上游 SDK 测试夹具 `success-tools.jsonl`，录制后脱敏）。" +
    "任务：读 `note.txt`、列目录，再写出 `out.txt`。共 31 行，每行一个 JSON 事件。" +
    "表格逐行列出它们，最后一列是真实的 `ItemAccumulator` 对每一条的处理。\n",
);
console.log(markdownTable(rows));
console.log(
  `\n折叠的结果：${events.length} 个事件 → ${items.length} 个 item；被丢弃的事件序号是 ${dropped.join("、")}。\n`,
);
console.log(markdownTable(itemRows));

// 三种看上去合理的合并办法，在这段录像上各得到什么。
const { concatenated, eventCount } = naiveMerges(events);
const cancelled = await foldRecording("cancelled");
const lastDelta = [...naiveMerges(cancelled.events).lastPerId].find((event) => event.item.type === "agent_message");
const realText = cancelled.items.find((item) => item.type === "agent_message").text;
console.log("\n再看三种“直观”的合并办法：\n");
console.log(`- 把所有 contentDelta 接在一起：${quote(concatenated, 70)}。两条消息粘成了一段，三次工具调用不见了。`);
console.log(`- 一个 item.* 事件当一条记录：${eventCount} 条记录，真正的 item 只有 ${items.length} 个。`);
console.log(
  `- 每个 id 只留最后一个事件：在这段录像里碰巧没问题（最后一个事件是完整文本）。` +
    `但在被取消的那段录像里，消息的最后一个事件是增量 ${quote(lastDelta.item.contentDelta)}，真正的文字是 ${quote(realText, 40)}。`,
);

// 守住结论
assert.equal(events.length, 31);
assert.deepEqual(dropped, [7, 10, 20, 21]); // 和上游 SDK 测试 stream.test.ts 里断言的序号一致
assert.equal(items.length, 5);
assert.ok(items.every((item) => !item.incomplete));
// 交错：read 的第一个和最后一个事件之间，夹着别的 item 的事件
const readSeqs = events.filter((event) => event.item && label(event.item) === "read").map((event) => event.sequence);
assert.ok(events.some((event) => event.item && label(event.item) !== "read" && event.sequence > readSeqs[0] && event.sequence < readSeqs.at(-1)));
// 最终回答来自 exec.completed，并且和最后一条消息一致
assert.equal(result.output, items.filter((item) => item.type === "agent_message").at(-1).text);
// 被取消的录像：两个 item 都没有完成
assert.deepEqual(cancelled.items.map((item) => item.incomplete), [true, true]);
assert.notEqual(lastDelta.item.contentDelta, realText);
