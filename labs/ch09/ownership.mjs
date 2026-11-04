// 实验：取消的所有权——abort() 发出之后，会话什么时候才能接纳下一个 Turn。运行的是上游真实的 TurnController。
//   node labs/ch09/ownership.mjs
import assert from "node:assert/strict";
import { markdownTable, steering } from "./scenarios.mjs";

const result = await steering();

console.log("一个 Turn 被 abort 之后，按顺序观察 controller：\n");
console.log(markdownTable(result.ownership));

assert.match(result.sessionBusy, /Turn already active/);
assert.equal(result.timeout.status, "abort-timeout");
