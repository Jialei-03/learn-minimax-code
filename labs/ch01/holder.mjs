// 子进程：拿到一个会话的租约，然后一直等着——直到被杀。crash.mjs 用它扮演“持有租约的另一个 mcode 进程”。
//   node labs/ch01/holder.mjs <数据目录> <会话 id> <turnId>
import { Sessions } from "../../host/src/sessions.mjs";

const [data, sessionId, turnId] = process.argv.slice(2);
new Sessions(data).admit(sessionId, turnId);
console.log(`ADMITTED ${process.pid}`);
setInterval(() => {}, 1000); // 租约的续租定时器是 unref 的，这里让进程保持存活
