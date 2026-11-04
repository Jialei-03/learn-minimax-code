// 实验：同一段事件流，朴素合并 vs. 真实的 ItemAccumulator。
//   node labs/ch10/accumulate.mjs
import assert from "node:assert/strict";
import { accumulation, markdownTable } from "./scenarios.mjs";

const { steps, variants } = await accumulation();

console.log(
  "合成一段事件流，让它同时撞上三个坑：消息 a 和思考 r 的文字是增量，而且两次增量的内容相同；" +
    "工具 t 是快照，而且有一份重复；三个 item 的事件交错在一起；最后 a 和 t 完成了，r 没有（比如 Turn 被取消）。" +
    "先看真实的折叠器一步一步做了什么（✓ 表示这个 item 已经收到 item.completed）：\n",
);
console.log(markdownTable(steps));
console.log("\n再看五种朴素做法，每一种只在一条规则上和上游不同：\n");
console.log(markdownTable(variants));

const row = (name) => variants.find((variant) => variant.做法.startsWith(name));
assert.equal(steps[2]["apply() 返回"], false); // 第 3 步：重复的快照被丢弃
assert.equal(steps[3]["apply() 返回"], true); // 第 4 步：内容相同的增量照样追加
assert.equal(row("ItemAccumulator").a, "haha");
assert.equal(row("ItemAccumulator").r, "想想");
assert.equal(row("ItemAccumulator").r完成了吗, "否（incomplete）");
assert.equal(row("按文字去重").r, "想");
assert.equal(row("完成帧的 content").a, "hahahaha");
assert.equal(row("结束时一律").r完成了吗, "是（错）");
