# Learn MiniMax Code

**读懂 MiniMax Code，然后贡献一处改进。**

这是 [Learn Pi Agent](https://github.com/Jialei-03/learn-pi-agent) 和 [Learn Claude Code](https://github.com/Jialei-03/learn-claude-code) 之后的第三个 Agent 学习项目。沿用中文课程、固定源码、可运行实验、阅读站和面试题的结构，增加面向真实开源贡献的独立任务。

研究对象是官方开源 [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)，固定 **0.7.2 · `6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc`**，核实于 2026-11-03。公开范围主要是终端 TUI、headless CLI、ACP 与运行时及发行设施；不能把它当成完整 Desktop 或云服务源码。

## 贯穿全课的实现

课程已按 **13 个递进阶段**重写，主线是 `host/src/`。每章围绕一个具体失败，给出固定源码的分支与状态分析、真实行号注解、本章接入代码、独立实验、结果解释和动手验收。

- [实现主线与阶段契约](course/progression.json)
- [第 0 章](course/00-method.md)
- [核心代码](host/src)
- [逐章实验](labs/chapters)
- [源码工程地图](docs/engineering-map.md)与 [Obsidian Canvas](engineering/architecture.canvas)

## 安装、逐章运行与阅读

Node.js 22.19+。默认实验不需要 API Key，不读取个人 CLI 配置，不调用收费模型。

```bash
npm ci
npm run setup:source
npm run lesson -- 0       # 单独运行第 0 章
npm run lesson -- 3       # 单独运行第 3 章
npm run verify:course    # 顺序运行全部阶段
npm run build            # 再运行全部阶段、检查源码注解并生成网页
npm run serve
```

网页顶部“实现主线”提供所有章节、模块、依赖与实际断言数量。每章的实现块来自本仓库真实文件；实验表由构建时运行生成，不手写 PASS。完整结果与实现 SHA256 在 `site/dist/course-evidence.json`。

## 最后一章怎样验收

host 先启动真实长工具进程 A，发布 R2 并让 B 入队；取消 A 后等待事件与历史收尾、释放 R1 和 busy，再让 B 使用 R2 工具、Skill 与新提示修复项目并运行真实测试。SDK accumulator 消费同一条实际事件流。

Prompt Registry、MCP generation 与 ItemAccumulator 直接装载固定上游模块；其余宿主为原创教学实现。工作队列以真实日志演示 claim/accept/consume，accepted 后的不确定效果不被宣称成 exactly-once。39 处源码阅读注解校验到实际行号。

## 独立贡献任务

[首次贡献说明](contribution/README.md)仍在独立 checkout 进行。课程第 11 章生成本地 red-green 材料与真实可校验 diff，明确不是上游已确认 bug 或已提交 PR。外部动作前重新核对当前贡献政策与已有讨论。

## 边界与验证

[验证记录](VERIFICATION.md)说明实际运行范围。源码阅读、真实上游纯模块、原创 `host`、合成模型回复和 OS 探针分别标注。未验证的真实 Provider、完整产品模式或其他平台不会写成 PASS。

源码目录保持只读；图标沿用产品原始图标，来源在 `site/static/brand-source.json`。Mermaid 本地分发，保留其许可。
