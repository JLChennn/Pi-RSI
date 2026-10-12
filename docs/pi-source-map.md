# Pi 源码地图（Phase 0）

调研对象仅为官方 [earendil-works/pi](https://github.com/earendil-works/pi)。锁定发布 `v1.0.4`，commit `7c10bd4337495ee613f2224843ecdf349b80d1df`；npm `@earendil-works/pi-coding-agent@1.0.4` 的 `gitHead` 与该提交一致。版本机器记录见 `pi-version.json`，所有链接固定到该提交，不引用 main 的后续 API。

本地只读副本位于 `upstream/pi`（Git 忽略），未安装上游工作区依赖，也未修改上游源码。

## 1. 创建 Session 与 State

入口：[packages/coding-agent/src/core/sdk.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/sdk.ts)，`createAgentSession`。

它解析 cwd、ModelRuntime、SettingsManager、SessionManager、ResourceLoader，从 `sessionManager.buildSessionContext()` 恢复消息；创建 `Agent({ initialState, convertToLlm, streamFn, transformContext, ... })`，再创建 `AgentSession`。该版本 `tools` 是 **工具名称字符串列表**，而 `customTools` 才是 `ToolDefinition[]`；不要混用旧版本教程中的签名。

```ts
const { session } = await createAgentSession({
  modelRuntime: runtime, model, tools: ['workspace_service'],
  customTools: [tool], sessionManager: SessionManager.inMemory(cwd),
  settingsManager: settings, resourceLoader: loader,
});
```

[packages/agent/src/agent.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/agent/src/agent.ts) 的 `Agent` 保存运行状态：model、thinkingLevel、tools、messages、isStreaming、pendingToolCalls 等。消息持久化与会话上下文投影由 `AgentSession` / `SessionManager` 负责。Pi-RSI 使用 in-memory manager，每个任务建全新会话，独立 JSONL 留证。

## 2. 用户任务到真实 LLM

[packages/coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/agent-session.ts)：`AgentSession.prompt` 处理输入并交给 `agent.prompt`。

调用链：`AgentSession.prompt → Agent.prompt → Agent.runPromptMessages → runAgentLoop → runLoop → streamAssistantResponse`。

[packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/agent/src/agent-loop.ts) 的 `streamAssistantResponse` 依次执行 `transformContext`、`convertToLlm`、`normalizeContext`，调用传入的 `streamFunction`。SDK 中的 `streamFn` 转到 `ModelRuntime.streamSimple`，由 pi-ai 的 provider 执行真实请求。

Pi-RSI 没有实现替代循环，也没有生成假模型输出。`smoke:sdk` 仅验证真实会话创建与工具直接执行，不声称调用了 LLM。

## 3. 工具注册与 Extension

`AgentSession` 构造函数调用 `_buildRuntime`；其 `_refreshToolRegistry` 整理 builtin、SDK custom、extension tools，再由 `wrapRegisteredTools` 转为 agent-core 工具。

[packages/coding-agent/src/core/extensions/loader.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/extensions/loader.ts)：`createExtensionAPI` 创建 Extension API，`registerTool` 将定义存入 extension 的 tools map。Extension factory 还可通过 `pi.on(...)` 注册生命周期处理器。`DefaultResourceLoader.reload` 加载资源，`ExtensionRunner` 绑定会话上下文并分发事件。

[packages/coding-agent/src/core/extensions/wrapper.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/extensions/wrapper.ts)：`wrapRegisteredTool → wrapToolDefinition`，为工具注入 `ExtensionToolContext`。

[packages/coding-agent/src/core/tools/tool-definition-wrapper.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts)：`wrapToolDefinition` 调用工具定义的 `execute(toolCallId, params, signal, onUpdate, ctx)`。

因此 **公开 SDK customTools 就能注册我们的包装工具**，无需再维护一个磁盘 Extension 文件。它沿用同一 ToolDefinition 和注册适配机制；本阶段刻意关闭自动发现的外部 Extension、MCP、Skill、上下文文件，保持隔离与复现。

## 4. LLM Tool Call 到执行与结果回流

`runLoop` 从 assistant message 的 content 中找 `type === 'toolCall'`。路径：

`executeToolCalls → executeToolCallsSequential/Parallel → prepareToolCall → executePreparedToolCall → tool.execute → finalizeExecutedToolCall → emitToolExecutionEnd / emitToolResultMessage`。

`prepareToolCall` 校验工具与参数，并经过 `beforeToolCall` hook；`executePreparedToolCall` 捕获异常，将其规范化为错误结果，也识别返回的 `result.isError === true`。`afterToolCall` 可处理返回值。

```ts
const result = await prepared.tool.execute(id, args, signal, onUpdate);
return { result, isError: result.isError === true };
```

随后工具结果作为 `toolResult` 消息添加到 context 和新消息列表；模型下一轮可看见错误并决定再调用工具。`finishTurn` 是循环结束/继续 hook，但 Pi-RSI 不改该 hook，也不修改原生 loop。

**H0 Stop 仅停止本次 toolCallId 的内部尝试，不会强迫整个 Agent Session 停止。** 模型可能另发 toolCallId，因此 H0 瞬时故障的 Agent E2E 不一定失败。

## 5. 事件订阅与退出

`Agent.subscribe` 订阅 core events；`AgentSession._handleAgentEvent` 将它们交给会话监听器并处理消息持久化。公开 `AgentSession.subscribe(listener)` 返回取消订阅函数。核心事件定义见 `packages/agent/src/types.ts` 的 `AgentEvent`：`agent_start/end`、`turn_start/end`、`message_*`、`tool_execution_*`。

Pi-RSI 保存 `pi_<type>` 事件以及自己的 wrapper 事件。`tool_execution_start` 另外记为 `llm_tool_call`；内部自动尝试不产生新的 Pi Tool Call。结束调用 unsubscribe 与 `session.dispose()`；超时调用公开 `session.abort()`。

## 6. 本阶段边界

自定义 wrapper 只操作本地可控 WorkspaceService；SDK 只启用这个工具。`retrySafe` 来自 adapter，最大尝试数由 wrapper 固定执行。Provider HTTP 重试、Session 自动重试与 cache warming 已关闭，便于观察工具层行为。Pi 本身不提供项目所需的 Evolver 文件权限沙箱；未来只改一个文件的约束仍需 Phase 2 的外部执行和 patch 审核边界，不能靠 prompt 宣称已完成。
