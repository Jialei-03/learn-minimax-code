// 实验：摘要请求自己也要放进窗口。输入太大时，一级一级换更小的。
//   node labs/ch06/ladder.mjs
import assert from "node:assert/strict";
import { ladderScenario, markdownTable } from "./scenarios.mjs";

const { history, total, rows } = ladderScenario();
console.log(`一段 ${history.length} 条消息、约 ${total} token 的会话：6 轮读文件和改文件，每轮 read 返回一大段内容，中途用户补了一句话。摘要请求的输入上限越小，选中的越靠后：\n`);
const label = { h0: "h0 完整历史", hall: "hall 工具结果换成占位", hmid: "hmid 再整组删中间", hmin: "hmin 只留最近的用户消息" };
console.log(
  markdownTable(
    rows.map((r) => ({ 输入上限: r.limit, 选中: r.chosen ? label[r.chosen] : "都放不下 → COMPACTION_INPUT_TOO_LARGE", "估算 token": r.size ?? "—", 消息数: r.count ?? "—" })),
  ),
);

const hmid = rows.find((r) => r.chosen === "hmid");
const shape = (messages) => messages.map((m) => (m.role === "assistant" ? `A${(m.calls ?? []).length ? `(${m.calls.map((c) => c.id.slice(-2)).join(",")})` : ""}` : m.role === "tool" ? `T(${m.id.slice(-2)})` : "U")).join(" ");
console.log(`\nhmid 选中时留下的 ${hmid.messages.length} 条：${shape(hmid.messages)}`);
console.log("U 是用户消息（含中途补充的那句，受保护），A(..) 是带调用的 assistant 消息，T(..) 是它的结果。删除永远是整组：assistant 消息和它的全部结果一起走，不会留下孤立的一半。");

const callsOf = (messages) => new Set(messages.flatMap((m) => (m.calls ?? []).map((c) => c.id)));
const resultsOf = (messages) => new Set(messages.filter((m) => m.role === "tool").map((m) => m.id));
const paired = (messages) => [...callsOf(messages)].every((id) => resultsOf(messages).has(id)) && [...resultsOf(messages)].every((id) => callsOf(messages).has(id));

assert.deepEqual(rows.map((r) => r.chosen), ["h0", "hall", "hmid", "hmid", "hmin", undefined]);
for (const r of rows.filter((r) => r.messages)) assert.ok(paired(r.messages), `${r.chosen} 没有拆开工具回合`);
assert.ok(paired(hmid.messages), "hmid：调用和结果成对留下或成对删除");
assert.ok(rows.find((r) => r.chosen === "hall").messages.some((m) => m.text === "[Tool result removed by context compaction.]"));
assert.ok(hmid.messages.some((m) => m.text?.includes("中途补充")), "含用户消息的组受保护");
