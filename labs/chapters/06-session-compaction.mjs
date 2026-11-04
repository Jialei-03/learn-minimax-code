// 第 6 章回归实验：历史、投影与压缩。
//   node labs/chapters/06-session-compaction.mjs          打印实验过程和每项检查
//   node labs/chapters/06-session-compaction.mjs --json   构建模式
// 场景在 labs/ch06/scenarios.mjs；正文里嵌入的是 labs/ch06/*.mjs 打印的表格。
// 这里把它们串起来：游标 → 触发线 → 投影 → 崩溃修复 → 压缩提交 → 协议校验 → 输入阶梯 → 整条链路。
import { lesson } from "./harness.mjs";
import { historyCursor, compactView } from "../../host/src/history.mjs";
import {
  appendFailures,
  commitScenarios,
  crashScenarios,
  ladderScenario,
  pipelineScenarios,
  protocolAssembly,
  protocolMatrix,
  staleDisplayRows,
  triggerTable,
  upstreamImageLimit,
  viewsReport,
} from "../ch06/scenarios.mjs";

await lesson(6, "历史、投影与压缩：存下来的、发出去的、换掉的", async (t) => {
  // ── 一、提交游标 ──────────────────────────────────────────────
  t.log("一、提交游标：交付成功才前移，失败是粘性的，压缩的整份替换走同一个出口");
  const delivered = [];
  const cursor = historyCursor(1, async (rows, change) => delivered.push({ reason: change.reason, rows: rows.length }));
  const messages = [{ role: "user", text: "旧历史" }, { role: "assistant", text: "新消息" }];
  await cursor.flush(messages);
  await cursor.flush(messages);
  t.equal("旧历史不再通知，同一个尾部只交付一次", delivered, [{ reason: "messageDelta", rows: 1 }]);
  t.equal("交付成功后游标指向末尾", cursor.position, 2);
  await cursor.replace([{ role: "compactionSummary", summary: "…" }], { replacementId: "ctx" });
  t.equal("replace 把整份历史交付出去，游标指向新历史末尾", [delivered[1], cursor.position], [{ reason: "replaceMessages", rows: 1 }, 1]);

  const broken = historyCursor(0, async () => {
    throw Error("disk failure");
  });
  await t.rejects("写入失败向上传播", broken.flush(messages), /disk failure/);
  t.equal("失败时游标不前移", broken.position, 0);
  t.equal("失败是粘性的", broken.failed, true);
  await broken.replace(messages);
  t.equal("失败之后连 replace 也不再尝试", broken.position, 0);

  // ── 二、什么时候压缩 ─────────────────────────────────────────
  t.log("\n二、什么时候压缩：触发线随输出预算移动，host 的公式和上游一致");
  const trigger = await triggerTable();
  t.table(trigger.rows.map((r) => r.row));
  t.equal(`host 的 compactionBudget 与上游在 ${trigger.compared} 组输入上一致`, trigger.mismatches, []);
  t.equal("200K 窗口、64K 输出：触发线 142500", trigger.rows[3].real.automaticTriggerAt, 142_500);

  // ── 三、存下来的，和发出去的 ──────────────────────────────────
  t.log("\n三、发给模型的是一份投影，存档不动");
  const views = viewsReport();
  const r = views.sent.report;
  t.equal("投影前后存档逐字节相同", views.unchanged, true);
  t.equal("六种改动各发生了预期的次数", [r.hostOnly, r.merged, r.orphanResults, r.thinkingToText, r.imagesOmitted], [1, 1, 1, 1, 4]);
  t.equal("按前缀缓存的模型不裁图片", views.cachedImages, views.totalImages);
  const up = await upstreamImageLimit();
  t.equal("真实的 limitRequestImages：5 张图、上限 2，省略 3 张", [up.omitted, up.kept], [3, 2]);

  // ── 四、崩溃留下的 ────────────────────────────────────────────
  t.log("\n四、崩溃之后：规范历史在读取时删掉配不齐的回合，展示行改成 failed");
  const [a, b, c, d] = await crashScenarios();
  t.equal("A：只存了调用 → 落定读取删掉，活动读取保留", [a.settledRows, a.activeRows], [["user"], a.stored]);
  t.equal("B：已到的部分结果跟着整个回合一起删", b.settledRows, ["user"]);
  t.equal("C：回合被后来的用户消息打断", [c.settledRows, c.issues[0].kind], [["user", "user"], "interrupted-tool-round"]);
  t.equal("D：没有调用的结果被删", d.issues[0].kind, "orphan-tool-result");
  t.ok("读取修复会写回文件本身", [a, b, c, d].every((s) => s.settledRewritten));
  const stale = await staleDisplayRows();
  t.equal("真实的 StaleCompactionMessageRepair：别的进程遗留的 compaction_start 变成 failed", stale.patched, ["m2"]);
  t.equal("本进程发的、且不是最后一行的也不再算进行中", stale.laterPatched, ["m2", "m4"]);

  // ── 五、压缩提交 ──────────────────────────────────────────────
  t.log("\n五、压缩提交：先存档，再替换，最后核对");
  const commits = await commitScenarios();
  t.table(commits);
  const pick = (prefix) => commits.find((row) => row.场景.startsWith(prefix));
  t.ok("正常提交：第 1 代，快照在", /第 1 代/.test(pick("1").活动文件) && /g0--ctx1/.test(pick("1").快照));
  t.ok("快照发布时崩溃：活动文件没动", /第 0 代 · 13 条/.test(pick("2").活动文件));
  t.ok("替换时崩溃：快照已在，活动文件没动", /第 0 代 · 13 条/.test(pick("3").活动文件) && /g0--ctx1/.test(pick("3").快照));
  t.ok("同一个 id 重来：发现快照已存在且一致，直接提交", /already-exists/.test(pick("4").结果) && /第 1 代/.test(pick("4").活动文件));
  t.ok("同名快照内容不同：拒绝提交", /snapshot conflict/.test(pick("5").结果));
  t.ok("反面教材：先替换后存档，崩溃后旧历史永远丢失", /永远丢了/.test(pick("6").快照));

  t.log("\n追加写失败：失败不等于没写进去");
  const appends = await appendFailures();
  t.table(appends);
  t.equal("四种失败的写入尝试次数", appends.map((row) => row.写入尝试), [2, 2, 1, 1, 3]);
  t.equal("每种情况下这批消息最多出现一次（不重复）", appends.map((row) => row["这批消息出现的次数"]), [1, 1, 1, 0, 0]);
  t.equal("结果不明：抛 CommitUncertainError，绝不重试", appends[3].调用方看到, "CommitUncertainError");

  // ── 六、checkpoint 协议 ───────────────────────────────────────
  t.log("\n六、checkpoint 协议：硬性无效才拒绝，格式不合只降级");
  const matrix = await protocolMatrix();
  t.table(matrix);
  t.equal("host 的判断与上游 validateCheckpointGeneration 逐项一致", matrix.map((row) => row.host), matrix.map((row) => row.上游));
  t.equal("四类被拒绝的情形", matrix.filter((row) => row.接受 === "否").map((row) => row.情形), ["响应是空的", "模型发起了工具调用", "输出超过了预算", "请求被取消（aborted）"]);
  const assembly = await protocolAssembly();
  t.equal("附录里只留最近两条用户原话，/compact 不算", assembly.firstQueries, ["修复 search.ts 的大小写 bug", "别引入新依赖"]);
  t.equal("第二次压缩：旧原话让位给新的", assembly.secondQueries, ["别忘了 lint", "顺便看看 CI"]);
  t.equal("host 版的附录与真实 buildCheckpointMessage 一致", [assembly.hostFirst, assembly.hostSecond], [assembly.firstQueries, assembly.secondQueries]);

  // ── 七、摘要输入的阶梯 ────────────────────────────────────────
  t.log("\n七、摘要输入放不下：一级一级往下退，工具回合不拆开");
  const ladder = ladderScenario();
  t.equal("五档上限依次选中", ladder.rows.map((row) => row.chosen), ["h0", "hall", "hmid", "hmid", "hmin", undefined]);
  t.throws("keepFrom 必须是用户消息，不能从工具回合中间切", () => compactView(ladder.history, "摘要", 2), /user boundary/);
  t.equal("compactView 省略 keepFrom：什么都不留", compactView(ladder.history, "摘要").length, 1);

  // ── 八、整条链路 ──────────────────────────────────────────────
  t.log("\n八、请求模型之前的压缩钩子：摘要出问题就算了（敞开），提交出问题就停（闭合）");
  const pipeline = await pipelineScenarios();
  t.table(pipeline.rows);
  const { results } = pipeline;
  t.equal("没到触发线：什么都不做", results.under.out.status, "unchanged");
  t.equal("越过触发线：压缩成功，磁盘进入第 1 代", [results.done.out.status, results.done.generation], ["completed", 1]);
  t.ok("压缩后历史变成 摘要 + 当前用户消息", results.done.live.length === 2 && results.done.live[0].role === "compactionSummary" && results.done.live[1].role === "user");
  t.equal("摘要里调了工具：跳过，历史原样", [results.toolCall.out.reason, results.toolCall.live.length], ["INVALID_CHECKPOINT", 23]);
  t.equal("服务商拒绝完整历史：退到 hall 再成功", results.tooLarge.out.rung, "hall/exact");
  t.equal("服务商连续出错：只重试一次，跳过", results.providerDown.out.reason, "CHECKPOINT_PROVIDER_FAILED");
  t.equal("提交失败：抛出，磁盘仍是第 0 代", [results.commit.out.status, results.commit.generation], ["threw", 0]);
  t.equal("服务商刚拒绝过：没到触发线也压缩", results.recovery.out.status, "completed");
  t.observations.rungs = ladder.rows.map((row) => row.chosen ?? "none");
});
