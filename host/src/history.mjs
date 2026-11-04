// 第 6 章：历史、投影与压缩。
//
// 对应 MiniMax Code 0.7.2 的四处代码：
//   1. agent-core/src/pi-turn-runner/history.ts          提交游标（`newHistory` 的 `flushTail` 与 `replace`）
//   2. agent-core/src/pi-turn-runner/outbound-message-normalizer.ts
//                                                          发给模型的那一份投影（`projectAgentMessagesForModel`）
//   3. local-runtime-v2/.../session-system/messages/history/canonical-history-provider.ts 和 infra/file/jsonl.ts
//                                                          规范历史的落盘：追加、读取时修复、压缩时先存档再替换
//   4. local-runtime-v2/.../turn-system/compaction/        何时压缩、摘要输入放不下时怎么办、checkpoint 协议的校验、
//                                                          失败时的取舍（`automatic-context-compactor.ts`、`compact-context.ts`、`checkpoint-format.ts`）
//
// 一份会话的历史在三个地方出现，失败方式各不相同：
//   存下来的   CanonicalHistory   messages.jsonl + snapshots/，只追加；压缩时整份换掉，旧的先存档
//   发出去的   projectOutbound    每次请求临时算出的副本，永远不写回
//   压缩之后的 compactBeforeModelCall   请求前的钩子：摘要失败就算了（敞开），提交失败就停（闭合）
//
// 简化：
//   - 消息用第 2 章的玩具形状（`{ role, text, calls }` / `{ role: "tool", id, text }`），不是 Pi 的内容块；
//   - 不做 SQLite 里的展示行（UI 看的那一份），也不做 tool_archive、共享前缀的摘要请求；
//   - 摘要输入的阶梯只保留 h0 / hall / hmid / hmin 四级，token 用“四个字符一个”估算。
//
// 导出的 `historyCursor`、`checkpoint`、`compactView` 保持原来的参数顺序；新增的参数都有默认值。
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { importSource } from "../../lab/source.mjs";

const CHECKPOINT_PROTOCOL =
  "packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-protocol.ts";

/** 带稳定错误码的错误：调用方按 `code` 分流，不解析错误文字。 */
function coded(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

// ─── 1. 提交游标 ────────────────────────────────────────────────────────────
// 游标记录“messages 里有多少条已经交给宿主存下了”。两条规则：
//   - 交付成功才前移：失败时不能把没存下来的消息算作已提交；
//   - 失败是粘性的：一次写入状态不明之后，不再偷偷重试同一批，把不确定性留给上层。

/**
 * @param initial 旧历史的长度。旧历史属于调用方，不会再通知它一遍（history.ts 的 lastSnapshotLength）。
 * @param persist `(rows, change) => Promise`。`change.reason` 是 `messageDelta`（追加新消息）
 *                或 `replaceMessages`（压缩：整份历史被换掉）。
 */
export function historyCursor(initial, persist) {
  let cursor = initial;
  let failed = false;

  /** 所有写入的唯一出口。已经失败就不再尝试（返回 false）；这次失败就置位并原样抛出。 */
  async function deliver(rows, change) {
    if (failed) return false;
    try {
      await persist(rows, change);
      return true;
    } catch (error) {
      failed = true;
      throw error;
    }
  }

  return {
    /** `flushTail`：只交付游标之后的新消息。 */
    async flush(messages) {
      if (failed || messages.length <= cursor) return;
      const delta = structuredClone(messages.slice(cursor));
      if (await deliver(delta, { reason: "messageDelta" })) cursor = messages.length;
    },
    /** `replace`：压缩之后整份历史被换掉。交付成功，游标才指向新历史的末尾。 */
    async replace(messages, metadata = {}) {
      const rows = structuredClone(messages);
      if (await deliver(rows, { reason: "replaceMessages", metadata })) cursor = messages.length;
    },
    get position() {
      return cursor;
    },
    get failed() {
      return failed;
    },
  };
}

// ─── 2. 何时压缩 ────────────────────────────────────────────────────────────

/** 粗估 token：四个字符算一个。MiniMax 用 `createDefaultTokenEstimator`，这里只需要能比较大小。 */
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

/**
 * 对应 `provider-budget.ts` 的 `resolveCompactionTokenBudget`。返回两个数：
 *   inputLimit  一次请求的输入硬上限（含摘要请求）；
 *   triggerAt   自动压缩的触发线，比 inputLimit 低，留出余地。
 * 触发线先为“配置的输出”预留空间（最多四分之一窗口），在剩下的窗口里用到 95% 就压缩。
 * 所以输出预算配得越大，触发线越靠前；用户设置的 `triggerAt` 只能把线调得更低。
 */
export function compactionBudget({ contextWindow, maxOutputTokens, triggerAt }) {
  const RESERVE = 16_384; // Pi 的默认预留
  const SAFETY = 2_048;
  const outputFloor = Math.min(maxOutputTokens, RESERVE);
  const inputLimit = Math.max(
    1,
    Math.min(
      Math.floor(contextWindow * 0.95),
      contextWindow - RESERVE,
      contextWindow - outputFloor - SAFETY,
    ),
  );
  const outputReserve = Math.min(maxOutputTokens, Math.floor(contextWindow / 4));
  const builtIn = Math.min(
    inputLimit,
    Math.max(1, Math.floor(((contextWindow - outputReserve) * 95) / 100)),
  );
  // 用户设置：(0, 1] 是窗口比例，大于 1 必须是整数 token 数；其余忽略。
  const valid = Number.isFinite(triggerAt) && triggerAt > 0 && (triggerAt <= 1 || Number.isSafeInteger(triggerAt));
  const custom = !valid ? undefined : triggerAt > 1 ? triggerAt : Math.max(1, Math.floor(contextWindow * triggerAt));
  return { inputLimit, triggerAt: custom === undefined ? builtIn : Math.min(builtIn, custom) };
}

// ─── 3. 发给模型的投影 ──────────────────────────────────────────────────────

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";
const OLDER_THINKING = ["<|prior-thinking|>", "<|/prior-thinking|>"];

/** 模型是否按“精确前缀”缓存提示。是的话，请求里改任何早先的内容都会让缓存全部失效。 */
export function keepsRequestImages(model) {
  return model.prefixCached ?? /claude/i.test(model.id);
}

/**
 * 对应 `projectAgentMessagesForModel`：从存下来的历史算出这一次请求要发的消息。
 * 只读：永远处理副本，传进来的历史一个字节都不改。返回 `{ messages, report }`，
 * report 数出每条规则改动了多少处，实验和日志用。
 *
 * 规则的顺序和上游一致：先丢掉宿主专用消息，再合并连发的用户消息，剥掉宿主字段，
 * 丢掉没有对应调用的工具结果，把别的模型留下的思考转成普通文字，最后限制图片数量。
 */
export function projectOutbound(history, model, { maxImages = 20 } = {}) {
  const changes = []; // 每处改动：{ rule, at }，at 是它在存档里的下标
  const note = (rule, at) => changes.push({ rule, at });
  const out = [];
  const origin = []; // out[i] 来自存档的第几条
  const knownCalls = new Set(); // 到目前为止出现过的工具调用 id
  const batchAt = new Map(); // immediateSendBatchId → 在 out 里的位置

  history.forEach((stored, index) => {
    const message = structuredClone(stored);

    // ① 宿主专用的消息（给界面或插件看的）不发给模型。
    if (message.role === "custom" && message.hostMetadata?.providerVisibility === "omit") {
      note("hostOnly", index);
      return;
    }
    // ② 压缩摘要是 Pi 的原生消息类型；发出去时是一条带说明的用户消息。
    if (message.role === "compactionSummary") {
      out.push({ role: "user", text: SUMMARY_PREFIX + message.summary + SUMMARY_SUFFIX });
      origin.push(index);
      return;
    }
    // ③ 同一次“立即发送”拆成的几条用户消息，合成一条（普通相邻的用户消息保持独立）。
    const batch = message.role === "user" ? message.hostMetadata?.immediateSendBatchId : undefined;
    if (batch !== undefined && batchAt.has(batch)) {
      const target = out[batchAt.get(batch)];
      target.text += `\n\n${message.text}`;
      target.images = [...(target.images ?? []), ...(message.images ?? [])];
      note("merged", index);
      return;
    }
    if (batch !== undefined) batchAt.set(batch, out.length);
    // ④ 宿主字段不出本机。
    delete message.hostMetadata;
    delete message.genuineUserQueryText;

    if (message.role === "assistant") {
      for (const call of message.calls ?? []) knownCalls.add(call.id);
      // ⑥ 别的模型留下的思考：换了模型就读不懂它的签名，转成普通文字让当前模型当作旁白。
      if (message.thinking !== undefined && message.model !== undefined && message.model !== model.id) {
        message.text = `${OLDER_THINKING[0]}\n${message.thinking}\n${OLDER_THINKING[1]}\n${message.text ?? ""}`;
        delete message.thinking;
        note("thinkingToText", index);
      }
    }
    // ⑤ 没有对应调用的工具结果：服务商会拒绝整个请求，丢掉。
    if (message.role === "tool" && !knownCalls.has(message.id)) {
      note("orphanResults", index);
      return;
    }
    out.push(message);
    origin.push(index);
  });

  // ⑦ 图片上限：只保留最新的 maxImages 张，更早的换成一行文字。
  //    按精确前缀缓存的模型不裁——每次请求改早先的内容会让缓存失效，只有压缩（一次性、持久）才能移除图片。
  if (!keepsRequestImages(model)) {
    let toOmit = Math.max(0, out.reduce((n, m) => n + (m.images?.length ?? 0), 0) - maxImages);
    out.forEach((message, i) => {
      if (!message.images?.length || toOmit === 0) return;
      const dropped = message.images.splice(0, Math.min(toOmit, message.images.length));
      toOmit -= dropped.length;
      message.text = `${message.text ?? ""}\n[Earlier image omitted: this request keeps only the ${maxImages} most recent images.]`;
      for (let k = 0; k < dropped.length; k++) note("imagesOmitted", origin[i]);
    });
  }

  const count = (rule) => changes.filter((c) => c.rule === rule).length;
  const report = {
    hostOnly: count("hostOnly"),
    merged: count("merged"),
    orphanResults: count("orphanResults"),
    thinkingToText: count("thinkingToText"),
    imagesOmitted: count("imagesOmitted"),
    changes,
  };
  return { messages: out, report };
}

// ─── 4. 规范历史：落盘 ──────────────────────────────────────────────────────
// 目录布局（对应 session-history-paths.ts）：
//   messages.jsonl                        活动历史，每行一个信封 { message_id, turn_id, message, history_artifact? }
//   snapshots/g<代>--<compactionId>.jsonl   每次压缩之前的完整历史，压缩提交之前就写好
// 第 0 代是没压缩过的历史；每次压缩把代数加一，信封里的 history_artifact 记下上一代的快照和它的哈希。

const MAX_WRITE_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [25, 50];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 追加之后无法判断是否已经落盘（对应 `JsonlAppendCommitUncertainError`）。绝不重试。 */
export class CommitUncertainError extends Error {
  name = "CommitUncertainError";
  constructor(path, cause) {
    super(`append commit is uncertain for ${path}`, { cause });
  }
}

/** 文件操作的默认实现。实验里用故障版本替换它，复现各种写失败。 */
export const nodeFiles = {
  /** 追加：写完 fsync 才算数。 */
  append(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  /** 原子替换：先写同目录的临时文件并 fsync，再 rename。rename 之前，原文件始终是完整的。 */
  replace(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  },
  /** 目标不存在才发布。硬链接是原子的；已存在就返回 "already-exists"，绝不覆盖。 */
  publish(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.${process.pid}.publish`;
    const fd = openSync(staging, "w");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(staging, path);
      return "published";
    } catch (error) {
      if (error.code === "EEXIST") return "already-exists";
      throw error;
    } finally {
      rmSync(staging, { force: true });
    }
  },
};

const encode = (envelopes) => Buffer.from(envelopes.map((e) => JSON.stringify(e) + "\n").join(""));
const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0);
const revisionOf = (envelopes) => "sha256:" + createHash("sha256").update(JSON.stringify(envelopes)).digest("hex");
/** 活动历史第一条信封上记着它是第几代；没有就是第 0 代。 */
const generationOf = (envelopes) => envelopes[0]?.history_artifact?.generation ?? 0;

function readRange(path, start, length) {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/**
 * 读取时的修复（对应 `canonical-history-recovery.ts` 的 `repairCanonicalHistory`）。
 * 工具协议要求“一条带调用的 assistant 消息，后面紧跟着每个调用的结果”。进程在中途被杀，
 * 文件里就会留下配不齐的回合。MiniMax 的做法是删掉：整个回合（assistant 消息和已经到的部分结果）一起丢，
 * 孤立的结果也丢。不补假结果——那是 Pi 在发送时做的事（`transform-messages.ts` 的 “No result provided”）。
 *
 * `allowPendingTail`：最后一个回合如果还在等结果，可能只是工具正在执行，活动读取时保留它；
 * 开始新 Turn 前的“落定读取”则把它当作崩溃遗留，删掉。
 */
export function settleEnvelopes(records, { allowPendingTail }) {
  const kept = [];
  const issues = [];
  let open; // 正在等工具结果的回合

  const abandon = (kind) => {
    issues.push({ kind, at: open.at, dropped: open.rows.length });
    open = undefined;
  };

  records.forEach((record, index) => {
    const { message } = record;
    if (open) {
      if (message.role === "tool") {
        if (open.expected.has(message.id) && !open.seen.has(message.id)) {
          open.rows.push(record);
          open.seen.add(message.id);
          if (open.seen.size === open.expected.size) {
            kept.push(...open.rows);
            open = undefined;
          }
        } else {
          issues.push({ kind: "orphan-tool-result", at: index, dropped: 1 });
        }
        return;
      }
      abandon("interrupted-tool-round"); // 该来的结果没来，别的消息先来了
    }
    if (message.role === "tool") {
      issues.push({ kind: "orphan-tool-result", at: index, dropped: 1 });
      return;
    }
    const calls = message.role === "assistant" ? (message.calls ?? []) : [];
    if (calls.length === 0) {
      kept.push(record);
      return;
    }
    open = { rows: [record], expected: new Set(calls.map((c) => c.id)), seen: new Set(), at: index };
  });

  if (open) {
    if (allowPendingTail) kept.push(...open.rows);
    else abandon("pending-tool-call-tail");
  }
  return { kept, issues };
}

export class CanonicalHistory {
  /**
   * @param dir 会话目录
   * @param files 文件操作；默认是 `nodeFiles`
   * @param retryDelay 重试之间的等待；实验里换成立即返回
   */
  constructor(dir, { files = nodeFiles, retryDelay = sleep } = {}) {
    this.dir = dir;
    this.files = files;
    this.retryDelay = retryDelay;
    this.activePath = join(dir, "messages.jsonl");
  }

  snapshotPath(generation, compactionId) {
    return join(this.dir, "snapshots", `g${String(generation).padStart(12, "0")}--${compactionId}.jsonl`);
  }

  /** 严格读取：任何一行不是合法 JSON 都直接报错，不跳过（中间的坏行说明文件被改过）。 */
  readEnvelopes(path = this.activePath) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw Error(`${path}:${index + 1} is not valid JSON`);
        }
      });
  }

  get generation() {
    return generationOf(this.readEnvelopes());
  }

  /** 追加一批消息。失败的处理见 `persist` 和 `settleFailedAppend`。 */
  async append(messages, turnId = "turn") {
    const active = this.readEnvelopes();
    const generation = generationOf(active);
    const rows = messages.map((message, i) => ({
      message_id: `msg-g${generation}-${active.length + i}`,
      turn_id: turnId,
      message,
    }));
    await this.persist(() => this.appendOnce(encode(rows)));
    return rows.length;
  }

  /**
   * 读取历史。`pendingTail: false`（默认）是“落定读取”，开始新 Turn 前用：
   * 修复结果会写回文件本身，下一次读到的就已经是干净的了。
   * `pendingTail: true` 是“活动读取”：保留最后一个还在等结果的回合。
   */
  async read({ pendingTail = false } = {}) {
    const records = this.readEnvelopes();
    const { kept, issues } = settleEnvelopes(records, { allowPendingTail: pendingTail });
    if (issues.length > 0) await this.files.replace(this.activePath, encode(kept));
    return { messages: kept.map((r) => r.message), issues };
  }

  /**
   * 压缩提交：先存档，再替换，最后核对。顺序就是正确性：
   *   0. 在内存里造好要换上去的信封（代数、产生方式、上一代快照的哈希），这一步出错还没碰过磁盘；
   *   1. 把压缩前的完整历史发布到 snapshots/（目标已存在就比较哈希：相同视为已经做过，不同是冲突）；
   *   2. 原子替换活动文件；
   *   3. 重新读一遍，确认代数确实加了一。
   * 第 1 步之后崩溃：活动文件没动，旧历史完整；重试时第 1 步发现快照已存在且一致，直接往下走。
   * 反过来先替换再存档，崩溃就会丢掉旧历史。
   */
  async compact({ compactionId, replacement }) {
    const active = this.readEnvelopes();
    const generation = generationOf(active);
    const snapshot = this.snapshotPath(generation, compactionId);
    const artifact = {
      schemaVersion: 1,
      generation: generation + 1,
      producedBy: "llm_checkpoint",
      parentSnapshot: { generation, compactionId, revision: revisionOf(active) },
    };
    const rows = replacement.map((message, i) => ({
      message_id: `msg-g${generation + 1}-${i}`,
      turn_id: `${compactionId}:compaction`,
      message,
      history_artifact: artifact,
    }));

    const outcome = await this.files.publish(snapshot, encode(active));
    if (outcome === "already-exists" && revisionOf(this.readEnvelopes(snapshot)) !== revisionOf(active)) {
      throw Error(`snapshot conflict: ${snapshot}`);
    }
    await this.files.replace(this.activePath, encode(rows));

    if (generationOf(this.readEnvelopes()) !== generation + 1) {
      throw Error(`compaction generation verification failed: ${this.dir}`);
    }
    return { generation: generation + 1, snapshot, outcome };
  }

  /** 普通失败重试，最多三次；提交结果不明的错误绝不重试。 */
  async persist(operation) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof CommitUncertainError || attempt >= MAX_WRITE_ATTEMPTS) throw error;
        await this.retryDelay(RETRY_DELAYS_MS[attempt - 1] ?? 0);
      }
    }
  }

  async appendOnce(bytes) {
    const before = sizeOf(this.activePath);
    try {
      await this.files.append(this.activePath, bytes);
    } catch (failure) {
      this.settleFailedAppend(before, bytes, failure);
    }
  }

  /**
   * 追加报了错，不等于没写进去。看文件比写之前长了多少（对应 jsonl.ts 的 `recoverFailedAppend`）：
   *   一个字节没多  → 没写：抛出原错误，调用方可以安全重试；
   *   整批都在了    → 写成功了，只是报错在后面：算提交成功，不能再写一遍；
   *   只有半截      → 截回写之前的长度，再抛出原错误；
   *   连文件现状都读不清 → 无法判断，抛 CommitUncertainError。
   */
  settleFailedAppend(before, bytes, failure) {
    let written;
    try {
      written = sizeOf(this.activePath) - before;
      if (written < 0 || written > bytes.length) throw Error("file size is outside the payload range");
      if (written > 0 && !readRange(this.activePath, before, written).equals(bytes.subarray(0, written))) {
        throw Error("appended bytes do not match the payload");
      }
      if (written > 0 && written < bytes.length) truncateSync(this.activePath, before);
    } catch (cause) {
      throw new CommitUncertainError(this.activePath, cause);
    }
    if (written === bytes.length) return;
    throw failure;
  }
}

// ─── 5. checkpoint 协议 ─────────────────────────────────────────────────────

/**
 * 对应 `checkpoint-format.ts` 的 `validateCheckpointGeneration`：判断模型写出的摘要能不能用。
 * 只有两类结论，界线很清楚：
 *   - 硬性无效（抛 INVALID_CHECKPOINT）：响应不是一份“写完了的摘要”——没有正常结束、里面有工具调用、
 *     输出超过预算、是空的。这样的东西提交了会让会话带着残缺的历史继续。
 *   - 软降级（status = "soft_fallback"）：是一份写完了的摘要，只是没有严格按八个标题写。照样接受。
 *     压缩失败的代价（上下文一直是满的）比一份格式略差的摘要大得多。
 *
 * @param generation `{ stopReason, kinds, outputTokens, maxOutputTokens }`，描述这次生成。
 */
export async function checkpoint(summary, generation = {}) {
  const { stopReason = "stop", kinds = ["text"], outputTokens = 0, maxOutputTokens = Infinity } = generation;
  const { CHECKPOINT_SYSTEM_PROMPT, parseCheckpointHeadings } = await importSource(CHECKPOINT_PROTOCOL);
  const headings = parseCheckpointHeadings(CHECKPOINT_SYSTEM_PROMPT);

  const finished = stopReason === "stop" || stopReason === "length";
  const callsTools = kinds.some((kind) => kind === "toolCall" || kind === "unknown");
  if (!finished || callsTools || outputTokens > maxOutputTokens) {
    throw coded("INVALID_CHECKPOINT", "Checkpoint LLM returned a non-terminal or oversized response.");
  }
  const text = summary.trim();
  if (!text) throw coded("INVALID_CHECKPOINT", "Checkpoint LLM returned an empty response.");

  // 严格格式：第一个标题打头，八个标题按顺序各出现一次，每节有内容。
  const sections = [...text.matchAll(/^## ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/gmu)];
  const exact =
    text.startsWith(`## ${headings[0]}\n`) &&
    sections.length === headings.length &&
    headings.every((heading, i) => sections[i][1] === heading && sections[i][2].trim() !== "");
  const missing = headings.filter((heading) => !text.includes(`## ${heading}\n`));
  return { headings, summary: text, status: exact ? "exact" : "soft_fallback", missing };
}

/** 最近两条用户亲手输入的消息，原文。`/compact` 这样的控制命令不算。 */
export function recentUserQueries(history) {
  const inherited = history[0]?.role === "compactionSummary" ? (history[0].recentUserQueries ?? []) : [];
  const typed = history
    .filter((m) => m.role === "user" && m.text?.trim() && !/^\/compact(\s|$)/i.test(m.text.trim()))
    .map((m) => m.text);
  return [...inherited, ...typed].slice(-2);
}

/** 对应 `buildCheckpointMessage`：摘要 + 宿主自己核实过的事实。后者不交给模型去写。 */
export function checkpointMessage(history, summary, tokensBefore) {
  const queries = recentUserQueries(history);
  const appendix = ["<context-appendix>", "## Recent user queries", ...queries.map((q) => `- ${JSON.stringify(q)}`), "</context-appendix>"];
  return {
    role: "compactionSummary",
    summary: `${summary}\n\n${appendix.join("\n")}`,
    recentUserQueries: queries,
    tokensBefore,
  };
}

// ─── 6. 摘要的输入：放不下时一级一级往下退 ─────────────────────────────────────

const TOOL_REMOVED = "[Tool result removed by context compaction.]";

/** 工具回合是不可拆的整体：assistant 消息和紧跟着它的所有工具结果，下标放在一组。其余每条消息自成一组。 */
function closuresOf(messages) {
  const groups = [];
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].role === "assistant" ? (messages[i].calls ?? []) : [];
    const group = [i];
    for (let k = 0; k < calls.length && messages[i + 1 + k]?.role === "tool"; k++) group.push(i + 1 + k);
    groups.push(group);
    i += group.length - 1;
  }
  return groups;
}

/** 从中间向两边的删除顺序：最早的任务目标和最近的进展离中间最远，最晚被删。 */
function middleOut(items) {
  const order = [];
  const middle = Math.floor((items.length - 1) / 2);
  for (let d = 0; order.length < items.length; d++) {
    if (items[middle - d] !== undefined) order.push(items[middle - d]);
    if (d > 0 && items[middle + d] !== undefined) order.push(items[middle + d]);
  }
  return order;
}

/** hmid：整组整组地删中间的内容，直到放得下。第一组和所有含用户消息的组受保护。 */
function deleteMiddle(messages, fits) {
  const groups = closuresOf(messages);
  const deletable = groups
    .map((group, index) => ({ group, index }))
    .filter(({ group, index }) => index !== 0 && !group.some((i) => messages[i].role === "user"))
    .map(({ index }) => index);
  const removed = new Set();
  for (const index of middleOut(deletable)) {
    groups[index].forEach((i) => removed.add(i));
    const candidate = messages.filter((_, i) => !removed.has(i));
    if (fits(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 对应 `buildCheckpointCandidates` 和 `recoverAfterHall`：摘要请求本身也要放进窗口。
 * 依次产出越来越小的输入，调用方拿第一个“本地估算放得下”的去请求；服务商仍然拒绝（返回
 * `INPUT_TOO_LARGE`）就取下一个。
 *   h0    完整历史
 *   hall  所有工具结果换成一行占位（工具输出通常是最大的块）
 *   hmid  再整组删中间的消息
 *   hmin  只剩最近一条用户消息
 */
export function* checkpointInputs(history, fits) {
  const rungs = [
    ["h0", () => history],
    ["hall", () => withoutToolResults(history)],
    ["hmid", () => deleteMiddle(withoutToolResults(history), fits)],
    ["hmin", () => latestUserQuery(history)],
  ];
  for (const [name, build] of rungs) {
    const messages = build();
    if (messages && fits(messages)) yield { name, messages };
  }
}

function withoutToolResults(history) {
  return history.map((m) => (m.role === "tool" ? { ...m, text: TOOL_REMOVED } : m));
}

function latestUserQuery(history) {
  const last = history.findLast((m) => m.role === "user" && m.text?.trim() && !/^\/compact(\s|$)/i.test(m.text.trim()));
  return last ? [{ role: "user", text: last.text }] : undefined;
}

// ─── 7. 压缩之后的视图 ──────────────────────────────────────────────────────

/**
 * 用摘要换掉 `keepFrom` 之前的全部历史。`keepFrom` 是要保留的后缀的起点：
 * 它必须是一条用户消息——后缀不能从一个工具回合的中间开始。省略 `keepFrom` 表示什么都不留。
 *
 * MiniMax 的 llm_checkpoint 整份换掉历史，唯一留下的是“这个 Turn 正要回答的那条用户消息”
 * （Turn 开头压缩时），所以实际调用时 `keepFrom` 就是最后一条用户消息的下标。
 */
export function compactView(history, checkpointText, keepFrom = history.length) {
  if (keepFrom !== history.length) {
    if (!Number.isInteger(keepFrom) || keepFrom <= 0 || history[keepFrom]?.role !== "user") {
      throw Error("compact at a user boundary");
    }
  }
  return [{ role: "compactionSummary", summary: checkpointText }, ...structuredClone(history.slice(keepFrom))];
}

// ─── 8. 请求前的压缩钩子 ────────────────────────────────────────────────────

/**
 * 对应 `createAutomaticContextCompactionHook` + `compactContext` + Pi 循环里的 `transformContext`：
 * 每次请求模型之前调用一次。
 *
 * 两种失败的取舍相反，这是本章最要紧的设计：
 *   摘要这一半（探测、生成、校验、事后核对）失败 → 敞开：返回 `skipped`，这一次照旧用压缩前的历史请求模型。
 *     压缩是维护工作，不该因为它出问题让用户的任务停下。
 *   提交这一半（持久化替换）失败 → 闭合：抛出，不请求模型。
 *     带着“没存下来的新历史”去请求，下一次恢复时就会和模型看到的对不上。
 *
 * @param messages 当前历史（会被原地替换）
 * @param model `{ id, contextWindow, maxOutputTokens }`
 * @param summarize `async (messages) => { text, stopReason, kinds, outputTokens }`；放不下时抛 `INPUT_TOO_LARGE`
 * @param recovery 服务商刚拒绝过上一次请求：无论量出来多大都压缩（对应 `input.recovery`）
 * @param manual 用户手动 `/compact`：提交前不做事后核对（“用户明确要求的压缩总是提交”）
 */
export async function compactBeforeModelCall(input) {
  const { messages, model, cursor, summarize, compactionId, recovery = false, manual = false, triggerAt } = input;
  const budget = compactionBudget({ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, triggerAt });

  // ① 量的是真正会发出去的那份，不是内存里的原始历史。
  const before = estimateTokens(projectOutbound(messages, model).messages);
  if (!manual && !recovery && before <= budget.triggerAt) return { status: "unchanged", before, budget };

  let replacement;
  let rung;
  try {
    // ② 找一份放得下的摘要输入，请模型写摘要；服务商说输入太大，就换更小的一份。
    const fits = (candidate) => estimateTokens(projectOutbound(candidate, model).messages) <= budget.inputLimit;
    let generation;
    for (const candidate of checkpointInputs(messages, fits)) {
      try {
        generation = await generateWithOneRetry(summarize, candidate.messages);
        rung = candidate.name;
        break;
      } catch (error) {
        if (error.code !== "INPUT_TOO_LARGE") throw error;
      }
    }
    if (!generation) throw coded("COMPACTION_INPUT_TOO_LARGE", "Context is too large for bounded checkpoint generation.");

    // ③ 校验，再把摘要和宿主核实过的事实装成一条消息。
    const checked = await checkpoint(generation.text, generation);
    const summary = checkpointMessage(messages, checked.summary, before);
    // Turn 开头压缩时，历史末尾是这个 Turn 正要回答的用户消息：它必须留在摘要后面。
    const last = messages.length - 1;
    replacement = compactView(messages, summary.summary, messages[last]?.role === "user" ? last : undefined);
    Object.assign(replacement[0], { recentUserQueries: summary.recentUserQueries, tokensBefore: before });
    rung = `${rung}/${checked.status}`;

    // ④ 事后核对：换完之后的请求必须放得下，否则这次压缩没有意义。
    const after = estimateTokens(projectOutbound(replacement, model).messages);
    if (!manual && after > budget.inputLimit) throw coded("POST_ADMISSION_FAILED", "Generated checkpoint does not fit the next request.");
  } catch (error) {
    return { status: "skipped", reason: error.code ?? "failed", error, before, budget };
  }

  // ⑤ 提交。内存先换（对应 `agent.state.messages = replacement.messages`），再持久化；持久化失败就停。
  messages.splice(0, messages.length, ...replacement);
  try {
    await cursor.replace(messages, { replacementId: compactionId, tokensBefore: before });
  } catch (error) {
    throw new Error(`before_llm_checkpoint_persistence_failed: ${error.message}`, { cause: error });
  }
  const after = estimateTokens(projectOutbound(messages, model).messages);
  return { status: "completed", before, after, rung, budget };
}

/** 服务商层面的失败（stopReason 为 error）只重试一次；第二次还失败就按服务商故障上报。 */
async function generateWithOneRetry(summarize, messages) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const generation = await summarize(messages);
    if (generation.stopReason !== "error") return generation;
  }
  throw coded("CHECKPOINT_PROVIDER_FAILED", "Checkpoint Provider request failed after one retry.");
}
