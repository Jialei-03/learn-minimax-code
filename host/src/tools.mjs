// 第 4 章：工具。
//
// 对应 MiniMax Code 0.7.2 的这几处：
//   agent-core/src/tools/types.ts、define.ts          RuntimeTool：给模型看的 def + 干活的 impl
//   agent-core/src/pi-turn-runner/tools.ts            newTools / newRuntimeTool / setToolHooks
//   third_party/pi-mono/packages/agent/src/agent-loop.ts
//                                                     prepareToolCall（找工具 → 修参数 → 校验 → 前置 Hook）
//                                                     executeToolCalls（一批调用串行还是并行）
//   agent-core/src/pi-turn-runner/ptc-tool-executor.ts
//                                                     run_code 的子调用走同一条流水线
//   local-runtime-v2/.../agent-host/runner/ptc/       run_code 工具本身：描述、预算、结果整形
//   agent-tools/src/desktop/output-limit.ts           同一个 read：给模型的上限，给程序的全文
//
// 本文件分六块，自上而下就是一个工具调用的一生：
//   1. 目录与参数      toolCatalogue、修参数、校验（Hook 改写参数之后会再校验一次）
//   2. 适配            newRuntimeTool：把工具定义翻成“内核”能直接调用的形状，返回值在这里分流
//   3. 流水线          runToolCall / wrapTool：八种失败各停在哪一关，Hook 和权限的位置
//   4. 调度            batchMode（Pi 的整批规则）、SubcallScheduler（run_code 子调用的屏障队列）
//   5. 内置工具        localTools：read / edit / test
//   6. PTC             run_code：让模型写程序，工具结果留在程序里
//
// 简化：
//   - MiniMax 的工具参数是 TypeBox schema，由 Pi 校验；这里是一个很小的 JSON Schema 子集。
//   - MiniMax 的 run_code 在 QuickJS（WebAssembly）里跑，放在 Worker 线程里；这里用 node:vm。
//     node:vm 不是安全边界，它只用来演示“程序通过一个只传 JSON 字符串的桥调用工具”这条通路，
//     不要拿它运行不可信的代码。
//   - 没有 Tool Search 的长尾工具、媒体结果、后台 Bash，也没有批次共享的 wall clock 和审批暂停。
//
// 对外的 API 与之前一致：`toolCatalogue`、`wrapTool`、`localTools`。
// 新增的只有：返回值里的 `failure`，`wrapTool` 选项里的 `observeError`，工具定义里的
// `schema` / `description` / `prepareArguments`，以及 PTC 相关的导出。
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { workspacePath, atomicWrite } from "../../runtime/files.mjs";
import { runSandboxed } from "../../runtime/sandbox.mjs";
import { runProcess } from "../../runtime/process.mjs";
import { authorize } from "./permissions.mjs";

// ═══ 1. 目录与参数 ═══════════════════════════════════════════════════════════

/**
 * 一个 Turn 能用的工具目录。重名直接报错（对应 `newTools` 的 duplicate tool name）：
 * 否则目录里展示的是一个定义，实际执行的是另一个。
 */
export function toolCatalogue(definitions) {
  const map = new Map();
  for (const definition of definitions) {
    if (map.has(definition.name)) throw Error(`duplicate tool name '${definition.name}'`);
    map.set(definition.name, definition);
  }
  return map;
}

/**
 * 修正“意图毫无歧义”的格式错误，对应 Pi 的 `validateToolArguments` 在校验前做的类型修正：
 * 数字写成字符串、布尔写成 "true"、标量写成字符串。修不了的原样返回，由后面的严格校验报错。
 */
function coerceScalar(type, value) {
  if ((type === "number" || type === "integer") && typeof value === "string") {
    if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  return value;
}

const matchesType = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};

const describeValue = (v) => (typeof v === "string" ? JSON.stringify(v) : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * 按 schema 修正并检查一个值，返回修正后的副本；问题记进 `problems`（路径 + 说明）。
 * 只认 type / properties / required / items / enum，其余关键字一律放过。
 */
export function checkSchema(schema, value, path = "", problems = []) {
  if (!schema || typeof schema !== "object" || !schema.type) return value;
  const fixed = coerceScalar(schema.type, value);
  if (!matchesType[schema.type]?.(fixed)) {
    problems.push({ path, message: `expected ${schema.type}, got ${describeValue(value)}` });
    return value;
  }
  if (schema.enum && !schema.enum.includes(fixed)) {
    problems.push({ path, message: `must be one of ${schema.enum.join(", ")}` });
  }
  if (schema.type === "object") {
    const out = { ...fixed };
    for (const key of schema.required ?? []) {
      if (!(key in out)) problems.push({ path: path ? `${path}.${key}` : key, message: "is required" });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in out) out[key] = checkSchema(sub, out[key], path ? `${path}.${key}` : key, problems);
    }
    return out;
  }
  if (schema.type === "array" && schema.items) {
    return fixed.map((item, i) => checkSchema(schema.items, item, `${path}[${i}]`, problems));
  }
  return fixed;
}

/**
 * 第 2 道关：参数修正。工具可以带自己的 `prepareArguments`，处理某个模型对某个工具的固定坏习惯
 * （MiniMax 的 `prepareEditArguments`：有的模型把 edits 数组序列化成字符串发过来）。
 * 先复制一份，工具和 Hook 改的都是副本，历史里那条调用不会被改写。
 */
function prepareArguments(definition, rawInput) {
  const copy = structuredClone(rawInput ?? {});
  return definition.prepareArguments ? definition.prepareArguments(copy) : copy;
}

/**
 * 第 3 道关：校验。先过 schema（带修正），再过工具自己的语义检查 `validate`（比如路径不能越出工作区）。
 * 错误信息是写给下一轮模型看的：哪个参数、错在哪、实际收到了什么。
 */
function validateArguments(definition, input) {
  let value = input;
  if (definition.schema) {
    const problems = [];
    value = checkSchema(definition.schema, input, "", problems);
    if (problems.length) {
      const lines = problems.map((p) => `  - ${p.path || "(root)"}: ${p.message}`).join("\n");
      throw Error(`Validation failed for tool "${definition.name}":\n${lines}\n\nReceived arguments:\n${JSON.stringify(input, null, 2)}`);
    }
  }
  definition.validate?.(value);
  return value;
}

// ═══ 2. 适配：把工具定义翻成内核能调用的形状 ═══════════════════════════════════

/**
 * 对应 `newRuntimeTool`：定义里给模型看的部分（名字、描述、schema、串并行声明）原样带上；
 * 干活的 `execute` 套一层——每次调用都新造一份上下文（带上这次调用的 toolCallId），
 * 返回值在这里分成三路：
 *   text / terminate        → 给模型（进历史）
 *   details（含 is_error）  → 给界面和日志，模型看不到
 *   programmatic            → 只交给 observer（run_code 的执行器），从不进入返回值
 */
export function newRuntimeTool(definition, context, observer) {
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.schema,
    source: definition.source,
    // 没有声明的工具按“串行”处理：新工具什么都不写，就当成独占的。
    executionMode: definition.executionMode ?? "sequential",
    async execute(toolCallId, input) {
      const callContext = { ...context, toolCallId }; // 共享定义不等于共享调用身份
      let raw;
      try {
        raw = await definition.execute(input, callContext);
      } catch (error) {
        observer?.onError?.(error); // 内核只保留 error.message，observer 还能看到原始错误对象
        throw error;
      }
      observer?.onResult?.(raw); // 先让 observer 看到完整的原始返回值……
      return {
        // ……再投影成对外的结果：programmatic 在这里被丢掉。
        text: raw.text ?? "",
        details: { ...raw.details, ...(raw.isError !== undefined ? { is_error: raw.isError } : {}) },
        terminate: raw.terminate,
      };
    },
  };
}

// ═══ 3. 流水线 ═══════════════════════════════════════════════════════════════

/**
 * 一次调用的失败，按 Pi 的 `ToolCallFailureKind` 分类。分类是“哪一关拦下的”，不是从错误文字里猜的：
 *   tool_not_found / argument_preparation / argument_validation   工具还没动手
 *   before_hook / blocked / cancelled                              准入阶段拦下，execute 不会被调用
 *   execution                                                      execute 抛出
 *   after_hook                                                     后置 Hook 抛出（工具已经执行过）
 */
function failureFrom(kind, error, extra = {}) {
  return { kind, message: String(error?.message ?? error), ...extra };
}

/**
 * 跑一个工具调用，不抛异常：任何一关失败都变成一条 isError 的结果交回模型。
 * 对应 Pi 的 prepareToolCall → executePreparedToolCall → finalizeExecutedToolCall。
 *
 * `before` 钩子返回 `{ block, reason }` 拦下调用，返回 `{ updatedInput }` 改写参数
 * （改写后重新校验：MiniMax 用 `isRuntimeToolInputValid` 对照权威 schema）。
 * `after` 钩子返回补丁，后一个钩子看到的是前一个改写之后的结果。
 * 权限（`authorize`）是准入阶段的最后一个检查，对应 MiniMax 里挂在 beforeToolCall 上的权限门。
 */
async function runToolCall(definition, context, call, options) {
  const { before = [], after = [], observe, observeError, rules = {}, mode } = options;
  const stop = (failure) => ({ failure, text: failure.message, details: {}, isError: true });

  // 第 2、3 道关：修参数、校验。
  let input;
  try {
    input = prepareArguments(definition, call.input);
  } catch (error) {
    return stop(failureFrom("argument_preparation", error));
  }
  try {
    input = validateArguments(definition, input);
  } catch (error) {
    return stop(failureFrom("argument_validation", error));
  }

  // 第 4 道关：准入。先是 Hook，再是权限。
  try {
    context.signal?.throwIfAborted();
  } catch (error) {
    return stop(failureFrom("cancelled", error));
  }
  for (const hook of before) {
    let verdict;
    try {
      verdict = await hook({ ...call, input, source: definition.source }, context);
    } catch (error) {
      return stop(failureFrom("before_hook", error));
    }
    if (verdict?.block) {
      return stop(failureFrom("blocked", verdict.reason ?? "blocked by hook", { blockedBy: "hook" }));
    }
    if (verdict?.updatedInput) {
      try {
        input = validateArguments(definition, structuredClone(verdict.updatedInput));
      } catch (error) {
        return stop(failureFrom("before_hook", `hook returned invalid input: ${error.message}`));
      }
    }
  }
  try {
    if (!authorize({ ...call, input }, definition, { root: context.root, rules, mode })) {
      return stop(failureFrom("blocked", "permission denied", { blockedBy: "permission" }));
    }
  } catch (error) {
    return stop(failureFrom("before_hook", error)); // 权限门本身出错：和 Hook 抛错一样，宁可拦下
  }
  try {
    context.signal?.throwIfAborted();
  } catch (error) {
    return stop(failureFrom("cancelled", error));
  }

  // 第 5 道关：执行。抛出的错误变成结果，但后置 Hook 照样会看到它。
  const tool = newRuntimeTool(definition, context, { onResult: observe, onError: observeError });
  let result;
  let isError = false;
  let errorOrigin;
  let failure;
  try {
    const executed = await tool.execute(call.id, input);
    result = { text: executed.text, details: executed.details, terminate: executed.terminate };
    // 工具自己在 details 里写了 is_error / ok:false，也算失败，来源是工具（toolResultErrorPatch）。
    if (result.details.is_error === true || result.details.ok === false) {
      isError = true;
      errorOrigin = "tool";
    }
  } catch (error) {
    failure = failureFrom("execution", error);
    result = { text: failure.message, details: {} };
    isError = true;
    errorOrigin = "tool";
  }

  // 第 6 道关：后置 Hook，可以改写结果；后一个看到的是前一个改写之后的。
  for (const hook of after) {
    try {
      const patch = await hook(call, { ...result, isError });
      if (!patch) continue;
      const { isError: patched, ...rest } = patch;
      result = { ...result, ...rest };
      if (patched !== undefined) {
        isError = patched;
        errorOrigin = patched ? "hook" : undefined;
      }
    } catch (error) {
      failure = failureFrom("after_hook", error);
      result = { text: failure.message, details: {} };
      isError = true;
      errorOrigin = "hook";
      break;
    }
  }
  return { ...result, isError, errorOrigin, ...(failure ? { failure } : {}) };
}

/**
 * 把一个工具定义包成 `(call) => 结果` 的函数，结果是交回模型的 tool 消息。
 * 签名与第 2 章的 `runTurn` 使用方式一致；`observe(raw)` 能看到工具的原始返回值
 * （包括 programmatic），`observeError(error)` 能看到抛出的原始错误。
 */
export function wrapTool(definition, context, options = {}) {
  return async (call) => {
    // 子调用走哪条流水线：和这一次调用的 Hook、权限、规则是同一套。
    const ptcExecutor = createPtcExecutor(context, options);
    const outcome = await runToolCall(definition, { ...context, ptcExecutor }, call, options);
    const { failure, isError, errorOrigin, ...result } = outcome;
    return {
      role: "tool",
      id: call.id,
      ...result,
      error: isError || result.details?.is_error === true || result.details?.ok === false,
      ...(errorOrigin ? { errorOrigin } : {}),
      ...(failure ? { failure } : {}),
    };
  };
}

/**
 * 从目录里按名字找到工具再跑。找不到不是异常：模型编造了一个工具名，得到的是一条
 * `tool_not_found` 的错误结果（对应 Pi prepareToolCall 的第一关），下一轮它自己会改。
 */
export function callTool(catalogue, call, context, options = {}) {
  const definition = catalogue.get(call.name);
  if (!definition) {
    const message = `Tool ${call.name} not found`;
    return Promise.resolve({
      role: "tool", id: call.id, text: message, details: {}, error: true,
      failure: failureFrom("tool_not_found", message),
    });
  }
  return wrapTool(definition, context, options)(call);
}

/**
 * tool 消息里模型能看到的部分：文本和错误标记。details、failure 留给界面和日志。
 * MiniMax 里这一步发生在 Pi 的 convertToLlm：工具结果只取 content。
 */
export const modelView = (message) => ({ role: "tool", id: message.id, text: message.text, error: message.error });

// ═══ 4. 调度 ═════════════════════════════════════════════════════════════════

/**
 * 一条回复里的多个调用，是一起跑还是一个个跑？Pi 的规则很简单（agent-loop.ts 的 executeToolCalls）：
 * 批次里只要有一个工具声明了串行，整批串行；否则整批并行。没有声明的工具按串行算。
 * 查不到的工具不参与判断：它会立刻得到一条“工具不存在”的错误，不会真的执行。
 */
export function batchMode(calls, catalogue) {
  const sequential = calls.some((call) => {
    const definition = catalogue.get(call.name);
    return definition && (definition.executionMode ?? "sequential") === "sequential";
  });
  return sequential ? "sequential" : "parallel";
}

/**
 * run_code 里的子调用不是“一批”，而是程序随时发来的一串请求，所以用一条队列排：
 * 并行工具最多同时跑 maxConcurrent 个；串行工具要等前面的都结束才开始，
 * 它开始之后，排在后面的所有调用（哪怕是并行的）都得等它结束——写操作既是独占者，也是栅栏。
 * 对应 PtcSubcallScheduler 的 pump()。
 */
export class SubcallScheduler {
  queue = [];
  active = new Set();
  idle = [];

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  run(mode, task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ mode: mode ?? "sequential", task, resolve, reject });
      this.pump();
    });
  }

  /** 等队列和正在跑的调用都结束。 */
  async drain() {
    if (!this.queue.length && !this.active.size) return;
    await new Promise((resolve) => this.idle.push(resolve));
  }

  /** 排队中和正在跑的调用数，程序提前返回时用来判断“还有没有没结束的子调用”。 */
  get pending() {
    return this.queue.length + this.active.size;
  }

  pump() {
    if ([...this.active].some((item) => item.mode === "sequential")) return; // 正在跑独占的调用
    for (;;) {
      const next = this.queue[0];
      if (!next) break;
      if (next.mode === "sequential") {
        if (this.active.size > 0) return; // 独占调用要等前面的都跑完，并且挡住后面所有的调用
        this.start(this.queue.shift());
        return;
      }
      if (this.active.size >= this.maxConcurrent) return;
      this.start(this.queue.shift());
    }
    this.notifyIdle();
  }

  start(item) {
    this.active.add(item);
    (async () => {
      try {
        item.resolve(await item.task());
      } catch (error) {
        item.reject(error);
      } finally {
        this.active.delete(item);
        this.pump(); // 腾出了位置（或独占调用结束了），看看队头能不能开始
        this.notifyIdle();
      }
    })();
  }

  notifyIdle() {
    if (this.queue.length || this.active.size) return;
    for (const resolve of this.idle.splice(0)) resolve();
  }
}

// ═══ 5. 内置工具 ═════════════════════════════════════════════════════════════

/** 给模型的读上限（MiniMax 的 DESKTOP_READ_TEXT_MAX_BYTES）：模型的上下文贵，一次读不了太多。 */
export const MODEL_READ_MAX_BYTES = 24 * 1024;
/** run_code 子调用能拿到的整份输出上限（PTC_CHILD_FULL_OUTPUT_MAX_BYTES）：给程序的，不进模型上下文。 */
export const PTC_CHILD_FULL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 这次调用是不是 run_code 程序发出的子调用。只有子调用的上下文里有 parentToolCallId，
 * 模型直接发起的调用没有（对应 output-limit.ts 的 isPtcChildCall）。
 */
export function isPtcChildCall(context) {
  return typeof context.parentToolCallId === "string" && context.parentToolCallId.length > 0;
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/** 取尽量多的整行，让“正文 + 提示”不超过 maxBytes。返回显示的行数。 */
function fitLines(lines, maxBytes, notice) {
  let count = 0;
  let used = 0;
  for (const line of lines) {
    const next = used + byteLength(line) + 1;
    if (next + byteLength(notice(count + 1)) > maxBytes) break;
    used = next;
    count += 1;
  }
  return count;
}

/**
 * read 的执行：同一个工具，两种读者，两种上限。
 *   模型直接调用    超过 24 KiB 就只给前面的整行，并告诉它从哪一行继续（模型的上下文贵）
 *   run_code 子调用  整个窗口交给程序，不截断（程序只会把过滤后的结果还给模型）
 * 对应 MiniMax 的 LocalReadTool：它手里有两个 Pi 的 read（一个有上限、一个没有），按 isPtcChildCall 选。
 * 每次都在 programmatic 里报告“这次有没有截断”：run_code 只相信工具自己的说法。
 */
function readFile(root, input, context) {
  const lines = readFileSync(workspacePath(root, input.path), "utf8").split("\n");
  const start = (input.offset ?? 1) - 1;
  const end = input.limit === undefined ? lines.length : Math.min(lines.length, start + input.limit);
  const window = lines.slice(start, end);
  const body = window.join("\n");
  // 调用方明确要求的窗口结束在文件中间：没有任何内容被截掉，但后面还有，告诉程序从哪里继续。
  const more = end < lines.length ? { hasMore: true, nextOffset: end + 1, offsetUnit: "line" } : {};
  const whole = {
    text: body,
    programmatic: {
      data: { content: body, totalLines: lines.length },
      completeness: { truncated: false, ...more },
    },
  };

  if (isPtcChildCall(context) && byteLength(body) <= PTC_CHILD_FULL_OUTPUT_MAX_BYTES) return whole;
  if (byteLength(body) <= MODEL_READ_MAX_BYTES) return whole;

  // 模型直接调用，超过上限：只给前面的整行，并告诉它从哪一行继续。
  const firstLine = start + 1;
  const notice = (shown) =>
    `\n[truncated: showing ${shown} of ${window.length} lines. Continue with offset=${firstLine + shown}.]`;
  const shown = fitLines(window, MODEL_READ_MAX_BYTES, notice);
  if (shown === 0) {
    // 连一整行都放不下（比如压缩过的单行文件）：按字节切，仍然告诉模型从下一行继续。
    const cut = Buffer.from(window[0]).subarray(0, MODEL_READ_MAX_BYTES).toString("utf8");
    return {
      text: `${cut}\n[truncated: line ${firstLine} is longer than ${MODEL_READ_MAX_BYTES} bytes.]`,
      details: { truncation: { truncated: true, shownLines: 0, totalLines: window.length } },
      programmatic: { completeness: { truncated: true, hasMore: true, nextOffset: firstLine + 1, offsetUnit: "line" } },
    };
  }
  return {
    text: window.slice(0, shown).join("\n") + notice(shown),
    details: { truncation: { truncated: true, shownLines: shown, totalLines: window.length } },
    programmatic: {
      completeness: { truncated: true, hasMore: true, nextOffset: firstLine + shown, offsetUnit: "line" },
    },
  };
}

/** 内置的三个本地工具。每个工具的 schema 和 description 是写给模型的，execute 是干活的。 */
export function localTools(root) {
  const validPath = (input) => {
    if (typeof input.path !== "string") throw Error("path required");
    workspacePath(root, input.path);
  };
  return [
    {
      name: "read",
      source: "builtin",
      readOnly: true,
      executionMode: "parallel", // 只读，可以和别的读一起跑
      description:
        "Read a UTF-8 text file in the workspace. Output is capped at 24 KiB; use offset and limit (in lines) to page through longer files.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          offset: { type: "integer", description: "First line to read (1-indexed)." },
          limit: { type: "integer", description: "Number of lines to read." },
        },
        required: ["path"],
      },
      validate: validPath,
      execute: (input, context) => readFile(root, input, context),
    },
    {
      name: "edit",
      source: "builtin",
      executionMode: "sequential", // 会改文件，独占
      description: "Replace one exact, unique occurrence of `old` with `next` in a workspace file.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old: { type: "string", description: "Exact existing text. Must match exactly once." },
          next: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old", "next"],
      },
      validate: (input) => {
        validPath(input);
        if (!input.old || typeof input.next !== "string") throw Error("edit strings required");
      },
      execute: (input) => {
        const file = workspacePath(root, input.path),
          before = readFileSync(file, "utf8");
        if (before.split(input.old).length !== 2) throw Error("edit target not unique");
        atomicWrite(file, before.replace(input.old, input.next));
        // “edited” 是一张收据，不可能被截断；明确报告出来，run_code 才会把它标成 complete。
        return { text: "edited", details: { before }, programmatic: { file, completeness: { truncated: false } } };
      },
    },
    {
      name: "test",
      source: "builtin",
      executionMode: "sequential",
      description: "Run a JavaScript test file in the workspace with Node and return its output.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      validate: validPath,
      execute: async (input, context) => {
        const result = context.sandboxRequired
          ? await runSandboxed(root, process.execPath, [workspacePath(root, input.path)], { signal: context.signal })
          : await runProcess(process.execPath, [workspacePath(root, input.path)], { cwd: root, signal: context.signal });
        return {
          text: result.stdout + result.stderr,
          isError: result.code !== 0,
          details: result,
        };
      },
    },
  ];
}

// ═══ 6. PTC：让模型写程序，工具结果留在程序里 ═══════════════════════════════════

/**
 * 对应 contracts.ts 的 PTC_LIMITS 和 ptc.ts 的 PTC_*_WALL_CLOCK_MS。数字取自 MiniMax；
 * `maxComputeMs` 在这里没有对应物：QuickJS 有中断处理器能打断同步死循环，node:vm 管不住 await 之后的死循环。
 */
export const PTC_LIMITS = {
  maxToolCalls: 100, // 一个程序最多发 100 次子调用，之后的调用被拒绝（不执行），程序继续
  maxConcurrentToolCalls: 16, // 并行工具最多同时跑几个
  maxOuterResultBytes: 64 * 1024, // 程序的返回值（模型能看到的唯一结果）上限
  maxConsoleBytes: 16 * 1024, // console.* 输出上限
  maxBridgeMessageBytes: 16 * 1024 * 1024, // 一次子调用结果过桥的上限，超过只让这一次调用失败
  defaultWallClockMs: 120_000,
  maxWallClockMs: 3_600_000,
};

/** 这些工具在 PTC 模式下仍然是模型直接调用的：要和用户交互、改变控制流的，不能藏进程序里。 */
export const PTC_DIRECT_ONLY_TOOL_NAMES = new Set([
  "ask_user", "request_feature_enable", "EnterPlanMode", "ExitPlanMode",
  "create_goal", "get_goal", "update_goal", "skill", "tool_search",
  "website_deploy", "task", "task_append", "code_review", "run_code",
]);

/** 对应 resolvePtcWallClock：把模型给的 timeout_ms 变成程序的 wall clock。 */
export function resolveWallClock(requested, limits = PTC_LIMITS) {
  if (requested === undefined) return { ms: limits.defaultWallClockMs, source: "default" };
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return { ms: limits.defaultWallClockMs, source: "invalid" };
  }
  if (requested > limits.maxWallClockMs) return { ms: limits.maxWallClockMs, source: "capped" };
  return { ms: requested, source: "requested" };
}

/** 子调用失败的错误码来自这张表，是“哪一关拦下的”，不是从工具输出里抄来的，所以程序可以放心 switch。 */
const FAILURE_CODES = {
  tool_not_found: "PTC_TOOL_NOT_FOUND",
  argument_preparation: "PTC_ARGUMENT_PREPARATION_FAILED",
  argument_validation: "PTC_ARGUMENT_VALIDATION_FAILED",
  before_hook: "PTC_BEFORE_TOOL_HOOK_FAILED",
  cancelled: "PTC_CANCELLED",
  execution: "PTC_TOOL_EXECUTION_FAILED",
  after_hook: "PTC_AFTER_TOOL_HOOK_FAILED",
};
export function failureCode(failure) {
  if (!failure) return "PTC_TOOL_FAILED"; // 工具自己返回了 isError，不是流水线拦下的
  if (failure.kind === "blocked") return failure.blockedBy === "permission" ? "PTC_PERMISSION_DENIED" : "PTC_TOOL_BLOCKED";
  return FAILURE_CODES[failure.kind];
}

/**
 * 工具的 programmatic 数据只有在“结果还是工具自己的”时候才交给程序。
 * 后置 Hook 改过内容或错误状态（比如把密钥隐去、把失败改成成功），工具自带的 data 可能还带着被隐去的东西，
 * 所以必须扣下（对应 ptc-tool-executor.ts 的 resolveToolOwnership）。
 */
function ownsResult(own, result) {
  if (result.failure?.kind === "after_hook") return false;
  if (!own) return !result.failure; // 抛出的错误：没有 programmatic 可交
  const ownError = own.isError === true || own.details?.is_error === true || own.details?.ok === false;
  if (result.errorOrigin === "hook" || result.error !== ownError) return false;
  return (own.text ?? "") === result.text;
}

/**
 * 对应 createPtcToolExecutor：一个 Turn 私有的能力，注入到每次工具调用的上下文里（ctx.ptcExecutor）。
 * run_code 用它执行子调用。子调用走的是 `wrapTool`——参数校验、Hook、权限和普通调用是同一套，
 * 只是上下文里多了 parentToolCallId。没有这一点，模型把危险操作包进脚本就能绕过权限。
 */
function createPtcExecutor(context, options) {
  return {
    async execute(child, call, { parentToolCallId, signal }) {
      let own;
      const result = await wrapTool(
        child,
        { ...context, signal: signal ?? context.signal, parentToolCallId },
        { ...options, observe: (raw) => (own = raw), observeError: undefined },
      )(call);
      return { result, own, owned: ownsResult(own, result), source: child.source };
    },
  };
}

/** 一次子调用在程序里长什么样：先看 status，再用 output 或 data。 */
function guestResult(outcome, childId) {
  const { result, own, owned } = outcome;
  const completeness = owned ? own?.programmatic?.completeness : undefined;
  // “完整”必须是工具自己说的，并且结果没被 Hook 改过；没说就是 unknown，不是 complete。
  const verified = outcome.source === "builtin" && typeof completeness?.truncated === "boolean";
  const truncated = result.error ? "unknown" : verified ? completeness.truncated : "unknown";
  const status = result.error ? "failed" : truncated === true ? "truncated" : truncated === false ? "complete" : "unverified";
  return {
    status,
    isError: result.error,
    output: result.text,
    // 结构化数据只来自内置工具自己的 programmatic，并且结果没被 Hook 改过；第三方工具的自述不算数。
    data: owned && outcome.source === "builtin" ? (own?.programmatic?.data ?? {}) : {},
    truncation: {
      truncated,
      ...(verified && completeness.hasMore ? { hasMore: true, nextOffset: completeness.nextOffset, offsetUnit: completeness.offsetUnit } : {}),
    },
    ...(result.error ? { error: { code: failureCode(result.failure), message: result.text, toolCallId: childId } } : {}),
  };
}

/** 从工具的 schema 渲染一行 TypeScript 签名，写进 run_code 的描述（对应 tool-sdk.ts 的 renderPtcToolSdk）。 */
function schemaType(schema) {
  if (!schema?.type) return "unknown";
  if (schema.type === "integer") return "number";
  if (schema.type === "array") return `Array<${schemaType(schema.items)}>`;
  if (schema.type === "object") {
    const required = new Set(schema.required ?? []);
    const members = Object.entries(schema.properties ?? {}).map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${schemaType(v)}`);
    return `{ ${members.join("; ")} }`;
  }
  return schema.type;
}

/** 模型看到的 run_code 描述：隐藏了哪些工具、程序怎么写、每个子调用的签名。 */
export function runCodeDescription(children) {
  const names = children.map((child) => child.name);
  return [
    `In this turn ${names.join(", ")} ${names.length === 1 ? "is not a top-level tool" : "are not top-level tools"}; call ${names.length === 1 ? "it" : "them"} only inside run_code as await tools.<name>(args).`,
    "Write the body of a JavaScript async function and return a JSON-serializable value; only that value (and console output) comes back to you. Put independent calls in one Promise.all.",
    "Every call resolves to a ToolResult and never throws: check r.status first (complete | truncated | unverified | failed), then use r.output or r.data. Only the tool's own report can make a result 'complete'.",
    "Calls made inside run_code are not subject to the output caps a direct call has: r.output and r.data hold the whole result. Only the value you return is limited.",
    "type ToolResult = { status: string; isError: boolean; output?: string; data: object; truncation: { truncated: boolean | 'unknown'; hasMore?: boolean; nextOffset?: number }; error?: { code: string; message: string } };",
    "declare const tools: {",
    ...children.map((child) => `  // ${child.description ?? child.name}\n  ${JSON.stringify(child.name)}: (args: ${schemaType(child.schema)}) => Promise<ToolResult>;`),
    "};",
  ].join("\n");
}

const RUN_CODE_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", description: "Body of an async function." },
    description: { type: "string", description: "What the program does, shown when a child call needs approval." },
    timeout_ms: { type: "number", description: "Wall clock for this program in milliseconds." },
  },
  required: ["code", "description"],
};

/**
 * 创建 run_code 工具。`children` 是被藏起来的工具：模型看不到它们，只能在程序里 `tools.<name>(args)`。
 * 对应 createPtcRunCodeTool + registerPtcChildTools（MiniMax 用 WeakMap 把子工具表挂在 run_code 对象上，
 * 不暴露给程序）。
 */
export function createRunCodeTool(children, { limits = PTC_LIMITS } = {}) {
  return {
    name: "run_code",
    source: "builtin",
    readOnly: true, // run_code 自己没有副作用；每个子调用在自己的流水线里单独过权限，不会因为外层放行而放行
    executionMode: "sequential",
    description: runCodeDescription(children),
    schema: RUN_CODE_SCHEMA,
    children,
    async execute(input, context) {
      const executor = context.ptcExecutor;
      if (!executor) return failedProgram("PTC_UNAVAILABLE", "run_code is available only during an active turn.");
      return runProgram({ children, limits, input, context, executor });
    },
  };
}

/**
 * PTC 模式下模型看到的工具目录：run_code，加上必须由模型直接调用的工具。
 * 其余工具成为 run_code 的子工具，从目录里消失（对应 buildPtcCatalog 返回的 [runCode, ...directTools]）。
 */
export function ptcCatalogue(tools, options) {
  const direct = tools.filter((tool) => PTC_DIRECT_ONLY_TOOL_NAMES.has(tool.name));
  const children = tools.filter((tool) => !PTC_DIRECT_ONLY_TOOL_NAMES.has(tool.name));
  return [createRunCodeTool(children, options), ...direct];
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const failedProgram = (code, message) => ({
  text: `<ptc_error code="${code}">${message}</ptc_error>`,
  details: { ptc: { version: 1, child_calls: [], retained_facts: [] } },
  isError: true,
});

// 访客代码：先取走桥函数再把它们从全局删掉，访客只能通过 tools.* 和 console.* 说话。
// 桥上来回的全是 JSON 字符串，没有任何活的宿主对象穿过边界（QuickJS 版本里是 argsJson / 返回 string）。
function bootstrap(names) {
  return `(() => {
    const call = globalThis.__call, log = globalThis.__log;
    delete globalThis.__call; delete globalThis.__log;
    const tools = {};
    for (const name of ${JSON.stringify(names)}) {
      tools[name] = async (args) => {
        const reply = JSON.parse(await call(name, JSON.stringify(args ?? {})));
        if (reply.bridgeError) throw new Error(reply.bridgeError);
        return reply;
      };
    }
    globalThis.tools = Object.freeze(tools);
    const show = (value) => (typeof value === "string" ? value : JSON.stringify(value));
    globalThis.console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => log(args.map(show).join(" "))]));
  })()`;
}

/**
 * 访客和宿主之间的桥。访客发来 (name, args)：宿主给它编号、排队、走流水线，再把结果投影成访客能看的样子。
 * 返回值的 `childCalls` 是要记进历史的子调用记录。
 */
function createChildBridge({ byName, limits, executor, parentToolCallId, signal, scheduler }) {
  const childCalls = [];
  let admitted = 0;

  async function call(name, args) {
    const child = byName.get(name);
    if (!child) return { bridgeError: `Tool is not available to PTC: ${name}` };
    admitted += 1;
    if (admitted > limits.maxToolCalls) {
      // 超出预算：这次调用不执行，程序继续往下走。
      return failedChild("PTC_TOOL_CALL_LIMIT_EXCEEDED", `PTC refused this call after reaching the ${limits.maxToolCalls}-call limit; it was not executed.`);
    }
    // 子调用的身份在动手之前就分配好、记下来：进程在子调用中途崩溃，记录里仍有一条 status=unknown 的条目。
    const childId = `${parentToolCallId}:${admitted}`;
    const record = { child_tool_call_id: childId, parent_tool_call_id: parentToolCallId, tool_name: name, status: "unknown" };
    childCalls.push(record);

    const outcome = await scheduler.run(child.executionMode, () =>
      executor.execute(child, { id: childId, name, input: args }, { parentToolCallId, signal }),
    );
    record.status = outcome.result.error ? "failed" : "completed";
    if (outcome.result.error) record.is_error = true;

    const reply = guestResult(outcome, childId);
    const size = Buffer.byteLength(JSON.stringify(reply));
    if (size > limits.maxBridgeMessageBytes) {
      // 工具已经执行了，只是结果过不了桥：只让这一次调用失败，程序可以缩小参数再试。
      return failedChild("PTC_RESULT_TOO_LARGE", `PTC child result is ${size} bytes, over the ${limits.maxBridgeMessageBytes}-byte per-call limit; the tool itself ran. Narrow the arguments and retry.`);
    }
    return reply;
  }
  return { call, childCalls };
}

/** 没有真正执行（或结果送不到）的子调用，访客看到的失败结果。 */
const failedChild = (code, message) => ({
  status: "failed",
  isError: true,
  data: {},
  truncation: { truncated: "unknown" },
  error: { code, message },
});

/** 访客的世界：一个只有 tools 和 console 的 vm 上下文。`output` 收集 console 输出，超过上限就截断。 */
function createGuest({ bridge, names, limits }) {
  const output = { text: "", truncated: false };
  const sandbox = vm.createContext(
    {
      __call: async (name, argsJson) => {
        try {
          return JSON.stringify(await bridge.call(name, JSON.parse(argsJson)));
        } catch (error) {
          return JSON.stringify({ bridgeError: String(error?.message ?? error) });
        }
      },
      __log: (line) => {
        if (output.truncated) return;
        if (Buffer.byteLength(output.text + line) + 1 > limits.maxConsoleBytes) output.truncated = true;
        else output.text += `${line}\n`;
      },
    },
    { codeGeneration: { strings: false, wasm: false } }, // 访客自己不能 eval / new Function
  );
  vm.runInContext(bootstrap(names), sandbox);
  return { sandbox, output };
}

/** 跑访客程序，返回 { value } 或 { error }。三个终点：程序自己结束、wall clock 到了、Turn 被取消。 */
async function runGuest({ sandbox, code, wallClockMs, signal }) {
  let timer;
  let onAbort;
  try {
    const program = new vm.Script(
      `(async () => { const value = await (async () => {\n${code}\n})(); return value === undefined ? undefined : JSON.stringify(value); })()`,
    );
    const running = program.runInContext(sandbox, { timeout: 1000 }); // 只管得住第一个 await 之前的同步部分
    const wallClockExceeded = new Promise((_, reject) => {
      timer = setTimeout(() => reject({ code: "wall_clock_exceeded", message: `The program exceeded its ${wallClockMs} ms wall clock.` }), wallClockMs);
    });
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject({ code: "cancelled", message: "The turn was cancelled." });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return { value: await Promise.race([running, wallClockExceeded, cancelled]) };
  } catch (error) {
    return { error: error?.code ? error : { code: "guest_error", message: String(error?.message ?? error) } };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function runProgram({ children, limits, input, context, executor }) {
  const abort = new AbortController(); // 程序结束时用它停掉还在跑的子调用
  const signal = context.signal ? AbortSignal.any([context.signal, abort.signal]) : abort.signal;
  const scheduler = new SubcallScheduler(limits.maxConcurrentToolCalls);
  const byName = new Map(children.map((child) => [child.name, child]));
  const bridge = createChildBridge({ byName, limits, executor, parentToolCallId: context.toolCallId, signal, scheduler });
  const { sandbox, output } = createGuest({ bridge, names: [...byName.keys()], limits });

  const outcome = await runGuest({ sandbox, code: input.code, wallClockMs: resolveWallClock(input.timeout_ms, limits).ms, signal });

  // 程序已经返回（或失败），但还有子调用没结束：停掉它们，并且告诉模型不要假设它们成功了。
  const incomplete = scheduler.pending > 0;
  if (incomplete || outcome.error) abort.abort();
  // 子调用不理会取消信号时，不能让整个 run_code 一直挂着：最多等 2 秒（对应 releaseProgramAfterDrain 的有界等待）。
  await withTimeout(scheduler.drain(), 2000);

  return programResult({ outcome, incomplete, output, childCalls: bridge.childCalls, limits });
}

/** 程序的结果怎样交给模型：console 在前，返回值在后；返回值太大就保留开头并注明。 */
function programResult({ outcome, incomplete, output, childCalls, limits }) {
  const consoleBlock = output.text || output.truncated
    ? `<ptc_console>\n${output.text}${output.truncated ? "[console output truncated]\n" : ""}</ptc_console>`
    : undefined;
  const header = incomplete && !outcome.error
    ? '<ptc_error code="PTC_INCOMPLETE">run_code returned before every child call settled. Do not assume incomplete child operations succeeded.</ptc_error>'
    : undefined;
  let body = outcome.error
    ? `<ptc_error code="${outcome.error.code}">${outcome.error.message}</ptc_error>`
    : outcome.value ?? "No return value.";
  let truncatedNote;
  if (!outcome.error && Buffer.byteLength(body) > limits.maxOuterResultBytes) {
    const total = Buffer.byteLength(body);
    body = Buffer.from(body).subarray(0, limits.maxOuterResultBytes).toString("utf8");
    truncatedNote = `[run_code result truncated: showing ${Buffer.byteLength(body)} of ${total} bytes. Return a smaller value or aggregate inside the code.]`;
  }
  const text = [consoleBlock, header, body, truncatedNote].filter(Boolean).join("\n");
  return {
    text,
    details: { ptc: { version: 1, child_calls: childCalls, retained_facts: [] } },
    // 返回值被截短不算错误：程序跑完了，注释里说明了显示了多少。
    isError: Boolean(outcome.error) || incomplete,
  };
}
