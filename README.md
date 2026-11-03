# Learn MiniMax Code

**读懂 MiniMax Code，然后贡献一处改进。**

这是 [Learn Pi Agent](https://github.com/Jialei-03/learn-pi-agent) 和 [Learn Claude Code](https://github.com/Jialei-03/learn-claude-code) 之后的第三个 Agent 学习项目。沿用中文课程、固定源码、可运行实验、阅读站和面试题的结构，增加面向真实开源贡献的独立任务。

研究对象是官方开源 [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)，固定 **0.7.2 · `6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc`**，核实于 2026-11-03。公开范围主要是终端 TUI、headless CLI、ACP 与运行时及发行设施；不能把它当成完整 Desktop 或云服务源码。

## 开始阅读与运行

需要 Node.js 22.19+。课程不需要 API Key，不读取本机模型凭据，也不启动收费模型。

```bash
npm install
npm run setup:source       # 准备旁边的 minimax-code-source，已有目录不会被覆盖或切分支
npm run lab                # 十组离线实验（含课程自写宿主）
npm run check              # 校验版本、摘录、实验与生成页面的本地链接
npm run build              # 生成 site/dist，实验结果实时嵌入正文
npm run serve              # http://127.0.0.1:4323/
```

也可用 `MINIMAX_SRC=/absolute/path` 指定已有源码克隆；其 HEAD 必须与版本锁一致。构建读取 committed Git 对象，不会把另一个贡献分支的改动混入课程。

从 [第 0 章：方法](course/00-method.md) 开始。每章先理解场景，再追源码，最后按需做实验；不预设学习进度或强制作业。

## 课程

| 章 | 主题 |
| --- | --- |
| 0 | 方法：固定版本、证据边界与贡献目标 |
| 1 | TUI / exec / ACP 与共享运行时 |
| 2 | Turn、Pi 装配、事件队列与收尾 |
| 3 | 模型身份、协议适配与上下文预算 |
| 4 | 工具执行、副作用与文件边界 |
| 5 | 上下文、记忆与 prompt 快照 |
| 6 | 会话、canonical history 与压缩协议 |
| 7 | 权限、路径策略与沙箱职责 |
| 8 | Plugin、Skill、Hook 与 MCP generation |
| 9 | 队列、子任务、steering 与取消 |
| 10 | SDK 事件归并、增量、快照与 incomplete |
| 11 | 首次贡献：选题、复现、补丁与 PR |
| 12 | 三项目对照与实习面试证据 |

## 实验到底验证了什么

```bash
npm run lab -- architecture  # 真实发布契约与 package scope 的静态分析
npm run lab -- registry      # 上游 prompt Registry 的容量、交接与清理
npm run lab -- usage         # 上游 usage Service；fake 存储端口
npm run lab -- paths         # 上游 ACP 的 POSIX / Windows 路径分类
npm run lab -- checkpoint    # 上游 checkpoint 标题协议解析
npm run lab -- sdk           # 上游 ItemAccumulator；合成事件输入
npm run lab -- turn          # 提取上游驱动函数；fake Agent 与错误分类端口
npm run lab -- generation    # 上游 generation 与纯依赖；fake runtime.close
npm run lab -- queue         # 上游 QueueService 与纯依赖；fake store 与时钟
npm run lab -- capstone      # 课程宿主组合三个真实上游组件
```

课程通过 Node 的 TypeScript transform 执行审核过的完整上游模块及其显式允许的纯依赖；turn 实验提取上游函数并用 fake Agent 控制生命周期。capstone 的宿主逻辑由课程编写，组合真实 Registry 与 ItemAccumulator。所有输出分别标明源码执行、测试端口和教学实现。实验范围有限：未构建完整上游 CLI，未验证 SQLite、真实模型、认证、MCP 服务或多平台端到端行为。各章会区分源码阅读与实际执行证据。

## 独立的贡献任务

已经创建 **MiniMax Code 首次贡献：复现、修复与 PR 提案**，详细交付契约在 [contribution/README.md](contribution/README.md)。它在旁边的 `minimax-code-contrib` 中独立工作，成果汇总到 `minimax-code-contribution`。

**当前官方只接收 repository collaborators 的 PR，外部贡献先通过 Issue 讨论。** 见 [固定基准的 CONTRIBUTING](https://github.com/MiniMax-AI/minimax-code/blob/6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc/CONTRIBUTING.md)。任务先准备可复现问题、最小修复、回归测试和英文草稿，再依据维护者的许可推进。补丁准备、发出提案、打开 PR 与合并是不同阶段；本项目不提前宣称 contributor 身份。

## 目录

| 目录 | 用途 |
| --- | --- |
| `course/` | 13 章正文、目录与 23 个源码阅读入口 |
| `lab/` | 源码版本验证、Git 读取与审核过的纯模块加载 |
| `labs/` | 十组离线实验、教学宿主与断言 |
| `site/` | 静态阅读站、深浅主题、搜索、源码索引、面试题库与贡献页 |
| `contribution/` | 独立贡献任务说明与上游许可 |
| `source.lock.json` | 上游版本、提交与范围 |

`site/dist/evidence.json` 是构建时生成的实验与版本证据。更新源码时，先在单独克隆中 review，再同步 lock、源码入口、正文和实验；不要把 `main` 的最新行号直接贴进固定版本课程。

## License

MIT。阅读站样式与交互代码复用本系列 Learn Pi Agent，保留其版权；MiniMax Code 摘录保留上游 MIT 许可，见 [UPSTREAM-LICENSE](contribution/UPSTREAM-LICENSE)。第三方组件分别遵循上游声明；本项目不重新授权它们。

## 工程地图与解读方法

提供[源码工程地图](docs/engineering-map.md)、[可编辑 Canvas](engineering/architecture.canvas)和[工具与方法说明](docs/engineering-workflow.md)。本地阅读站顶栏的“工程地图”支持按主题筛选、缩放和打开固定源码；`npm run map:generate` 可重建。左上角使用软件官方原始图标，来源与哈希见 `site/static/brand-source.json`。

## 每章的学习产出

每章包含具体场景、状态与调用链、失败反例、机制图、练习和验收目标。第 10 章提供 ItemAccumulator 的逐事件回放；第 12 章提供教学宿主的十一阶段回放，覆盖热更新、取消、busy 收尾、迟到事件与下一轮结果。回放数据由构建时实际执行实验生成，输入为合成数据。

图形使用本地随站分发的 Mermaid，不需要 CDN。长源码块可按需展开；章节目标和右侧目录与系列阅读体验保持一致。
