// 实验：客户端在中途断线，怎样接上才能得到和“一直在线”相同的结果。
//   node labs/ch10/replay.mjs
import assert from "node:assert/strict";
import { reconnects, markdownTable } from "./scenarios.mjs";

const { rows, truth, frames, CUT } = await reconnects();

console.log("host 跑一个真实的 Turn（读 a、b 两个文件再总结），每一帧先写进 EventStore，再交给客户端。下表是这个 Turn 的 12 帧：\n");
console.log(markdownTable(frames.map((f) => ({ seq: f.seq, 类型: f.type, item: f.item?.id ?? "-", 内容: f.status ?? (f.item?.contentDelta ?? f.item?.content ?? f.item?.toolCall?.status ?? "-") }))));
console.log(`\n一直在线的客户端得到：status=${truth.status}，lastSeq=${truth.lastSeq}，${truth.items.length} 个 item。另一个客户端在第 ${CUT} 帧之后断线，用下面八种办法重新接上：\n`);
console.log(markdownTable(rows.map(({ error, ...row }) => row)));

// 守住结论
const by = (name) => rows.find((row) => row.办法 === name);
assert.equal(by("从游标继续")["与一直在线一致"], "是");
assert.equal(by("整段重放，和已收到的重叠")["与一直在线一致"], "是");
assert.equal(by("新客户端，整段重放")["与一直在线一致"], "是");
assert.match(by("新客户端，只重放游标之后").error.message, /sequence gap: expected #1, got #6/);
assert.match(by("游标往后跳了一格").error.message, /sequence gap: expected #6, got #7/);
assert.match(by("重放的帧和之前不一样").error.message, /sequence conflict: #3/);
assert.match(by("游标超过最后一帧").error.message, /invalid cursor/);
assert.match(by("终态之后又来一帧").error.message, /after terminal/);
