// 第 1 章：会话状态——会话本身，以及“这个会话正在忙”这一条事实。
//
// 对应 MiniMax Code 0.7.2 的三处代码：
//   1. local-runtime-v2/src/application/session/lifecycle-application.ts
//      创建会话。工作目录必须是绝对路径：相对路径由入口（cli/program.ts 的 `resolve(directory)`）
//      在命令行边界上解析好，运行时不替入口猜“当前目录”。
//   2. local-runtime-v2/src/service/turn-system/persistence/turn.repository.ts 的 `admitTurnInTransaction`
//      “忙”不是进程里的一个变量，而是数据库 `local_runtime_session_locks` 表里的一行
//      （主键是 session_id，所以一个会话最多一行）：持有者 ownerId、acquiredAtMs、expiresAtMs。
//      准入在一个事务里完成：先回收已经过期或者持有者已死的锁，再看还有没有锁，没有才插入新的。
//   3. local-runtime-v2/src/infra/runtime-owner/identity.ts 的 `createRuntimeOwnerLiveness`
//      判断持有者是否还活着：ownerId 里写着 pid 和进程实例号。
//
// 为什么要这样？同一台机器上，终端里的 mcode、另一个窗口的 `mcode exec`、编辑器拉起的 `mcode acp`
// 是三个独立的进程，共用同一个数据目录。只在内存里记“忙”，每个进程都以为这个会话是空闲的。
//
// 简化：
//   - MiniMax 的锁在 SQLite 里，靠事务和主键保证两个进程不会同时拿到锁；host 的锁在只追加日志
//     locks.jsonl 里，靠同步写入保证顺序。Journal 本来就声明了“不是多进程数据库”，
//     所以这里演示的是租约的规则，不是并发控制本身。
//   - 存活判断只用 `process.kill(pid, 0)`。MiniMax 还要求每个进程持有一个带心跳的 lockfile，
//     用来分辨“这个 pid 现在属于另一个进程”（PID 被复用）。
//   - 只有一种持有者（Turn）；MiniMax 还有压缩、删除会话、维护等持有者种类。
//
// 对外的 API（create / get / history / append / admit / active）保持兼容，新增 list / latest / holder /
// renew / recoveries，以及构造函数的第二个可选参数。和上一版相比有三处行为变化：
//   - “忙”写进共享的 locks.jsonl，而不是只记在 `active` 里；
//   - 释放函数在租约早已被回收时返回 false，而不是抛出异常；
//   - `append` 会拒绝已经失去租约的 Turn。
// 第 12 章总装又加了一个出口 `replace`：压缩提交时整份替换历史（旧行留在日志里当存档），`history` 随之改成折叠。
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Journal } from "../../runtime/journal.mjs";

/** 租约时长。MiniMax 的默认值是 30 分钟（turn.repository.ts 的 DEFAULT_LEASE_MS）。 */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;
/** 续租间隔。MiniMax 的 Turn 控制器每 10 秒续一次（turn.controller.ts 的 DEFAULT_RENEWAL_INTERVAL_MS）。 */
export const DEFAULT_RENEWAL_MS = 10 * 1000;

/**
 * 准入被拒绝。`reason` 是服务层的原因（对应 `TurnAdmissionRejectionReason`），
 * `code` 是应用层给入口的稳定错误键（对应 session-stream-delivery.ts 的 `directSendAdmissionError`），
 * 入口只认 `code`，不关心原因是怎么算出来的。
 */
export class AdmissionError extends Error {
  static CODES = {
    "active-turn": ["local_session_busy", "session busy"],
    "invalid-session": ["local_session_not_found", "session not found"],
  };
  constructor(reason, detail = {}) {
    const [code, message] = AdmissionError.CODES[reason];
    super(message);
    this.name = "AdmissionError";
    this.reason = reason;
    this.code = code;
    this.detail = detail; // 例如当前持有者，给日志和实验看，不给用户看
  }
}

/** 持有者的 ownerId 形如 `turn-lease:<pid>:<进程实例号>.<turnId>`，对应 MiniMax 的 `formatRuntimeOwnerId`。 */
const OWNER_ID = /^turn-lease:(\d+):([^.]+)\./;

/** 进程还在吗？`kill(pid, 0)` 不发信号，只检查。ESRCH 是“没有这个进程”，EPERM 是“有，但不归你”。 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * 把锁日志折叠成“此刻谁持有哪个会话”。
 * 事件有四种：acquire（拿到）、renew（续租）、release（正常释放）、recover（被别人回收）。
 * 被回收的 Turn 记进 `fenced`：它如果还在跑，就是僵尸，不能再写历史。
 */
function foldLocks(events) {
  const holders = new Map();
  const fenced = new Set();
  for (const event of events) {
    const holder = holders.get(event.sessionId);
    if (event.type === "acquire") {
      holders.set(event.sessionId, {
        ownerId: event.ownerId,
        turnId: event.turnId,
        acquiredAt: event.acquiredAt,
        expiresAt: event.expiresAt,
      });
    } else if (event.type === "renew" && holder?.ownerId === event.ownerId) {
      holder.expiresAt = event.expiresAt;
    } else if (event.type === "release" && holder?.ownerId === event.ownerId) {
      holders.delete(event.sessionId);
    } else if (event.type === "recover") {
      holders.delete(event.sessionId);
      fenced.add(event.turnId);
    }
  }
  return { holders, fenced };
}

export class Sessions {
  /**
   * @param dataDir 数据目录：同一个目录上的所有 Sessions 实例共享会话和锁，就像共用同一个数据库的几个进程。
   * @param options 都是为了让实验可控：假时钟、短租约、指定实例号、伪造“进程是否存活”。
   *   续租间隔默认取 min(10 秒, 租约 / 3)：租约是 30 分钟时就是 MiniMax 的 10 秒，实验里用很短的租约也能续上。
   */
  constructor(
    dataDir,
    {
      now = Date.now,
      leaseMs = DEFAULT_LEASE_MS,
      renewalMs = Math.min(DEFAULT_RENEWAL_MS, Math.max(1, Math.floor(leaseMs / 3))),
      instanceId = randomUUID(),
      pid = process.pid,
      isProcessAlive = processExists,
    } = {},
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.meta = new Journal(join(dataDir, "sessions.jsonl")); // 会话是谁、在哪个目录
    this.locks = new Journal(join(dataDir, "locks.jsonl")); // “忙”的事实：租约的全部变化
    this.now = now;
    this.leaseMs = leaseMs;
    this.renewalMs = renewalMs;
    this.instanceId = instanceId;
    this.pid = pid;
    this.isProcessAlive = isProcessAlive;
    // 本实例持有的租约（sessionId → turnId）。它只是镜像，真相在 locks.jsonl 里。
    this.active = new Map();
  }

  // ─── 会话 ────────────────────────────────────────────────────────────────

  create(workspaceDir) {
    // 入口要先把相对路径解析成绝对路径；到了这里，相对路径就是调用方的错误。
    if (!isAbsolute(workspaceDir)) throw Error("absolute workspace required");
    const session = {
      id: randomUUID(),
      workspaceDir: realpathSync(workspaceDir),
    };
    this.meta.append(session);
    return session;
  }

  get(id) {
    const session = this.meta.read().find((s) => s.id === id);
    if (!session) throw new AdmissionError("invalid-session");
    return session;
  }

  /** 所有会话（按创建先后）；给了 workspaceDir 就只要这个目录下的。 */
  list(workspaceDir) {
    const sessions = this.meta.read();
    if (workspaceDir === undefined) return sessions;
    const wanted = realpathSync(workspaceDir);
    return sessions.filter((s) => s.workspaceDir === wanted);
  }

  /** 这个目录下最近创建的会话，对应 `mcode exec --continue` 用到的 `findLatestWorkspaceSession`。 */
  latest(workspaceDir) {
    return this.list(workspaceDir).at(-1);
  }

  historyLog(id) {
    this.get(id);
    return new Journal(join(this.dataDir, `${id}.history.jsonl`));
  }

  /**
   * 历史 = 把日志从头折叠一遍。普通行（append）把消息接在后面；压缩行（replace）说“从这里起，历史就是这些”，
   * 前面的行原样留在日志里当存档（对应 MiniMax 压缩前先把旧历史存进 snapshots/ 再替换）。
   */
  history(id) {
    return this.historyLog(id)
      .read()
      .reduce((messages, row) => (row.replace ? [...row.messages] : [...messages, ...row.messages]), []);
  }

  /**
   * 追加一批消息。只有持有租约的 Turn 才能写：
   * 别的 Turn 持有着锁，或者自己的租约已经被回收（僵尸），都要拒绝。
   * 对应 MiniMax 里 Turn 结算时的“持有权检查”（turn.repository.ts 的 `settleInTransaction`）。
   */
  append(id, turnId, messages) {
    this.assertOwner(id, turnId);
    this.historyLog(id).append({ turnId, messages: structuredClone(messages) });
  }

  /**
   * 压缩提交：用 `messages` 整份替换这个会话的历史（第 6 章 `compactBeforeModelCall` 的持久化出口，
   * 对应 `change.reason === "replaceMessages"`）。持有权检查和 `append` 一样；被换掉的旧行还在日志里。
   */
  replace(id, turnId, messages, metadata = {}) {
    this.assertOwner(id, turnId);
    this.historyLog(id).append({ turnId, replace: true, metadata, messages: structuredClone(messages) });
  }

  /** 写历史之前的持有权检查：别人持有着锁，或者自己的租约已经被回收（僵尸），都要拒绝。 */
  assertOwner(id, turnId) {
    const { holders, fenced } = foldLocks(this.locks.read());
    const holder = holders.get(id);
    if (fenced.has(turnId) || (holder && holder.turnId !== turnId)) {
      throw Error("lease lost: this turn no longer owns the session");
    }
  }

  // ─── “忙”：租约 ──────────────────────────────────────────────────────────

  /** 此刻持有这个会话的人；没有就是 undefined。 */
  holder(id) {
    return foldLocks(this.locks.read()).holders.get(id);
  }

  /**
   * 接纳一个 Turn，返回只能由它自己调用的释放函数（正常释放返回 true，租约早已被回收返回 false）。
   * 顺序和 `admitTurnInTransaction` 一致：会话存在吗 → 回收过期/已死的锁 → 还有锁吗 → 拿锁。
   */
  admit(id, turnId) {
    this.get(id);
    const now = this.now();
    this.recoverStale(id, now);
    const holder = this.holder(id);
    if (holder) throw new AdmissionError("active-turn", { holder });

    const ownerId = `turn-lease:${this.pid}:${this.instanceId}.${turnId}`;
    this.locks.append({
      type: "acquire",
      sessionId: id,
      ownerId,
      turnId,
      acquiredAt: now,
      expiresAt: now + this.leaseMs,
    });
    this.active.set(id, turnId);

    // 续租：正常运行的 Turn 一直在续，所以永远不会过期；崩掉的不再续，到期就被回收。
    // MiniMax 里由 Turn 控制器做；它续不上（`lease-lost`）时会自己中止这个 Turn。
    // host 的 Sessions 够不到 Turn 的控制器，只能在这个 Turn 下一次写历史时把它挡下（见 append）。
    // unref 让定时器不拖住进程退出。
    const heartbeat = setInterval(() => this.renew(id, turnId), this.renewalMs);
    heartbeat.unref();

    let released = false;
    return () => {
      if (released) return true;
      released = true;
      clearInterval(heartbeat);
      this.active.delete(id);
      // 租约已经被别人回收了（比如它过期了）：不能替新的持有者释放锁。这不是异常，
      // 只是告诉调用方“你早就不是持有者了”——这个 Turn 的历史写入已经被挡下，会以失败结束。
      if (this.holder(id)?.ownerId !== ownerId) return false;
      this.locks.append({ type: "release", sessionId: id, ownerId });
      return true;
    };
  }

  /** 续租。只有仍然持有、且尚未过期的 Turn 才续得上（turn.repository.ts 的 `renew`：`changes === 1`）。 */
  renew(id, turnId) {
    const holder = this.holder(id);
    const now = this.now();
    if (holder?.turnId !== turnId || holder.expiresAt <= now) return false;
    this.locks.append({
      type: "renew",
      sessionId: id,
      ownerId: holder.ownerId,
      expiresAt: now + this.leaseMs,
    });
    return true;
  }

  /**
   * 回收没人管的锁，两种原因：
   *   expired-lease  租约到期了（`recoverExpiredInTransaction`）
   *   owner-dead     持有者的进程已经不在了（`recoverProcessRestartInTransaction`）
   * 被回收的 Turn 在 MiniMax 里会被标成 failed；这里记进 recover 事件，`recoveries()` 可以查到。
   */
  recoverStale(id, now = this.now()) {
    const holder = this.holder(id);
    if (!holder) return undefined;
    let reason;
    if (holder.expiresAt <= now) reason = "expired-lease";
    else if (this.isOwnerAlive(holder.ownerId) === false) reason = "owner-dead";
    if (!reason) return undefined;
    this.locks.append({
      type: "recover",
      sessionId: id,
      ownerId: holder.ownerId,
      turnId: holder.turnId,
      reason,
      at: now,
    });
    if (this.active.get(id) === holder.turnId) this.active.delete(id);
    return reason;
  }

  /** true 活着，false 已死，undefined 不知道（认不出 ownerId），不知道时只能等租约过期。 */
  isOwnerAlive(ownerId) {
    const match = OWNER_ID.exec(ownerId);
    if (!match) return undefined;
    if (match[2] === this.instanceId) return true;
    return this.isProcessAlive(Number(match[1]));
  }

  /** 被回收过的 Turn（它们在 MiniMax 里会被记成 failed）。 */
  recoveries() {
    return this.locks
      .read()
      .filter((event) => event.type === "recover")
      .map(({ sessionId, turnId, reason }) => ({ sessionId, turnId, reason }));
  }
}
