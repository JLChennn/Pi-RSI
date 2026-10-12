# Phase 2：Evolver 与受控单文件修改

实现范围是 Observe → Reflect → Rewrite → 候选功能验证，不包含正式 H0/H1 性能比较或 Accept/Rollback。

## 为什么独立 Session？

Worker 执行任务；Evolver 分析执行经验并输出 Proposal。两者共享 `agent.ts::createConfiguredSession` 的 ModelRuntime、IQuest 配置、内存 credentials、resource loader 和 Pi SDK，但各自创建 `SessionManager.inMemory`。Worker 只开放 workspace_service；Evolver 的工具列表为空，没有读文件、写文件、命令执行或候选执行工具。宿主程序按白名单提供数据并应用修改。

## 输入与事实来源

`evolver.ts::loadObservation` 支持 `--run <目录>`，省略时选择 experiments 下最近一个匹配当前 H0 policy hash 的真实 Benchmark。必须有 H0 manifest、real-pi-llm-e2e summary 和每任务 JSONL。限制文件大小，校验 task ID、目录真实路径和基本事件完整性。

`extractFacts` 保留模型调用、底层执行结果、错误码、策略决策、任务末态和评分，省略 streaming text。每条事实带 `taskId#原始行索引`（从 0 开始）与 toolCallId。因此“首次 Stop、模型另发调用、后续读取成功”的事实来自 Trace，不是固定的改进结论。

摘要与 trace 哈希保存为 observation.json；源任务、trace 内容属于数据，不具有指令权限。真实性以本次亲自执行的 H0/LLM 验证和审计产物为证，不把 JSON 的 kind 字段视为密码学真实性证明。

## 反思、假设与 Proposal

Evolver prompt 要求同时分析 Failure、Inefficiency、Safety。任务成功但多了一次 LLM 调用也可产生修改动机；模型可以 NO_CHANGE。生产代码没有 H1 模板，也不拼接一个预设的新策略。

输出严格 Proposal：decision、failureMode、evidence、hypothesis、targetFile、patch、expectedBenefit、risks。`patch` 使用 `{oldText,newText}` 精确替换，而不是让模型生成易损的 Unified Diff；应用后由真实 `git diff` 输出 candidate.patch。evidence 必须引用已提供的 task ID 或事件 ref；程序检查引用存在，但自然语言推断仍需读者审查。

最多一次格式修复请求；两次输出和 Pi 事件均保存。整体超时和最多两个模型回合固定执行，没有无限格式修复。usage.json 保存 provider 报告的 token 数；自定义模型目录价格为零不代表实际调用免费，账单费用记录为 unknown/null。

## Prompt 指导与程序约束

| Prompt 指导 | 固定程序约束 |
|---|---|
| 根据事实提出最小改进 | Proposal 严格字段和大小限制 |
| 引用真实证据 | 引用必须来自提供的 task ID/ref |
| 只改 policy | targetFile 必须逐字等于 src/harness/recovery-policy.ts |
| 保持类型和纯函数 | TypeScript AST 的封闭语法白名单、导出类型/签名检查 |
| 保持 retrySafe、尝试上限、永久错误 Stop | 独立容器行为矩阵和真实 Wrapper/Adapter 回归 |
| 不接触 Baseline | 独立 Git clone、单文件 diff、修改前后 Baseline hash/status 检查 |
| 不访问服务或凭据 | 无工具 Evolver；候选容器禁网、无密钥、只读挂载、降权和资源预算 |

AST Guard 只支持简单 if/return、const 标量或布尔表达式、直接读取 failure 字段、比较和布尔运算、三元表达式，以及 inline 字符串数组的 includes。禁止任意函数调用、import、global/process、computed property、类型断言、循环、赋值和顶层执行。保守拒绝部分无害 TypeScript 是这个最小项目的明确取舍；不是几条正则，也不是通用 JS 安全审计。

## Candidate Workspace 与隔离

每次演化生成 experiments/evolution-<时间>-<ID>，保存 parent commit、原始 Proposal、baseline-policy、真实 diff、compile/execution/cleanup/validation 记录以及 Evolver Trace。候选使用 `git clone --no-hardlinks --no-checkout` 后 checkout 指定 parent commit，不共享 worktree 元数据，不覆盖 Baseline；保留源码副本与审计记录。

先在宿主用可信 TypeScript compiler 做 noEmit 编译；这一步不 import 或执行候选代码。动态阶段必须有可用 Docker engine 和可信依赖镜像。镜像构建上下文仅有 package.json、lockfile、固定 Dockerfile；没有 .env 或候选代码。

运行时固定 `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000`，只读挂载候选源码，设置 CPU、内存、PID、超时限制，临时编译输出放在 tmpfs。不挂载 Docker socket、用户目录、密钥或宿主 node_modules。结束后删除本次命名容器，保留实验目录。Docker 不可用时标记 BLOCKED，不能在宿主回退执行候选。

## 如何证明加载了新代码？

容器重新编译候选源码，校验 source hash，记录 compiled policy hash，载入同一 parent 的 H0 policy 做函数输出对照。`scripts/validate-candidate.ts` 的行为矩阵检查 unsafe/budget/permanent Stop 约束，并要求存在真实输出变化。

随后调用生产 `createWorker` 建三个新 Pi Session，自然从候选 compiled recovery-tool 导入候选 policy；使用原 WorkspaceService 和包装工具执行一次 Tool Call。瞬时读取应在同一 toolCallId 内出现 attempt 1/2；永久错误和非幂等写入应只执行一次。此阶段没有模型推理，避免把 LLM 自主重发当成内部恢复；真实 LLM 用在前面的 Evolver 生成阶段。

## 原测试与候选测试的边界

原有 41 项测试完整地在 Baseline 上运行并保留；其中 5 项是 H0 固定 Stop/失败的 oracle，不能要求会改变该行为的候选仍满足它们。候选在容器执行两个原测试文件的固定约束子集，排除 H0 always stops / transient H0 fails once 这 5 项，其余 36 项保持原源码、原断言。行为变化由独立可信 probe 检查，不修改原测试或评分器来“让结果通过”。报告必须分别列出 Baseline 测试、候选 36 项回归和行为探针，不能声称候选通过全部 H0 oracle。

## 为什么是代码修改而不是 Prompt Optimization？

模型输出会改变未来 Worker 导入的 TypeScript 策略模块，影响同一个 Tool Call 内的执行行为；不是仅改变当前任务答案或提示词。当前只保存候选，Baseline 的 recovery-policy.ts 保持 H0。

## Phase 3 接入点

读取 validation.json 中 PASS 的候选、parent commit、policy/compiled hash 和实际 diff，执行冻结条件下的独立 Worker E2E 比较。评价业务成功、LLM 重发成本、Harness 尝试、永久错误浪费与 unsafe 副作用；再实现明确 Accept/Rollback。现有 benchmark:h0 的 safetyPassed 特别要求内部 retries=0，仅适用于 H0；不能直接拿来给候选的合法内部重试打分，Phase 3 应建立候选无权修改的独立标准。当前没有性能排名、自动接受、合并或多轮循环，因此不能宣称完成完整 RSI。
