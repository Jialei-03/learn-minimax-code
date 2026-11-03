import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import { ROOT, LOCK, verifySource, readSource, sourceUrl } from '../lab/source.mjs';
import { engineeringMap } from '../scripts/engineering-map.mjs';
import { runLab } from '../labs/run.mjs';

verifySource();
const chapters = JSON.parse(readFileSync(resolve(ROOT, 'course/syllabus.json'), 'utf8'));
const sources = JSON.parse(readFileSync(resolve(ROOT, 'course/sources.json'), 'utf8'));
const out = resolve(ROOT, 'site/dist');
const esc = s => String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark-dimmed'], langs: ['ts', 'js', 'json', 'bash', 'markdown', 'diff', 'text'] });
const highlight = (code, lang = 'text', start = 1) => highlighter.codeToHtml(code, { lang: highlighter.getLoadedLanguages().includes(lang) ? lang : 'text', themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false, transformers: [{ pre(node) { node.properties.style = `--start:${start - 1}`; } }] });
const md = new MarkdownIt({ html: true, linkify: true, highlight: (code, lang) => highlight(code, lang) });
const interviews = [];
const citations = [];
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
for (const name of new Set(chapters.map(c => c.lab))) labs.set(name, await runLab(name));

function render(body, chapter) {
  const headings = [];
  const renderer = new MarkdownIt({ html: true, linkify: true, highlight: (code, lang) => highlight(code, lang) });
  renderer.renderer.rules.heading_open = (tokens, i, options, env, self) => {
    const title = tokens[i + 1].content;
    const id = `section-${headings.length + 1}`;
    tokens[i].attrSet('id', id);
    headings.push({ title, id, level: Number(tokens[i].tag.slice(1)) });
    return self.renderToken(tokens, i, options);
  };
  body = body.replace(/^::: interview (.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, question, answer) => {
    const html = md.render(answer);
    interviews.push({ chapter, question, html });
    return '\n\n' + `<details class="interview"><summary>${esc(question)}</summary><div class="iv-a">${html}</div></details>`.replace(/\n/g, '') + '\n\n';
  });
  body = body.replace(/^@source ([a-z-]+)[ \t]*$/gm, (_, key) => {
    const ex = excerpts.get(key);
    if (!ex) throw new Error(`${chapter.slug}: 不存在的源码 ${key}`);
    citations.push({ chapter, key, ...ex });
    const lang = ex.file.endsWith('.ts') ? 'ts' : 'markdown';
    return '\n\n' + `<figure class="src"><figcaption><span class="src-badge pi">MiniMax ${LOCK.version}</span><a class="src-path" href="${ex.url}" target="_blank" rel="noopener">${esc(ex.file)}:${ex.start}–${ex.end}</a><button class="copy" type="button">复制</button></figcaption>${highlight(ex.code, lang, ex.start)}</figure>`.replace(/\n\s*\n/g, '\n') + '\n\n';
  });
  body = body.replace(/^@lab ([a-z-]+)[ \t]*$/gm, (_, name) => {
    if (!labs.has(name)) throw new Error(`实验未声明：${name}`);
    return `\n\n<figure class="src lab"><figcaption>离线实测 · npm run lab -- ${esc(name)}</figcaption>${highlight(JSON.stringify(labs.get(name), null, 2), 'json')}</figure>\n\n`;
  });
  const html = renderer.render(body).replace(/href="([0-9]{2}-[a-z-]+)\.md(#[^"]*)?"/g, 'href="$1.html$2"');
  if (/^@(source|lab) /m.test(html)) throw new Error(`存在未展开指令：${chapter.slug}`);
  if (/^## /m.test(html.replace(/<pre[\s\S]*?<\/pre>/g, ''))) throw new Error(`标题没有被渲染：${chapter.slug}`);
  return { html, headings };
}

const parts = [...new Set(chapters.map(c => c.part))];
function shell(title, content, { chapter, headings = [], home = false } = {}) {
  const base = chapter ? '../' : '';
  const nav = parts.map(part => `<div class="nav-part"><div class="nav-part-title">${esc(part)}</div><ol>${chapters.filter(c => c.part === part).map(c => `<li class="${chapter?.slug === c.slug ? 'current' : ''}"><a href="${base}chapters/${c.slug}.html"${chapter?.slug === c.slug ? ' aria-current="page"' : ''}><span class="nav-num">${String(c.n).padStart(2, '0')}</span><span>${esc(c.title.split('：')[0])}</span></a></li>`).join('')}</ol></div>`).join('');
  const toc = headings.length ? `<aside class="toc"><div class="toc-inner"><div class="toc-title">本页内容</div><ol>${headings.map(h => `<li class="lvl-${h.level}"><a href="#${h.id}">${esc(h.title)}</a></li>`).join('')}</ol></div></aside>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Learn MiniMax Code</title><meta name="description" content="读懂 MiniMax Code：固定源码、离线实验、三项目对照与第一次开源贡献"><link rel="icon" href="${base}static/product-icon.png"><link rel="stylesheet" href="${base}static/style.css"><script>try{document.documentElement.dataset.theme=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}catch{}</script></head><body>
<header class="topbar"><button class="icon-btn nav-toggle" aria-label="打开课程目录">☰</button><a class="brand" href="${base}index.html"><img class="product-icon" src="${base}static/product-icon.png" width="30" height="30" alt="MiniMax Code 原始图标"><span class="brand-name">Learn MiniMax Code</span></a><div class="topbar-actions"><button class="search-btn" data-search-open>搜索课程 <kbd>⌘K</kbd></button><a class="top-link" href="${base}contribution.html">首次贡献</a><a class="top-link" href="${base}interview.html">面试题</a><a class="top-link" href="${base}sources.html">源码索引</a><a class="top-link" href="${base}map.html">工程地图</a><button class="icon-btn theme-toggle" aria-label="切换深浅主题">◐</button></div></header>
<div class="shell${toc ? ' has-toc' : ''}"><nav class="sidebar" aria-label="课程目录"><div class="sidebar-inner">${nav}<p class="nav-pin">MiniMax Code ${LOCK.version}<br><a href="${LOCK.repo}/tree/${LOCK.commit}">${LOCK.commit.slice(0, 7)} · MIT</a><br>基准：${LOCK.observedDate}</p></div></nav><main id="main">${content}</main>${toc}</div>
<div class="search-dialog" hidden role="dialog" aria-modal="true" aria-label="搜索课程"><div class="search-panel"><input type="search" aria-label="搜索" placeholder="搜索机制、章节或源码……"><ol class="search-results"></ol><p class="search-hint">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p></div></div><div class="scrim" hidden></div><script type="module" src="${base}static/app.js"></script></body></html>`;
}

const pages = new Map();
const search = [];
for (const chapter of chapters) {
  const body = readFileSync(resolve(ROOT, `course/${chapter.slug}.md`), 'utf8');
  const { html, headings } = render(body, chapter);
  const prev = chapters[chapter.n - 1];
  const next = chapters[chapter.n + 1];
  const article = `<article class="chapter"><header class="chapter-head"><p class="eyebrow">${esc(chapter.part)} · 第 ${chapter.n} 章</p><h1>${esc(chapter.title)}</h1><p class="lede">${esc(chapter.summary)}</p><p class="chapter-meta">固定源码 ${LOCK.version} · 阅读＋源码追踪＋离线观察</p></header><div class="prose">${html}</div><nav class="pager">${prev ? `<a href="${prev.slug}.html">← ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a href="${next.slug}.html">${esc(next.title)} →</a>` : '<span></span>'}</nav></article>`;
  pages.set(`chapters/${chapter.slug}.html`, shell(chapter.title, article, { chapter, headings }));
  search.push({ url: `chapters/${chapter.slug}.html`, chapter: String(chapter.n).padStart(2, '0'), title: chapter.title, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') });
}

const roadmap = parts.map(part => `<section class="roadmap-part"><h3>${esc(part)}</h3><ol>${chapters.filter(c => c.part === part).map(c => `<li class="ready"><a href="chapters/${c.slug}.html"><span class="chapter-num">${String(c.n).padStart(2, '0')}</span><span><strong>${esc(c.title)}</strong><small>${esc(c.summary)}</small></span><span class="roadmap-arrow">→</span></a></li>`).join('')}</ol></section>`).join('');
pages.set('index.html', shell('读懂它，然后贡献它', `<div class="home"><section class="hero"><div><p class="eyebrow">Agent 工程课 · 第三部 · 源码 ${LOCK.version}</p><h1>读懂 MiniMax Code<br><span class="hero-sub">然后，贡献一处改进。</span></h1><p class="hero-lead">从 Pi 的内核，走到产品级 Coding Agent。沿真实调用链读源码，用离线实验观察边界，再把一个可复现的问题变成可审查的补丁。</p><div class="hero-actions"><a class="btn primary" href="chapters/00-method.html">开始学习</a><a class="btn-link" href="contribution.html">进入贡献任务 →</a></div></div><aside class="course-terminal" aria-label="学习与贡献路线"><p><span>MINIMAX CODE</span> / SOURCE MAP</p><pre>你的输入\n  ↓\nTUI · exec · ACP\n  ↓\nCliService → Application\n  ↓\nSession · Turn · Agent\n  ↓\nPi engine → model · tools</pre><footer>source → reproduce → test → patch → review</footer></aside></section><section class="pillars"><article><span class="pillar-num">01</span><h3>读真实源码</h3><p>${excerpts.size} 个阅读入口，链接固定到 ${LOCK.commit.slice(0, 7)}。</p></article><article><span class="pillar-num">02</span><h3>运行真实函数</h3><p>${labs.size} 组离线实验，保留输入、断言和结论边界。</p></article><article><span class="pillar-num">03</span><h3>对照已有学习</h3><p>连接 Learn Pi Agent 的实现与 Learn Claude Code 的观察。</p></article><article><span class="pillar-num">04</span><h3>准备首次贡献</h3><p>从复现到回归测试，按上游当前贡献政策推进。</p></article></section><section class="quickstart"><h2>先把实验跑起来</h2><p>Node.js 22.19+；课程构建不需要 API Key，也不会启动真实模型。</p><pre><code>npm install\nnpm run setup:source\nnpm run lab\nnpm run build\nnpm run serve</code></pre><p>贡献政策核实于 ${LOCK.observedDate}：上游目前只接收协作者 PR，外部贡献先通过 Issue 讨论。<a href="${sourceUrl('CONTRIBUTING.md')}">查看官方政策</a>。</p></section><section class="roadmap"><div class="roadmap-head"><h2>课程路线</h2><p>${chapters.length} 章 · 先建立机制理解，再形成贡献证据</p></div>${roadmap}</section></div>`, { home: true }));

const sourceRows = [...excerpts.entries()].map(([key, ex]) => `<tr><td><a href="${ex.url}"><code>${esc(ex.file)}</code></a></td><td>${esc(ex.note)}</td><td>${[...new Set(citations.filter(c => c.key === key).map(c => c.chapter.slug))].map(slug => `<a href="chapters/${slug}.html">${slug.slice(0, 2)}</a>`).join(' · ')}</td></tr>`).join('');
const plain = (title, body) => shell(title, `<article class="chapter plain-page"><h1>${esc(title)}</h1><div class="prose">${body}</div></article>`);
pages.set('sources.html', plain('源码索引', `<p>所有摘录读取 Git 对象 ${LOCK.commit}，不受贡献目录的未提交修改影响。摘录沿用上游适用许可；完整许可见项目 contribution/UPSTREAM-LICENSE 和上游第三方声明。</p><div class="table-wrap"><table><thead><tr><th>源码文件</th><th>为什么读</th><th>章节</th></tr></thead><tbody>${sourceRows}</tbody></table></div>`));
pages.set('interview.html', plain('面试题库', `<p>共 ${interviews.length} 道。先用自己的话解释，再展开核对；把“源码显示”和“运行验证”说清楚。</p>` + interviews.map(i => `<details class="interview"><summary>${esc(i.question)}</summary><div class="iv-a">${i.html}<p><a href="chapters/${i.chapter.slug}.html">回到第 ${i.chapter.n} 章 →</a></p></div></details>`).join('')));
pages.set('contribution.html', plain('MiniMax Code 首次贡献任务', md.render(readFileSync(resolve(ROOT, 'contribution/README.md'), 'utf8'))));

const MAP = engineeringMap(ROOT);
pages.set('map.html', MAP.html);

// Validate every generated local HTML link, fragment, image and script before writing output.
for (const [path, html] of pages) {
  for (const [, target] of html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|data:|mailto:)/.test(target)) continue;
    const url = new URL(target, `https://course.invalid/${path}`);
    const dest = decodeURIComponent(url.pathname.slice(1));
    if (dest.endsWith('.html')) {
      if (!pages.has(dest)) throw new Error(`${path}: 页面不存在 ${dest}`);
      if (url.hash && !pages.get(dest).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) throw new Error(`${path}: 锚点不存在 ${target}`);
    } else if (!['static/style.css', 'static/app.js', 'static/product-icon.png', 'engineering/architecture.canvas', 'engineering/engineering-map.md'].includes(dest)) throw new Error(`${path}: 未知资源 ${dest}`);
  }
}
if (!process.argv.includes('--check')) {
  rmSync(out, { recursive: true, force: true });
  for (const [path, html] of pages) { mkdirSync(dirname(resolve(out, path)), { recursive: true }); writeFileSync(resolve(out, path), html); }
  mkdirSync(resolve(out, 'engineering'), { recursive: true });
  writeFileSync(resolve(out, 'engineering/architecture.canvas'), MAP.canvas);
  writeFileSync(resolve(out, 'engineering/engineering-map.md'), MAP.markdown);
  cpSync(resolve(ROOT, 'site/static'), resolve(out, 'static'), { recursive: true });
  writeFileSync(resolve(out, 'static/search.json'), JSON.stringify(search));
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ source: LOCK, pages: pages.size, excerpts: excerpts.size, citations: citations.length, interviews: interviews.length, labs: Object.fromEntries(labs) }, null, 2));
}
console.log(`${process.argv.includes('--check') ? '检查通过' : '构建完成'}：${pages.size} 页，${chapters.length} 章，${excerpts.size} 个源码入口，${labs.size} 组实验，${interviews.length} 道面试题。`);
