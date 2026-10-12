# Phase 4 交付验收

## 交付范围

英文/中文README、Replay/隔离Live、真实证据包、数据生成图表、中文面试指南。没有新增RSI算法或Harness进化目标。没有创建远程仓库、推送或擅自添加许可证。

## 真实性与发布边界

- 结果主表固定引用真实Phase3成功轮次，数据从 examples/phase3-demo 的原始复制件读取，不改写为Live的新成绩。
- Replay默认离线读证据包，也支持 `--run experiments/<completed-rsi-run>`；显示REPLAY，源码只读文本，无模型、容器或指针变更。
- Live复用 `rsiOnce(config, namespace)`，Version Manager和Evaluator显式使用该namespace。每次从独立H0开始，主Manifest前后SHA256相同才报告保存成功。它不是通过rollback/reset主版本启动。
- 缺配置/Docker或开发运行不可用时BLOCKED；实际生成可NO_CHANGE、REJECT或INCONCLUSIVE，禁止回退预置候选。
- 提交的证据只有受控公开任务的必要文件，保留原始bytes/relative paths/parent/upstream/source/compiled hashes；原始HTTP和流式trace、大型clone、凭据不提交。
- 未选择项目级License，README明确说明；技术发布材料与许可决策分开。
- 当前67个交付文件的实际key字面值检查为0；旧12个文档提交含历史机器路径，未破坏性重写。最终另生成干净Git archive ZIP用于不携带历史的发布。

## 已执行验证

| 项目 | 真实结果 |
|---|---|
| build | PASS |
| 锁定依赖安装 | `npm ci --ignore-scripts --offline` PASS，171 packages，无新增依赖 |
| 最终默认npm test | 5文件、100 passed、4 Docker opt-in skipped，22.90s |
| 实际demo:replay | PASS；显示完整历史RSI与原始数字 |
| 无凭据、无Docker、无版本存储Replay | PASS，真实子进程测试 |
| Namespace接受/回滚保留主Manifest | PASS，真实文件字节比较；指标为历史数据的单元fixture，不冒充新模型实验 |
| status/rollback离线CLI | PASS，在临时仓库无凭据且PATH无Docker执行，不改变真实主Active |
| Git证据bytes | 7份原始文件暂存blob与provenance SHA256全部一致；.gitattributes防止行尾转换 |
| Live缺配置BLOCKED | PASS，子进程退出2，主Manifest字节不变 |
| Docker全量测试 | 待真实最终记录 |
| Live真实运行 | 待单次验证记录 |
| 文档/图表/敏感数据检查 | 当前67文件、51本地链接，README完整表格与图表匹配，errors=[]；实际key命中0 |

## 14 项交付清单

| 标准 | 状态与证据 |
|---|---|
| GitHub README专业完整 | PASS，README.md的问题、方法、边界与真实数字 |
| 中英文一致 | PASS，同一主表、子集结果、架构与命令 |
| RSI架构图准确 | PASS，rsi-loop.svg及README Mermaid对应调用链 |
| 真实结果图表 | PASS，docs:assets读取校验后的数据；data-value可程序核对 |
| Replay无密钥无Docker | PASS，子进程PATH为空且无.env/版本存储 |
| Replay不冒充Live | PASS，输出明确REPLAY/historical，不写Active |
| Live复用真实RSI | PASS，demo.ts动态调用同一个rsiOnce |
| Live不破坏Active | PASS，namespace接受/回滚和BLOCKED测试验证主Manifest字节不变；真实运行记录待补 |
| 1分钟/3分钟介绍 | PASS，interview-guide.zh-CN.md |
| 准确源码路径 | PASS，函数契约表与锁定Pi源码地图 |
| 清楚的技术问答 | PASS，20问及11项质疑权衡 |
| 原测试和构建 | PASS，默认回归已通过；Docker最终数量待补 |
| 无敏感信息泄露 | 待最终Git候选文件与实际key字面值检查 |
| 未新增多余RSI功能 | PASS，仅显示、证据复制、namespace参数与文档 |

图表由 `npm run docs:assets` 可重复生成SVG；本次还使用已有渲染运行时生成 @2x PNG 并目视检查。PNG是展示副本，SVG及源数据是可复现输入。没有为图表增加项目依赖。
