// 第 10 章逐章回归实验：对外协议——从交错的事件到可信的结果。
//   node labs/chapters/10-sdk-events.mjs          读者模式：打印过程和每项检查
//   node labs/chapters/10-sdk-events.mjs --json   构建模式
// 分块的小实验在 labs/ch10/ 下（stream / accumulate / outcomes / protocols / replay），
// 共用的场景在 labs/ch10/scenarios.mjs；这里把它们串起来，再补上 collector 和 EventStore 的细节检查。
import { lesson, ROOT } from "./harness.mjs";
import { join } from "node:path";
import { runProcess } from "../../runtime/process.mjs";
import { collector, requireSuccess, TurnError } from "../../host/src/sdk.mjs";
import { EventStore } from "../../host/src/events.mjs";
import {
  accumulation,
  exitMapping,
  failureRecordings,
  foldRecording,
  parseCases,
  projections,
  reconnects,
} from "../ch10/scenarios.mjs";

await lesson(10, "对外协议：从交错的事件到可信的结果", async (t) => {
  // ─── 一、真实录像：31 个事件，5 个 item ────────────────────────────────────
  t.log("一、真实录像（上游 SDK 测试夹具 success-tools.jsonl）喂给真实的 ItemAccumulator");
  const recorded = await foldRecording("success-tools");
  t.table(recorded.itemRows);
  t.log(`  ${recorded.events.length} 个事件 → ${recorded.items.length} 个 item；丢弃的重复快照：序号 ${recorded.dropped.join("、")}\n`);
  t.equal("录像共 31 个事件", recorded.events.length, 31);
  t.equal("重复的快照正好是序号 7、10、20、21（上游 stream.test.ts 里断言的同一组）", recorded.dropped, [7, 10, 20, 21]);
  t.equal("5 个 item 全部完成", recorded.items.map((item) => item.incomplete ?? false), [false, false, false, false, false]);
  t.equal(
    "最终回答 exec.completed.result.output 与最后一条消息一致",
    recorded.result.output,
    recorded.items.filter((item) => item.type === "agent_message").at(-1).text,
  );

  // ─── 二、交错、重复、增量：朴素做法各坏一次 ──────────────────────────────────
  t.log("\n二、同一段合成事件流：朴素做法 vs. 真实的折叠器");
  const { steps, variants } = await accumulation();
  t.table(variants);
  const pick = (name) => variants.find((variant) => variant.做法.startsWith(name));
  t.equal("第 3 步的重复快照被丢弃", steps[2]["apply() 返回"], false);
  t.equal("第 4 步内容相同的增量仍然追加", steps[3]["apply() 返回"], true);
  t.equal("ItemAccumulator：a 是 haha，r 是想想，r 没有完成", [pick("ItemAccumulator").a, pick("ItemAccumulator").r, pick("ItemAccumulator").r完成了吗], ["haha", "想想", "否（incomplete）"]);
  t.equal("按文字去重会吞掉合法的重复增量", pick("按文字去重").r, "想");
  t.equal("把完成帧当增量会得到 hahahaha", pick("完成帧的 content").a, "hahahaha");

  // ─── 三、没有结果就是失败 ────────────────────────────────────────────────
  t.log("\n三、没有结果就是失败：逐行解析、退出码、坏结局的录像");
  const parsed = await parseCases();
  t.equal(
    "stdout 上的非 JSON 行是协议错误，schemaVersion 不符是版本错误，未知事件类型放行",
    parsed.map((row) => row.错误类型),
    ["-", "MCodeProtocolError", "MCodeProtocolError", "MCodeVersionError", "MCodeProtocolError", "MCodeProtocolError", "MCodeProtocolError", "-"],
  );
  const { rows: exitRows } = await exitMapping();
  for (const row of exitRows.filter((r) => r.fromResult)) {
    t.equal(
      `${row.CLI结果}：有 exec.completed 和只有退出码 ${row.退出码}，SDK 抛出同一类错误`,
      [row.fromExit.constructor, row.fromExit.status, row.fromExit.category],
      [row.fromResult.constructor, row.fromResult.status, row.fromResult.category],
    );
  }
  t.equal("退出码 0 却没有 exec.completed 是协议错误", exitRows[0].fromExit.constructor.name, "MCodeProtocolError");
  const [cancelled, failed] = await failureRecordings();
  t.equal("取消的录像：MCodeAbortError，带着两个 incomplete 的 item", [cancelled.error.constructor.name, cancelled.error.items.map((item) => item.incomplete)], ["MCodeAbortError", [true, true]]);
  t.equal("上游报错的录像：MCodeRunError，retryable", [failed.error.constructor.name, failed.error.status, failed.error.retryable], ["MCodeRunError", "failed", true]);

  // ─── 四、同一份内部事件，exec 和 ACP 各说什么 ─────────────────────────────────
  t.log("\n四、同一份内部事件，两个真实的投影器");
  const { rows: projected, detail, terminal } = await projections();
  t.table(projected);
  const [, , lo, same, , full] = detail;
  t.equal("exec 把没有变化的工具快照原样发了两次，留给客户端去重", lo.execEvents[1].item, same.execEvents[0].item);
  t.equal("exec 的结尾是 turn.completed 和 exec.completed", terminal.map((event) => event.type), ["turn.completed", "exec.completed"]);
  t.equal("ACP 对工具先发 tool_call，之后发 tool_call_update", [lo.acpUpdates[1].sessionUpdate, same.acpUpdates[0].sessionUpdate], ["tool_call", "tool_call_update"]);
  t.equal("ACP 不重发已经流式发出过的完整消息", full.acpUpdates, []);

  // ─── 五、host 的 collector：身份、连续、幂等、终态 ─────────────────────────────
  t.log("\n五、host 的 collector 对账规则");
  const sink = await collector("T");
  let seq = 0;
  const frame = (type, extra = {}) => ({ sessionId: "s", turnId: "T", seq: ++seq, type, ...extra });
  const message = (id, extra) => ({ item: { id, type: "agent_message", ...extra } });
  sink.apply(frame("item.started", message("a")));
  sink.apply(frame("item.updated", message("a", { contentDelta: "ha" })));
  sink.apply(frame("item.updated", message("b", { content: "other" })));
  sink.apply(frame("item.updated", message("a", { contentDelta: "ha" })));
  const snapshot = frame("item.updated", message("a", { content: "haha" }));
  sink.apply(snapshot);
  t.equal("同一帧被重复投递：幂等地忽略", sink.apply(snapshot), false);
  t.equal("重复的快照（新序号、同内容）：由上游折叠器丢弃", sink.apply(frame("item.updated", message("a", { content: "haha" }))), false);
  sink.apply(frame("item.completed", message("a", { content: "haha" })));
  t.equal("别的 Turn 的帧不会污染这个 Turn", sink.apply({ turnId: "other", seq: 1, type: "item.updated" }), false);
  t.equal("终态之前的结果是 incomplete", sink.result().status, "incomplete");
  sink.apply(frame("turn.completed", { status: "completed" }));
  t.equal("相同的增量都保留：a 是 haha", sink.result().items[0].text, "haha");
  t.equal("没有 item.completed 的 item 保持 incomplete", sink.result().items[1].incomplete, true);
  t.equal("sessionId 取自第一帧", sink.result().sessionId, "s");
  t.throws("终态之后再来一帧是错误", () => sink.apply(frame("item.started", message("c"))), /after terminal/);
  t.throws("同一序号内容不同是冲突", () => sink.apply({ ...snapshot, item: { ...snapshot.item, content: "不一样" } }), /sequence conflict/);
  const gap = await collector("G");
  t.throws("跳号暴露丢帧，而不是悄悄拼起来", () => gap.apply({ turnId: "G", seq: 2, type: "turn.started" }), /sequence gap: expected #1, got #2/);

  // requireSuccess：对应 Thread.run 只在成功时返回
  const open = await collector("O");
  open.apply({ sessionId: "s", turnId: "O", seq: 1, type: "turn.started" });
  t.throws("还没有终态的 Turn：requireSuccess 抛出 TurnError", () => requireSuccess(open.result()), TurnError);
  const failedTurn = await collector("F");
  failedTurn.apply({ sessionId: "s", turnId: "F", seq: 1, type: "item.started", item: { id: "x", type: "agent_message" } });
  failedTurn.apply({ sessionId: "s", turnId: "F", seq: 2, type: "turn.completed", status: "cancelled" });
  let thrown;
  try {
    requireSuccess(failedTurn.result());
  } catch (error) {
    thrown = error;
  }
  t.equal("取消的 Turn：错误带着状态、sessionId 和 incomplete 的 items", [thrown.status, thrown.sessionId, thrown.items.map((item) => item.incomplete)], ["cancelled", "s", [true]]);
  t.equal("完成的 Turn：requireSuccess 原样返回", requireSuccess(sink.result()).status, "completed");

  // ─── 六、EventStore：写入规则与游标 ──────────────────────────────────────────
  t.log("\n六、EventStore 的写入规则和游标");
  const store = new EventStore(join(t.temp, "store.jsonl"));
  store.append({ sessionId: "s", turnId: "T", seq: 1, type: "turn.started" });
  store.append({ sessionId: "s", turnId: "T", seq: 2, type: "turn.completed", status: "completed" });
  store.append({ sessionId: "s", turnId: "U", seq: 1, type: "turn.started" });
  t.throws("没有 turnId 的帧被拒绝", () => store.append({ sessionId: "s", seq: 1, type: "turn.started" }), /identity or sequence/);
  t.throws("跳号的帧被拒绝", () => store.append({ sessionId: "s", turnId: "U", seq: 3, type: "item.started" }), /identity or sequence/);
  t.throws("终态之后的帧被拒绝", () => store.append({ sessionId: "s", turnId: "T", seq: 3, type: "item.started" }), /event after terminal/);
  t.equal("replay() 返回全部 Turn 的帧", store.replay().length, 3);
  t.equal("replay(turnId, afterSeq) 只返回游标之后的帧", store.replay("T", 1).map((f) => f.seq), [2]);
  t.equal("游标正好在最后一帧：返回空（已追平）", store.replay("T", 2), []);
  t.throws("游标超过最后一帧：无效游标", () => store.replay("T", 3), /invalid cursor/);
  t.equal("lastSeq 按 Turn 分别统计", [store.lastSeq("T"), store.lastSeq("U"), store.lastSeq("none")], [2, 1, 0]);

  // ─── 七、断线重连：真实的 host Turn ───────────────────────────────────────────
  t.log("\n七、客户端在第 5 帧之后断线，用八种办法接上");
  const reconnect = await reconnects(5);
  t.table(reconnect.rows.map(({ error, ...row }) => row));
  const by = (name) => reconnect.rows.find((row) => row.办法 === name);
  t.equal(
    "从游标继续、整段重放（重叠）、新客户端整段重放：都与一直在线一致",
    ["从游标继续", "整段重放，和已收到的重叠", "新客户端，整段重放"].map((name) => by(name)["与一直在线一致"]),
    ["是", "是", "是"],
  );
  t.ok("新客户端只拿游标之后的帧：暴露缺口", /expected #1, got #6/.test(by("新客户端，只重放游标之后").error.message));
  t.ok("游标往后跳一格：暴露缺口", /expected #6, got #7/.test(by("游标往后跳了一格").error.message));
  t.ok("重放的帧被改过：暴露冲突", /sequence conflict: #3/.test(by("重放的帧和之前不一样").error.message));
  t.ok("无效游标：EventStore 拒绝", /invalid cursor/.test(by("游标超过最后一帧").error.message));

  // ─── 八、真实的子进程：host CLI 经管道交付，collector 在另一端还原 ──────────────
  t.log("\n八、真实子进程：host CLI 把帧写到 stdout，collector 在管道另一端还原");
  const child = await runProcess(
    process.execPath,
    [join(ROOT, "host/src/cli.mjs"), t.root, join(t.temp, "cli-data")],
    {
      cwd: t.root,
      input: JSON.stringify({ type: "user", text: "hello", replies: [{ text: "child done" }] }) + "\n",
      maxBytes: 100000,
    },
  );
  t.equal("host CLI 在 stdin 关闭后正常退出", child.code, 0);
  const frames = child.stdout.trim().split("\n").map(JSON.parse);
  const piped = await collector(frames[0].turnId);
  for (const f of frames) piped.apply(f);
  t.equal("管道另一端的 collector 还原出 completed 和一条消息", [piped.result().status, piped.result().items.map((item) => item.text)], ["completed", ["child done"]]);
  t.observations.childProtocol = frames.map((f) => ({ type: f.type, status: f.status }));
  t.observations.result = piped.result();
  t.observations.recording = { events: recorded.events.length, items: recorded.items.length, dropped: recorded.dropped };
});
