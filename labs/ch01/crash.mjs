// 实验：拿着租约的进程崩了，会话会一直忙下去吗？
//   node labs/ch01/crash.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sessions } from "../../host/src/sessions.mjs";
import { markdownTable, tempWorld } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** 试着接纳一个 Turn，把结果写成一个词。 */
const tryAdmit = (sessions, id, turnId) => {
  try {
    sessions.admit(id, turnId);
    return "接纳";
  } catch (error) {
    return `拒绝（${error.code}）`;
  }
};
/** 一个已经失去租约的 Turn 想写历史。 */
const tryAppend = (sessions, id, turnId) => {
  try {
    sessions.append(id, turnId, [{ role: "assistant", text: "迟到的回复" }]);
    return "写进了历史";
  } catch (error) {
    return `拒绝：${error.message}`;
  }
};
const recorded = (sessions) => sessions.recoveries().map((r) => `${r.turnId}：${r.reason}`).join("；") || "无";

// ─── 一、续租能续住，不续就过期 ────────────────────────────────────────────────
{
  const world = tempWorld();
  let clock = 0; // 假时钟（毫秒）。整个场景是同步的，不会触发真实的续租定时器。
  const options = { now: () => clock, leaseMs: 1000 };
  const A = new Sessions(world.data, options); // 持有者
  const B = new Sessions(world.data, options); // 想接手的另一个“进程”（同一个数据目录）
  const session = A.create(world.workspace);
  const rows = [];
  const step = (ms, 动作, 结果) => {
    clock = ms;
    rows.push({ 时刻: `${ms} ms`, 动作, 结果: 结果() });
  };

  step(0, "A 接纳 turn-A（租约 1000ms）", () => tryAdmit(A, session.id, "turn-A"));
  step(500, "B 想接纳 turn-B", () => tryAdmit(B, session.id, "turn-B"));
  step(600, "A 续租", () => (A.renew(session.id, "turn-A") ? "续上了，到期时间推到 1600" : "续不上"));
  step(1500, "B 想接纳 turn-B（A 续过租，没到期）", () => tryAdmit(B, session.id, "turn-B"));
  step(1700, "B 想接纳 turn-B（A 没再续租，已到期）", () => tryAdmit(B, session.id, "turn-B"));
  step(1700, "回收记录", () => recorded(B));
  step(1800, "A 这时才回来：续租", () => (A.renew(session.id, "turn-A") ? "续上了" : "续不上，租约已经不是 turn-A 的"));
  step(1800, "A 这时才回来：写历史", () => tryAppend(A, session.id, "turn-A"));

  console.log("### 一、续租能续住，不续就过期\n");
  console.log("A、B 是两个 `Sessions` 实例，共用一个数据目录。两个实例都在本进程里，所以“持有者的进程还活着”，只能靠租约到期来回收。时间用假时钟，租约 1000ms。\n");
  console.log(markdownTable(rows));
  console.log();
  assert.deepEqual(rows.slice(0, 5).map((r) => r.结果), ["接纳", "拒绝（local_session_busy）", "续上了，到期时间推到 1600", "拒绝（local_session_busy）", "接纳"]);
  assert.equal(B.recoveries()[0].reason, "expired-lease");
  assert.match(rows[7].结果, /lease lost/);
  world.cleanup();
}

// ─── 二、持有者的进程被 kill -9：不用等租约到期 ─────────────────────────────────
{
  const world = tempWorld();
  const B = new Sessions(world.data); // 默认租约：30 分钟
  const session = B.create(world.workspace);
  const child = spawn(process.execPath, [join(here, "holder.mjs"), world.data, session.id, "turn-A"], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(child.stdout, "data");
  assert.match(String(line), /ADMITTED/);
  const rows = [];
  const step = (动作, 结果) => rows.push({ 动作, 结果 });

  step("子进程（真实的 node 进程）接纳 turn-A，并一直运行", "锁日志：acquire(turn-A)");
  step("本进程想接纳 turn-B", tryAdmit(B, session.id, "turn-B"));
  child.kill("SIGKILL"); // 没有机会释放租约，也没有机会续租
  await once(child, "exit");
  step("`kill -9` 子进程", "锁日志里还是只有 acquire(turn-A)，没有 release");
  step("本进程再次想接纳 turn-B", tryAdmit(B, session.id, "turn-B"));
  step("回收记录", recorded(B));
  step("turn-A 的僵尸想写历史", tryAppend(B, session.id, "turn-A"));

  console.log("### 二、持有者被 `kill -9`：不用等 30 分钟\n");
  console.log("持有者是真实的子进程（`labs/ch01/holder.mjs`），租约是默认的 30 分钟，锁日志里的 `ownerId` 写着它的 pid。\n");
  console.log(markdownTable(rows));
  console.log();
  assert.equal(rows[1].结果, "拒绝（local_session_busy）");
  assert.equal(rows[3].结果, "接纳");
  assert.equal(B.recoveries()[0].reason, "owner-dead");
  world.cleanup();
}
