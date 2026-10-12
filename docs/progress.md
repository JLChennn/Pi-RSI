# Pi-RSI 验收进度：Phase 0 + Phase 1 + Phase 2

更新：2026-10-12（Asia/Shanghai）。Phase 0–4 已完成。Phase 3 实现真实闭环，Phase 4 完成中英文交付、真实证据Replay、隔离Live与面试指南，见 [phase4-delivery.md](phase4-delivery.md)。主Active保持H1-2c076349354f；根目录Baseline仍为H0。

## 实际环境与版本

- Windows / PowerShell，项目根目录；初始目录为空，不存在用户仓库或文件。
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

## Phase 2 时点的历史与 Phase 3 入口

用户补充了 IQuest-Q1 配置并自行填入 key。已支持 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL_NAME` / `OPENAI_API_MODE`，原 `PI_RSI_*` 非空项优先；本地 `.env` 被 Git 忽略，未输出或提交密钥。真实 endpoint 已通过 Demo 与三场景验证。

Phase 2 时只有受控候选功能验证，尚无性能评估与接受/回滚。Phase 3 已补全这两部分；没有开展正式多轮统计实验。真实 H0 历史与首轮问题见 [live-baseline.md](live-baseline.md)；需要检查 stopReason / runError / actual service state / trace / summary，而不是仅看命令结束。

Phase 2 的结构化 Proposal、单文件 Guard、候选隔离和功能验证见下。Phase 3 只执行独立评测和单轮编排，不实现多轮搜索。

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

AST 仅支持小型纯函数子集，有限行为矩阵不能替代完整语义证明。自定义模型价格未知，记录实际 provider token 用量但不伪称目录零成本为免费。Phase 2 候选 Worker 验证无模型推理，Phase 3 真实 Agent E2E 另有实验记录。Docker/依赖镜像不可用时 BLOCKED，不在宿主执行候选。初始模型输出截断记录已保留，Evolver 默认独立 8192-token 预算，可配置最高16384，最多一次格式修复。

Phase 2 历史验收与真实 Diff 见 [phase2-validation.md](phase2-validation.md)。Phase 3 新增 evaluation/policy-runtime、evaluator、selector、version-manager 和 rsi；独立设计见 [evaluator-design.md](evaluator-design.md)，真实验收见 [phase3-validation.md](phase3-validation.md)。

## Phase 3 最终状态

- 真实原候选正式E2E与新自动RSI候选正式E2E均ACCEPT；每次6任务×2重复×2策略，共24个真实Pi/IQuest Session。
- 完整RSI目录：`experiments/rsi-2026-10-12T12-04-29-750Z-20447277`。当前Active为`H1-2c076349354f`，previous为H0。
- 本轮正确处理12/12，业务成功4/12（全部瞬时任务4/4）；Calls16→12，internal retries0→4，底层尝试16→16，tokens13718→11382，latency总和40225.217→39414.379ms，重复副作用0。
- ACCEPT后新Worker、显式Rollback后H0和最终新H1的运行时hash/工具行为均有实际探针证据；探针不推理，不能混入E2E统计。
- 最终build PASS；默认92 passed+4 Docker skipped；启用Docker后**4文件、96 passed、0失败、0跳过，119.10s**。新增分类测试覆盖模型证据不足INCONCLUSIVE。
- 保留真实EACCES误重试拒绝、8192-token截断及其旧分类缺陷记录；仅修正通用生成约束和异常分类，没有改测试、评分或评测阈值。
- Phase3时点无BLOCKED；15项逐项验收、源码/编译/配置/Validation hashes与费用unknown说明见Phase3报告，当时仅完成最小单轮闭环。

## Phase 4 最终交付

- 英文README、中文README、真实证据包、可重复生成SVG、中文面试指南、Replay/隔离Live。
- 默认100 passed+4 Docker skipped；全量Docker **104 passed、0失败、0跳过**；build及离线依赖安装通过。
- 仅执行一次真实Live，完整闭环ACCEPT，独立Demo版本H1-b4213cfb66f6；主Manifest字节保持不变。
- 14项验收全部PASS；当前文件无私密路径/实际key，保留旧历史并另提供干净源码ZIP。License未擅自选择，未创建远程或推送。
- 完成Phase4后停止，不扩展其他Harness模块。源码导航和技术权衡见 [面试指南](interview-guide.zh-CN.md)。
