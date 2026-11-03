## 用一个真实问题建立工程证据

第一次贡献适合选择输入输出清楚、能独立复现、影响范围可控的问题。一次能解释因果的修复，比一次覆盖大量文件却说不清为什么改的功能，更能支持实习面试。

本项目单独创建了“MiniMax Code 首次贡献：复现、修复与 PR 提案”任务。它使用独立的 `minimax-code-contrib` 克隆，课程的 `minimax-code-source` 保持固定。复现、diff、英文草稿和验证材料输出到旁边的 `minimax-code-contribution`。

## 先检查当前政策

@source contributing

2026-11-03 核实时，仓库只接受 collaborators 的代码和文档 PR；外部贡献者先通过 Issue 讨论，API 同时报告 `pull_request_creation_policy=collaborators_only`。这意味着可以立即调查和准备修复，但提交资格需要维护者确认。原始政策变化后，再依据新状态推进。

上游要求文档和 commit message 主要使用英文，适用的共享 README 内容需要中英同步。当前仓库是内部源码的 reviewed public projection，新增文件还涉及 source inventory，不能只让测试通过就结束。

## 选题先排除三件事

1. **已经修复。** Issue 仍 open 不代表当前 main 仍有问题；要在确定的提交上重现。
2. **别人已有完整补丁。** 阅读评论、关联 PR 和 fork。可以帮助复测，但不能把他人工作包装为自己的修复。
3. **公开代码不覆盖。** Desktop 独有问题可能不在此仓库，不能强行在 CLI 里寻找补丁位置。

起始候选包括 #543 的终端链接检测、#507 的 usage 模型字段、#544 的 nullable schema。这些是调查线索，最终选题由独立任务根据实际源码和讨论确定。

## 一条可审查的修复链

```text
用户症状 → 最小复现 → 根因调用链 → 失败回归
        → 最小修复 → 原回归通过 → 相关入口验证
        → 英文提案 → 获准贡献 → PR / review → merge
```

每一步都要留下能复核的证据。测试失败要因为目标 bug，而不是依赖没装好；修复后要验证边界条件；测试文件应进入 `test/vitest-suites.json` 的正确 gate。只修改已有文件不一定需要重写 inventory；新增/删除文件要先审查，再生成清单。

## 完整验证不能用一个局部检查冒充

迭代时运行 focused test、`git diff --check` 和受影响 gate。上游 `pnpm verify` 的 source export 读取 committed HEAD，要求 tracked working tree 干净；因此完整交付验证应在审查后的本地提交上进行。

是否需要 `perf:full` 依据上游规则判断。历史、存储、流式和工具循环等修改涉及更完整性能验证。未运行的平台、实时服务、交互终端检查，要明确写 NOT RUN。

@lab usage

这里的 usage 实验提供一种可复现边界测试的例子：无效输入在进入存储前被拒绝。它不是对 #507 的修复，也没有证明那个 Issue 仍然存在。

::: interview 面试时怎样描述一个尚未合并的开源贡献？
按真实阶段说：已复现、已准备补丁与回归测试、已提出方案、已开 PR 或已合并。展示自己负责的根因与验证，说明维护者反馈和未验证范围。只有上游接受的公开记录，才支持“贡献已合并”的表述；准备补丁不能提前等同于 contributor 身份。
:::
