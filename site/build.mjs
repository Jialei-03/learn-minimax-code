import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import { ROOT, LOCK, verifySource, readSource, sourceUrl } from '../lab/source.mjs';
import { courseMap } from '../scripts/course-map.mjs';
import { sourceNotes } from '../scripts/source-notes.mjs';
import { buildCourseRuntime } from '../scripts/course-runtime.mjs';
import { runLab } from '../labs/run.mjs';

verifySource();
const COURSE = buildCourseRuntime(ROOT);
const chapters = JSON.parse(readFileSync(resolve(ROOT, 'course/syllabus.json'), 'utf8'));
const sources = JSON.parse(readFileSync(resolve(ROOT, 'course/sources.json'), 'utf8'));
const out = resolve(ROOT, 'site/dist');
const esc = s => String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark-dimmed'], langs: ['ts', 'js', 'json', 'bash', 'markdown', 'diff', 'text'] });
const highlight = (code, lang = 'text', start = 1) => highlighter.codeToHtml(code, { lang: highlighter.getLoadedLanguages().includes(lang) ? lang : 'text', themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false, transformers: [{ pre(node) { node.properties.style = `--start:${start - 1}`; } }] });
const md = new MarkdownIt({ html: true, linkify: true, highlight: (code, lang) => highlight(code, lang) });
const interviews = [];
const citations = [];
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const CHECK_ONLY = process.argv.includes('--check') || !!ONLY;
const errors = [];
const PI = { version: 'v1.5.0', commit: 'f9a26365568127461c47a07a37dcb42c140a3ac5', repo: 'https://github.com/earendil-works/pi', dir: process.env.PI_SRC ?? resolve(ROOT, '../pi-v1.5.0') };
const MOX = { dir: process.env.MOX_SRC ?? resolve(ROOT, '../learn-pi-agent'), repo: 'https://github.com/Jialei-03/learn-pi-agent' };
const REPO = 'https://github.com/Jialei-03/learn-minimax-code';
const langOf = path => ({ ts: 'ts', tsx: 'ts', js: 'js', mjs: 'js', json: 'json', md: 'markdown', sh: 'bash', jsonl: 'json' })[path.split('.').pop()] ?? 'text';
const highlightLines = (code, lang, start, hl) => highlighter.codeToHtml(code, { lang: highlighter.getLoadedLanguages().includes(lang) ? lang : 'text', themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false, transformers: [{ pre(node) { node.properties.style = `--start:${start - 1}`; }, line(node, line) { if (hl?.has(line + start - 1)) this.addClassToHast(node, 'hl'); } }] });

// ── 源码摘录：@mm（MiniMax 固定提交）、@pi（Pi v1.5.0）、@mox（learn-pi-agent）、@code（本仓库）─────
/** 按名字找一个声明的范围：从声明行到同一缩进的闭合行。 */
function findSymbol(lines, name) {
  const decl = new RegExp(`^(\\s*)(export\\s+)?(default\\s+)?(abstract\\s+)?(async\\s+)?(function\\*?|const|let|class|interface|type|enum)\\s+${name}\\b`);
  const method = new RegExp(`^(\\s*)(public |private |protected |static |async |readonly )*${name}\\s*[(<]`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(decl) ?? lines[i].match(method);
    if (!m) continue;
    const indent = m[1];
    const opens = (lines[i].match(/[{(]/g) ?? []).length, closes = (lines[i].match(/[})]/g) ?? []).length;
    if ((/;\s*$/.test(lines[i]) && opens === 0) || (opens > 0 && opens === closes)) return [i + 1, i + 1];
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^[}\])][;,)]*(\s+as\s+const;?)?\s*$/.test(lines[j].slice(indent.length)) && lines[j].length - lines[j].trimStart().length === indent.length;
      if (close) return [i + 1, j + 1];
    }
  }
}
const piFiles = new Map();
function readPi(file) {
  if (!piFiles.has(file)) {
    try { piFiles.set(file, execFileSync('git', ['-C', PI.dir, 'show', `${PI.commit}:${file}`], { encoding: 'utf8', maxBuffer: 8e6, stdio: ['ignore', 'pipe', 'ignore'] })); }
    catch { piFiles.set(file, undefined); }
  }
  return piFiles.get(file);
}
function excerpt(kind, spec, where) {
  const [file, anchor = ''] = spec.split('#');
  let text;
  try {
    text = kind === 'mm' ? readSource(file) : kind === 'pi' ? readPi(file) : existsSync(resolve(kind === 'mox' ? MOX.dir : ROOT, file)) ? readFileSync(resolve(kind === 'mox' ? MOX.dir : ROOT, file), 'utf8') : undefined;
  } catch { text = undefined; }
  if (text === undefined) { errors.push(`${where}: 找不到文件 ${file}`); return; }
  const lines = text.split('\n');
  const lineMatch = anchor.match(/^L(\d+)(?:-L(\d+))?$/);
  const region = anchor.match(/^region:(.+)$/);
  let range;
  if (lineMatch) range = [Number(lineMatch[1]), Number(lineMatch[2] ?? lineMatch[1])];
  else if (region) {
    const s = lines.findIndex(l => l.trim() === `// #region ${region[1]}`);
    const e = lines.findIndex((l, i) => i > s && /^\s*\/\/ #endregion/.test(l));
    if (s >= 0 && e > s) range = [s + 2, e];
  } else if (anchor) range = findSymbol(lines, anchor);
  else range = [1, lines.length];
  if (!range) { errors.push(`${where}: 在 ${file} 里找不到 ${anchor}`); return; }
  if (range[1] > lines.length) { errors.push(`${where}: ${file} 只有 ${lines.length} 行，摘录到了 ${range[1]}`); return; }
  return { file, start: range[0], end: range[1], code: lines.slice(range[0] - 1, range[1]).join('\n') };
}
function renderExcerpt(kind, args, chapter) {
  const [spec, ...rest] = args.trim().split(/\s+/);
  const opts = Object.fromEntries(rest.map(o => o.split('=')).map(([k, v]) => [k, v ?? 'true']));
  const ex = excerpt(kind, spec, chapter.slug);
  if (!ex) return '';
  const hl = new Set();
  for (const part of (opts.hl ?? '').split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b ?? a); i++) hl.add(i);
  }
  const lines = ex.end - ex.start + 1;
  const url = kind === 'mm' ? sourceUrl(ex.file, ex.start, ex.end)
    : kind === 'pi' ? `${PI.repo}/blob/${PI.commit}/${ex.file}#L${ex.start}-L${ex.end}`
    : kind === 'mox' ? `${MOX.repo}/blob/main/${ex.file}#L${ex.start}-L${ex.end}`
    : `${REPO}/blob/main/${ex.file}#L${ex.start}-L${ex.end}`;
  if (kind === 'mm') citations.push({ chapter, key: `${ex.file}#${ex.start}`, file: ex.file, start: ex.start, end: ex.end, url, note: opts.title ? decodeURIComponent(opts.title) : '' });
  const badge = kind === 'mm' ? `<span class="src-badge mm">MiniMax ${LOCK.version}</span>` : kind === 'pi' ? `<span class="src-badge pi">Pi ${PI.version}</span>` : kind === 'mox' ? '<span class="src-badge mox">mox</span>' : '<span class="src-badge mox">本课</span>';
  const label = opts.title ? `<span class="src-title">${esc(decodeURIComponent(opts.title))}</span>` : '';
  const collapsed = opts.collapse === 'true' || (opts.collapse !== 'false' && lines > 60);
  return `<figure class="src ${kind}${collapsed ? ' collapsible collapsed' : ''}"><figcaption>${badge}<a class="src-path" href="${url}" target="_blank" rel="noopener">${esc(ex.file)}<span class="src-lines">:${ex.start}${ex.end > ex.start ? '–' + ex.end : ''}</span></a>${label}<button class="copy" type="button" aria-label="复制代码">复制</button></figcaption>${highlightLines(ex.code, langOf(ex.file), ex.start, hl)}${collapsed ? `<button class="expand" type="button">展开全部 ${lines} 行</button>` : ''}</figure>`;
}

// ── 构建时运行的实验：@lab 命令 [| md]、@trace 命令 ─────────────────────
function runCommand(command, where, mergeStderr = true) {
  try {
    return execFileSync('sh', ['-c', mergeStderr ? `${command} 2>&1` : command], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' }, timeout: 60_000, maxBuffer: 8e6 });
  } catch (error) {
    errors.push(`${where}: 实验失败 \`${command}\`\n${error.stdout ?? ''}${error.stderr ?? error.message}`);
    return '';
  }
}
/** 实验输出里夹着的 Markdown 表格渲染成表格，其余保持等宽文本。 */
function renderMixedOutput(output) {
  const lines = output.split('\n');
  const parts = [];
  let text = [];
  const flush = () => { if (text.join('').trim()) parts.push(`<pre class="lab-out">${esc(text.join('\n').replace(/^\n+|\n+$/g, ''))}</pre>`); text = []; };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('|') && /^\|\s*-{3}/.test(lines[i + 1] ?? '')) {
      flush();
      const table = [];
      while (i < lines.length && lines[i].startsWith('|')) table.push(lines[i++]);
      i--;
      parts.push(`<div class="lab-md">${md.render(table.join('\n'))}</div>`);
    } else text.push(lines[i]);
  }
  flush();
  return parts.join('\n');
}
function renderCommandLab(args, where) {
  const [command, mode = ''] = args.split('|').map(s => s.trim());
  const output = runCommand(command, where).trimEnd();
  const body = mode === 'md' ? `<div class="lab-md">${md.render(output)}</div>` : renderMixedOutput(output);
  return `<figure class="lab"><figcaption><code class="lab-cmd"><span>$</span> ${esc(command)}</code><span class="lab-label">实际运行输出</span><button class="copy" type="button" data-copy="${esc(command)}">复制命令</button></figcaption>${body}</figure>`;
}
function renderTrace(command, where) {
  const json = runCommand(command.trim(), where, false);
  if (!json) return '';
  try { JSON.parse(json); } catch { errors.push(`${where}: ${command} 的输出不是 JSON`); return ''; }
  return `<div class="trace-player" data-source="${esc(command.trim())}"><script type="application/json">${json.replace(/</g, '\\u003c')}</script><noscript>交互回放需要 JavaScript。</noscript></div>`;
}
const usedAssets = new Set();
function renderFigure(args, where) {
  const [src, ...caption] = args.trim().split(/\s+/);
  if (!existsSync(resolve(ROOT, src))) { errors.push(`${where}: 找不到插图 ${src}`); return ''; }
  usedAssets.add(src);
  return `<figure class="figure"><a href="../${src}" target="_blank" rel="noopener"><img src="../${src}" alt="${esc(caption.join(' '))}" loading="lazy"></a>${caption.length ? `<figcaption>${esc(caption.join(' '))}</figcaption>` : ''}</figure>`;
}
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  const data = {};
  if (!match) return { data, body: text };
  let key = '';
  for (const line of match[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) { data[key].push(item[1]); continue; }
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) { key = kv[1]; data[key] = kv[2] ? kv[2] : []; }
  }
  return { data, body: text.slice(match[0].length) };
}
const CALLOUT_LABEL = { note: '说明', warn: '注意', insight: '关键洞察', compare: '对照', build: '动手', pi: 'Pi 怎么做', cc: 'Claude Code 怎么做' };
const labs = new Map();
const excerpts = new Map();

for (const [key, spec] of Object.entries(sources)) {
  const lines = readSource(spec.file).split('\n');
  const matches = lines.flatMap((line, n) => line.includes(spec.anchor) ? [n] : []);
  if (matches.length !== 1) throw new Error(`${key}: 源码锚点需唯一，实际 ${matches.length} 处`);
  const start = matches[0];
  const end = Math.min(lines.length, start + spec.lines);
  excerpts.set(key, { ...spec, start: start + 1, end, code: lines.slice(start, end).join('\n'), url: sourceUrl(spec.file, start + 1, end) });
}
const NOTES = sourceNotes(ROOT, Object.fromEntries(excerpts), readSource);
const declaredLabs = new Set();
for (const chapter of chapters.filter(c => !ONLY || c.slug === ONLY)) {
  const text = readFileSync(resolve(ROOT, `course/${chapter.slug}.md`), 'utf8');
  for (const match of text.matchAll(/^@(?:lab|replay) ([a-z-]+)[ \t]*$/gm)) declaredLabs.add(match[1]);
}
for (const name of declaredLabs) labs.set(name, await runLab(name));

/** 指令预处理：在交给 Markdown 之前，把新指令和 ::: 容器替换成 HTML。 */
function preprocess(source, chapter) {
  const lines = source.split('\n');
  const out = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence) { out.push(line); continue; }
    // 手写的 SVG 图示：去掉内部空行，否则 Markdown 会在空行处截断 HTML 块
    if (line.startsWith('<figure class="diagram"')) {
      const block = [];
      let j = i;
      for (; j < lines.length; j++) { if (lines[j].trim()) block.push(lines[j].trim()); if (lines[j].includes('</figure>')) break; }
      i = j;
      out.push('', block.join('\n'), '');
      continue;
    }
    const directive = line.match(/^@(mm|pi|mox|code|trace|figure|lab)\s+(.+)$/);
    // `@lab 名字` 是 labs/run.mjs 里的源码实验（下面单独处理）；`@lab 命令` 在构建时运行命令
    if (directive && !(directive[1] === 'lab' && /^[a-z-]+\s*$/.test(directive[2]))) {
      const [, kind, args] = directive;
      const html = kind === 'trace' ? renderTrace(args, chapter.slug) : kind === 'figure' ? renderFigure(args, chapter.slug) : kind === 'lab' ? renderCommandLab(args, chapter.slug) : renderExcerpt(kind, args, chapter);
      out.push('', html.replace(/\n\s*\n/g, '\n'), '');
      continue;
    }
    const container = line.match(/^:::\s*(\w+)\s*(.*)$/);
    if (container) {
      const [, type, title] = container;
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !/^:::\s*$/.test(lines[j]); j++) body.push(lines[j]);
      if (j >= lines.length) errors.push(`${chapter.slug}: 第 ${i + 1} 行的 ::: ${type} 没有闭合`);
      i = j;
      const inner = text => md.render(preprocess(text, chapter));
      let html;
      if (type === 'predict') {
        const split = body.findIndex(l => /^\?\?\?\s*$/.test(l));
        const question = inner(body.slice(0, split < 0 ? body.length : split).join('\n'));
        const answer = split < 0 ? '' : inner(body.slice(split + 1).join('\n'));
        html = `<aside class="predict"><p class="predict-head">想一想${title ? `<span>${esc(title)}</span>` : ''}</p><div class="predict-q">${question}</div><details><summary>显示答案</summary><div class="predict-a">${answer}</div></details></aside>`;
      } else if (type === 'interview') {
        const answer = inner(body.join('\n'));
        interviews.push({ chapter, question: title, html: answer });
        html = `<details class="interview"><summary><span class="iv-q">${esc(title)}</span></summary><div class="iv-a">${answer}</div></details>`;
      } else {
        html = `<aside class="callout ${type}"><div class="callout-head"><span class="callout-label">${CALLOUT_LABEL[type] ?? type}</span>${title ? `<span class="callout-title">${esc(title)}</span>` : ''}</div>${inner(body.join('\n'))}</aside>`;
      }
      out.push('', html.replace(/\n\s*\n/g, '\n'), '');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function render(body, chapter) {
  const headings = [];
  const renderer = new MarkdownIt({ html: true, linkify: true, highlight: (code, lang) => highlight(code, lang) });
  renderer.renderer.rules.heading_open = (tokens, i, options, env, self) => {
    const title = tokens[i + 1].content;
    const id = `section-${headings.length + 1}`;
    tokens[i].attrSet('id', id);
    headings.push({ title: title.replace(/`/g, ''), id, level: Number(tokens[i].tag.slice(1)) });
    return self.renderToken(tokens, i, options);
  };
  renderer.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
  renderer.renderer.rules.table_close = () => '</table></div>';
  renderer.renderer.rules.link_open = (tokens, i, options, _env, self) => {
    if (/^https?:/.test(tokens[i].attrGet('href') ?? '')) { tokens[i].attrSet('target', '_blank'); tokens[i].attrSet('rel', 'noopener'); }
    return self.renderToken(tokens, i, options);
  };
  body = preprocess(body, chapter);
  body = body.replace(/^@(implementation|experiment|journey) ([a-z0-9-]+)[ \t]*$/gm, (_, kind, slug) => '\n\n' + (kind === 'journey' ? COURSE.journey(slug) : kind === 'implementation' ? COURSE.implementation(slug, code => highlight(code, 'js')) : COURSE.experiment(slug, code => highlight(code, 'json'))).replace(/\n\s*\n/g, '\n') + '\n\n');
  body = body.replace(/^@source ([a-z-]+)[ \t]*$/gm, (_, key) => {
    const ex = excerpts.get(key);
    if (!ex) throw new Error(`${chapter.slug}: 不存在的源码 ${key}`);
    citations.push({ chapter, key, ...ex });
    const lang = ex.file.endsWith('.ts') ? 'ts' : 'markdown';
    const collapse = ex.end - ex.start > 22;
    return '\n\n' + `<figure class="src${collapse ? ' collapsible collapsed' : ''}"><figcaption><span class="src-badge pi">MiniMax ${LOCK.version}</span><a class="src-path" href="${ex.url}" target="_blank" rel="noopener">${esc(ex.file)}:${ex.start}–${ex.end}</a><button class="copy" type="button">复制</button></figcaption>${highlight(ex.code, lang, ex.start)}${collapse ? `<button class="expand" type="button">展开全部 ${ex.end - ex.start + 1} 行</button>` : ''}</figure>`.replace(/\n\s*\n/g, '\n') + NOTES(key) + '\n\n';
  });
  body = body.replace(/^@lab ([a-z-]+)[ \t]*$/gm, (_, name) => {
    if (!labs.has(name)) throw new Error(`实验未声明：${name}`);
    const { trace, ...report } = labs.get(name);
    return `\n\n<figure class="src lab"><figcaption>离线实测${trace ? '摘要' : ''} · npm run lab -- ${esc(name)}</figcaption>${highlight(JSON.stringify(report, null, 2), 'json')}</figure>\n\n`;
  });
  body = body.replace(/^@replay (sdk|capstone)[ \t]*$/gm, (_, name) => {
    const result = labs.get(name);
    const data = name === 'capstone' ? {
      title: '教学宿主：取消、热更新与下一轮',
      subtitle: `课程宿主 + 真实上游组件 · 合成 IO · ${LOCK.commit.slice(0, 7)}`,
      steps: result.timeline.map((row, i) => ({
        kind: row.phase === 'completed' || row.phase === 'aborted' ? 'end' : 'tool',
        label: `${i + 1}. ${row.phase}`, explain: row.note,
        messages: [{ role: 'system', text: `active Turn: ${row.active ?? 'idle'}\n当前能力代: ${row.revision}\n已关闭: ${row.closed.join(', ') || '无'}` }],
        fresh: [0], wire: row, wireSummary: '查看本步教学宿主状态 JSON',
      })),
    } : {
      title: '逐步观察 ItemAccumulator',
      subtitle: `真实函数 · 合成事件 · ${LOCK.commit.slice(0, 7)}`,
      steps: result.trace.map((row, i) => ({
        kind: row.event.type === 'item.completed' ? 'end' : 'response',
        label: `${i + 1}. ${row.event.type.replace('item.', '')} ${row.event.item.id}`,
        explain: row.accepted ? `接受事件。按 id 更新状态；${row.event.item.contentDelta !== undefined ? 'delta 追加，重复文字也保留。' : row.event.type === 'item.completed' ? '此 item 已完成，去掉 incomplete。' : 'snapshot 表示当前完整状态。'}` : '重复 snapshot：apply 返回 false，最终状态不变。',
        messages: row.items.map(item => ({ role: 'assistant', text: `${item.id} · ${item.type}\n${item.text ?? ''}\n${item.incomplete ? 'incomplete: true' : 'completed'}` })),
        fresh: row.items.flatMap((item, n) => item.id === row.event.item.id && row.accepted ? [n] : []),
        wire: row.event, wireSummary: '查看本步合成输入 JSON',
      })),
    };
    return `\n\n<div class="trace-player"><script type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script></div>\n\n`;
  });
  const fence = renderer.renderer.rules.fence;
  renderer.renderer.rules.fence = (tokens, i, options, env, self) => {
    if (tokens[i].info.trim() === 'mermaid') return `<figure class="diagram lesson-diagram"><pre class="mermaid">${esc(tokens[i].content)}</pre><figcaption>机制图 · 依据本章固定源码整理</figcaption></figure>`;
    return fence(tokens, i, options, env, self);
  };
  const html = renderer.render(body).replace(/href="([0-9]{2}-[a-z-]+)\.md(#[^"]*)?"/g, 'href="$1.html$2"');
  if (/^@(source|lab|replay|implementation|experiment|journey) /m.test(html)) throw new Error(`存在未展开指令：${chapter.slug}`);
  if (/^## /m.test(html.replace(/<pre[\s\S]*?<\/pre>/g, ''))) throw new Error(`标题没有被渲染：${chapter.slug}`);
  return { html, headings };
}

const parts = [...new Set(chapters.map(c => c.part))];
function shell(title, content, { chapter, headings = [], home = false } = {}) {
  const base = chapter ? '../' : '';
  const nav = parts.map(part => `<div class="nav-part"><div class="nav-part-title">${esc(part)}</div><ol>${chapters.filter(c => c.part === part).map(c => `<li class="${chapter?.slug === c.slug ? 'current' : ''}"><a href="${base}chapters/${c.slug}.html"${chapter?.slug === c.slug ? ' aria-current="page"' : ''}><span class="nav-num">${String(c.n).padStart(2, '0')}</span><span>${esc(c.title.split('：')[0])}</span></a></li>`).join('')}</ol></div>`).join('');
  const toc = headings.length ? `<aside class="toc"><div class="toc-inner"><div class="toc-title">本页内容</div><ol>${headings.map(h => `<li class="lvl-${h.level}"><a href="#${h.id}">${esc(h.title)}</a></li>`).join('')}</ol></div></aside>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Learn MiniMax Code</title><meta name="description" content="读懂 MiniMax Code：把 Pi 内核做成产品的那一圈代码，沿源码逐段拆解，并准备第一次开源贡献"><link rel="icon" href="${base}static/product-icon.png"><link rel="stylesheet" href="${base}static/style.css"><script>try{document.documentElement.dataset.theme=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}catch{}</script></head><body>
<header class="topbar"><button class="icon-btn nav-toggle" aria-label="打开课程目录">☰</button><a class="brand" href="${base}index.html"><img class="product-icon" src="${base}static/product-icon.png" width="30" height="30" alt="MiniMax Code 原始图标"><span class="brand-name">Learn MiniMax Code</span></a><div class="topbar-actions"><button class="search-btn" data-search-open>搜索课程 <kbd>⌘K</kbd></button><a class="top-link" href="${base}workshop.html">实现主线</a><a class="top-link" href="${base}contribution.html">首次贡献</a><a class="top-link" href="${base}interview.html">面试题</a><a class="top-link" href="${base}sources.html">源码索引</a><a class="top-link" href="${base}map.html">源码导图</a><button class="icon-btn theme-toggle" aria-label="切换深浅主题">◐</button></div></header>
<div class="shell${toc ? ' has-toc' : ''}"><nav class="sidebar" aria-label="课程目录"><div class="sidebar-inner">${nav}<p class="nav-pin">MiniMax Code ${LOCK.version}<br><a href="${LOCK.repo}/tree/${LOCK.commit}">${LOCK.commit.slice(0, 7)} · MIT</a><br>基准：${LOCK.observedDate}</p></div></nav><main id="main">${content}</main>${toc}</div>
<div class="search-dialog" hidden role="dialog" aria-modal="true" aria-label="搜索课程"><div class="search-panel"><input type="search" aria-label="搜索" placeholder="搜索机制、章节或源码……"><ol class="search-results"></ol><p class="search-hint">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p></div></div><div class="scrim" hidden></div><script defer src="${base}static/mermaid.min.js"></script><script type="module" src="${base}static/app.js"></script></body></html>`;
}

const pages = new Map();
const search = [];
/** 按小节建搜索索引：每个 h2/h3 一条，正文全文可搜（以前只索引每章前 6000 字）。 */
function sectionIndex(html, url, chapter, title) {
  const plain = (s) => s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const parts = html.split(/(?=<h[23][^>]*\bid=")/);
  const rows = [];
  for (const part of parts) {
    const head = part.match(/^<h[23][^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/);
    const text = plain(head ? part.slice(head[0].length) : part).slice(0, 8000);
    rows.push(head ? { url: `${url}#${head[1]}`, chapter, title, section: plain(head[2]), text } : { url, chapter, title, text });
  }
  return rows;
}

for (const chapter of chapters.filter(c => !ONLY || c.slug === ONLY)) {
  const { data: fm, body } = parseFrontmatter(readFileSync(resolve(ROOT, `course/${chapter.slug}.md`), 'utf8'));
  if ((body.match(/^@(mm|source) /gm) ?? []).length < 2) errors.push(`${chapter.slug}: 每章至少需要两处 MiniMax 源码摘录（@mm）`);
  const { html, headings } = render(body, chapter);
  const prev = chapters[chapter.n - 1];
  const next = chapters[chapter.n + 1];
  const learn = Array.isArray(fm.learn) && fm.learn.length ? fm.learn : chapter.learn;
  const build = fm.build || chapter.build;
  const objectives = `<div class="objectives"><p class="objectives-title">本章目标</p><ul>${learn.map(goal => `<li>${esc(goal)}</li>`).join('')}</ul><p class="objectives-build"><span>动手产出</span>${esc(build)}</p></div>`;
  const meta = [`约 ${esc(String(fm.time || chapter.time).replace(/^约\s*/, ''))}`, fm.prereq ? `前置：${esc(fm.prereq)}` : ''].filter(Boolean).map(x => `<span>${x}</span>`).join('');
  const article = `<article class="chapter"><header class="chapter-head"><p class="eyebrow">第 ${String(chapter.n).padStart(2, '0')} 章<span>·</span>${esc(chapter.part)}</p><h1>${esc(chapter.title)}</h1><p class="lede">${esc(chapter.summary)}</p>${fm.motto ? `<p class="motto">${esc(fm.motto)}</p>` : ''}${objectives}<p class="chapter-meta">${meta}</p></header><div class="prose">${html}</div><nav class="pager">${prev ? `<a class="prev" href="${prev.slug}.html"><small>← 上一章</small><span>${esc(prev.title)}</span></a>` : '<span></span>'}${next ? `<a class="next" href="${next.slug}.html"><small>下一章 →</small><span>${esc(next.title)}</span></a>` : '<span></span>'}</nav></article>`;
  pages.set(`chapters/${chapter.slug}.html`, shell(chapter.title, article, { chapter, headings }));
  search.push(...sectionIndex(html, `chapters/${chapter.slug}.html`, String(chapter.n).padStart(2, '0'), chapter.title));
}
if (ONLY) {
  if (!pages.size) errors.push(`没有这一章：${ONLY}`);
  if (errors.length) { console.error(`检查失败，${errors.length} 个问题：\n` + errors.map(e => '  · ' + e).join('\n')); process.exit(1); }
  console.log(`${ONLY} 检查通过：${citations.length} 处源码摘录，${interviews.length} 道面试题`);
  process.exit(0);
}
if (errors.length) { console.error(`构建失败，${errors.length} 个问题：\n` + errors.map(e => '  · ' + e).join('\n')); process.exit(1); }

const roadmap = parts.map(part => `<section class="roadmap-part"><h3>${esc(part)}</h3><ol>${chapters.filter(c => c.part === part).map(c => `<li class="ready"><a href="chapters/${c.slug}.html"><span class="chapter-num">${String(c.n).padStart(2, '0')}</span><span><strong>${esc(c.title)}</strong><small>${esc(c.summary)}</small></span><span class="roadmap-arrow">→</span></a></li>`).join('')}</ol></section>`).join('');
pages.set('index.html', shell('读懂它，然后贡献它', `<div class="home"><section class="hero"><div><p class="eyebrow">Agent 工程课 · 第三部 · 源码 ${LOCK.version}</p><h1>读懂 MiniMax Code<br><span class="hero-sub">Pi 外面的那九十九</span></h1><p class="hero-lead">MiniMax Code 的 Agent 循环就是 Pi，只占全部代码的百分之一。这门课读另外的部分：三个入口怎样共用一个应用、一个 Turn 怎样装配和收尾、排队和取消、插件热更新、模型重试、给内核打的补丁——把一个 Agent 内核做成产品，要加的正是这些。</p><div class="hero-actions"><a class="btn primary" href="chapters/00-method.html">开始学习</a><a class="btn-link" href="workshop.html">查看 host 实现主线 →</a></div></div><aside class="course-terminal" aria-label="MiniMax Code 的分层"><p><span>MINIMAX CODE</span> / ${LOCK.commit.slice(0, 7)}</p><pre>mcode · exec · acp\n        ↓\n    CliService\n        ↓\n  Applications\n        ↓\nSession · Turn · Queue …\n        ↓\n agent-core（pi-turn-runner）\n        ↓\n Pi（third_party/pi-mono）</pre><footer>读源码 → 跑真实函数 → 写 host → 找贡献点</footer></aside></section><section class="pillars"><article><span class="pillar-num">01</span><h3>把源码摆出来讲</h3><p>每章沿一条调用链摘录真实源码，逐段解释状态、分支和失败路径，配流程图。</p></article><article><span class="pillar-num">02</span><h3>运行真实函数</h3><p>纯模块直接从固定提交装载执行，实验里的行为是 MiniMax 自己的代码给出的。</p></article><article><span class="pillar-num">03</span><h3>亲手写一个宿主</h3><p>host 把会话、Turn、队列、事件、插件和对外协议装在一个可替换的内核外面。</p></article><article><span class="pillar-num">04</span><h3>准备首次贡献</h3><p>从 MiniMax 给 Pi 的补丁台账和测试出发，练习复现、定位和写 Issue。</p></article></section><section class="quickstart"><h2>先把实验跑起来</h2><p>Node.js 22.19+；所有实验离线运行，不需要 API Key。建议先学 <a href="https://github.com/Jialei-03/learn-pi-agent">Learn Pi Agent</a>。</p><pre><code>npm ci\nnpm run setup:source\nnpm run lesson -- 0\nnpm run build\nnpm run serve</code></pre><p>贡献政策核实于 ${LOCK.observedDate}：上游目前只接收协作者 PR，外部贡献先通过 Issue 讨论。<a href="${sourceUrl('CONTRIBUTING.md')}">查看官方政策</a>。</p></section><section class="roadmap"><div class="roadmap-head"><h2>课程路线</h2><p>${chapters.length} 章</p></div>${roadmap}</section></div>`, { home: true }));

const byFile = new Map();
for (const c of citations) {
  if (!byFile.has(c.file)) byFile.set(c.file, { file: c.file, url: sourceUrl(c.file), notes: new Set(), chapters: new Set() });
  const row = byFile.get(c.file);
  if (c.note) row.notes.add(c.note);
  row.chapters.add(c.chapter.slug);
}
const sourceRows = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)).map(row => `<tr><td><a href="${row.url}" target="_blank" rel="noopener"><code>${esc(row.file)}</code></a></td><td>${esc([...row.notes].join('；'))}</td><td>${[...row.chapters].sort().map(slug => `<a href="chapters/${slug}.html">${slug.slice(0, 2)}</a>`).join(' · ')}</td></tr>`).join('');
const plain = (title, body) => shell(title, `<article class="chapter plain-page"><h1>${esc(title)}</h1><div class="prose">${body}</div></article>`);
pages.set('workshop.html', plain('host：贯穿全课的实现主线', COURSE.overview()));
pages.set('sources.html', plain('源码索引', `<p>所有摘录读取 Git 对象 ${LOCK.commit}，不受贡献目录的未提交修改影响。摘录沿用上游适用许可；完整许可见项目 contribution/UPSTREAM-LICENSE 和上游第三方声明。</p><div class="table-wrap"><table><thead><tr><th>源码文件</th><th>读什么</th><th>章节</th></tr></thead><tbody>${sourceRows}</tbody></table></div>`));
pages.set('interview.html', plain('面试题库', `<p>共 ${interviews.length} 道。先用自己的话解释，再展开核对；把“源码显示”和“运行验证”说清楚。</p>` + interviews.map(i => `<details class="interview"><summary>${esc(i.question)}</summary><div class="iv-a">${i.html}<p><a href="chapters/${i.chapter.slug}.html">回到第 ${i.chapter.n} 章 →</a></p></div></details>`).join('')));
pages.set('contribution.html', plain('MiniMax Code 首次贡献任务', md.render(readFileSync(resolve(ROOT, 'contribution/README.md'), 'utf8'))));

const MAP = courseMap({
  title: `MiniMax Code ${LOCK.version}`,
  subtitle: '这门课读过的每一段 MiniMax Code 源码：按章节看学习路线，按目录看覆盖了源码的哪些部分。',
  chapters: chapters.map(c => ({ n: c.n, slug: c.slug, title: c.title, part: c.part })),
  citations: citations.map(c => ({ chapter: c.chapter.slug, file: c.file, start: c.start, end: c.end, url: c.url })),
  display: file => file.replace(/^packages\//, '').replace(/^third_party\/pi-mono\/packages\//, 'pi-mono/'),
});
pages.set('map.html', plain('源码思维导图', MAP.html));

// Validate every generated local HTML link, fragment, image and script before writing output.
for (const [path, html] of pages) {
  for (const [, target] of html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|data:|mailto:)/.test(target)) continue;
    const url = new URL(target, `https://course.invalid/${path}`);
    const dest = decodeURIComponent(url.pathname.slice(1));
    if (dest.endsWith('.html')) {
      if (!pages.has(dest)) throw new Error(`${path}: 页面不存在 ${dest}`);
      if (url.hash && !pages.get(dest).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) throw new Error(`${path}: 锚点不存在 ${target}`);
    } else if (!['static/style.css', 'static/app.js', 'static/mermaid.min.js', 'static/product-icon.png', 'engineering/architecture.canvas', 'engineering/engineering-map.md'].includes(dest) && !usedAssets.has(dest)) throw new Error(`${path}: 未知资源 ${dest}`);
  }
}
if (!CHECK_ONLY) {
  rmSync(out, { recursive: true, force: true });
  for (const [path, html] of pages) { mkdirSync(dirname(resolve(out, path)), { recursive: true }); writeFileSync(resolve(out, path), html); }
  mkdirSync(resolve(out, 'engineering'), { recursive: true });
  writeFileSync(resolve(out, 'engineering/architecture.canvas'), MAP.canvas);
  writeFileSync(resolve(out, 'engineering/engineering-map.md'), MAP.markdown);
  cpSync(resolve(ROOT, 'site/static'), resolve(out, 'static'), { recursive: true });
  for (const asset of usedAssets) { mkdirSync(dirname(resolve(out, asset)), { recursive: true }); cpSync(resolve(ROOT, asset), resolve(out, asset)); }
  cpSync(resolve(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'), resolve(out, 'static/mermaid.min.js'));
  cpSync(resolve(ROOT, 'node_modules/mermaid/LICENSE'), resolve(out, 'static/mermaid-LICENSE.txt'));
  writeFileSync(resolve(out, 'static/search.json'), JSON.stringify(search));
  writeFileSync(resolve(out, 'course-evidence.json'), JSON.stringify(COURSE.evidence(), null, 2));
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ source: LOCK, pages: pages.size, excerpts: excerpts.size, citations: citations.length, interviews: interviews.length, labs: Object.fromEntries(labs) }, null, 2));
}
console.log(`${process.argv.includes('--check') ? '检查通过' : '构建完成'}：${pages.size} 页，${chapters.length} 章，${citations.length} 处 MiniMax 源码摘录，${interviews.length} 道面试题。`);
