// 实验：同样的事件、同样时快时慢的 writer，直接写 vs. 串行队列。
//   node labs/ch02/order.mjs
import assert from "node:assert/strict";
import { deliveryOrder, markdownTable } from "./scenarios.mjs";

const { rows, naive, serial, produced } = await deliveryOrder();

/** 到达顺序和产生顺序不一致的帧对数：一对 (i, j)，i 先产生，却比 j 晚到。 */
const inversions = (arrived) =>
  produced.flatMap((a, i) => produced.slice(i + 1).filter((b) => arrived.indexOf(b) < arrived.indexOf(a)).map((b) => [a, b]));

console.log("一个带两个并行工具的 Turn 按下表的时刻产生 8 个事件。writer 写“工具 a 的开始”和“消息的完成”各要 100ms，其余每帧 3ms。\n");
console.log(markdownTable(rows));
console.log();
for (const [label, arrived] of [["朴素直写", naive], ["串行队列", serial]]) {
  const pairs = inversions(arrived);
  console.log(`- ${label}：${pairs.length} 处到达顺序和产生顺序相反`);
  for (const [a, b] of pairs) console.log(`  - “${a}”先产生，却比“${b}”晚到`);
}

assert.deepEqual(serial, produced);
assert.ok(inversions(naive).length > 0);
