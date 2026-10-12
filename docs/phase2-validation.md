# Phase 2 验收：真实 IQuest-Q1 Evolver

日期：2026-10-12（Asia/Shanghai）。Pi v1.0.4，上游 commit 保持锁定。原 Phase 1 parent 为 0b59a34；本次真实候选 parent 为 b09d962d5d008411c113f941c842b27da273da5d，H0 策略和原测试未被修改。

## 真实生成案例

输入是 `experiments/benchmark-2026-10-12T07-53-55-958Z-f2b3a9cb`：瞬时读取第一次 ECONNRESET，H0 Stop，模型用另一个 toolCallId 重新读取后成功；永久 ENOENT 正确停止；非幂等 append 已提交后响应丢失，正确报告 unknown。

Evolver 引用 transient-read#25/#26/#55、permanent-read#25、unsafe-append#49，判断主要问题是成功任务依赖额外模型交互。假设：仅对 retrySafe、预算未耗尽、已知瞬时错误返回 retry，避免模型重新驱动读取；永久和 unsafe 保持 Stop。

真实输出不是预置 H1，保存于：

`experiments/evolution-2026-10-12T08-56-28-617Z-fffbb308/proposal.json`

实际 Diff：

```diff
-export function decideRecovery(_failure: ToolFailure): RecoveryDecision {
-  return { action: 'stop' };
+export function decideRecovery(failure: ToolFailure): RecoveryDecision {
+  if (!failure.retrySafe || failure.attempt >= failure.maxAttempts || !['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAGAIN'].includes(failure.errorCode)) {
+    return { action: 'stop' };
+  }
+  return { action: 'retry' };
 }
```

ECONNRESET 来自实际轨迹；模型列出的其余代码是泛化假设，不代表实际服务已测试过这些故障。行为矩阵验证 ECONNRESET/ETIMEDOUT、永久错误、安全标志与尝试预算；WorkspaceService 集成故障为 ECONNRESET。没有正式性能比较。

## 验证证据

同目录 validation.json：status、staticGuard、compilation、containerCompilation、invariantTests、behavior 均 PASS，baselineUnchanged=true。

- candidate source hash：`3be544b66c1fc41b1731bb1ae85647cbf2cd995fef52f21ba66a79cdb5f5f9ac`。
- compiled policy hash：`a21ebbf602350b0e562b4728e4d67829ee2bcdbbb5001a3ac7075136f8a8ecaf`。
- 固定 Docker image ID：`sha256:f554b6163d07b6cef959d42161b1ccf98b2ba9030f28b156b017b2d442ff6d31`。
- Host tsc noEmit 与容器重新编译均通过，实际 Git Diff 只有 policy 文件。
- 容器执行两个原测试文件：36 passed、5 skipped；5 项是专属 H0 Stop oracle，不改它们的断言。
- 策略函数矩阵 108 个输入验证输出合法、unsafe/permanent/budget Stop，并记录 6 个相对 H0 的变化输入。

生产 `createWorker` 在容器构造三个新的真实 Pi Session，自然导入候选的 compiled wrapper/policy；直接调用注册工具，未调用模型：

| 场景 | 底层执行 | 结果 | 实际加载证据 |
|---|---:|---|---|
| transient | 2 | 成功 | 同一 candidate-call-transient：attempt 1、2 |
| permanent | 1 | isError=true | 一次尝试后停止 |
| unsafe | 1 | isError=true，恰好一条记录 | 未自动重复写 |

这证明生成代码已改变 Recovery 执行行为，不只是生成 Diff。候选动态阶段禁网且无密钥；真实 IQuest 调用发生在 Evolver 生成阶段。

## 模型调用与失败记录

成功运行只使用 1 条 assistant message，无格式修复。Provider 报告 input=40、cacheRead=2544、output=2897，total=5481 tokens；目录模型价格未配置，所以 reportedCatalogCost=0 不能当作免费调用，真实账单费用 unknown/null。

首轮 `experiments/evolution-2026-10-12T08-50-02-403Z-f3cc956b` 在 2048 输出 tokens 截断，stopReason=length，没有应用 patch；失败 trace 和 usage 保留。修正了 Evolver 独立输出预算后重新运行，非自动多轮进化，也没有伪造 Proposal。

## 测试分类

- 最初 Baseline 原 41 项：全部通过。
- 默认全量：70 passed、3 skipped；新增 29 项纯离线测试，三个容器 fixture 默认 opt-in。
- opt-in 的 evolution.test.ts：32 passed，含 29 项重复的纯测试和 3 项动态容器测试。合成合规 fixture 通过；unsafe-only fixture 在 36 项固定回归通过后被函数安全矩阵拒绝；类型不兼容 fixture 在编译阶段拒绝。合成 Proposal 从未被称为真实模型生成。
- 最后全量 opt-in 测试：**3 文件，73 passed，0 failed，0 skipped**，duration 129.36s；包括原 41 项和全部 32 项新增测试。没有将重跑的测试数量相加。

## Acceptance Criteria

| 验收项 | 状态 | 证据 |
|---|---|---|
| 真实 Pi Evolver AgentSession | PASS | 成功真实调用、evolver.jsonl、usage.json |
| 读取真实 H0 轨迹 | PASS | observation.json 对应三个实际 trace/hash |
| 分析 Failure 与 Inefficiency | PASS | proposal 引用失败、模型重发、永久与 unsafe 事实 |
| 结构化 Proposal | PASS | 严格 schema 与引用检查；支持 NO_CHANGE |
| 非预置源码修改 | PASS | 真实 IQuest response-0.json → proposal → candidate.patch |
| 唯一 policy 修改范围 | PASS | literal whitelist、AST、候选 git diff 单文件 |
| Baseline 不被候选修改 | PASS | baselineUnchanged=true、原策略仍 Stop |
| Guard 拒绝非法变更 | PASS | 路径、接口、import/global/call/loop/赋值等测试 |
| 合法候选编译和测试 | PASS | 两层编译、36 项不变约束；5 项 H0 oracle 仅作 Baseline 检查 |
| 候选实际改变工具恢复 | PASS | 108 输入矩阵和新 Worker 同调用 attempt 1/2 |
| 产物与失败诊断保留 | PASS | 审计目录、失败运行、合成 unsafe/type 记录 |
| 原 41 项测试继续通过 | PASS | 默认全量 70 中完整包含原 41 |
| 不接受或合并候选 | PASS | 当前 policy 仍 H0，候选只在独立 clone |
| 不实现多轮 RSI | PASS | evolveOnce 没有候选搜索/接受/多轮循环 |

## 限制与 Phase 3

AST 只允许一个很小的 TypeScript 子集，会保守拒绝一些无害实现；行为矩阵是有限输入测试，不是完整语义证明。Wrapper 的 retrySafe 与 attempt 上限始终是固定安全边界。候选 Worker 验证没有进行模型推理，不是候选的 Agent E2E 性能评测。

镜像构建需要网络与 Docker；动态阶段禁网。构建或引擎不可用时 BLOCKED，不执行候选后备。源码副本和实验审计目录保留，本次执行容器已清理。未配置正式价格数据、真实费用核算、接受/回滚或候选统计比较。

Phase 3 从 PASS 的 validation.json、parent commit、policy/compiled hash 和 candidate.patch 接入独立 Evaluator，冻结任务/模型/版本并比较业务成功、额外 LLM 调用与副作用，之后才实现 Accept/Rollback。本阶段停止于此。
