// 实验：同一个剧本，host 的 createPlugins 对照真实的 AgentHostTurnCapabilityLifecycle。
//   node labs/ch08/compare.mjs
import assert from "node:assert/strict";
import { gateScenario, hostSystem, markdownTable, realSystem } from "./scenarios.mjs";

const line = (event) => `${event.谁}｜${event.发生了什么}`;
const real = (await gateScenario(await realSystem())).map(line);
const host = (await gateScenario(await hostSystem())).map(line);

const rows = real.map((text, i) => ({ "#": i + 1, 真实生命周期: text, host: host[i] ?? "（缺）", 一致: text === host[i] ? "是" : "否" }));
console.log(markdownTable(rows));
console.log(`\n${rows.filter((row) => row.一致 === "是").length} / ${rows.length} 行一致。`);

assert.deepEqual(host, real);
