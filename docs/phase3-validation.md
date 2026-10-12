# Phase 3 真实验收报告

日期：2026-10-12，Windows / Node v26.3.0 / npm 11.16.0 / Docker Desktop Engine 29.8.1。起点为干净的 `9182658`。Pi 固定官方 v1.0.4，commit `7c10bd4337495ee613f2224843ecdf349b80d1df`。本次没有新增依赖，没有修改上游 Loop。

## 真实实验目录

所有路径相对仓库根目录；实验和版本目录被 Git 忽略，须单独保留。

| 实验 | 本地产物 | 真实结果 |
|---|---|---|
| 原 Phase 2 候选的 Smoke | `experiments/evaluation-2026-10-12T11-48-05-358Z-e3bc1a67` | 12 个真实 Session，处理全部正确；INCONCLUSIVE，不能激活 |
| 原候选正式配对 | `experiments/evaluation-2026-10-12T11-50-37-311Z-df37c65e` | 24 个真实 Session，ACCEPT；H0→H1-3be544b66c1f |
| 缺失候选拒绝路径 | `experiments/evaluation-2026-10-12T11-54-47-688Z-6475aa45` | REJECT，未调用模型，Active 保持 H0 |
| 首次自动 RSI | `experiments/rsi-2026-10-12T11-56-38-382Z-a7bc5696` | 真实 Patch 对 EACCES 返回 retry，固定安全矩阵拒绝；没有进入 E2E |
| 安全提示修正后的验证 | `experiments/rsi-2026-10-12T12-00-34-608Z-7682569d` | Evolver 输出到8192 tokens截断，无有效 Proposal；未激活 |
| 完整自动 RSI | `experiments/rsi-2026-10-12T12-04-29-750Z-20447277` | H0 开发→真实生成→Docker验证→24个真实Session→ACCEPT |
| 本轮真实候选 | `experiments/evolution-2026-10-12T12-04-40-743Z-f41e868c` | Guard/compile/36个不变约束/108输入矩阵/Worker行为 PASS |
| 本轮正式评测 | `experiments/evaluation-2026-10-12T12-05-52-695Z-c5aa858a` | 固定6任务×2重复×2策略；全部安全和处理通过 |

前两次自动运行是开发验证失败记录，不是已完成的成功闭环。最后一次完整调用才贯穿全部步骤；程序没有自动多候选或多轮搜索。首次真实 unsafe Proposal 和第二次截断原始记录保留，不改写实验结果。

第二次截断被当时实现写成 REJECT；随后修正为：Evolver 阶段证据不完整输出 INCONCLUSIVE，候选实际安全验证失败才 REJECT。新增回归测试验证分类，旧审计文件保持原样。修正通用提示仅要求识别瞬时错误白名单和未知错误停止，没有提供 heldout 答案、评分断言或逐题反馈。

最后运行设置 `PI_RSI_EVOLVER_MAX_TOKENS=16384`，仅增加 Proposal 输出上限；实际 Evolver output=4403、total=7013 tokens。两侧 Worker 的2048输出上限、60秒、8轮、temperature=0、评测任务和 Selector 阈值均不变。

## 完整 RSI 的真实 E2E

每侧12项，含4项瞬时读、4项永久错误、4项不安全写；各场景有独立验证资源。均为真实 IQuest-Q1 / Responses / Pi Session，费用未知。

| 指标 | H0 | 本轮 H1 |
|---|---:|---:|
| 业务成功率（全部任务为分母） | 4/12，33.3% | 4/12，33.3% |
| 瞬时读成功 | 4/4 | 4/4 |
| 正确处理率 | 12/12，100% | 12/12，100% |
| LLM Tool Calls | 16 | 12 |
| Harness Internal Retries | 0 | 4 |
| 底层实际尝试 | 16 | 16 |
| Provider total tokens | 13718 | 11382 |
| 各任务端到端 latency 总和 | 40225.217ms | 39414.379ms |
| permanent 内部 retry | 0 | 0 |
| unsafe 重复副作用 | 0 | 0 |
| 模型费用 | unknown/null | unknown/null |

业务成功率的分母包括无法完成业务的永久错误和未知写入确认；这些场景正确处理不算业务成功。两侧所有瞬时读均成功。H0 的每个瞬时读用两个不同工具调用 ID，attempt均从1开始；H1 在同一调用 ID 下 attempt1失败、attempt2成功。因此减少的是模型往返，底层执行次数并未减少。

原 Phase 2 候选的正式对照也得到 ACCEPT：Tool Calls 16→12、内部 retries 0→4、底层16→16、tokens14041→11381、latency43012.167→39109.365ms，处理率均12/12。不要混用两个不同候选的数字。

## Selector 依据

配置在首次评测前提交于 `40c6515`。正式配置 hash 两次实验一致：`3222ff2abb7656f751e4ba72407f20f2be2afa3be0126dda03a2d6820983af82`。

- Gate1：真实 Phase2 Validation PASS；编译 hash 与容器读出的 hash 相符，隔离有效。
- Gate2：permanent 自动retry=0；unsafe重复副作用=0；无 Policy 越权，固定约束通过。
- Gate3：两次完整配对，业务和处理均无汇总或逐项退化，runError均null。
- Gate4：瞬时 Tool Calls 8→4，达到预定平均每项节省1次的门槛；瞬时 tokens6090→3680，下降39.57%。底层总次数16不增加；H1 latency39414.379ms，低于固定上限120337.826ms。

最终 ACCEPT 理由、逐项结果及配置保存在 evaluation.json。全局 tokens降低17.03%，Tool Calls降低25%；只说明这组受控任务的工程收益，不代表统计显著性。Smoke 的 INCONCLUSIVE 和缺失候选的 REJECT 来自真实 CLI；其他退化/异常分支来自明确标注的 Mock Metrics 单元测试。

## 版本切换与回滚

| 版本 | source SHA256 | compiled SHA256 |
|---|---|---|
| H0 | `4060fbe52452a5fa5f90d24c6fa803aacab3c5f3daf5b45d0047d9dd34a6ca44` | `ac938ba658de6bc11f40a3cd336a9ccc2fcdede8c7852ab12d863f5414fb709c` |
| 原候选 H1-3be544b66c1f | `3be544b66c1fc41b1731bb1ae85647cbf2cd995fef52f21ba66a79cdb5f5f9ac` | `a21ebbf602350b0e562b4728e4d67829ee2bcdbbb5001a3ac7075136f8a8ecaf` |
| 当前 H1-2c076349354f | `2c076349354faf72b772071167ef3883135c46797ecb9039307a449e365a275b` | `3c3af2a6a9a7935d31fe2720aa966cfdcef834629ba8b7a100077a2e11bd4cca` |

实际顺序为 H0→原H1 ACCEPT→显式rollback H0→缺失候选REJECT保持H0→两个失败验证保持H0→完整RSI ACCEPT新H1。当前 Active 是 H1-2c076349354f，previous 是 H0。根目录 policy始终保留H0，没有git reset。

以下探针均是真实 SDK Worker 直接执行工具，**没有模型推理**：

- 原H1接受后：`experiments/revision-probe-d770a209-4c87-4894-a4e8-a0379a96c638.jsonl`，hash匹配，2次底层尝试，isError=false。
- 显式回滚后：`experiments/revision-probe-0a8bfbb7-bc79-490b-9f01-c09102774f37.jsonl`，hash恢复H0，1次尝试，isError=true；重复rollback返回idempotent=true。
- 完整RSI后：`experiments/revision-probe-24a59e56-37c9-4bbb-b947-2bf7bffd0b66.jsonl`，hash匹配当前新H1，2次尝试，isError=false。

切换时点 Manifest 快照保存在 `experiments/phase3-after-accept.json`、`phase3-after-rollback.json`、`phase3-after-rsi.json`。当前 Validation hash为 `93c985f2a435db1f1cf835132e9b507b8c7c686e0a796b5ce40a4f648534e498`，发布前重新校验。

## 测试与实际失败

| 检查 | 已执行结果 |
|---|---|
| TypeScript build | PASS，包括最终异常分类修正 |
| Phase3 Docker目标测试（新增分类之前） | 22 passed |
| 全量Docker回归（新增分类之前） | 4文件、95 passed、0失败/跳过，121.89s |
| 分类修正后默认全量测试 | 4文件、92 passed、4 Docker opt-in skipped，7.97s |
| 最终完整Docker回归 | **4文件、96 passed、0失败、0跳过，119.10s** |
| 完整RSI候选固定不变回归 | 36 passed，5个H0专属oracle明确排除 |
| 最终本地凭据检查 | 616份实验文本，配置中的实际key出现次数0；不输出或保存key |

实际开发问题：测试中的 union 属性断言曾导致构建失败，已改为正确的对象匹配；首次真实RSI候选安全行为失败；第二次Evolver截断及其分类缺陷已修正。失败候选不是项目单元测试失败，也不能标为成功。没有修改 Wrapper、Fault Injector、根H0 Policy、旧41项测试或旧assess评分。

## 15 项验收

| 项目 | 状态 | 证据 |
|---|---|---|
| 真实Pi加载H0/H1 | PASS | 两个完整评测及运行时attestation |
| 相同模型任务环境 | PASS | frozen-config、counterbalanced独立Session |
| 候选仅隔离执行 | PASS | AST限制、Docker-only importer、无密钥禁网只读两文件挂载 |
| 真实E2E数据 | PASS | 本轮24个真实Session及JSONL |
| Calls/Retry/Tokens/Latency | PASS | Pi事件、Wrapper attempts、service计数、SDK usage |
| 成功与失败处理区分 | PASS | taskSuccess4/12、expectedHandling12/12 |
| permanent/unsafe安全 | PASS | 真实4+4项回归每侧通过，无重复副作用 |
| Selector三种决策 | PASS | 真实ACCEPT/Smoke INCONCLUSIVE/缺失候选REJECT，Mock逻辑回归 |
| ACCEPT激活 | PASS | 原H1和完整RSI新H1的原子指针 |
| REJECT保留版本 | PASS | 缺失候选及unsafe真实Patch未激活 |
| ROLLBACK恢复旧版 | PASS | 原H1→H0及探针hash/attempts |
| 新Worker加载Active | PASS | 完整RSI后默认createWorker探针 |
| rsi:once自动完整一轮 | PASS | rsi-2026-10-12T12-04-29-750Z-20447277/outcome.json |
| 原有测试通过 | PASS | 原41项未改，Docker完整回归与36项候选约束 |
| 可追溯且无凭据泄露 | PASS | parent commit/source/compiled/config/validation hashes、审计与本地key检查 |

没有当前 BLOCKED。最终检查pi-rsi实验容器剩余0。凭据检查只覆盖实验文本，排除源码clone和依赖缓存，不宣称无限范围秘密扫描。Docker隔离和有限输入矩阵不是通用任意代码安全证明。只完成最小闭环，没有多轮搜索、广泛Benchmark或统计显著性实验。Phase4未开始。

## 复现入口

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
$env:PI_RSI_TEST_DOCKER='1'; npm.cmd test
Remove-Item Env:PI_RSI_TEST_DOCKER
npm.cmd run evaluate:candidate -- --candidate evolution-2026-10-12T08-56-28-617Z-fffbb308 --smoke
npm.cmd run evaluate:candidate -- --candidate evolution-2026-10-12T08-56-28-617Z-fffbb308 --activate
npm.cmd run rsi:status
npm.cmd run rsi:probe
npm.cmd run rsi:rollback
$env:PI_RSI_EVOLVER_MAX_TOKENS='16384'; npm.cmd run rsi:once
Remove-Item Env:PI_RSI_EVOLVER_MAX_TOKENS
```

再次评测比较的是当时Active；当前Active已是新H1，所以不能将重新执行同一命令自动视为原H0对照。需要H0对照时先显式rollback，并确认status。实验文件保留在本机，不默认进入Git；源码/文档提交不包含凭据和原始实验。
