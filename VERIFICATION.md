# 验证记录

日期：2026-11-03（Asia/Singapore）。环境：macOS，Node.js v22.22.3。

## 课程与构建

| 检查 | 结果 |
| --- | --- |
| `npm install --ignore-scripts --no-audit --no-fund` | PASS，锁定 markdown-it 14.1.0、shiki 3.13.0 |
| `npm run setup:source` | PASS，现有源码 HEAD 与版本锁一致，无切换和覆盖 |
| `npm run check` | PASS，源码锚点、实验、本地页面与锚点链接有效 |
| `npm run build` | PASS，18 页、13 章、19 个源码入口、13 道面试题 |
| 六组课程离线实验 | PASS，构建时实际运行并嵌入结果 |
| `git diff --cached --check` | PASS |
| HTTP 预览 | 首页、SDK 章节、贡献页、搜索索引和交互脚本返回 200 |
| 浏览器检查 | 首页与章节可读；全文搜索命中 ItemAccumulator；深浅主题切换、面试答案展开有效 |

源码基准：`6e062ae8ca365db34b93a7cdc96ffda3a8b9fffc`，根 workspace 0.7.2。
具体实验输出在构建产物 `site/dist/evidence.json`，可用 `npm run build` 重建。

## 证据范围

课程执行的是审核过的自包含上游模块，SDK 使用合成事件，usage 使用 fake 存储端口。没有把这些结果描述为完整 CLI、数据库、真实模型、认证或多平台验收。

独立贡献任务的上游验证属于另一份交付，以旁边 `minimax-code-contribution/verification/` 的实际报告为准；本课程构建成功不代表上游完整验证成功。

本轮更新：三个课程均使用产品原始图标；新增工程地图、Canvas 和 Mermaid。网页地图的主题筛选与源码链接已在浏览器检查，来源记录在 `site/static/brand-source.json`。
