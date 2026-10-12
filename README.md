# Pi-RSI

面试学习项目：Failure-Driven Harness Evolution 的 **Phase 0 + Phase 1**。实现真实 Pi Worker、H0 工具失败策略、三类本地故障、JSONL 轨迹和最小基线评测。当前没有 Evolver / 自动改写 / Accept-Rollback。

Pi 上游固定为官方 `earendil-works/pi`，`v1.0.4`，commit `7c10bd4337495ee613f2224843ecdf349b80d1df`。版本与 npm gitHead 见 [docs/pi-version.json](docs/pi-version.json)，源码入口见 [docs/pi-source-map.md](docs/pi-source-map.md)。项目根目录直接使用当前 `Pi-RSI`，避免无意义再套一层子目录；npm 包名 `pi-rsi`。

## 安装与离线验证

Node.js >=22.19，npm，Git；Windows PowerShell 建议用 `npm.cmd` 避免脚本执行策略问题。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd test
npm.cmd run smoke:sdk
```

`package-lock.json` 固定完整依赖树；`--ignore-scripts` 避免安装执行第三方 lifecycle scripts。`smoke:sdk` 创建真实 AgentSession，直接执行注册的 Pi tool 并 dispose，**不进行模型推理，不算 Agent E2E**。

重新获取调研源码（不需要构建上游）：

```powershell
git clone --depth 1 --branch v1.0.4 https://github.com/earendil-works/pi.git upstream/pi
git -C upstream/pi rev-parse HEAD
```

## 配置真实模型

```powershell
Copy-Item .env.example .env
# 用本地编辑器配置自己的 provider/model/API key；不要粘贴到聊天或提交到 Git。
npm.cmd run demo:agent
npm.cmd run benchmark:h0
```

CLI 使用 Node `loadEnvFile` 加载项目 `.env`，也支持进程环境变量。必须提供 `PI_RSI_PROVIDER`、`PI_RSI_MODEL`、`PI_RSI_API_KEY`；不会搜索已有用户 auth.json 或其他项目的密钥。内置模型以锁定 Pi catalog 为准。自定义兼容服务同时设置 `PI_RSI_API` 和 `PI_RSI_BASE_URL`，支持 openai-responses / openai-completions / anthropic-messages。`.env.example` 是格式示例，不代表已验证任一服务可用。没有配置时 E2E 命令清楚提示并退出 1。

默认 60 秒、8 轮模型请求，工具内部最多 3 次尝试、每任务最多 12 次工具调用。可配置 `PI_RSI_TIMEOUT_MS` / `PI_RSI_MAX_TURNS`。没有真实外部业务副作用：append 仅修改每任务的本地内存数组。

每次运行创建 `experiments/<command>-<timestamp>-<id>/`，Benchmark 保存 `manifest.json`（版本、配置非秘密项、任务/policy/lock 哈希）、三份 trace 与 `summary.json`。目录被 Git 忽略，按需保留本地证据。源码执行用 tsx；build 对源码、测试和 scripts 全部做 TypeScript 检查，dist 不作为 CLI 输入。

## 理解结果

H0 在每个工具错误后 Stop，**只停止本次 toolCallId 的内部尝试**。模型仍可自主另发调用，因此 H0 的 transient-read 任务可能成功。`llmReissuedCalls` 表示首个调用后的额外调用数量，不自动断言它们都是模型的重试意图。

Benchmark 分别报告任务成功、预期错误处理、安全，以及 LLM 调用和 Harness 尝试数。Permanent 正确返回 ENOENT、unsafe 正确返回 unknown 可以通过错误处理，但不伪装为业务任务完成。模型另发写调用可能重复写，grader 会发现；Wrapper 禁止内部 unsafe retry，但不宣称已经提供完整的跨调用 exactly-once 保证。

离线 tests 中注入 always-retry 来验证固定 Wrapper 的约束，这不是未来 H1 策略。测试的合成最终答案只检验 grader，生产 E2E 入口始终真实 Pi/LLM。

## 学习与状态

- [源码地图](docs/pi-source-map.md)：锁定上游 API 和调用链。
- [架构](docs/architecture.md)：Mermaid、数据流、安全边界、评分含义。
- [学习路线](docs/learning-guide.md)：十个问题定位源码。
- [验收进度](docs/progress.md)：实际命令、证据、未完成项。

从 `main → runWorker → createWorker → createAgentSession → tool.execute → decideRecovery → trace.record → assess` 阅读。下一阶段仅在用户确认后开发独立 Evolver，修改目标限定 recovery-policy.ts；本阶段完成后停止。
