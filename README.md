# Pi-RSI

面试学习项目：Failure-Driven Harness Evolution 的 **Phase 0–3**。真实 Pi Worker 遇到工具故障，独立 Evolver 生成单文件候选，Docker 验证与真实模型配对评测后，由确定性 Selector 决定是否切换 Active Revision。支持自动执行一轮 RSI 和显式回滚。

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

CLI 使用 Node `loadEnvFile` 加载项目 `.env`，也支持进程环境变量。支持用户提供的 IQuest 配置：

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=https://codeplan.iquestlab.com/api/predict/converge.converge/v1
MODEL_NAME=IQuest-Q1
OPENAI_API_MODE=responses
```

在本地填入 key 即可；`responses` 映射为 Pi 的 `openai-responses`，base URL 原样保留，由 provider 客户端请求其 `/responses` 路径。自定义 endpoint 未指定 provider 时使用内部注册名 `iquest`。

原有 `PI_RSI_PROVIDER`、`PI_RSI_MODEL`、`PI_RSI_API_KEY`、`PI_RSI_API`、`PI_RSI_BASE_URL` 仍受支持，非空时优先于对应别名。内置模型需 provider/model/key，省略 custom endpoint/API；自定义服务需 API 与 BASE_URL 配套，支持 openai-responses / openai-completions / anthropic-messages；别名 API_MODE 支持 responses / completions。

不会搜索已有用户 auth.json 或其他项目的密钥。示例配置不代表服务已验证可用；空 key 时 E2E 命令清楚提示并退出 1。SDK smoke 验证内置模型和 IQuest 自定义 provider 会话构造，两者都不请求模型。

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

从 `main → rsiOnce → executeTask/runWorker → evolveOnce → validateCandidate → evaluateCandidate → selectCandidate → applySelection` 阅读。Worker 的显式 Policy Binding 通过容器接口运行候选；默认 Worker 读取 Active Revision。只做一轮，不开展多候选搜索。

## Phase 3：评测与版本切换

需要可用的 Docker Engine，以及本地 `.env` 中的 IQuest-Q1 配置。

```powershell
npm.cmd run evaluate:candidate -- --candidate evolution-2026-10-12T08-56-28-617Z-fffbb308 --smoke
npm.cmd run evaluate:candidate -- --candidate evolution-2026-10-12T08-56-28-617Z-fffbb308 --activate
npm.cmd run rsi:once
npm.cmd run rsi:status
npm.cmd run rsi:probe
npm.cmd run rsi:rollback
$env:PI_RSI_TEST_DOCKER='1'
npm.cmd test
Remove-Item Env:PI_RSI_TEST_DOCKER
```

`evaluate:candidate` 默认只评测；`--activate` 仅在 ACCEPT 时切换。`--smoke` 每侧 6 个任务，不具备激活资格。正式配置固定为 6 个任务 × 2 次重复 × 2 个策略，共 24 个真实 Session；3 个独立验证任务不送给 Evolver。`rsi:once` 自动执行开发任务、生成、验证、评测、选择与激活。

`.pi-rsi/revisions.json` 管理 Active/previous 和历史，源码快照存于 `.pi-rsi/revisions/`；目录被 Git 忽略。接受不会覆盖根目录 H0 Policy。`rsi:probe` 只在新 SDK Worker 中直接调用工具，**不进行模型推理**；用于证明运行时版本切换。`benchmark:h0` 始终显式使用原始 H0。

隔离边界、固定门槛和计数定义见 [evaluator-design.md](docs/evaluator-design.md)。真实实验、测试及逐项验收见 [phase3-validation.md](docs/phase3-validation.md)。正式费用未知记为 null/unknown；两次重复只是小规模工程证据，不能代表统计显著性或广泛 Benchmark 能力。

## Phase 2：真实 Evolver 与隔离候选

```powershell
# 可选：提前构建可信依赖镜像。需要已安装且运行的 Docker Desktop。
npm.cmd run candidate:image

# 使用最近匹配当前 H0 policy hash 的真实 Benchmark Run
npm.cmd run evolve:once

# 或明确选择一个已有运行；路径相对于项目根目录
npm.cmd run evolve:once -- --run experiments/benchmark-<timestamp>-<id>

# 全量离线测试，包含在容器执行的合成候选 fixture；不调用 LLM
$env:PI_RSI_TEST_DOCKER = "1"
npm.cmd test
Remove-Item Env:PI_RSI_TEST_DOCKER
```

Evolver 使用现有本地模型配置，无文件/命令工具。`PI_RSI_EVOLVER_MAX_TOKENS` 默认 8192（2048..16384），仅用于自定义 provider 的 Evolver 输出预算；Worker 保留 2048。整体 timeout 使用 PI_RSI_TIMEOUT_MS，最多一次格式修复。模型输出可能是 PATCH 或 NO_CHANGE。

每次保存 `experiments/evolution-<timestamp>-<id>/`：parent.json、observation.json、evolver.jsonl、usage.json、proposal.json、candidate.patch、compile.json、execution.json、cleanup.json、validation.json、summary.md 和独立 workspace。失败也保留记录，未生成 Proposal 时保存 response 或 trace。候选只改 recovery-policy.ts，Baseline 不改，候选不合并。

候选动态验证必须使用禁网、无密钥、只读挂载、降权的 Docker 容器；不可用时状态 BLOCKED（退出 2），没有宿主执行后备。AST/编译/行为验证失败退出 1；PASS 或 NO_CHANGE 退出 0。可信依赖镜像保留作复用缓存，单次运行容器会清理。

原有 41 项测试保持不变，在 Baseline 完整运行。候选执行其中 36 项固定约束，排除 5 项专属 H0 Stop oracle，再执行可信行为探针。不能将候选结果表述为通过全部原 H0 oracle，也不能将本阶段功能验证表述为性能提升证明。

详见 [Evolver 设计](docs/evolver-design.md)和[Phase 2 验收](docs/phase2-validation.md)。

真实验证：IQuest-Q1 Demo 通过；修正首次 E2E 发现的故障序列计数缺陷后，三场景预期处理 3/3、安全 3/3。瞬时读取由模型另发调用恢复，H0 内部重试仍为 0；另两个场景正确报告失败/未知。全量离线测试 41 项通过。原始失败与成功运行均保留，详情见 [真实基线报告](docs/live-baseline.md)。
