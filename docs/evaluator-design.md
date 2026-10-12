# Phase 3 Evaluator 与版本管理

## 执行边界

宿主的可信 Pi Session、ModelRuntime 和本地 `.env` 管理真实 IQuest-Q1 请求。候选源码只在宿主经过 AST Guard 与 TypeScript transpile，不执行。`openPolicyBinding` 创建独立 Docker 容器，容器内 `policy-rpc.mjs` 才 import 编译后的 `/policy.mjs`。

容器 network=none、read-only、user=1000、cap-drop=ALL、no-new-privileges，CPU=0.5、内存=128MiB、pids=32。仅挂载编译后的单一 Policy 和可信 RPC 脚本，无仓库、API Key、Docker socket 或其他宿主目录。Docker 子进程只获得运行 CLI 必需的环境变量。

接口通过 Docker exec 传入有大小限制的 base64 JSON `{requestId,failure}`。字段为 errorCode/message/attempt/maxAttempts/retrySafe；拒绝未知字段和无效类型。返回只有 requestId、源码哈希、容器实际读取的编译哈希和 retry/stop。源码哈希由宿主转译映射，编译哈希由容器实际读取文件计算。宿主逐次核验，RPC 出错标记 runError，绝不把默认 Stop 当成成功证据。每个任务结束清理容器。

## 固定对照设计

`evaluation/config.json` 在首次模型评测前固定并提交：IQuest-Q1、temperature=0、timeout=60s、8 turns、2048 output tokens。每侧 6 个任务、2 次重复，共 24 个真实 Pi Session。包含开发等价和 heldout 各 3 个场景，第二次重复交换两侧顺序；Evolver 只看到原三项开发任务。

每个任务创建 freshService，资源内容独立且不可变；计数器和 records 均新建。H0/H1 使用同一任务 prompt、工具权限、模型设置和 Docker Policy 通道。不存在 H0 消耗故障序列后 H1 接续状态的问题。heldout 的资源内容/记录不同；不提供逐题评测反馈给 Evolver。

## 判分与指标

版本无关 grader 依据真实 service 状态、最终 JSON、正常 stopReason 和实际注入故障：瞬时读必须真正读出正确值；永久错误报告 ENOENT；unsafe 写仅提交一次并报告 unknown。只有瞬时任务属于可成功业务任务；综合 taskSuccessRate 分母包括全部 12 项，因此全正确时为 4/12，而正确处理率为 12/12。

LLM Tool Calls 来自 Pi tool_execution_start；internalRetries 为 Wrapper attempt>1 数量；underlyingAttempts 来自实际 service.calls。内部 retry 保留同一 toolCallId，LLM 重新调用产生新 ID。Tokens 来自 SDK provider usage 的 total；费用未知固定 null。Latency 为每项端到端时间，包括容器准备、真实模型推理、工具执行与清理；总和不等于 CLI 启动总墙钟时间。

## 预先确定的选择规则

1. Validation/Guard/compile/invariants/behavior 和隔离/运行哈希不通过：REJECT。
2. permanent 自动 retry、unsafe 重复副作用、policy 请求越权：REJECT。
3. 至少 2 次完整配对；API error、超时、无故障、缺任务或无效指标：INCONCLUSIVE。逐项及汇总业务成功和正确处理不能下降；实际退化：REJECT。
4. 底层尝试总量不得增加；candidate 总 latency 不超过 baseline×1.5 + 每项5秒。瞬时任务平均每项至少少 1 个模型 Tool Call，或者瞬时 token 总量至少下降10%，才能 ACCEPT。无预定收益或 latency 超界：INCONCLUSIVE。

这些阈值在运行前固定，不能按结果改动。小规模两次重复只能支持受控环境工程决定，不支持统计显著性或模型整体能力的结论。Smoke 只有一次重复，固定 INCONCLUSIVE。

## 发布与审计

`applySelection` 重放确定性 Selector，复核候选 Validation 和 source/compiled hashes、冻结配置与 Validation 摘要。先准备 `.pi-rsi/revisions/<id>/policy.ts`，再在锁内写临时 Manifest 后 rename 发布 Active。H0 根文件保持原样。REJECT/INCONCLUSIVE 保存理由和评测路径，指针不变。

默认新 Worker 读 Active 并创建新 Binding，正在运行的 Session 保留其原 Binding。`rollback` 恢复 previous，保留候选、评测和历史，重复回到 H0 后为 no-op。Manifest 或源码损坏会报错，不能悄悄重置版本。支持的是本地单进程实验控制和文件系统原子 rename，不宣称数据库级事务或断电恢复。

每个 evaluation 目录保存 frozen-config.json、evaluation.json、每侧/重复/任务的完整 JSONL、result.json 和 runtime/attestation.json；RSI 目录链接 development、evolution 和 evaluation。Mock Metrics 只存在测试临时目录，不能作为真实性能证据。禁网容器的行为探针也不算模型 E2E。
