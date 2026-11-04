// 实验：什么时候压缩。
//   node labs/ch06/trigger.mjs
// 触发线来自 MiniMax 的真实函数 `resolveCompactionTokenBudget`（importSource 从固定提交装载），
// host 的 `compactionBudget` 再拿同样的输入对一遍。
import assert from "node:assert/strict";
import { markdownTable, triggerTable } from "./scenarios.mjs";

const { rows, settings, compared, mismatches } = await triggerTable();

console.log("同一个窗口，输出预算配得不同，自动压缩的触发线各在哪里（MiniMax 一列是真实函数的结果）：\n");
console.log(markdownTable(rows.map((r) => r.row)));

console.log("\n用户可以在配置里写 contextManagement.compactionTriggerAt。200K 窗口、8.2K 输出，内置触发线是 182217：\n");
const explain = { 0.5: "窗口的一半", 80_000: "绝对 token 数", 0.99: "比例换算后高于内置触发线，不生效", 1.5: "大于 1 的小数，无效，忽略", [-1]: "非正数，无效，忽略" };
console.log(
  markdownTable(
    settings.map(({ triggerAt, real }) => ({ 设置值: triggerAt, 实际触发线: real.automaticTriggerAt, 说明: explain[triggerAt] })),
  ),
);

console.log(`\nhost 的 compactionBudget 和上游的函数在 ${compared} 组输入（窗口 × 输出预算 × 用户设置）上逐一对比：${mismatches.length === 0 ? "完全一致" : `${mismatches.length} 处不同`}。`);

assert.equal(mismatches.length, 0);
assert.equal(rows[3].real.automaticTriggerAt, 142_500, "200K 窗口、64K 输出：触发线是 142.5K");
assert.ok(rows[3].real.automaticTriggerAt < rows[3].real.providerInputLimit, "触发线低于请求上限");
assert.equal(settings[0].real.automaticTriggerAt, 100_000);
assert.equal(settings[2].real.automaticTriggerAt, settings[4].real.automaticTriggerAt, "设置值调不高：和没设置一样");
