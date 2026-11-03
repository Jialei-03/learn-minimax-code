## 四个概念放在正确位置

| 概念 | 主要职责 | 追踪时关注什么 |
| --- | --- | --- |
| Plugin | 分发与组织一组能力 | 来源、安装、启用、版本与生命周期 |
| Skill | 让 Agent 按需获得做事方法 | metadata、正文读取、权限及来源 |
| Hook | 在生命周期节点参与处理 | 触发时机、输入输出、失败语义 |
| MCP | 对外部能力进行协议交互 | 发现、调用、结果、连接与清理 |

它们可以组合：一个 Plugin 同时携带 Skill、Hook 与 MCP 配置。支持一种能力，不等于同一 Plugin 的所有能力都已经完成发现并进入当前 Turn。

## Skill 首先是一个需要校验的包内容

@source skills

`parseSkillFrontmatter` 要求起始 YAML 块与闭合分隔符，并要求解析结果是 mapping。后续 YAML 解析拒绝重复键，限制 alias 展开。配置格式的错误应在读包边界被解释，避免到模型执行时才变成一个模糊失败。

继续追 `skill/reader.ts` 和 package readers，核对名称、目录、相对路径与启用状态的处理。只有成功读取并发布，才谈得上可供 Agent 选择。

## MCP 连接不能随着配置更新被立刻销毁

假设 Turn A 读取了插件版本 R1 的工具快照；用户更新后，Turn B 开始使用 R2。若切换时立刻关闭 R1 的连接，A 已经看到的工具可能在调用时消失。

@source mcp-generation

`PluginCapabilityGenerationRegistry` 按 revision 保存运行时并计数 lease。replace 把旧代标为 retired；release 减少引用，满足条件后才清理。它解决的是能力快照与资源生命周期的协调。

这与第 5 章 prompt Registry 有相似的所有权问题，但不是同一个类，也没有被那个离线实验覆盖。要验证 MCP generation，需要调用它自己的实现和相关测试，覆盖 retain/release、替换与最终清理。

## “连接成功，但第一轮没有工具”怎样调查

把时间线拆成：Plugin enabled → MCP tools/list 完成 → 发现结果发布 → Turn 捕获 capability snapshot → 工具定义投影到模型请求。每一步记录 revision 与 owner，找到具体哪一条因果边没有完成。

公开 Issue #570 就报告过这种竞态，并由原作者提供补丁线索。本课程把它作为阅读案例；独立贡献任务需要检查现有提案，避免把已有修复当成自己的首次贡献。

::: interview 热更新插件时，为什么需要 capability generation？
正在运行的 Turn 需要继续使用它捕获时的工具契约和连接。用 revision 区分代，用 lease 保留仍被使用的旧运行时，等最后一个使用者结束再清理。验证不能只看新版本工具列表，还需要检查旧 Turn 是否能完成以及资源是否最终释放。
:::
