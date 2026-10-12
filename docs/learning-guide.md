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

## 9. 后续 Evolver 应该修改什么？

唯一目标 `src/harness/recovery-policy.ts::decideRecovery`，由失败轨迹提出最小候选 patch。不能改 wrapper、adapter、fault sequence、测试、任务或 grader。Phase 2 必须在受限候选工作区实现 patch 检查与独立验证；本项目当前没有自动修改入口，也没有 H1。

## 10. 为什么这是 Harness 级 RSI 的准备工作？

未来改的是影响后续所有任务工具执行的程序逻辑，不是改一个任务答案、prompt、模型权重或上下文内容。真正 RSI 要有 Run → Reflect → Rewrite → Evaluate → Accept/Rollback 的验证闭环；Phase 0/1 只是可进化对象、受控失败和证据链，不能称已实现自我改进。

建议口述：模型通过 Pi 决定“调用什么”，Wrapper 决定同一个调用失败后“是否再次执行”。Policy 可进化，安全边界与评测保持固定。真实提升必须独立比较新旧版本，且区分模型恢复和 Harness 恢复。
