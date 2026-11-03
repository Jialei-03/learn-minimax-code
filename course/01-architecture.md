## 从一个请求开始

假设你让 Agent 修复测试。终端界面需要渲染输出，脚本需要退出码，编辑器客户端需要协议事件。这三种界面不应该各写一套模型循环，否则一次权限或取消修复会漏掉另一个入口。

公开架构把它们连接到同一条主干：

```text
TUI / exec / ACP
       ↓
    CliService
       ↓
 local Applications
       ↓
Session / Turn / Agent services
       ↓
Pi / model providers / tools
```

这里的箭头表示职责流向；不表示每个操作都逐层发网络请求。`CliService` 是进程内门面，公开 CLI 不靠一个 Desktop HTTP 前门完成这条路径。

## 命令层只负责把意图交出去

`packages/tui/src/cli/program.ts` 用 Commander 注册命令，把执行函数作为 options 注入。阅读 `createTuiProgram` 时，先找到 `launchTui`、`runExec`、`runAcp`，再去读相应 handler；不要从终端渲染器猜模型在哪调用。

@source cli

同文件中 `init` 会把工作目录转成绝对路径，`exec` 注册一次性运行，`acp` 注册 stdio 服务。命令存在和命令可用是两层证据：源码能证明注册；真实帮助输出与运行检查还需要构建产物。

## 门面后面才是状态所有者

@source bridge

`createSession` 把明确工作目录和缺省创建分到对应 lifecycle 方法。门面做了转发，但 Session 的保存、Turn 的运行和模型解析分别由下游服务负责。排查问题时，先确认它是适配器的翻译错误，还是共享状态本身出错。

例如 ACP 返回 busy，可能是 adapter 自己保留了 active prompt，也可能是运行时还有未结算的 Turn。只改提示文字无法证明后者恢复正常。第 9 章会把取消与后续输入连起来看。

## 发行契约告诉你哪些代码真的属于公开项目

@lab architecture

实验从 `release/extraction.json` 读取 32 个 package roots，包括 vendored Pi 与 sandbox-runtime。这个数字描述发布范围，不是“32 个业务模块”。`release/public-source.json` 则是文件清单；它与 package scope 不是同一个层次。

源码中 `@mavis/*` 是 workspace 包名，公开构建从本地源码解析。看到这样的名字，不应直接认定它还要访问一个私有 npm registry。应继续查 exports、路径映射和 build 的解析规则。

## 和前两门课连接

在 Pi 课程里，你能从 mox 的 CLI 直接走到自己的循环；在 Claude Code 课程里，你能通过 stream-json 观察产品输出。在这里，两条线接起来了：产品入口的状态和事件由运行时组织，底层循环仍可以复用一个独立内核。

::: interview 同一套核心运行时为什么还需要三个适配器？
它们的输入、输出、生命周期不同。TUI 面向持续交互，exec 面向一次运行和进程退出，ACP 面向客户端协议。共享运行时保留 Session、Turn、权限和工具的一致语义，适配器负责把这些语义映射到各自界面。验证共享修复时仍要检查所有相关入口。
:::
