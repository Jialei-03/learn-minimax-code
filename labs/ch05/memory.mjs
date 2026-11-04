// 实验：记忆怎样进入请求——系统提示里放一份快照，会话中途的变化只送增量。
//   node labs/ch05/memory.mjs
import assert from "node:assert/strict";
import { markdownTable, memoryDelta, memoryInjection } from "./scenarios.mjs";

const injection = await memoryInjection();
console.log("**一、系统提示里的记忆块**（块用上游 `prompt-blocks.ts` 的真实构造器生成，拼装逻辑是 host 的）\n");
console.log(markdownTable(injection.rows));
console.log("\n第二种情形里，摘要索引块的真实文字：\n");
console.log("```text");
console.log(injection.sample[0]);
console.log("```");

const delta = await memoryDelta();
console.log("\n**二、会话中途记忆变了，下一个 Turn 的 reminder 里送什么**\n");
console.log(markdownTable(delta.rows));
console.log("\n上游真实的 `agentMemoryUpdateProvider` 对“末尾追加了一条”渲染出的块：\n");
console.log("```text");
console.log(delta.realBlock);
console.log("```");

// ── 检查 ──
assert.deepEqual(injection.tagsHost, injection.tagsUpstream, "host 与上游的块顺序一致");
assert.ok(injection.rows.every((r) => r["host 与上游的块顺序一致"] === "是"));
assert.match(injection.rows[0].注入的块, /^agent_memory_tail/);
assert.match(injection.rows[1].注入的块, /agent_memory_summary \+ agent_memory_tail/);
assert.match(injection.rows[2].注入的块, /agent_memory_tail \+ agent_memory_note/);
assert.equal(delta.rows[0].送出的增量, "（无）");
assert.equal(delta.rows[1].内容, "- release branch is main");
assert.equal(delta.rows[4].送出的增量, "（无）");
