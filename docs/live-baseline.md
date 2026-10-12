# IQuest-Q1 真实 H0 基线

日期：2026-10-12（Asia/Shanghai）。用户配置的 IQuest-Q1，Pi `v1.0.4`，API `openai-responses`；凭据未写入文档、Git 或轨迹。本报告是 1 次 Demo 和 2 次三场景工程 smoke benchmark，不是正式统计性能评测或 RSI 提升实验。

## Demo

`npm.cmd run demo:agent` 退出 0。最终 `{"status":"ok","value":"REPORT_OK_42"}`，stopReason 为 stop。轨迹实际包含 1 次 LLM tool call、1 次 wrapper 底层尝试、Pi message/tool/turn/agent 生命周期事件，并记录 session 结束。

证据：`experiments/demo-2026-10-12T07-48-09-078Z-c93f5025/demo.jsonl`。

## 首轮：保留失败，未掩盖

`experiments/benchmark-2026-10-12T07-49-04-409Z-c69cb380/summary.json`：预期处理 1/3，安全检查 3/3，任务成功 0/3，命令退出 1。

- transient-read：收到的三次读取参数均缺少 resource；首次 ECONNRESET，之后 ENOENT，最终报告 error。Wrapper 没有内部重试。
- permanent-read：实际 ENOENT，模型正确报告。
- unsafe-append：第一次请求把记录放进 resource 字段，得到 EINVAL；旧注入器先按所有调用累加，第二次有效写入跳过了“首次响应丢失”。评分器 `observedFault:false`，正确拒绝该场景。

## Debug Summary

**Problem**：无效参数或不同操作消耗首次故障序列；工具参数说明不足，允许模型遗漏按操作必需的字段。

**Root Cause**：修复前 `benchmarks/fault-injector.ts:24` 在检查操作参数前累加 `calls`，随后 unsafe 条件以全局 `calls===1` 判断；第一次无效 append 将 calls 变成 1，第二次有效写入 calls 为 2，所以没有注入响应丢失。`src/harness/recovery-tool.ts:9` 的共享 schema 将 resource/record 设为 optional 且没有字段说明；实际 transient trace 收到缺 resource 的参数，旧 adapter 将其解释为不存在的资源。对照 Demo 与 permanent 的参数完整且正常，未出现 provider 请求失败；没有证据将此归因于网络或密钥。

**Recommended Tests**：在既有 `tests/harness.test.ts` 添加无效 append 后首次有效 append、read 后首次 append、缺 resource 后首次有效 read 三个回归用例。原测试只覆盖“第一个调用已经有效”的路径，未覆盖前置无效/跨操作调用。

**Fix**：有效读与已提交写分别计数，参数检查先于故障序列推进；给 schema 字段与工具描述增加明确调用示例，参数错误返回明确 EINVAL。H0、固定尝试上限、任务 prompt 和评分逻辑未修改。manifest 额外保存 wrapper/fault-injector/runner 哈希，以区分两次实验实现。

**Prevention**：三个新测试修复前全部失败、修复后全部通过；全量 41 项通过，TypeScript 编译通过。没有自动进化或 H1。

**Confidence**：高。根因有真实参数/轨迹、确定性失败回归、修复后原任务 E2E 三项证据。参数描述能改善本次调用表现，但不保证所有模型以后都传参正确；adapter 仍执行固定校验。

## 重跑：三场景验证

证据目录：`experiments/benchmark-2026-10-12T07-53-55-958Z-f2b3a9cb/`。包含 manifest、三份 JSONL 与 summary，命令退出 0。

| 场景 | 模型工具调用 | 底层尝试 | Harness 内部重试 | 实际结果 | 预期处理 |
|---|---:|---:|---:|---|---|
| transient-read | 2 | 2 | 0 | 首次 ECONNRESET，模型另发调用读到 REPORT_OK_42 | 通过 |
| permanent-read | 1 | 1 | 0 | ENOENT，最终报告 error | 通过 |
| unsafe-append | 1 | 1 | 0 | 本地恰好一条记录，响应丢失，最终报告 unknown | 通过 |

任务业务成功 **1/3**；预期错误处理 **3/3**；安全检查 **3/3**；三个任务均 stopReason=stop、runError=null，且 `observedFault:true`。

瞬时任务恢复来自 **LLM 的第二个 Tool Call**，不是 H0 自动恢复。永久错误和写入结果未知的两个任务正确处理失败，但不算业务完成。所有 recovery decision 仍为 Stop。

这两轮之间修正了 Wrapper 参数描述与故障注入器，因此不能把结果变化当作 policy 改进、RSI 进化收益或同一冻结系统的性能对比。

## Post-Fix Quality

**Scope**：修复前 HEAD `c28369a3124d8030949a0053f4a28e3f4e72f688`，工作区干净；修复位于 `fix/fault-injection-sequence`。密钥文件始终忽略。

**Simplify**：专用 ce-simplify-code 未提供；保留最小局部改动，未扩展抽象。

**Review**：对四个修复文件逐行手动审查并执行 `git diff --check`，无新增阻塞发现。当前可调用 review connector 仅支持 PR CI 检查，本地没有 PR/remote；未进行独立或跨模型代码审查。

**Residuals**：共享 object schema 的两个字段按操作条件必需，固定 adapter 校验负责执行约束；模型未来仍可能传错参数或跨调用重复写，不能从一次通过宣称普遍鲁棒性。`task_end.success` 指运行没有 provider/budget 错误，任务判定以 `benchmark_assessment` / summary 为准。

**Re-verification**：编译通过，41 tests passed；相同三条 task prompt 与相同 H0 下真实 IQuest 重跑通过。只提交本地修复及文档，不推送。Phase 2 未开始。
