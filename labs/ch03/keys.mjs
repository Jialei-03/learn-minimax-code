// 实验：模型键怎么拆。朴素的 split('/')[1] 与只认第一个斜杠的解析器，在同一批键上各得到什么。
//   node labs/ch03/keys.mjs
import assert from "node:assert/strict";
import { KEY_CASES, formatModelKey, keyRows, markdownTable } from "./scenarios.mjs";
import { parseModelKey } from "../../host/src/models.mjs";

console.log("配置里写下的模型键，两种拆法各得到什么：\n");
console.log(markdownTable(keyRows()));

const valid = KEY_CASES.map((key) => [key, parseModelKey(key)]).filter(([, parsed]) => parsed);
const roundTrip = valid.every(([key, parsed]) => formatModelKey(parsed.providerId, parsed.modelId) === key);
console.log(`\n用量表的 model 字段是 \`provider/id\` 拼出来的：${valid.length} 个合法的键都能原样拼回去（${roundTrip ? "是" : "否"}）。`);

const gateway = parseModelKey("custom_provider:my-gateway/deepseek-ai/DeepSeek-V3");
assert.equal(gateway.modelId, "deepseek-ai/DeepSeek-V3");
assert.equal(gateway.providerKey, "my-gateway");
assert.notEqual("custom_provider:my-gateway/deepseek-ai/DeepSeek-V3".split("/")[1], gateway.modelId);
assert.equal(parseModelKey("custom_provider:/x"), undefined);
assert.ok(roundTrip);
