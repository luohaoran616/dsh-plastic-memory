# 文档轨与结晶车道设计 v2（2026-11-24）

状态：已被同目录 2026-11-25-doc-track-lane-v3.md 取代，留作修订记录。

原状态：待审定。本版合并并取代此前三份设计稿（crystallization-lane、master-plan 的车道部分、doc-track-wiring 的接线部分），主要修正：文档轨从三个文件恢复为六个文件加完整层间协议，ai-memory 的预算下推、渐进加载触发语义、寻址与搜索分道全部继承，被 DSH 已有机制接走的层写明归属而不是砍掉。接线锚点全部在本仓 `dsh-ours` 分支（v0.2.0，HEAD 48adf42）实测核对。

## 一、问题与容器总览

条目记忆承载不了项目知识：本机 memory-basic 九百八十八条里三成被截断、高频条目八成半从未展开；理解鸿沟调研的实验结论证明纯对话协作最丢失的是关系型理解；DBchain 的 AGENTS.md 停在 11-07 与九十六个提交脱节。主架构是写入分流：结构知识在产生那一刻直写仓内文档轨（零条目中间态），散粒事实走条目库，漏网的由体检结晶兜底。

文档轨六文件在 `<git-root>/.agents/memory/` 下，每层有独立的读取触发语义与预算，层间有下推协议。这是 ai-memory（用户 2026-08 给 pi agent 自建的分层记忆系统，`~/.pi/agent/skills/ai-memory`）渐进加载表的继承与裁剪，裁剪掉的层写明被谁接走。

| 文件 | 职责 | 读取触发 | 预算 | 超预算下推 |
|---|---|---|---|---|
| STATUS.md | 现状快照（目标、下一步） | 读轨每会话注入 | 60 行 | 任务线下沉 LEDGER，过期删除 |
| CONTEXT.md | 稳定事实（环境、约束、栈、外部依赖） | 「这项目用什么、受什么限」时 | 150 行 | 关系型事实移 MAP，命令移 RUNBOOK |
| RUNBOOK.md | 命令速查与排障步骤 | 跑命令、排障时 | 紧凑 | 持久内容按主题拆 RUNBOOK/ 子目录 |
| MAP.md | 叙事地图（模块职责加关系加为什么改） | 理架构、跨模块改动时 | 焦点模块上限 8，非焦点收一句 | 无焦点模块详情移 CONTEXT 事实 |
| LEDGER.md | 决策与教训账（结晶主目标，证据包格式） | 决策追溯、接手任务时 | 无上限 | 以新代旧（条目替换，旧的进归档区块） |
| POSTMORTEM.md | 事故复盘（根因、教训、防再犯） | 同类问题再出现时 | 按事故一节 | 无（教训不衰减） |

ai-memory 层表中其余层在 DSH 场景的归属：DIGEST 的压缩桥职能由塑料快照注入面（全库索引即 digest）与 meow 移植件（压缩后重注入任务线三块）瓜分；daily 的会话日志职能由 DSH 会话轨承担（pi 当年没有会话检索才用文件记）；reviews 的晋升评审由塑料体检治理承担；external 网页冻结由 knowledge-vault 承接。六个文件全是寻址层（确定性路径直取），搜索层归塑料（影子指针与 BM25F 检索）——寻址与搜索分道是 ai-memory 的原始纪律，原样继承。读取侧引导不新建：用户级 project-memory 技能已有渐进加载表与 AGENTS.md 纪律，六文件对齐该约定。

托管区块安全模型：每文件一个区块（`<!-- dsh-doc:{target}:start/end -->`），区块外用户手写内容一字不碰，写入文本净化边界标记。STATUS.md 与 project-memory 技能手写并存靠区块隔离。

## 二、写入分流

主通道是 `doc_write` 直写工具，模型在任务过程中按知识形态当场选择容器。参数面：`target`（六枚举）、`action`（append、update、remove）、`id`（update 与 remove 必填，条目注释锚）、`title`、`body`、`sourceMode`（复用塑料五枚举）、`why`（LEDGER 必填——这条决策为什么这么定，证据包格式；POSTMORTEM 必填——根因与防再犯）。

纯逻辑层五道门全部复用塑料现有件：定位门（`host.saveContextOf` 拿 workspacePath，git root 校验抄 project-memory 轨的攀爬逻辑，防仓外写入）；密钥门（`detectSecrets`，文档是明文仓文件，比库内更硬）；子代理门（`registerWrite` 自动继承，初版拒绝——直写仓文件不能绕过待确认机制）；预算门（各文件预算表，超限不硬拒、返回下推进哪层的引导，与塑料写入哲学一致）；写入门（区块写入器落盘）。

条目入口（`memory_save`）保持只收散粒事实（偏好、踩坑、悬案、跨项目教训）。兜底闭环：条目入口跑状态特征检测，命中不阻断但落一条结晶建议进待决账本；历史积压（迁移来的蒸馏类条目）走体检清理。

STATUS.md 与塑料的关系收缩为体检基线对账一条：完全不进库，快照由 doc_write 直写或会话 wrapup 更新，project-memory 读轨照旧注入，腐败检测靠 git diff 与读轨摘要变化。

## 三、结晶兜底

结晶通道退居兜底，处理模型路由漏网与历史积压。触发三个来源共用执行器：体检到期处置（project 类七天到期，带 related 边的簇默认建议结晶）、批量超限（workspace 条数越阈值产生待决提醒）、显式工具 `memory_crystallize`（memoryIds 加目标 workspace）。三个入口全进待决账本走人工裁决，自动化档位与体检治理同口径。

执行器阶段顺序照 dsh-mind 样板（先落盘原文、再零模型模板、最后才调模型），每步落盘可断点续跑：本地聚组（related 边连通分量，单组上限八条）→ 合成（复用治理的 `host-llm.ts` 通道走 cheap 池，一次调用产出 LEDGER 条目，schema 门严格校验，失败重试一次后整组放弃并落账可见，单次运行四次调用上限）→ 写入托管区块（receipt-first：先在 `.state/crystallization/` 落意图收据，写入成功补完成回执，启动对账）→ 换影子。

影子条目是本设计最省的部分：一条正常 reference 型 record（content 一行摘要加文档路径加组 id，recall 档 search、locked 防治理误伤），塑料的快照注入（`snapshot-message.ts` 的逐字比对与取代语义）、索引行渲染、MEMORY.md 目录、检索全部自动工作，零新增注入代码。唯一增量是 `index-line.ts` 给影子条目加「文档：<路径>」尾注。原条目批量 supersede（带指向文档的注记）。

## 四、源码接线锚点

工具模式：框架绑定与纯逻辑分离（`tools/save-tool.ts` 加 `tools/save.ts` 对），依赖注入照 `SaveToolDeps`（store、registry、host、snapshots、decisions）。装配面 `src/index.ts:278-313`：`registerWrite` 包装写工具（自动套子代理门与视图刷新），doc_write 注册在 forget 与 snapshot 之间常驻（分流是主通道不是治理功能）；`memory_crystallize` 照 `snapshot-tool` 形态注册。`promote` 工具（`index.ts:347`）是写 AGENTS.md 的现成先例，`agentsMd` 写入器（`index.ts:278` 创建）泛化为 `storage/doc-blocks.ts` 的多目标区块写入器（条级幂等按 id 锚，仓文件用 WriteSection 进程内串行，不走 rootLock）。

体检基线扩展是最小改动：`governance/instructions.ts` 的 `found.texts` 本来是多段数组，包一层 `createExtendedInstructionReader` 追加六文件现读，指纹与漂移检测自动继承。结晶建议挂两处：`semantic-scan.ts` 输出 schema 与 `decisions.ts` 的 PendingKind 各加 crystallize 值。

新增六个纯逻辑文件带 spec（doc-blocks、doc-write 对、crystallize 执行器、收据），改动四处现有文件各一小处（index.ts 注册约二十行、instructions.ts 包装、两处枚举值、index-line 尾注）。全部避开 pipeline 与检索热路径，merge 上游冲突面近零。

## 五、实施顺序

第一步 doc-blocks 加区块安全测试（边界注入、区块外不动、幂等、崩溃对账）——整个文档轨的地基。第二步 doc_write 工具对加注册，3086 实测「任务中直写一条 LEDGER 决策零条目产生」，六 target 逐个验收（STATUS 预算下推、POSTMORTEM 分节）。第三步影子条目加尾注（手动造影子验证注入与快照缓存）。第四步 crystallize 执行器加体检触发与收据对账。第五步 instructions 包装。每步独立可验收，4904 测试基线不得红。验收总口径：结晶后该 workspace 的检索面条目数下降、影子可检索、LEDGER 区块带来源、kill 续跑幂等。
