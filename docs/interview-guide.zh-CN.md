# Pi-RSI 面试与源码理解指南

这份指南围绕真实实现和 Phase 3 证据。重点是解释因果关系，不是记住项目标签。数字来自 [真实证据包](../examples/phase3-demo/README.md)，原始模型交互是 IQuest-Q1；Replay不是实时推理。

## 一分钟介绍

我做了一个基于 Pi SDK 的 Harness 自改进实验。Coding Agent 通常能修复任务代码，但遇到执行机制的不足，仍要人来改 Harness。我想验证：能不能把真实执行轨迹交给独立 Agent，让它提出影响未来执行的代码修改，再用程序决定是否接受。

我把范围限制在工具失败恢复策略。H0 遇到瞬时错误就停止内部尝试，模型会另发工具调用；Evolver 从轨迹识别这次额外交互，生成 TypeScript Patch，让安全的瞬时读在同一次调用内重试。候选只在禁网、无密钥的 Docker 执行，通过固定安全验证后，再做新旧版本真实模型对照，最后原子切换版本并支持回滚。

在6项任务、每侧两次重复的实验里，工具调用从16降到12，tokens下降约17%，正确处理均12/12，安全没有退化。它证明了一个小而完整的工程闭环，没有证明通用自主进化或统计显著性。

## 三分钟介绍：Problem → Insight → Method → Implementation → Evaluation → Result

**Problem。**Agent 的结果由模型和 Harness 共同决定。模型可能知道失败后再试一次，但每次把错误交回模型都会增加交互。现有工作流里，Harness 的这些不足通常靠工程师分析轨迹后修复。

**Insight。**Coding Agent 本来就有分析代码和生成修改的能力。可以把真实执行经验变成一个受约束的工程任务，让它改执行机制，而不是让它生成某一道任务的答案。改动会影响之后的新 Session，这才有“自改进”的实际作用。

**Method。**我的闭环是 Run、Reflect、Rewrite、Validate、Evaluate、Accept或保留版本，并支持显式Rollback。限定一个纯函数，不改模型、Loop、Wrapper、任务和评分。这样能够解释一次修改为什么有用，也减少不可信修改的权限。

**Implementation。**Worker 使用真实 Pi AgentSession，只有 workspace_service 一个工具。Evolver 是独立 Session，没有文件或执行工具，它输出严格 JSON Proposal，由可信程序做精确源码替换、AST检查和独立clone。编译在宿主只是可信静态处理，候选执行在 Docker；宿主保留模型密钥，容器只交换失败结构和retry/stop。Wrapper自己掌握retrySafe和尝试上限，不能被模型参数改写。

**Evaluation。**H0与候选各自创建新Session和独立故障状态。模型、参数、任务、工具权限、预算相同，6个任务重复两次，其中3个验证资源不交给Evolver。判分检查真实service状态、最终JSON、故障确实发生和正常停止；成功与正确处理失败分开。Selector使用预先提交的固定门槛，而不是LLM自评。代码哈希把Proposal、验证、执行和发布连接起来。

**Result。**H0的瞬时故障由模型另发调用恢复；H1在同一调用内部恢复。总体Calls16→12、tokens13718→11382，底层仍16次，正确处理12/12，不安全重复写0。成功率未提高，因为H0原本也能恢复；提升是以更少模型交互获得同样结果。时延仅下降约2%，不能强调显著性。系统也真的拒绝过把EACCES当瞬时错误的Patch。版本发布和回滚都有新Worker哈希与行为证据。

## 架构与函数契约

阅读时先回答：“谁有权做决定？数据从哪里来？失败以后状态如何改变？”

| 函数与文件 | 输入 → 输出 | 核心逻辑与上下层关系 | 可能追问 |
|---|---|---|---|
| `rsiOnce`：[src/rsi.ts](../src/rsi.ts) | ModelConfig、可选namespace → audit/outcome | 读Active，运行开发任务，交给Evolver，再验证、评测、发布；错误阶段提前结束 | 为什么不是自己写Agent loop？ |
| `createWorker`：[agent.ts](../src/agent.ts) | 配置、service、task/trace、可选Binding → Session/trace/close | 默认读主Active；显式Binding固定本次版本；构造唯一工具与事件订阅 | 正在运行的Session会随指针变化吗？不会 |
| `runWorker`：[agent.ts](../src/agent.ts) | Worker输入、prompt → 最终文本/stopReason/error/usage | session.prompt交给原Pi；约束预算、采集SDK用量、dispose | agent_end为何不等于业务成功？ |
| `createRecoveryTool`：[recovery-tool.ts](../src/harness/recovery-tool.ts) | adapter、trace、同步policy → Pi ToolDefinition | 捕获失败，冻结failure，调用policy，自己检查安全与次数；输出isError | policy请求retry为什么不一定执行？ |
| `decideRecovery`：[recovery-policy.ts](../src/harness/recovery-policy.ts) | ToolFailure → retry/stop | 根文件为H0；候选快照替换函数逻辑，只建议如何处理当前失败 | 为什么保持纯函数和同步接口？ |
| `TrajectoryCollector.record`：[trajectory.ts](../src/trajectory.ts) | eventType/fields → 内存事件+JSONL追加 | Pi订阅与Wrapper都调用，统一session/task/toolCallId/attempt并脱敏 | 为什么不能仅采集最终答案？ |
| `loadObservation/extractFacts`：[evolver.ts](../src/evolver.ts) | 匹配版本的开发Run → 精简事实与event refs | 检查manifest/source hash/trace完整性；保留低效交互，即使任务成功 | 怎么防止把任务内容当系统指令？ |
| `evolveOnce`：[evolver.ts](../src/evolver.ts) | 配置、开发Run、parentPolicy → audit/status | 独立无工具Session生成Proposal，校验证据引用，最多一次格式修复；交validateCandidate | 截断为什么不能当有效Patch？ |
| `validateCandidate`：[candidate.ts](../src/evolution/candidate.ts) | root/audit/Proposal/parent → Validation | 精确替换、Guard、clone parent、唯一文件diff、编译、禁网容器测试；保持baseline | 不执行候选如何编译它？ |
| `openPolicyBinding`：[policy-runtime.ts](../src/evaluation/policy-runtime.ts) | identity、runtime目录 → decide/close | 转译不执行，容器import，限界RPC，核验编译哈希；连接原Wrapper和隔离Policy | 为什么宿主模型与容器分离？ |
| `evaluateCandidate`：[evaluator.ts](../src/evaluation/evaluator.ts) | 配置、PASS候选、namespace → audit/metrics/selection | 每侧新Session/service，第二次换顺序，保存完整trace与固定配置 | 为什么要校验实际运行代码？ |
| `assessEvaluation`：[evaluator.ts](../src/evaluation/evaluator.ts) | 任务、service、WorkerResult、events → 逐项指标 | 检查真实副作用/读值/最终JSON，分别计模型call、内部retry、底层attempt | 4/12业务成功为何不表示另外8项失败？ |
| `selectCandidate`：[selector.ts](../src/evaluation/selector.ts) | 固定config、paired metrics、合法性/哈希 → decision/reasons | 先合法与安全，再结果和效率；不足INCONCLUSIVE，不做加权自评 | 条件满足一次就能称统计显著吗？ |
| `applySelection/rollback`：[version-manager.ts](../src/evolution/version-manager.ts) | evaluation或previous、namespace → Active/历史 | 重放选择与哈希核验，快照准备后锁内rename发布；回滚恢复previous | 文件事务与数据库事务有什么差异？ |

### 沿一个调用ID走通

H0：`A/attempt1 → ECONNRESET → policy stop → toolResult.isError → 模型下一轮 → B/attempt1 → 成功`。

H1：`A/attempt1 → ECONNRESET → policy retry → Wrapper安全检查 → A/attempt2 → 成功 → 模型生成最终JSON`。

两者都执行底层两次。H1少的是新模型Tool Call与相应模型请求，不是业务操作。先讲这个例子，再讲独立评测与发布，因果关系最清楚。

## 20 个核心技术问题

1. **什么是Agent Harness？**围绕模型组织任务执行的程序层，包括上下文构建、工具注册/执行、预算、状态、事件与失败处理。模型负责生成下一步，Harness负责实际执行和约束。Pi-RSI只改其中的Recovery Policy。
2. **Pi的Loop怎样运行？**`AgentSession.prompt → Agent.prompt → runAgentLoop/runLoop → streamAssistantResponse → ModelRuntime.streamSimple`。模型返回toolCall后，Pi校验参数并execute，再把toolResult放回context继续。以锁定的[源码地图](pi-source-map.md)为准，不把项目外层遍历任务的for循环叫Agent Loop。
3. **为什么选Pi？**公开SDK可创建独立Session、注册customTools、订阅事件，并控制资源自动加载。可在不改原生Loop的前提下替换一个明确策略。选择是工程便利性，不宣称Pi优于其他框架。
4. **为什么是Harness级RSI？**真实轨迹驱动真实代码修改；修改影响之后Worker的执行，再由外部固定评测决定是否接受。它是有限Harness实验，不是权重级RSI，也不是无边界自改进。
5. **为何分离Worker/Evolver？**Worker有执行任务的工具，Evolver只有分析/生成权限；上下文、Session和目标隔离，避免任务Agent直接改安全规则和评分。共享底座模型，不共享运行状态。
6. **Trajectory有什么、怎么采？**Pi生命周期/消息/tool events，加上Wrapper每次attempt、错误、请求与实际恢复决定、最终service状态和SDK usage。通过subscribe与同步JSONL追加，按sessionId/taskId/toolCallId/attempt关联，敏感字段与配置key字面值脱敏。
7. **Evolver怎么发现低效？**成功任务仍可能包含先失败、stop、另发call、成功的序列。精简事实保留这些事件及引用，提示明确“成功不等于高效”。分析来自真实模型，不把预写规则伪装成反思。
8. **为何直接TypeScript Patch？**它改变可执行机制，避免把自改进限制为prompt追加；单纯函数接口小，精确替换与真实git diff容易审计。代价是需要编译、AST约束和隔离。
9. **怎样限制修改？**严格Proposal schema、literal target、唯一精确oldText/newText、保持导出类型/接口，封闭AST语法白名单，clone后检查唯一改动文件。模型没有文件工具；最终权限由程序控制。
10. **候选安全如何保证？**不是完整证明。多层防护：Guard限制代码、可信Wrapper控制retrySafe与预算、Docker限制权限、固定行为矩阵检查永久/unsafe，再独立E2E。模型承诺本身不是防护。
11. **Docker具体隔离什么？**Policy容器network=none、read-only、user1000、cap-drop ALL、no-new-privileges，CPU/内存/pids/请求时间限额。E2E只挂载policy.mjs和可信RPC脚本，不挂密钥、仓库或Docker socket。Phase2验证容器只读挂载独立受控clone与基线模块。
12. **H0/H1怎么加载不同Policy？**按指定identity读取不同源码，可信转译后各建新容器，容器读取文件计算compiledHash。每次RPC核验requestId及hash；Wrapper注入不同Binding，避免宿主动态import和模块缓存混淆。正常Worker默认读主Active。
13. **为什么配对？**固定同一任务、模型、工具和预算，独立service使两侧都遇到首次故障；重复与顺序交叉减少偶然顺序影响。它改善工程比较的公平性，但两次重复仍不支持统计显著性。
14. **Selector为何不用LLM？**接受修改是安全和发布决定，应可重复、可追溯、可测试。确定性gates让同样证据产生同样结论，也避免候选和评审模型自我强化的主观分数。
15. **成功率没提高，优化有效在哪？**H0靠模型再调用也能成功。问题是额外交互成本；同样4/12业务成功与12/12正确处理，Calls少25%、tokens少17.03%，底层16次不变。结果维度相同，执行效率改善。
16. **怎样避免过拟合？**只把3项开发轨迹给Evolver，另有3项等价但内容不同的验证任务；固定环境与门槛，不允许改评分。仍是小型同类任务，不能排除场景过拟合；更大外部集属于未来工作。
17. **Accept/Rollback怎样实现？**不可变源码快照、source/compiled/Validation/config关联，锁内准备临时JSON并rename发布Active；保留previous和历史。新Session读新指针，旧Session固定原Binding。回滚不git reset，到H0后重复为no-op；不宣称断电恢复或数据库事务。
18. **Evolver失败怎么办？**NO_CHANGE直接结束；合法性或实际安全验证失败REJECT；模型截断/超时等证据不足INCONCLUSIVE；依赖不可用时Demo BLOCKED。全部保留产物，不激活，不偷偷替换预置Patch。本项目实际发生过EACCES误重试和输出截断。
19. **真正的创新是什么？**不是发明retry、Pi或Docker，而是把真实轨迹、独立代码生成、受控执行、固定E2E、可回滚发布连成可解释的Harness改进闭环。定位是工程实验，不是论文首创或通用进化算法。
20. **如何扩展Context Management？**未来可将context选择/压缩策略做成受限接口，固定任务与记忆环境，评估正确率、上下文token和关键事实保留，设置新安全门槛，再版本化发布。需要重新设计可观察性和权限，不能直接把当前纯Recovery函数的隔离推论套过去；目前未实现。

## 面试质疑与技术权衡

| 质疑 | 可以验证的回答 |
|---|---|
| 这只是自动代码修复？ | 代码修复是实现手段。目标是Agent自己的执行策略，证据来自任务经历，修改影响未来运行，评估和发布闭环是研究对象；范围仍很窄。 |
| 为什么不手工写retry？ | 这个场景手工写最快。选它是为了隔离变量、验证自动生成→独立评测→接受的闭环；不是证明生成比手工更优。 |
| 为什么不用tenacity/retry库？ | 库解决重试机制，不能决定哪些副作用可重试或是否应接受一次策略修改。项目用小函数展示该决策和验证边界，生产系统可使用成熟库。 |
| 为什么不用RL？ | 这里不训练权重，也没有足够任务量与稳定奖励支持RL。固定模型生成少量受限代码，程序gates选择，便于解释与审计。 |
| 为什么不再加更多Agent？ | 当前只有Worker和Evolver，Evaluator/Selector是确定性程序。更多角色会增加成本与解释难度，不能自动增强证据可靠性。 |
| 为什么成功率不变？ | H0已经依靠模型恢复成功；优化目标是减少这次模型往返，安全和正确性作为硬约束。 |
| 为什么实验这么小？ | 这是资源受限的工程验证，目标是闭环真实性与边界。6任务两重复不能支撑跨模型或大规模能力结论。 |
| 如何证明不是模型随机性？ | 温度0、固定fault序列、独立Session、两次重复、交换顺序、保存完整trace；H1的同ID retry有机制证据。但仍不能完全排除随机性，也没有统计显著性证明。 |
| 怎么防Benchmark作弊？ | 候选只改policy函数；任务、Wrapper、Fault Injector、评分、门槛和测试不开放修改。heldout反馈不交给Evolver。可信评测器也在威胁边界内，不能只靠prompt约束。 |
| 怎样防止危险代码？ | 先AST/编译/哈希，再禁网无密钥容器与资源限制；不在宿主执行候选。Wrapper不信任policy的权限建议，固定tests与E2E再检查行为。仍不是任意程序安全证明。 |
| 下一轮提退化修改怎么办？ | 同样gates拒绝或标证据不足，保持Active；accepted历史可显式回滚。项目没有自动多轮搜索，不保证每次都有进展。 |

## 演示与源码学习顺序

先 `npm run demo:replay` 看“失败→假设→真实Patch→验证→对照→历史决策”，明确这只是历史回放。再沿上表调用链读源码，重点看三个权限边界：模型不能设置retrySafe、Evolver不能改评分、候选不能接触模型凭据。

最后解释Live：`scripts/demo.ts` 创建新的namespace，再调用同一个 `rsiOnce(config, namespace)`；Version Manager和Evaluator显式接收该namespace，主指针保持字节不变。不要通过重置用户Active来让Demo看起来从H0开始。

可以现场画两条toolCallId序列，比较模型call/内部retry/底层attempt，再展示[固定规则](evaluator-design.md)和[发布证据](phase3-validation.md)。一条完整因果链比泛讲“多Agent自进化”更有说服力。
