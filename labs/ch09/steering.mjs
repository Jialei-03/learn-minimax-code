// 实验：同一组插话操作，交给 MiniMax 真实的 TurnController 和 host 的 SteeringBuffer，看结果是否逐行一致。
//   node labs/ch09/steering.mjs
import assert from "node:assert/strict";
import { markdownTable, steering } from "./scenarios.mjs";

const result = await steering();

console.log("同一个会话先后跑两个 Turn。每一行的操作先对上游的 createTurnController() 执行，再对 host 的 SteeringBuffer 执行：\n");
console.log(markdownTable(result.rows));
console.log(`\n${result.rows.length} 行里有 ${result.rows.filter((row) => row.一致 === "是").length} 行一致。`);

assert.equal(result.allAgree, true);
