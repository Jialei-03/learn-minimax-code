// 实验：同一份内部事件，exec 和 ACP 各说什么。
//   node labs/ch10/protocols.mjs
import assert from "node:assert/strict";
import { projections, markdownTable } from "./scenarios.mjs";

const { rows, detail, terminal } = await projections();

console.log(
  "把同一串内部事件（`TuiStreamEvent`：增量和完整消息）依次交给两个真实的投影器：" +
    "`ExecEventProjector` 产生 `mcode exec` 的 JSONL 事件，`TuiAcpUpdateProjector` 产生 ACP 的 `session/update` 通知。\n",
);
console.log(markdownTable(rows));

// 守住结论
const [thinking, hel, lo, same, done, full, history] = detail;
// exec：第一个事件带出 3 个信封事件；重复的工具快照原样发了两次，由客户端去重
assert.deepEqual(thinking.execEvents.map((e) => e.type), ["exec.started", "session.started", "turn.started", "item.started"]);
assert.deepEqual(lo.execEvents[1].item, same.execEvents[0].item);
// exec：完整消息把每个 item 都以 item.completed 收尾
assert.deepEqual(full.execEvents.map((e) => e.type), ["item.completed", "item.completed", "item.completed"]);
// exec：没有增量的消息，item.completed 前面没有 item.started
assert.deepEqual(history.execEvents.map((e) => e.type), ["item.completed", "item.completed"]);
assert.deepEqual(terminal.map((e) => e.type), ["turn.completed", "exec.completed"]);
// ACP：工具第一次出现是 tool_call，之后是 tool_call_update；已经流式发过的消息不再重发
assert.equal(lo.acpUpdates[1].sessionUpdate, "tool_call");
assert.equal(same.acpUpdates[0].sessionUpdate, "tool_call_update");
assert.deepEqual(full.acpUpdates, []);
assert.deepEqual(history.acpUpdates.map((u) => u.sessionUpdate), ["agent_message_chunk", "tool_call"]);
