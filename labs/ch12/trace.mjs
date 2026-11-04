// 把主线实验输出成 @trace 回放需要的 JSON（title / subtitle / steps）。
//   node labs/ch12/trace.mjs
import { mainStory } from "./scenarios.mjs";

const story = await mainStory();
process.stdout.write(
  JSON.stringify({
    title: "总装：取消 A、更新插件、B 修好测试",
    subtitle: "host 真实应用 · 真实子进程与日志 · 脚本化模型 · 逐步回放",
    steps: story.steps,
  }) + "\n",
);
