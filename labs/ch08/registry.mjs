// 实验：真实的 PluginCapabilityGenerationRegistry，每一步之后各代的状态。
//   node labs/ch08/registry.mjs
import assert from "node:assert/strict";
import { markdownTable, registryTour, relabelHazard } from "./scenarios.mjs";

const { rows, log } = await registryTour();
console.log("上游代码，runtime.close 只记日志。Turn A、B 持有 r1，更新发布 r2，Turn C 持有 r2。\n");
console.log(markdownTable(rows));

const byStep = (n) => rows.find((row) => row.步骤 === n);
assert.equal(byStep(3).r1, "退休，租约 2");
assert.equal(byStep(3).本步新增日志, "—", "有租约的旧代不能清理");
assert.equal(byStep(5).r1, "退休，租约 1");
assert.equal(byStep(6).r1, "已销毁");
assert.equal(byStep(6).本步新增日志, "close r1 → finalize r1", "先关运行时，再跑 finalizer");
assert.equal(byStep(7).本步新增日志, "—", "重复释放不会再清理一次");
assert.equal(byStep(8).本步新增日志, "抛出 SNAPSHOT_GENERATION_MISSING");
assert.equal(byStep(9).r2, "已销毁", "dispose 无视租约");
assert.deepEqual(log, ["close r1", "finalize r1", "close r2"]);

const hazard = await relabelHazard();
console.log("\n对照：replaceRevision 只换标签，新条目的租约从 0 开始。\n");
console.log(markdownTable(hazard));
assert.equal(hazard[2].本步新增日志, "close r1", "Turn A 还在用，运行时却被关了");
