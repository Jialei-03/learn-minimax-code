// 实验：内核补丁和宿主分类器之间的"措辞约定"。同样的故障，措辞一变，宿主的判断就跟着变。
//   node labs/ch03/patches.mjs
// 判定来自真实的 llm-error-classifier.ts；"Pi v1.5.0 的措辞"取自 pi-v1.5.0 的 anthropic-messages.ts。
import assert from "node:assert/strict";
import { markdownTable, patchRows } from "./scenarios.mjs";

const rows = patchRows();
console.log(markdownTable(rows));

const find = (补丁, 措辞) => rows.find((row) => row.补丁 === 补丁 && row.措辞 === 措辞);
assert.equal(find("没有 stop_reason 的流", "MiniMax 补丁的原话").真实分类器的判定, "unknown");
assert.equal(find("没有 stop_reason 的流", "同样的诊断数字，措辞改成别的（假设）").真实分类器的判定, "credits_exhausted");
assert.equal(find("拒答详情", "补丁的措辞，解释里碰巧有故障词").BYOK, "不重试");
assert.equal(find("拒答详情", "没有标记，解释里碰巧有 timed out（假设）").官方账号, "重试");
assert.equal(find("拒答详情", "Pi v1.5.0 的措辞").BYOK, "重试");
