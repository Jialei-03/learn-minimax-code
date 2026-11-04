// 实验：真实的 AgentHostTurnCapabilityLifecycle。发现慢不挡路，发布门才挡路；旧代等最后一个租约。
//   node labs/ch08/gate.mjs
import assert from "node:assert/strict";
import { gateScenario, markdownTable, realSystem } from "./scenarios.mjs";

const events = await gateScenario(await realSystem());
console.log("真实的 acquire / tryPublish / registry；PluginSystem 的角色由一个 20 行的迷你实现扮演。\n");
console.log(markdownTable(events.map((event, i) => ({ "#": i + 1, ...event }))));

const find = (who, prefix) => events.findIndex((e) => e.谁 === who && e.发生了什么.startsWith(prefix));
const [turnB, turnC] = [find("Turn B", "acquire →"), find("Turn C", "acquire 返回")];
assert.match(events[turnB].发生了什么, /r1/, "B 在发现期间拿到的是旧代 r1");
assert.match(events[turnC].发生了什么, /r2/, "C 等到门打开，拿到的是新代 r2");
assert.ok(turnC > find("更新", "commit 完成"), "C 在 commit 完成之后才返回");
assert.ok(turnB < find("更新", "候选 r2 发现完成"), "B 不用等发现完成");
const [release, close, finalizer] = [find("Turn B", "release"), find("r1 的运行时", "close"), find("r1 的 finalizer", "执行")];
assert.ok(find("Turn A", "release") < release, "A 先释放，r1 还有 B 的租约");
assert.equal(close, release + 1, "最后一个租约（B）一释放，r1 就 close");
assert.equal(finalizer, close + 1, "finalizer 紧跟在 close 之后");
assert.equal(events.filter((e) => e.谁 === "r1 的运行时").length, 1, "r1 只关一次");
