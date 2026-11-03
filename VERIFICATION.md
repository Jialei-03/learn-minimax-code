# 验证记录

日期：2026-11-03（Asia/Singapore）。macOS，Node.js v22.22.3。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 固定源码版本 | 0.7.2 / `6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc`；读取 Git 对象 |
| `npm run lab` | PASS，10 组：architecture、sdk、registry、usage、paths、checkpoint、generation、queue、turn、capstone |
| `npm run check` | PASS，源码锚点、实验、页面和锚点 |
| `npm run build` | PASS，18 页、13 章、23 个源码入口、13 道面试题 |
| 全量本地资源检查 | 页面、资源、锚点无缺失 |
| 浏览器逐章检查 | 13 章共 14 张 Mermaid 图全部渲染，无残留指令 |
| SDK 回放 | 第六步识别重复 snapshot；最终 a completed、b incomplete；末步下一步禁用 |
| 总装回放 | A aborted 后 busy 释放，R1 关闭，B 接纳；支持状态 JSON 查看 |
| 长源码 | 可展开；长实验输出有独立滚动区域 |
| JavaScript | `node --check site/static/app.js` PASS；播放器检查无 console warn/error |
| `git diff --check` | PASS |

课程每章包含目标、具体推导、机制图、失败反例与练习。第 12 章总装实验组合三个真实上游组件，展示热更新、取消、收尾与迟到事件。

## 证据范围

SDK、Prompt Registry、usage、路径、checkpoint、MCP generation 和 QueueService 执行审核过的完整上游模块；纯相对依赖从同一个 Git 提交装载，不 mock 内部实现。使用的存储、会话读取、时钟和 runtime.close 是明确测试端口。

turn 实验提取原始驱动函数，用 fake Agent 与错误分类端口控制输入。capstone 中的 host admission、busy 和事件归属由课程自己实现，并组合真实 PromptRegistry、GenerationRegistry、ItemAccumulator；不是生产 Session/Turn 服务的集成测试。播放器数据来自构建时运行结果，输入为合成事件。

未构建完整上游 CLI，未验证 SQLite、真实 Provider、认证、真实 MCP 或所有平台。独立贡献任务以上游 contribution checkout 自己的验证报告为准。

Mermaid 11.17.2 随网站本地分发并保留许可；Markdown 解析器固定 14.3.3。产品原始图标与来源记录保持一致。
