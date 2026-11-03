## 模型看到的不是整个工作区

文件存在于磁盘，不意味着它已经进入模型请求。对话历史、用户指令、项目说明、Skill、工具定义与记忆需要被读取、裁剪、组合，再投影到本轮上下文中。把这些步骤分开，就能解释“文件里明明有，模型却不知道”一类问题。

先看 `turn-system/agent-host/preparation/`：它包含配置、prompt surface、memory composer 等设施。再回到第 2 章的 `convertToLlm`，区分准备时组装的上下文和真正发给模型的消息。

## 记忆可以分成索引、尾部和按需读取

@source memory

`buildMemoryTailBlock` 把最近记忆包在带路径的块中。相邻函数负责 summary、超预算提示与 topic 列表；它们说明持久记忆和本轮注入内容并非逐字等同。

这是一种容量管理取舍：全部注入简单，却消耗更多上下文；只注入索引或尾部，成本小，但模型必须能定位并读取旧信息。继续追 `memory-prompt-composer.ts`，才能判断本版本如何分配具体注入预算，不能从 block formatter 推断完整策略。

还应区分 recall 和 write。允许读取历史经验，并不必然允许本次任务写入长期记忆。Session memory policy 里分别保存这些状态。隐藏子任务、legacy 来源等上下文也可能有不同写入指导。

## 同一次模型调用需要一致的 prompt 读取

想象 admission 前读到了一个模板，开始 Turn 时模板又更新了。如果前后随意重读，用户、日志与实际请求很难对应。`PromptReadScope` 把 host source 和一次 snapshot 绑在一起；Registry 负责把它交给对应的内部 Turn。

@source registry

@lab registry

观察实验中四个性质：reservation 计入容量；remember 必须对应已预留的 Turn；rebind 把同一读取交给新 ID；take 消费之后就不能重复取出。`close` 清空并禁止后续预留。

这是一段进程内交接代码。它没有 WAL、数据库事务或进程重启后的读取逻辑，所以不能把它称为 durable checkpoint。先明确一个对象承诺的生命周期，才能知道应该在哪里修恢复问题。

## 和已有实验接起来

Learn Claude Code 的金丝雀实验回答“哪段文字进入了哪次请求”。这里可以沿 composer 和 snapshot 路径解释原因。一个完整调查可以同时保存：配置、文件内容的非敏感标记、请求中的出现位置、读取时机与源码版本。

::: interview 为什么“持久记忆写成功”不能证明“下一轮会记得”？
持久存储、召回选择、注入预算和模型实际使用是不同步骤。要核对读写 owner、Session policy、裁剪策略与最终请求。用合成金丝雀验证是否进入请求，再解释它在上下文中的位置；不能只看磁盘文件或模型的一次回答。
:::
