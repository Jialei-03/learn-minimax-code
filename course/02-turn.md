## Session 和 Turn 不是一个生命周期

Session 是可以继续的对话与相关状态；Turn 是一次被接纳的执行。一个 Session 可以承载多个 Turn。进程也可能同时处理多个 Session。因此，把“当前工具列表”“历史游标”“事件计数器”放在进程共享的可变字段中，会让交错执行相互影响。

`PiTurnRunner` 的类实例保存进程级缺省设施，每次 `runTurn` 创建新的 Turn 状态。先读这个装配入口，再读各个 helper，比从底层 Agent 循环反向猜产品状态更容易。

@source runner

## 找到 Pi 真正进入的地方

@source agent

`newAgent` 注入 systemPrompt、model、tools 和 initialMessages；`convertToLlm` 则生成真正面向模型的历史投影。该函数还设置并行工具执行。阅读时区分三个对象：产品中的 Session 历史、一次 Turn 的内存状态、一次模型请求的 messages。

源码中的投影会处理孤立工具结果和图片请求限制。它提示了一个重要设计：为了适配模型而改请求，不必同时改掉保存的原始历史。保留事实和决定本次发什么，可以是两套数据结构。

## 并行执行，串行提交观察结果

继续阅读 `pi-turn-runner.ts` 中的 Step 4–6：先安装工具和 LLM hooks，再订阅事件，把并行 promise 分支产生的 AgentEvent 接入一个串行队列。队列负责翻译 RuntimeEvent、更新历史游标并调用 step-end 逻辑。

这不代表工具变成串行。计算可以并行，而状态提交与观察输出需要一个可解释的顺序。否则 UI、持久历史和最终状态可能分别看到不同顺序。

取消也不是抛一个异常就结束。调用前 signal 已取消，需要避免启动 Agent；执行中取消，需要转发到 `agent.abort()`；结束时还要处理已排队事件、终态输出和 metrics 收尾。源码的 `finally` 路径值得和正常分支一起读。

## 一个真实的小型状态交接

@source registry

内部模型 Turn 可能在 admission 前就读取了 prompt。这个 Registry 用 reservation 先占名额，再 remember、rebind、take，把同一次读取交给正确的 Turn；它不是 Session 持久化数据库。

@lab registry

实验设置容量为 1：未填入值的 reservation 也占容量；rename 保留同一个对象；take 后再次读取为空；close 后不能再 reserve。这里直接运行上游完整类，没有重写其算法。

::: interview 为什么一个 Agent 结束了，产品还可能不能接下一条消息？
模型循环返回、工具子进程退出、事件队列排空、历史提交和 Session busy 状态释放是不同步骤。应按真实执行路径确认最终结算顺序，并测试取消后立即再次发送，而不能只检查界面显示了 cancelled。
:::
