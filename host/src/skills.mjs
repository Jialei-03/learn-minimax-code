// 第 8 章：Skill 的读取。
//
// 同一种 SKILL.md，MiniMax Code 0.7.2 在三个地方读它。格式规则几乎一样，格式不对时的态度不一样：
//   strict  → plugin-system/plugin/package/minimax-reader.ts
//             官方插件包。一个 Skill 的格式不对，整个包被拒绝，不会有“半个插件”上线。
//   skip    → plugin-system/plugin/package/agent-plugin-reader.ts 的 readSkills
//             别人写的 Agent Skills 包。坏的那个跳过并记一条诊断，好的照常收录。
//   lenient → agent-modules/skills/src/registry.ts 的 parseSkillFile
//             用户自己的 Skill 目录。从不拒绝：缺名字就用目录名，缺描述就取正文第一段，问题记成诊断。
// 谁来修、修得了吗，决定了态度：官方包经过审核，必须干净；用户自己的文件，宁可宽容也别让它凭空消失。
//
// 简化：MiniMax 用 YAML 库解析 frontmatter（插件包用 yaml，开 uniqueKeys 和 maxAliasCount；
// 独立 Skill 用 js-yaml）。host 只认一行一个 `key: value`（值可以加引号），嵌套、列表、多行都不支持，
// 遇到就按“格式不对”处理。重复的键在三处都不会被悄悄接受：YAML 库在这两条路径上都把它当错误。
//
// 对外的 API 和之前一致：parseSkill(text)、Skills(root, paths)、skills.descriptions()、skills.load(name)。
// 新增的只有可选参数（parseSkill 的 dirName、Skills 的 policy）和 skills.diagnostics。
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { workspacePath } from "../../runtime/files.mjs";

/** 格式不对。code 对应 MiniMax 的 SKILL_SCHEMA_INVALID。 */
export class SkillError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SkillError";
    this.code = code;
  }
}
const invalid = (message) => {
  throw new SkillError("SKILL_SCHEMA_INVALID", message);
};

/**
 * 拆出 frontmatter 和正文。起始行和结束行都必须是单独一行的 `---`
 * （对应 skill/frontmatter.ts 的 parseSkillFrontmatter）。
 * 返回 { header, body }；没有开头或没有闭合就抛 SkillError。
 */
function splitFrontmatter(text) {
  const opening = /^---\r?\n/.exec(text);
  if (!opening) invalid("must start with frontmatter (---)");
  const rest = text.slice(opening[0].length);
  const closing = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(rest);
  if (!closing) invalid("unclosed frontmatter");
  return { header: rest.slice(0, closing.index), body: rest.slice(closing.index + closing[0].length) };
}

/** 把 frontmatter 的每一行读成键值。写法不支持或者键重复，抛 SkillError。 */
function parseFields(header) {
  const fields = {};
  for (const line of header.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) invalid(`unsupported frontmatter line: ${line.trim().slice(0, 40)}`);
    const [, key, raw] = pair;
    if (Object.hasOwn(fields, key)) invalid(`duplicate key "${key}"`); // YAML 库的 uniqueKeys 在这里也会报错
    fields[key] = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

/** 从 fields 里取出 host 关心的几项。 */
function shape(name, description, fields, body) {
  return {
    name,
    description,
    allowedTools: (fields["allowed-tools"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    fork: fields.context === "fork",
    userInvocable: fields["user-invocable"] !== "false",
    body: body.trim(),
  };
}

/**
 * 严格读取（strict / skip 两种态度共用的规则，对应 skill/reader.ts 的 readPluginSkill）：
 *   - frontmatter 必须完整；键不许重复；
 *   - description 必填；
 *   - name 可以省略，省略时用目录名；写了就必须和目录名一致（dirName 是 SKILL.md 所在目录的名字）。
 * 不满足就抛 SkillError，调用者决定整个包拒绝还是只跳过这一个。
 */
export function parseSkill(text, { dirName } = {}) {
  const { header, body } = splitFrontmatter(text);
  const fields = parseFields(header);
  const name = fields.name || dirName;
  if (!name) invalid("no skill name");
  if (!fields.description) invalid("no skill description");
  if (dirName !== undefined && name !== dirName) invalid(`name "${name}" does not match its directory "${dirName}"`);
  return shape(name, fields.description, fields, body);
}

// ─── 宽松读取 ──────────────────────────────────────────────────────────────

/** 第一个 `# 标题`（对应 firstHeading）。 */
const firstHeading = (body) => /^#\s+(.+)$/m.exec(body)?.[1].trim();

/** 正文里标题之后的第一段文字，到空行或下一个标题为止（对应 firstDescription）。 */
function firstParagraph(body) {
  const paragraph = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (line.startsWith("#")) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  return paragraph.join("\n") || undefined;
}

/**
 * 宽松读取：从不抛异常，返回 { skill, diagnostics }。skill 在名字实在推不出来时为 undefined。
 * 对应 registry.ts 的 parseSkillFile：frontmatter 坏了就当没有，名字退回目录名，
 * 描述退回正文第一段；所有“退回”都记成诊断，而不是拒绝。
 */
export function inspectSkill(text, dirName) {
  const diagnostics = [];
  const note = (level, code, message) => diagnostics.push({ level, code, message });
  let fields = {};
  let body = text; // 最后交给模型的正文：frontmatter 读不通时，整个文件都给它
  let prose = text; // 用来推断标题和描述的正文
  if (/^---\r?\n/.test(text)) {
    let header;
    try {
      ({ header, body } = splitFrontmatter(text));
      prose = body;
      fields = parseFields(header);
    } catch (error) {
      if (!(error instanceof SkillError)) throw error;
      // 没闭合是错误级，其余（重复键、写法不支持）是警告级；两种情况都把 frontmatter 当作没有
      const unclosed = /unclosed/.test(error.message);
      note(unclosed ? "error" : "warning", unclosed ? "frontmatter_unclosed" : "frontmatter_invalid", error.message);
      fields = {};
      if (unclosed) prose = ""; // 没闭合：连正文在哪里都不知道，没有东西可以推断
    }
  }
  const name = fields.name || dirName;
  const description = fields.description || firstParagraph(prose);
  if (!firstHeading(prose) && !fields.title) note("warning", "missing_title", "no title in frontmatter or body");
  if (!description) note("warning", "missing_description", "no description in frontmatter or body");
  if (!name) {
    note("error", "missing_name", "skill name could not be inferred");
    return { skill: undefined, diagnostics };
  }
  return { skill: shape(name, description ?? "", fields, body), diagnostics };
}

// ─── 目录 ──────────────────────────────────────────────────────────────────

/**
 * 一组 SKILL.md。policy 决定格式不对时的态度：
 *   "strict"（默认，和之前一样）：抛出，整组作废；重名也抛出。
 *   "skip"：坏的跳过，记进 skills.diagnostics；重名的后来者跳过。
 *   "lenient"：用 inspectSkill 读，什么都收；重名的后来者跳过。
 * 目录里只放名字和描述（模型看的目录）；正文 load(name) 时才读，每次都读磁盘上当前的文件
 * ——这是“独立 Skill”的行为。插件里的 Skill 不一样，它的正文随 capture 到的那一代冻结。
 */
export class Skills {
  constructor(root, paths, { policy = "strict" } = {}) {
    this.root = root;
    this.policy = policy;
    this.entries = new Map();
    this.diagnostics = [];
    for (const path of paths) this.#register(path);
  }

  /** 读一个文件，按 policy 解析。strict / skip 解析失败会抛 SkillError。 */
  #read(path) {
    const text = readFileSync(workspacePath(this.root, path), "utf8");
    const dir = dirname(path);
    const dirName = dir === "." ? undefined : basename(dir); // 放在工作区根目录的 SKILL.md 没有目录名可比
    if (this.policy === "lenient") return inspectSkill(text, dirName);
    return { skill: parseSkill(text, { dirName }), diagnostics: [] };
  }

  #register(path) {
    let result;
    try {
      result = this.#read(path);
    } catch (error) {
      if (this.policy === "strict" || !(error instanceof SkillError)) throw error;
      this.diagnostics.push({ level: "error", code: error.code, message: error.message, path });
      return;
    }
    for (const item of result.diagnostics) this.diagnostics.push({ ...item, path });
    const { skill } = result;
    if (!skill) return;
    if (this.entries.has(skill.name)) {
      if (this.policy === "strict") throw Error("duplicate skill name");
      this.diagnostics.push({ level: "warning", code: "SKILL_NAME_CONFLICT", message: `duplicate skill name "${skill.name}"`, path });
      return;
    }
    this.entries.set(skill.name, { path, name: skill.name, description: skill.description });
  }

  /** 进提示的目录：只有名字和描述。 */
  descriptions() {
    return [...this.entries.values()].map(({ name, description }) => ({ name, description }));
  }

  /** 加载一个 Skill 的全文（去掉 frontmatter）。每次都重新读文件。 */
  load(name) {
    const entry = this.entries.get(name.trim().replace(/^\//, ""));
    if (!entry) throw Error("unknown skill");
    const { skill } = this.#read(entry.path);
    if (!skill) throw Error("unknown skill");
    return skill;
  }
}
