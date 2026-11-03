# 完整重做验证记录

日期：2026-11-04（Asia/Singapore）。macOS，Node.js v22.22.3。

## 内容与实现

全部 13 章重新组织为具体问题、固定源码分支、实际行号注解、原创实现、执行顺序说明、独立实验、结果解释与动手验收。贯穿项目在 `host/src/`；`course/progression.json` 绑定阶段依赖、真实导出符号与实验。网页直接读取实现文件，证据清单记录文件 SHA256。

固定 0.7.2 / `6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc`，27 个源码定位与 39 处阅读注解均从 Git 对象核对。保留原始图标、工程地图、Canvas、原有 10 组源码实验与独立贡献任务。

## 本机执行结果

| 检查 | 结果 |
| --- | --- |
| 逐章独立实验（构建时重跑） | PASS，13 份、96 项断言 |
| 原有 `labs/run.mjs` | PASS，10 组固定源码实验，构建同样运行 |
| `npm run check`、`npm run build` | PASS，19 页、39 道面试题 |
| 新实现、运行器、逐章实验语法 | `node --check` PASS，实际执行通过 |
| 本地页面、资源与 fragment | 全量检查无缺失 |
| 浏览器逐章检查 | 13/13 章都有实现、独立实验、执行路径说明和行号注解；14 张机制图全部渲染 |
| 总装交互 | 代码展开、实验数据、逐步回放与事件 JSON 正常，console warn/error 为空 |
| `git diff --check` | PASS |

`site/dist/course-evidence.json` 保存实际断言、观察数据和实现摘要。页面 PASS 来自子进程退出结果及报告检查，断言失败会中止构建。

## 实验范围

Prompt Registry、MCP generation 与 ItemAccumulator 直接装载固定上游完整模块及审核过的相对依赖。原有 usage、路径、checkpoint、queue 等源码实验保留独立端口说明。原创 host 实现 Session/Turn、日志、事件交付、工具和队列装配，其通过不能描述成生产宿主全量集成通过。

新实验使用确定性模型回复，但真实运行文件修改、Node 测试、长工具进程、stdio MCP、管道 CLI 与追加日志。第 12 章先启动 A 的长进程，发布 R2，取消并等待 A 收尾、释放 R1 与 busy；B 随后从队列接纳，使用新提示与 R2 完成 Skill、文件修复、真实测试与 MCP 调用。SDK 消费同一条实际事件流，报告保留文件、工具结果、队列与客户端状态。

accepted 队列项重启后保留待协调，不盲目重试，不承诺 exactly-once。三个入口是共用应用的参数适配子集，不是完整 TUI/ACP 产品。没有运行真实 Provider、认证、SQLite 或全部平台；需要沙箱时拒绝无后端降级，平台可用性不能由路径检查代替。

第 11 章使用课程故意错误的基线生成真实可校验 diff，结果是 local-evidence-only，不是新发现的上游缺陷或已提交 PR。独立贡献任务的状态以其真实记录为准。

GitHub Actions 从干净 checkout 准备固定源码并运行完整构建。提交后的结果以对应 Actions run 为准。
