// 实验：十八种错误，官方账号和 BYOK 各自重不重试。
//   node labs/ch03/errors.mjs
// "分类"和两种"重试"列都来自真实的 llm-error-classifier.ts；最后一列核对 host 的 classifyError 是否给出同样的结论。
import assert from "node:assert/strict";
import { ERROR_SAMPLES, errorRows, markdownTable } from "./scenarios.mjs";

const rows = errorRows();
console.log(markdownTable(rows));

const retried = (column) => rows.filter((row) => row[column] === "重试").length;
console.log(`\n${rows.length} 个样本里，官方账号重试 ${retried("官方账号")} 个，BYOK 重试 ${retried("BYOK")} 个；host 与真实分类器的结论${rows.every((row) => row["host 一致"] === "是") ? "全部一致" : "有出入"}。`);

const by = Object.fromEntries(rows.map((row) => [row.错误, row]));
for (const name of ["529 服务过载", "429 限流", "连接被重置 ECONNRESET", "首包超时"]) assert.equal(by[name].官方账号, "重试", name);
for (const name of ["500 服务器内部错误", "401 key 无效", "402 余额不足", "模型拒答", "用户取消", "认不出的错误"]) assert.equal(by[name].官方账号, "不重试", name);
assert.equal(by["401 key 无效"].BYOK, "重试"); // BYOK 对输出之前的失败几乎都重试
for (const name of ["模型拒答", "用户取消", "413 请求太大", "上下文溢出（2013）", "图片数量超限", "400 invalid_request_error"]) assert.equal(by[name].BYOK, "不重试", name);
assert.ok(rows.every((row) => row["host 一致"] === "是"));
assert.equal(rows.length, ERROR_SAMPLES.length);
