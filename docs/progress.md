# Phase 0 + Phase 1 验收进度

更新：2026-10-12（Asia/Shanghai）。本阶段实现完成，离线验证与真实 IQuest-Q1 Demo、三任务 Agent E2E 均已验证。首轮失败暴露的注入器缺陷已修复并保留证据。没有开始 Phase 2，也没有宣称完成完整 RSI。

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

当前仍未完成 Evolver、独立候选评估与接受/回滚，也没有正式多轮统计实验。真实 H0 结果与首轮问题见 [live-baseline.md](live-baseline.md)；需要检查 stopReason / runError / actual service state / trace / summary，而不是仅看命令结束。

随后才进入 Phase 2：独立 Pi Evolver 消费失败 trace，生成只涉及 `src/harness/recovery-policy.ts` 的最小 patch；候选工作区必须禁止改 wrapper、fault injector、任务、测试、grader。独立比较 H0/候选的业务成功、模型重发、Harness 重试、永久错误浪费与 unsafe 重复写。通过后才接受，失败则回滚。默认未来最多 3 轮。**这些权限与循环尚未实现，本阶段在此停止。**
