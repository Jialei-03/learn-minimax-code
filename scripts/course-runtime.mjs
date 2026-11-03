import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const esc = (s) =>
  String(s).replace(
    /[&<>\"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
export function buildCourseRuntime(root) {
  const plan = JSON.parse(
    readFileSync(resolve(root, "course/progression.json"), "utf8"),
  );
  const reports = new Map(),
    excerpts = new Map();
  const seen = new Set();
  for (const [index, chapter] of plan.chapters.entries()) {
    if (
      chapter.n !== index ||
      seen.has(chapter.slug) ||
      chapter.dependsOn !== (index ? plan.chapters[index - 1].slug : null)
    )
      throw Error("invalid course progression");
    seen.add(chapter.slug);
    const body = readFileSync(
      resolve(root, "course", chapter.slug + ".md"),
      "utf8",
    );
    if (
      !body.includes("@implementation " + chapter.slug) ||
      !body.includes("@experiment " + chapter.slug)
    )
      throw Error(
        `${chapter.slug}: implementation and experiment must be in chapter body`,
      );
    const test = resolve(root, chapter.experiment);
    if (!existsSync(test)) throw Error(`missing experiment ${test}`);
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", test],
        { cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 2e6 },
      ),
    );
    if (
      report.chapter !== index ||
      report.status !== "passed" ||
      report.checks.length < 3 ||
      report.checks.some((c) => c.passed !== true)
    )
      throw Error(`chapter verification failed: ${chapter.slug}`);
    reports.set(chapter.slug, report);
    for (const target of chapter.implementation) {
      const [file, symbol] = target.split("#");
      if (
        !/^(coda|host|runtime)\/src\/|^runtime\//.test(file) ||
        file.includes("..")
      )
        throw Error("invalid implementation path");
      const raw = readFileSync(resolve(root, file), "utf8"),
        lines = raw.split("\n");
      const start = lines.findIndex((line) =>
        new RegExp(`^export (?:async )?(?:function|class) ${symbol}\\b`).test(
          line,
        ),
      );
      if (start < 0) throw Error(`missing implementation symbol ${target}`);
      let end = lines.findIndex((line, i) => i >= start && /^}\s*$/.test(line));
      if (end < 0) throw Error(`unterminated implementation ${target}`);
      excerpts.set(target, {
        file,
        symbol,
        start: start + 1,
        end: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        sha256: createHash("sha256").update(raw).digest("hex"),
      });
    }
  }
  const chapter = (slug) => {
    const value = plan.chapters.find((c) => c.slug === slug);
    if (!value) throw Error(`unknown progression ${slug}`);
    return value;
  };
  return {
    plan,
    reports,
    implementation(slug, highlight) {
      const row = chapter(slug);
      return (
        `<section class="implementation-stage"><p class="eyebrow">贯穿项目 · ${esc(plan.name)} · 第 ${row.n} 步</p><h3>${esc(row.build)}</h3><p>${esc(row.connection)}</p><p>前置：${row.dependsOn ? esc(row.dependsOn) : "准备环境"} · <a href="../workshop.html">查看完整实现主线 →</a></p></section>` +
        row.implementation
          .map((target) => {
            const ex = excerpts.get(target),
              url = `${plan.repo}/blob/main/${ex.file}#L${ex.start}-L${ex.end}`;
            const collapsed = ex.end - ex.start > 60;
            return `<figure class="src ${collapsed ? "collapsible collapsed" : ""}"><figcaption><span class="src-badge mox">本课原创实现</span><a class="src-path" href="${url}" target="_blank" rel="noopener">${esc(ex.file)} · ${esc(ex.symbol)} · L${ex.start}–L${ex.end}</a><button class="copy" type="button">复制</button></figcaption>${highlight(ex.code)}${collapsed ? '<button class="expand" type="button">展开完整实现</button>' : ""}</figure>`;
          })
          .join("")
      );
    },
    experiment(slug, highlight) {
      const row = chapter(slug),
        report = reports.get(slug);
      return `<section class="chapter-experiment"><p class="eyebrow">构建时实际运行 · ${report.checks.length} 项断言通过</p><figure class="lab"><figcaption><code class="lab-cmd">node --disable-warning=ExperimentalWarning ${esc(row.experiment)}</code></figcaption><div class="table-wrap"><table><thead><tr><th>契约检查</th><th>实际结果</th></tr></thead><tbody>${report.checks.map((c) => `<tr><td>${esc(c.name)}</td><td>PASS</td></tr>`).join("")}</tbody></table></div></figure><details><summary>查看本次实验的数据与状态轨迹</summary>${highlight(JSON.stringify(report.observations, null, 2))}</details></section>`;
    },
    journey(slug) {
      const report = reports.get(slug),
        rows = report.observations.journey ?? report.observations.events;
      if (!Array.isArray(rows) || !rows.length)
        throw Error("missing real journey");
      const explanations = {
        started: "任务已经开始。",
        request: "构造下一次模型请求。",
        assistant: "模型给出文本或工具意图。",
        tool_result: "实际工具结果回到循环。",
        terminal: "任务产生明确终态。",
        "turn.started": "此 Turn 已接纳并开始交付。",
        "item.started": "这个 item 开始，尚不能视作完整结果。",
        "item.updated": "增量到达，仍需等待完成或取消。",
        "item.completed": "此 item 完成，任务仍有自己的终态。",
        "turn.completed": "历史和交付收尾后，提交此 Turn 的最终状态。",
      };
      const data = {
        title: plan.name + " 总装：实际实验轨迹",
        subtitle: "构建时真实运行文件、进程与协议；模型回复为确定性脚本",
        steps: rows.map((row, i) => ({
          kind: row.status
            ? "end"
            : row.type.includes("tool")
              ? "tool"
              : "response",
          label: `${i + 1}. ${row.type}`,
          explain: explanations[row.type] ?? "同一运行中的实际事件。",
          messages: [{ role: "system", text: JSON.stringify(row, null, 2) }],
          fresh: [0],
          wire: row,
          wireSummary: "查看本步实际实验事件 JSON",
        })),
      };
      return `<div class="trace-player"><script type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script></div>`;
    },
    overview() {
      return (
        `<p class="lede">${esc(plan.description)}</p><p>${plan.chapters.length} 个递进阶段 · ${[...reports.values()].reduce((n, r) => n + r.checks.length, 0)} 项真实断言。所有阶段使用同一个项目；最后一章把各部件放进实际文件与进程实验。</p><div class="progression">` +
        plan.chapters
          .map(
            (c) =>
              `<section><p class="eyebrow">第 ${c.n} 步 · ${esc(c.slug)}</p><h2><a href="chapters/${c.slug}.html">${esc(c.build)}</a></h2><p>${esc(c.connection)}</p><ul>${c.implementation.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul><p><code>node ${esc(c.experiment)}</code> · ${reports.get(c.slug).checks.length} checks PASS</p></section>`,
          )
          .join("") +
        "</div>"
      );
    },
    evidence() {
      return {
        plan,
        chapters: Object.fromEntries(reports),
        implementation: [...excerpts.values()].map(({ code, ...meta }) => meta),
      };
    },
  };
}
