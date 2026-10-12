# 按调用链读源码

先读 README 的验证状态，再执行 `npm test` 和 `npm run smoke:sdk`。有用户自行配置的凭据才运行 Demo/Benchmark；离线测试不是 Agent E2E。

## 1. 项目从哪个函数启动？

`src/cli.ts::main`：选择 demo / benchmark，调用 `readModelConfig`，生成唯一 experiment 目录。配置不全直接退出 1，列出缺少的环境变量，没有假模型后备。

## 2. 一个 AgentSession 如何创建？

`src/agent.ts::createWorker → Pi sdk.ts::createAgentSession`。每个任务新建 `SessionManager.inMemory`，使用 pi-ai 公开导出的 `InMemoryCredentialStore` 和独立 ModelRuntime，关闭自动加载用户全局配置、Extension 和 Skill；只注册 workspace_service。可运行 `smoke:sdk` 验证真实 SDK 会话与工具适配。

## 3. 一个用户任务如何传给 Pi？

`runWorker → session.prompt(prompt) → AgentSession.prompt → Agent.prompt → runAgentLoop`。本项目没有自己的 Agent while loop。Benchmark 的 for 循环只是在遍历三个独立任务。

## 4. LLM 如何决定调用 Tool？

Pi 的 `streamAssistantResponse` 把当前消息和工具 schema 送进 `ModelRuntime.streamSimple`，真实模型返回包含 toolCall 的 assistant message。参数 schema 声明 operation/resource/record。retrySafe 和 maxAttempts 没有出现在模型可写参数中。

## 5. Tool 如何执行并返回结果？

Pi `executeToolCalls → prepareToolCall → executePreparedToolCall → wrapToolDefinition → recovery-tool.ts::execute`。Wrapper 的 content 和 isError 返回 Pi，toolResult 被加入 context。下一次 LLM 请求读取这个结果；只在 text 中说“失败”而没有 isError 会造成错误语义，因此本项目明确使用 isError。

## 6. Recovery Policy 在哪里介入？

底层 adapter 抛错或返回 `{ok:false}` 后，Wrapper 生成冻结的 ToolFailure，调用 `decideRecovery`。Policy 只建议 retry / stop；Wrapper 再检查可信 retrySafe、attempt 上限和 signal。H0 永远 Stop，没有根据 ECONNRESET 偷偷恢复。

## 7. 一次错误如何形成 Trajectory？

`TrajectoryCollector.record` 将 events 同步追加到 JSONL。Pi 事件保留 `pi_` 前缀；wrapper 单独记录每次尝试、错误码、requestedAction 和实际 recoveryDecision。按 sessionId/taskId/toolCallId/attempt 连接，即可重建模型调用与内部尝试。读 `tests/harness.test.ts` 的“transient H0 fails once”可以看到两个调用 ID 都从 attempt 1 开始。

## 8. H0 为什么失败？

严格说，H0 的**首次瞬时故障工具调用**失败，因为 policy 返回 Stop；不是说整个 Pi 任务必败。模型有能力再发 Tool Call，第二次底层调用可成功。E2E 的 H0 可能仍通过任务，不能将该成功归功于 Harness 自动恢复。Permanent 本来无法读成功；unsafe 的 response loss 应报告未知，不能通过重复写换取成功响应。

## 9. Evolver 修改什么？

唯一目标 `src/harness/recovery-policy.ts::decideRecovery`。Phase 2 已实现 `evolve:once`：独立 Evolver 根据失败及低效轨迹生成结构化替换，由程序在独立候选 clone 中应用；不能改 wrapper、adapter、fault sequence、测试、任务或 grader。候选经过 AST、编译与隔离验证，不自动成为当前策略。Baseline 仍为 H0。

## 10. 为什么这是 Harness 级 RSI？

Evolver 改的是候选 Worker 会加载的程序逻辑，不是任务答案、prompt、模型权重或上下文内容。Phase 3 将真实任务轨迹、真实代码 Patch、独立 E2E 评测、确定性接受与新 Worker 加载连接起来；回滚可恢复旧行为。没有修改 Pi Agent Loop。

建议口述：模型通过 Pi 决定“调用什么”，Wrapper 决定同一个调用失败后“是否再次执行”。Policy 可进化，安全边界与评测保持固定。真实提升必须独立比较新旧版本，且区分模型恢复和 Harness 恢复。

## Phase 2 源码阅读顺序

1. `evolver.ts::loadObservation / extractFacts`：如何从原始行号、错误和调用 ID 建立事实；为什么成功任务也可能有改进动机。
2. `agent.ts::createConfiguredSession`：Worker 的工具列表含 workspace_service，Evolver 是空列表；同底座模型但独立 Session。
3. `evolver.ts::evolveOnce`：提供当前源码、生成 Proposal、最多一次格式修复、保存真实 token 用量。
4. `patch-guard.ts::parseProposal / guardPolicy`：为什么要求 literal target 和 AST 白名单，而不是信任 prompt。
5. `candidate.ts::validateCandidate`：如何 clone parent、应用唯一替换、生成 diff、编译和隔离运行。
6. `scripts/validate-candidate.ts`：source/compiled hash 如何对应实际 import；新 Session 同一调用内 attempt 1/2 如何证明候选已加载。

真实案例和限制见 [phase2-validation.md](phase2-validation.md)，设计见 [evolver-design.md](evolver-design.md)。

## Phase 3 最值得阅读的 8 个函数

1. `rsi.ts::rsiOnce`：从 Active 开始，只把开发轨迹交给 Evolver，串联单轮与提前结束分支。
2. `agent.ts::createWorker`：每次建立真实 Pi Session；默认读取 Active，也支持显式 Binding。`null` 表示明确使用原 H0。
3. `evaluation/policy-runtime.ts::openPolicyBinding`：源码、编译、运行时哈希对应；Docker 只执行 Policy，宿主负责模型调用。
4. `evaluation/evaluator.ts::evaluateCandidate`：固定配置、独立故障状态、重复配对与顺序交叉；保存全部 E2E 证据。
5. `evaluation/evaluator.ts::assessEvaluation`：业务成功与正确处理失败分开，内部重试不算新的模型工具调用。
6. `evaluation/selector.ts::selectCandidate`：四道 Gate；证据缺失返回 INCONCLUSIVE，不能激活。
7. `evolution/version-manager.ts::applySelection`：重放选择、核对哈希、准备快照、原子发布指针；REJECT 不改变 Active。
8. `evolution/version-manager.ts::rollback`：恢复 previous，保留所有历史；到 H0 后重复操作幂等。

面试时可以沿着一个工具调用 ID 讲：H0 的 attempt=1 失败后返回模型，模型另发 ID；H1 在相同 ID 下 attempt=2 成功。两者底层仍执行两次，但 H1 少一次模型工具调用和相应模型交互。然后解释独立评测为什么有权决定接受，以及实际源码哈希怎样证明新 Worker 已生效。
