# 首次贡献任务

目标：为 MiniMax-AI/minimax-code 准备一项真实、可复现、能解释根因的改进，并沿维护者允许的流程争取提交和合并 PR。已单独创建 Codex 任务 **MiniMax Code 首次贡献：复现、修复与 PR 提案**。

该任务在本地 Codex 工作区独立推进；课程构建不依赖其状态。

## 工作位置

- `minimax-code-source`：课程旁边的固定源码，供课程读取。
- `minimax-code-contrib`：独立贡献克隆，负责 feature branch、复现、测试和补丁。
- `minimax-code-contribution`：复现说明、diff、英文沟通草稿、检查证据与中文面试讲述。

这三个目录默认和 learn-minimax-code 位于同一级。独立任务不会修改 Learn Pi Agent 或 Learn Claude Code。

## 已核实的上游政策

核实日期：2026-11-03。官方 [CONTRIBUTING.md](https://github.com/MiniMax-AI/minimax-code/blob/6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc/CONTRIBUTING.md) 规定仅接受 repository collaborators 的代码和文档 PR，外部贡献先通过 Issue 讨论；仓库 API 也报告 `collaborators_only`。

因此本任务先完成所有可审查材料。Issue、评论和申请消息的英文草稿先交给你审核；目前没有授权自动发送这些消息。得到维护者允许后，再按真实权限推进 PR。政策可能变化，实际发送前应复核。

## 选题与交付要求

起始调查线索：[#543](https://github.com/MiniMax-AI/minimax-code/issues/543) 终端 OSC 8 检测、[#507](https://github.com/MiniMax-AI/minimax-code/issues/507) usage 模型字段、[#544](https://github.com/MiniMax-AI/minimax-code/issues/544) Gemini nullable schema。先排除已修复与已有完整补丁的问题；这些链接不是“当前仍有 bug”的证明。

最终交付应包含：

1. 确定的 upstream/base commit、环境和问题范围。
2. 调用真实实现的最小复现；修复前失败与修复后通过的回归。
3. 单一问题的最小补丁、正确署名与相关本地提交。
4. focused tests、适用 gates 和 `pnpm verify` 的实际状态。
5. 英文 Issue/提案草稿、英文 PR 草稿与维护者下一步沟通路径。
6. 中文三分钟面试讲述，区分自己做的工作、自动化辅助和未验证部分。

## 用真实阶段追踪结果

`investigating → reproduced → patch-ready → proposal-sent → invited/approved → pr-open → merged`

当前阶段请查看独立任务的最新输出与 `minimax-code-contribution` 的状态记录。此处不把进行中的工作写成已合并成果。成为 contributor 或获得实习机会都依赖后续真实结果。

## 练习解释

你应能独立回答：这个问题影响谁？最小复现为什么足够？错误假设在哪里？补丁为何没有改更多东西？测试为何能防止再次发生？尚未验证的终端、系统或服务是什么？
