# Pi-RSI 验收进度：Phase 0 + Phase 1 + Phase 2

更新：2026-10-12（Asia/Shanghai）。Phase 0/1 真实 Worker 与 H0 基线已验证；Phase 2 已有真实 IQuest-Q1 生成候选通过静态、编译、容器回归和新 Worker 加载验证。Baseline 仍为 H0，没有开始 Phase 3，也没有宣称完成完整 RSI。

## 实际环境与版本

- Windows / PowerShell，项目 `C:\Users\CJL\Desktop\Pi-RSI`；初始目录为空，不存在用户仓库或文件。
- 实际执行 Node.js `v26.3.0`、npm `11.16.0`、Git `2.55.0.windows.2`。项目 engines 为 Node >=22.19.0；没有另外验证 Node 22 的运行结果。
- 官方 Pi tag `v1.0.4`，commit `7c10bd4337495ee613f2224843ecdf349b80d1df`，npm version/gitHead 一致。
- npm 安装 171 个包，audit 172 个包，执行时报告 0 vulnerabilities；不是长期安全保证。
- 主依赖精确版本、Pi 同系列 overrides、完整 npm lockfile 已保存；上游副本未修改。

## 真实执行结果

| 命令 | 结果 | 证据与限制 |
|---|---|---|
| `npm.cmd install --ignore-scripts --offline=false --fetch-retries=0 --fetch-timeout=30000` | 通过 | 下载慢，约 11 分钟；生成 lockfile |
| `npm.cmd install --package-lock-only --ignore-scripts --offline` | 通过 | 添加公开 pi-ai 直接依赖后的 lockfile 同步 |
| `npm.cmd run build` | 通过，退出 0 | TypeScript 检查源码、tests 和 scripts |
| `npm.cmd test` | **2 文件，41 passed，0 failed** | 最终一轮 duration 5.11s；新增三个故障序列回归用例，修复前失败、修复后通过 |
| `npm.cmd run smoke:sdk` | 通过 | 内置模型及 IQuest 自定义 provider 的真实 Pi AgentSession + 注册工具直接执行 + JSONL + dispose；**没有推理** |
| `npm.cmd run demo:agent` | 真实推理通过，退出 0 | IQuest-Q1 实际读出 REPORT_OK_42，1 次工具调用 |
| `npm.cmd run benchmark:h0` | 首轮退出 1；修复后退出 0 | 最终预期处理 3/3、安全 3/3、业务任务成功 1/3；详情见 live-baseline.md |

tests 中的模拟最终 JSON 仅用于检查 grader，always-retry policy 仅用于检查 Wrapper 防御边界；均不属于正式 H1 或 Agent E2E。

## 验收逐项状态

| 验收项 | 状态 |
|---|---|
| 安装依赖、锁定版本、lockfile | 已完成 |
| TypeScript 编译 | 已验证 |
| 使用真实 Pi SDK 创建 Worker | 已验证（离线真实 Session） |
| 注册并执行自定义工具 | 已验证（通过 Pi 的注册适配工具直接执行） |
| H0 默认 Stop、Wrapper 调用 H0 | 已验证 |
| 三类故障 | 已验证（离线） |
| 内部 retry / 新模型 Tool Call 标识 | 已验证，真实 transient trace 有两个调用 ID，均 attempt=1 |
| JSONL 保存 | 已验证（单元测试、SDK smoke 实际文件） |
| 无凭据单元测试 | 41 项通过 |
| 有凭据真实 Agent E2E | 已验证，使用用户自行填写的本地配置 |
| Pi 执行事件订阅及任务最终结果采集 | 真实 Demo/Benchmark 生命周期、工具、最终消息均保存 |
| 源码地图、架构、学习指南 | 已完成 |

SDK smoke 的 trace 存在 `experiments/sdk-smoke-*.jsonl`，明确记录 `inferenceExecuted:false`。该目录被 Git 忽略。上游调研副本也被忽略，重新下载命令在 README。

## 实际遇到并解决的问题

1. 初始沙箱连接本机代理失败；仅对源码 clone 使用本命令 `git -c http.proxy=`，成功获取官方 tag，不修改系统配置。
2. SDK 主入口没有导出 `AuthStorage`；改为 pi-ai 公开 `InMemoryCredentialStore`，编译与真实 Session smoke 已通过。
3. Vitest 默认发现调研仓库的测试；首次运行已中断，增加 `vitest.config.ts`，现在只运行 `tests/**/*.test.ts`，不需要上游开发依赖。
4. Windows sandbox 下 Vite/Vitest 对临时缓存 rename 产生 EPERM；使用获准的本项目本地验证运行完成测试。该错误不代表工具策略失败；没有通过修改业务代码掩盖。
5. Node 26 + tsx 显示 `module.register()` 的 DEP0205 警告；命令成功，不影响已验证功能。没有安装或切换 Node 版本。

## 尚未完成与下一入口

用户补充了 IQuest-Q1 配置并自行填入 key。已支持 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL_NAME` / `OPENAI_API_MODE`，原 `PI_RSI_*` 非空项优先；本地 `.env` 被 Git 忽略，未输出或提交密钥。真实 endpoint 已通过 Demo 与三场景验证。

Evolver 与受控候选功能验证已完成；独立性能评估与接受/回滚尚未完成，也没有正式多轮统计实验。真实 H0 结果与首轮问题见 [live-baseline.md](live-baseline.md)；需要检查 stopReason / runError / actual service state / trace / summary，而不是仅看命令结束。

Phase 2 的结构化 Proposal、单文件 Guard、候选隔离和功能验证现已实现，见下。独立统计比较、Accept/Rollback 和默认未来最多 3 轮的多轮 RSI 仍属于 Phase 3，尚未实现。

## Phase 2 当前状态

- 新增三个核心模块：evolver.ts、evolution/patch-guard.ts、evolution/candidate.ts。
- Worker/Evolver 使用共享 SDK 工厂，但独立 Session；Evolver 无工具。
- 真实 H0 输入通过 manifest、policy hash、trace/task 基本完整性校验并精简；支持 --run 或自动找最近匹配 Run。
- 严格 Proposal（PATCH/NO_CHANGE），精确代码替换，真实 git diff；只允许单一 policy 文件、保持导出接口，AST 封闭语法白名单。
- 独立源码 clone 指定 parent commit，宿主只静态编译；候选执行仅在禁网、无密钥、只读、降权 Docker 容器中进行。
- 真实生成候选 `evolution-2026-10-12T08-56-28-617Z-fffbb308`：guard/build/invariant-tests/behavior PASS，Baseline unchanged。
- 新候选 Worker 的瞬时读同一 toolCallId 内 attempt 1/2 成功；永久和 unsafe 各只执行一次，unsafe 恰好一条记录。
- 真实 Proposal、Diff、验证、Trace、用量、parent/hash、独立源码副本保留；容器已清理；没有合并候选。

## Phase 2 实际验证

| 命令/检查 | 结果 |
|---|---|
| 原 Baseline npm test | 41 passed |
| Phase 2 npm run build | PASS |
| 默认 npm test | 70 passed、3 skipped（opt-in Docker fixtures） |
| npm run smoke:sdk | 共用工厂后 Worker SDK Smoke PASS |
| Docker opt-in evolution.test.ts | 32 passed，包含 29 个纯测试与 3 个容器 fixture |
| 首次真实 evolve:once | FAIL：输出 2048 tokens 截断、stopReason=length，未应用候选 |
| 独立预算修正后真实 evolve:once | PASS：真实 IQuest 生成、静态/编译/36 项不变回归/行为验证通过 |
| 最后全量 Docker opt-in npm test | **3 文件，73 passed，0 failed，0 skipped，129.36s** |

三个动态 fixture 明确是合成 Proposal：合规改变通过、unsafe-only 重试在函数安全矩阵被拒绝、类型不兼容在编译时被拒绝。不得把它们当作模型生成证据。真实生成只由独立 IQuest run/response/proposal 证据支持。

原有 41 项测试未修改；其中 5 项只定义 H0 固定 Stop 行为，在候选阶段明确排除，其余 36 项不变。候选不是“通过全部 H0 oracle”，而是通过不变约束和新增可信行为检查。

## Phase 2 遗留限制

AST 仅支持小型纯函数子集，有限行为矩阵不能替代完整语义证明。自定义模型价格未知，记录实际 provider token 用量但不伪称目录零成本为免费。候选 Worker 验证无模型推理，正式 Agent E2E 比较尚未做。Docker/依赖镜像不可用时 BLOCKED，不在宿主执行候选。初始模型输出截断记录已保留，Evolver 现在使用独立 8192-token 默认预算，最多一次格式修复。

下一入口是读取 PASS 的 validation.json 和对应 parent/diff/hashes 接入独立 Evaluator，再实施 Accept/Rollback。本阶段不开展这些工作。完整验收与真实 Diff 见 [phase2-validation.md](phase2-validation.md)。
