// 第 2 章回归实验：一个 Turn 的一生。
//   node labs/chapters/02-turn.mjs          打印实验过程和每项检查
//   node labs/chapters/02-turn.mjs --json   构建模式
// 场景本身在 labs/ch02/scenarios.mjs，正文里嵌入的是 labs/ch02/*.mjs 打印的表格。
import { lesson } from "./harness.mjs";
import { SerialDelivery } from "../../host/src/events.mjs";
import { runTurn } from "../../host/src/turns.mjs";
import { scriptedKernel } from "../../host/src/models.mjs";
import { deliveryOrder, lifecycle, endings } from "../ch02/scenarios.mjs";

await lesson(2, "一个 Turn 的一生：串行交付、历史边界与终态顺序", async (t) => {
  // ── 一、串行队列 ──────────────────────────────────────────────
  t.log("一、同一份事件，直接写和串行队列各自的到达顺序");
  const order = await deliveryOrder();
  t.table(order.rows);
  t.equal("串行队列：到达顺序等于产生顺序", order.serial, order.produced);
  t.ok(
    "直接写：工具 a 的开始被工具 b 的结束超过",
    order.naive.indexOf("item.started 工具 a") > order.naive.indexOf("item.completed 工具 b"),
  );
  t.ok(
    "直接写：turn.completed 排到了最后一条消息完成之前",
    order.naive.indexOf("turn.completed") < order.naive.indexOf("item.completed 消息"),
  );

  t.log("首个 writer 被卡住时，后面的帧在队列里等着，不能抢先：");
  const written = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const queue = new SerialDelivery(async (frame) => {
    if (frame.n === 1) await gate;
    written.push(frame.n);
  });
  queue.send({ n: 1 });
  queue.send({ n: 2 });
  queue.send({ n: 3 });
  await Promise.resolve();
  t.log(`  卡住期间：已写出 ${written.length} 帧，队列里有 ${queue.pending} 帧在等`);
  t.equal("卡住期间没有任何帧被写出", written, []);
  t.equal("卡住期间三帧都在排队", queue.pending, 3);
  release();
  await queue.drain();
  t.equal("放行后按入队顺序写出", written, [1, 2, 3]);

  t.log("队列一旦出过错：普通帧被跳过，force 的帧仍然会写；drain 抛出第一个错误。");
  const seen = [];
  const broken = new SerialDelivery(async (frame) => {
    if (frame.n === 1) throw Error("first failure");
    seen.push(frame.n);
  });
  broken.send({ n: 1 });
  broken.send({ n: 2 });
  broken.send({ n: 3 }, { force: true });
  await t.rejects("drain 抛出第一个失败", broken.drain(), /first failure/);
  t.equal("n=2 被跳过，n=3（force）写出", seen, [3]);
  t.equal("跳过的帧被计数", broken.skipped, 1);

  // ── 二、历史和事件的先后 ─────────────────────────────────────────
  t.log("\n二、一个带两个并行工具的 Turn：事件帧和历史写入按什么顺序发生");
  const { rows, result } = await lifecycle();
  t.table(rows);
  const index = (test) => rows.findIndex(test);
  t.ok(
    "带调用的 assistant 消息先写进历史，之后才有工具的开始帧",
    index((r) => r.通道 === "历史写入") < index((r) => r.内容.includes("item.started 工具")),
  );
  t.ok(
    "工具结果先写进历史，之后才有 assistant 消息的 completed",
    index((r) => r.内容 === "tool a、tool b") < index((r) => r.内容.startsWith("#8 item.completed 消息 1")),
  );
  t.ok(
    "快工具先结束，历史里的结果仍按调用顺序",
    index((r) => r.内容.includes("fast_b → completed")) < index((r) => r.内容.includes("slow_a → completed")) &&
      result.messages.filter((m) => m.role === "tool").map((m) => m.id).join() === "a,b",
  );
  t.ok("assistant 消息的 completed 带着每个调用的最终状态", rows.some((r) => r.内容.includes("（slow_a:completed fast_b:completed）")));
  t.equal("终态帧是最后一帧", rows.at(-1).内容, "#12 turn.completed（completed）");
  t.equal("12 帧的序号从 1 连续到 12，没有空洞", result.seq, 12);

  // ── 三、七种结局 ──────────────────────────────────────────────
  t.log("\n三、同一个 Turn 的七种结局");
  const { rows: endingRows, runs } = await endings();
  t.table(endingRows);
  const by = Object.fromEntries(runs.map((run) => [run.name, run]));
  t.equal("正常结束：edit 执行了，终态是 completed", [by["正常结束"].fileChanged, by["正常结束"].result.status], [true, "completed"]);
  t.equal("取消：终态是 cancelled，不算失败", [by["用户在工具运行时取消"].result.status, by["用户在工具运行时取消"].result.failure], ["cancelled", undefined]);
  t.equal("模型出错：归因到 model", by["模型请求失败"].result.failure.source, "model");
  t.equal(
    "writer 失败：归因到 event_writer，edit 没有执行，失败终态仍然送达",
    [by["writer 在第一段文字上失败"].result.failure.source, by["writer 在第一段文字上失败"].fileChanged, by["writer 在第一段文字上失败"].last],
    ["event_writer", false, "turn.completed(failed)"],
  );
  t.equal(
    "历史写失败：归因到 history，edit 没有执行",
    [by["历史写不进去"].result.failure.source, by["历史写不进去"].fileChanged, by["历史写不进去"].result.persisted],
    ["history", false, false],
  );
  t.equal(
    "钩子否决：整条回复里的工具一个都没执行，被剥掉调用的回复仍写进了历史",
    [by["afterModel 钩子否决回复"].fileChanged, by["afterModel 钩子否决回复"].history.find((m) => m.role === "assistant").calls],
    [false, []],
  );
  t.equal("终态帧写不出去：不能报告成功", [by["终态帧写不出去"].result.status, by["终态帧写不出去"].result.delivered], ["failed", false]);

  // 钩子自己抛错也按否决处理
  const throwing = await runTurn({
    sessionId: "s",
    turnId: "hook",
    text: "go",
    root: t.root,
    prompt: { system: [] },
    model: scriptedKernel([{ text: "x", calls: [{ id: "1", name: "edit", input: {} }] }]),
    hooks: { afterModel: () => { throw Error("hook crashed"); } },
    write: async () => {},
    persist: async () => {},
  });
  t.equal("钩子抛错：fail closed，失败归因到钩子", [throwing.status, throwing.failure.source], ["failed", "after_llm_hook"]);

  // ── 四、旧约定仍然成立 ──────────────────────────────────────────
  const frames = [];
  const history = [];
  const normal = await runTurn({
    sessionId: "s",
    turnId: "t",
    text: "go",
    root: t.root,
    prompt: { system: [] },
    model: async () => ({ text: "done" }),
    write: async (frame) => frames.push(frame),
    persist: async (messages) => history.push(...messages),
  });
  t.equal("返回值：模型文字 + 终态帧，历史里是一问一答", [normal.status, frames.at(-1).type, history.length], ["completed", "turn.completed", 2]);
  t.observations.events = frames.map((frame) => ({ seq: frame.seq, type: frame.type }));
});
