// host 的命令行：`node host/src/cli.mjs [工作目录] [数据目录]`。
//
// 它是第四个入口：和 `mcode exec` 一样是无界面的，只是协议换成了 JSON 行——
//   stdin   每行一个命令：{"type":"user","text":"…","replies":[…],"rules":{…}} 或 {"type":"cancel"}
//   stdout  每行一帧事件（第 2 章的 item.* / turn.* 帧），最后一帧是 turn.completed
//   退出码  最后结束的那次运行的结局，数值和 `mcode exec` 一致（0 成功、4 运行失败、130 取消……）
// 命令行用法、输入输出的格式和之前一样；这一版只补上了入口该有的几样东西（见下面带“入口职责”的注释）。
//
// 入口只做装配，不保存状态：建应用、建会话、把每条命令交给 exec 适配器（第 1 章）。
// 会话、队列、事件、租约都在 app 里；这个进程一退出，数据目录里的日志还在，下一次可以接着用。
//
// 对应 MiniMax：packages/tui/src/cli/run-exec-command.ts 的“解析参数 → 建运行时 → 跑一次 → 按结局退出”。
// 模型是脚本化的：命令里的 `replies` 就是模型依次要给的回复，没给就回一句 ready。
import { resolve } from "node:path";
import { createApplication } from "./app.mjs";
import { adapters, EXIT_CODES } from "./adapters.mjs";
import { scriptedKernel } from "./models.mjs";

const root = resolve(process.argv[2] ?? "."),
  data = resolve(process.argv[3] ?? ".host-data");

// 入口职责一：stdout 只写协议帧。每帧一行 JSON。
// JSON 允许 U+2028 / U+2029 直接出现在字符串里，但按 JavaScript 行终止符切行的接收方会把一帧切成两半，
// 所以这里把它们写成转义形式（内容不变，只是更不容易被误切）。
const write = (frame) =>
  process.stdout.write(
    JSON.stringify(frame).replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`) + "\n",
  );

// 入口职责二：接收方先走了（管道断了），不要再写，也不要把 EPIPE 当成崩溃——按约定的码退出。
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(EXIT_CODES.brokenPipe);
  throw error;
});

/**
 * 按换行切命令：协议的成帧规则只有一条——一行一条 JSON，行尾是 \n（带不带 \r 都行）。
 * 自己切而不是交给 readline：协议的全部规则写在这十几行里，不用去查库的行为。
 */
async function* commandLines(stream) {
  stream.setEncoding("utf8");
  let rest = "";
  for await (const chunk of stream) {
    rest += chunk;
    for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
      yield rest.slice(0, end).replace(/\r$/, "");
      rest = rest.slice(end + 1);
    }
  }
  if (rest.trim()) yield rest; // 最后一行没有换行，也是一条命令
}

// 装配：应用（事件写到 stdout）→ 入口适配器 → 一个会话。
const app = await createApplication(data, { writer: write });
const entries = adapters(app);
const session = app.sessions.create(root);

// 入口职责三：Ctrl-C。有运行就取消它（等它收尾再退出）；没有运行就直接以 130 退出。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!app.cancel(session.id)) process.exit(EXIT_CODES.cancelled);
  });
}

// 入口职责四：退出码。每次运行结束就更新它，最后结束的那次说了算（和 Claude Code 看最后一条 result 一样）。
let exitCode = EXIT_CODES.success;
const jobs = [];

for await (const line of commandLines(process.stdin)) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    write({ type: "protocol_error" }); // 不是 JSON：这一行丢掉，其余命令照常处理
    exitCode = EXIT_CODES.invocation;
    continue;
  }
  if (command.type === "cancel") {
    app.cancel(session.id);
    continue;
  }
  if (command.type !== "user") {
    write({ type: "protocol_error" });
    exitCode = EXIT_CODES.invocation;
    continue;
  }
  // 命令不阻塞读取下一行：这样运行期间还能收到 cancel，也能看到第二条命令因为会话在忙而被拒绝。
  const job = entries
    .exec(
      { sessionId: session.id, prompt: command.text },
      {
        model: scriptedKernel(command.replies ?? [{ text: "ready" }]),
        rules: command.rules ?? {},
      },
    )
    .then((result) => {
      exitCode = result.exitCode;
      // 没能开始的运行（会话在忙、会话不存在）在这里变成一帧 error。
      if (result.status === "rejected") write({ type: "error", error: result.outcome.error.message });
    })
    .catch((error) => {
      exitCode = EXIT_CODES.internal;
      write({ type: "error", error: error.message });
    });
  jobs.push(job);
}

await Promise.all(jobs);
await app.close();
process.exitCode = exitCode;
