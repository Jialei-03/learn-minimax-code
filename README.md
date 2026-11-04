# Learn MiniMax Code

**Pi 外面的那九十九：读懂一个把 Agent 内核做成产品的开源项目，然后为它做一次贡献。**

[MiniMax Code](https://github.com/MiniMax-AI/minimax-code)（MIT）的 Agent 循环就是 Pi——它把 pi-mono 放在 `third_party/` 里，每个 Turn 创建一个 Pi 的 `Agent`。可 Pi 的循环只占全部代码的百分之一。另外的部分回答的都是产品问题：三个入口怎样共用一份状态、一个 Turn 怎样装配和收尾、模型怎样重试、工具结果分给谁、提示什么时候冻结、历史怎样压缩、权限和沙箱怎样分工、插件更新时旧版本什么时候能拆、忙的时候来的消息怎么办、客户端怎样从事件流里拿到可靠的结果。

这门课每章挑一个这样的问题，沿 MiniMax 的源码一站一站读（能运行的纯模块直接拿来跑），和 Pi、Claude Code 对照，再在贯穿项目 **host**——一个小型的产品宿主——里实现一遍。最后一章之前，有一章专门讲怎样从 MiniMax 给 Pi 打的四十多个补丁出发，找到值得报告的问题。

这是 [Learn Pi Agent](https://github.com/Jialei-03/learn-pi-agent)、[Learn Claude Code](https://github.com/Jialei-03/learn-claude-code) 之后的第三门课。

## 章节

| | 章 | 读什么 |
| --- | --- | --- |
| 00 | 导读：Pi 外面的那九十九 | 代码体检、分层、`newAgent` 接缝、Pi 补丁台账 |
| 01 | 入口与分层：三个入口，一份状态 | `mcode` / `exec` / `acp` 的汇合、Application 与 Service、带租约的会话锁 |
| 02 | 一个 Turn 的一生 | `PiTurnRunner` 的八步、串行交付、历史先写、终态最后提交 |
| 03 | 模型：键、预算与重试 | 模型键、凭证路线、动态输出上限、重试边界、用量 |
| 04 | 工具：一份定义，三个读者 | `newRuntimeTool`、六道关、调度规则、PTC（`run_code`） |
| 05 | 上下文：每个 Turn 开头拍一次照 | 系统提示配方、项目指令预算、记忆、reminder、提示冻结 |
| 06 | 历史：三份记录与一次压缩 | 存档、发送投影、checkpoint 压缩、先存档再替换 |
| 07 | 权限与沙箱 | 权限门、规则台阶与模式、审批交接、沙箱准入、路径三层 |
| 08 | 插件、Skill 与 MCP：新旧两代同堂 | 注册表与租约、发布门、MCP 运行时、Skill 读取方式 |
| 09 | 队列、插话与取消 | 持久队列、claim 与确认、插话、取消收尾、分叉 |
| 10 | 对外协议：exec、SDK 与 ACP | 事件投影链、`ItemAccumulator`、结局判定、重放、ACP |
| 11 | 贡献：先核对，再复现，最后写 Issue | 贡献规则、补丁台账核对 Pi 上游、红绿测试、Issue 草稿 |
| 12 | 总装与对照 | 服务装配、host 完整场景、MiniMax / Pi / Claude Code 对照 |

## 快速开始

需要 Node.js 22.19+。所有实验离线运行，不需要 API Key。

```bash
git clone https://github.com/Jialei-03/learn-minimax-code.git
cd learn-minimax-code && npm ci
npm run setup:source     # 把 MiniMax Code checkout 到 ../minimax-code-source（固定提交 6e062ae）
npm run lesson -- 2      # 运行第 2 章的实验
npm run build && npm run serve   # 本地阅读站 http://127.0.0.1:4323/
```

`npm run verify:course` 顺序运行全部章节的 host 实验；`node site/build.mjs --only 02-turn` 只检查一章。和 Pi v1.5.0、mox 对照的摘录需要旁边有 `../pi-v1.5.0` 和 `../learn-pi-agent`。

## 仓库里有什么

| 路径 | 内容 |
| --- | --- |
| `course/` | 各章正文、目录 `syllabus.json`、host 的阶段表 `progression.json` |
| `host/src/` | 贯穿全课的产品宿主：会话、Turn、模型、工具、上下文、历史、权限、插件、队列、对外协议 |
| `runtime/` | host 共用的底层：追加日志、工作区路径、子进程、JSON-RPC、沙箱 |
| `lab/source.mjs` | 从固定提交读取源码；`importSource()` 装载完整的上游纯模块直接运行 |
| `labs/chapters/`、`labs/chNN/` | 每章的实验 |
| `contribution/` | 独立贡献任务的说明 |
| `site/` | 阅读站生成器 |

## 贡献须知

MiniMax Code 目前只接收协作者的 PR，外部贡献者先开 Issue 讨论（见上游 `CONTRIBUTING.md`）。课程源码目录保持只读；尝试修改和补丁放在独立的 `../minimax-code-contrib`。任何对外动作（开 Issue、评论）之前，先准备好可审查的英文草稿。

## 版本

| | |
| --- | --- |
| MiniMax Code | 0.7.2 · `6e062ae`（MIT） |
| 内置的 Pi | pi-mono v0.79.1（`third_party/pi-mono`） |
| 对照 | Pi v1.5.0 · `f9a2636`；Claude Code 2.1.88（见 Learn Claude Code） |
