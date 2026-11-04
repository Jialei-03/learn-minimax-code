// 实验：改了这些文件，该走哪一档验证？运行 MiniMax 自己的 verify.mjs --list 和 ci-changes.mjs。
//   node labs/ch11/gates.mjs
import assert from "node:assert/strict";
import { changePlans, gateMatrix, markdownTable, suiteInventory } from "./scenarios.mjs";

const matrix = gateMatrix();
console.log(`\`scripts/verify.mjs --list\` 在本机（${matrix.platform}）上列出的门禁，● 表示该档会跑：\n`);
console.log(markdownTable(matrix.rows));

const inventory = suiteInventory();
console.log("\n`test/vitest-suites.json` 登记的测试文件：\n");
console.log(markdownTable(inventory.groups));
console.log(`\n其中位于 third_party/ 下的测试文件：${inventory.vendorFiles.length} 个。\n`);

const plans = await changePlans();
console.log("`scripts/ci-changes.mjs` 的 classifyChanges 加上课程里的 verificationPlan：\n");
console.log(
  markdownTable(
    plans.map((p) => ({
      改动: p.name,
      验证档: p.plan.profile,
      提醒: p.plan.advice.join("；") || "—",
    })),
  ),
);

assert.ok(matrix.plans.docs.length < matrix.plans.full.length);
assert.equal(inventory.vendorFiles.length, 0);
assert.deepEqual(plans.map((p) => p.plan.profile), ["docs", "full", "full", "full"]);
