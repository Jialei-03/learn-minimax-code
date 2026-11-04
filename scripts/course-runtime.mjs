// 贯穿项目的阶段表（course/progression.json）。
// 章节正文用 @implementation 嵌入本章的实现片段，用 @experiment / @journey 嵌入本章回归实验的结果。
// 实验只在被正文用到时才运行；`npm run verify:course` 会按顺序跑全部阶段。
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function buildCourseRuntime(root) {
  const plan = JSON.parse(readFileSync(resolve(root, "course/progression.json"), "utf8"));
  const seen = new Set();
  for (const [index, chapter] of plan.chapters.entries()) {
    if (chapter.n !== index || seen.has(chapter.slug) || chapter.dependsOn !== (index ? plan.chapters[index - 1].slug : null))
      throw Error(`progression.json 第 ${index} 项的编号或前置章节不连续`);
    seen.add(chapter.slug);
    if (!existsSync(resolve(root, chapter.experiment))) throw Error(`缺少实验 ${chapter.experiment}`);
  }

  const reports = new Map();
  const excerpts = new Map();
  const chapter = (slug) => {
    const value = plan.chapters.find((c) => c.slug === slug);
    if (!value) throw Error(`progression.json 里没有 ${slug}`);
    return value;
  };
  const report = (slug) => {
    if (reports.has(slug)) return reports.get(slug);
    const row = chapter(slug);
    const output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", resolve(root, row.experiment), "--json"], {
      cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4e6,
    });
    const value = JSON.parse(output.trim().split("\n").at(-1));
    if (value.chapter !== row.n || value.status !== "passed") throw Error(`实验没有通过：${slug}`);
    reports.set(slug, value);
    return value;
  };
  const implementation = (target) => {
    if (excerpts.has(target)) return excerpts.get(target);
    const [file, symbol] = target.split("#");
    const raw = readFileSync(resolve(root, file), "utf8");
    const lines = raw.split("\n");
    const start = lines.findIndex((line) => new RegExp(`^export (?:async )?(?:function\\*?|class|const) ${symbol}\\b`).test(line));
    if (start < 0) throw Error(`找不到实现 ${target}`);
    const end = lines.findIndex((line, i) => i >= start && /^}\s*;?\s*$/.test(line));
    if (end < 0) throw Error(`实现没有闭合 ${target}`);
    const value = { file, symbol, start: start + 1, end: end + 1, code: lines.slice(start, end + 1).join("\n"), sha256: createHash("sha256").update(raw).digest("hex") };
    excerpts.set(target, value);
    return value;
  };

  return {
    plan,
    reports,
    implementation(slug, highlight) {
      const row = chapter(slug);
      return (
        `<section class="implementation-stage"><p class="eyebrow">贯穿项目 · ${esc(plan.name)} · 第 ${row.n} 步</p><h3>${esc(row.build)}</h3><p>${esc(row.connection)}</p><p><a href="../workshop.html">查看完整实现主线 →</a></p></section>` +
        row.implementation
          .map((target) => {
            const ex = implementation(target);
            const url = `${plan.repo}/blob/main/${ex.file}#L${ex.start}-L${ex.end}`;
            const collapsed = ex.end - ex.start > 60;
            return `<figure class="src ${collapsed ? "collapsible collapsed" : ""}"><figcaption><span class="src-badge mox">${esc(plan.name)}</span><a class="src-path" href="${url}" target="_blank" rel="noopener">${esc(ex.file)}<span class="src-lines">:${ex.start}–${ex.end}</span></a><span class="src-title">${esc(ex.symbol)}</span><button class="copy" type="button">复制</button></figcaption>${highlight(ex.code)}${collapsed ? `<button class="expand" type="button">展开全部 ${ex.end - ex.start + 1} 行</button>` : ""}</figure>`;
          })
          .join("")
      );
    },
    experiment(slug, highlight) {
      const row = chapter(slug);
      const value = report(slug);
      return `<figure class="lab"><figcaption><code class="lab-cmd"><span>$</span> node ${esc(row.experiment)}</code><span class="lab-label">构建时实际运行</span></figcaption><div class="table-wrap"><table><thead><tr><th>检查</th><th>结果</th></tr></thead><tbody>${value.checks.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.passed ? "通过" : "失败"}</td></tr>`).join("")}</tbody></table></div></figure>${Object.keys(value.observations ?? {}).length ? `<details class="lab-data"><summary>查看实验记录的数据</summary>${highlight(JSON.stringify(value.observations, null, 2))}</details>` : ""}`;
    },
    journey(slug) {
      const value = report(slug);
      const rows = value.observations.journey ?? value.observations.events;
      if (!Array.isArray(rows) || !rows.length) throw Error(`${slug} 的实验没有记录事件轨迹`);
      const data = {
        title: `${plan.name}：一次完整运行的事件`,
        subtitle: "构建时真实运行；模型回复由脚本给出，文件、进程和协议都是真的",
        steps: rows.map((row, i) => ({
          kind: row.status ? "end" : String(row.type).includes("tool") ? "tool" : "response",
          label: `${i + 1}. ${row.type}`,
          explain: row.explain ?? "",
          messages: [{ role: "system", text: JSON.stringify(row, null, 2) }],
          fresh: [0],
          wire: row,
          wireSummary: "查看这一步的事件 JSON",
        })),
      };
      return `<div class="trace-player"><script type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script></div>`;
    },
    overview() {
      return (
        `<p class="lede">${esc(plan.description)}</p><p>${plan.chapters.length} 个阶段，每一步都在上一步的代码上增加一块能力。下面列出每一步写了什么、在哪个文件、用哪个实验检验。</p><div class="progression">` +
        plan.chapters
          .map((c) => `<section><p class="eyebrow">第 ${c.n} 步</p><h2><a href="chapters/${c.slug}.html">${esc(c.title)}</a></h2><p><strong>${esc(c.build)}</strong></p><p>${esc(c.connection)}</p><ul>${c.implementation.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul><p><code>node ${esc(c.experiment)}</code></p></section>`)
          .join("") +
        "</div>"
      );
    },
    evidence() {
      return { plan, chapters: Object.fromEntries(reports), implementation: [...excerpts.values()].map(({ code, ...meta }) => meta) };
    },
  };
}
