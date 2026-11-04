// 实验：两个进程同时往同一个会话发消息。
//   node labs/ch01/busy.mjs
// 终端里的 mcode（进程 P）正在重构；编辑器通过 ACP 拉起的 mcode acp（进程 Q）在 P 还没结束时也发来一条。
// 两个进程各自 createApplication，数据目录相同。
import assert from "node:assert/strict";
import { concurrentSend, markdownTable } from "./scenarios.mjs";

for (const shared of [false, true]) {
  const r = await concurrentSend({ shared });
  console.log(shared ? "### 租约：“忙”写在共享的锁日志里\n" : "### 上一版：“忙”只记在各自的内存里\n");
  console.log(
    markdownTable([
      { 进程: "终端 P", 入口: "tui", 接纳: "是", 模型开工时看到的消息数: r.seen.find((s) => s.who === "终端 P").messages, 结局: r.pResult.outcome.status },
      r.qAdmitted
        ? { 进程: "编辑器 Q", 入口: "acp", 接纳: "是（和 P 同时在跑）", 模型开工时看到的消息数: r.seen.find((s) => s.who === "编辑器 Q").messages, 结局: r.qOutcome.result.outcome.status }
        : { 进程: "编辑器 Q", 入口: "acp", 接纳: "否", 模型开工时看到的消息数: "-", 结局: `ACP 错误 ${r.qOutcome.error.code}：${r.qOutcome.error.message}` },
    ]),
  );
  console.log();
  if (r.qAdmitted) {
    console.log(`- Q 的模型看到 ${r.seen.find((s) => s.who === "编辑器 Q").messages} 条消息：它不知道 P 正在重构 slug.js，照样去“跑一遍测试”。`);
  } else {
    const holder = r.holderWhileQSends;
    const form = holder.ownerId.replace(/^turn-lease:\d+:[^.]+\./, "turn-lease:<pid>:<进程实例号>.").replace(/\.[0-9a-f-]{36}$/, ".<turnId>");
    console.log(`- Q 发消息的时候，锁日志里的持有者是 \`${form}\`（P 的 Turn）。Q 在入口就被拒绝，模型一次都没有被调用。`);
    console.log(`- P 结束、释放租约以后，Q 重试成功；这一次它的模型看到 ${r.seen.find((s) => s.who === "编辑器 Q（重试）").messages} 条消息（P 的一问一答，加上 Q 自己的新问题）。`);
  }
  console.log(`- 会话历史（按写入顺序）：${r.history.map((m) => `${m.role}「${m.text}」`).join(" → ")}`);
  console.log(`- 锁日志：${r.lockEvents.length ? r.lockEvents.map((e) => `${e.type}(${e.who})`).join(" → ") : "（空：内存标志不留痕迹）"}`);
  console.log();

  if (shared) {
    assert.equal(r.qAdmitted, false);
    assert.equal(r.qOutcome.error.code, -32603);
    assert.match(r.qOutcome.error.message, /session busy/);
    assert.equal(r.qOutcome.error.data.code, "local_session_busy");
    assert.equal(r.seen.find((s) => s.who === "编辑器 Q（重试）").messages, 3);
    assert.deepEqual(r.history.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual(r.activeAfter, [0, 0]);
  } else {
    assert.equal(r.qAdmitted, true);
    assert.equal(r.seen.find((s) => s.who === "编辑器 Q").messages, 1);
  }
}
