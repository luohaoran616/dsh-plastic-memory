# 文档轨接线设计：把 doc_write 这条线接进 plastic 源码

设计日期 2026-11-24。状态：待审定。前置：`crystallization-lane.md`（2026-11-24 修订版，写入分流模型）。本文是源码级接线方案，所有锚点基于本仓 `dsh-ours` 分支（v0.2.0 基线，HEAD 48adf42）实测核对。

## 一、源码事实盘点（接线前提）

塑料的工具面是「框架绑定与纯逻辑分离」模式：每个工具一对文件（如 `src/tools/save-tool.ts` 用 `defineTool` 注册 schema 与 render、`src/tools/save.ts` 是不依赖框架包的纯逻辑，测试直接测后者）。依赖经 `SaveToolDeps` 注入（store、registry、host 适配器、snapshots、decisions、onSaved 回调，`src/tools/save.ts:28-41`），会话上下文由宿主适配器 `saveContextOf` 提供 `workspacePath` 与 `session.id + turnStartSeq`（`src/tools/save.ts:13-22`）——**workspacePath 正是文档轨定位的钥匙**。

装配面在 `src/index.ts:278-313`：写工具统一经 `registerWrite` 包装（自动套子代理门与视图刷新），其中 `memory_promote` 已经是「写 AGENTS.md」的现成先例——`createPromoteTool({ store, agentsMd, snapshots, host, defaultTarget })`，`agentsMd = createAgentsMdWriter(agentsMdPath())` 在 `index.ts:278` 创建，治理工具随 `syncGovernanceTools()` 开关动态装卸（`index.ts:330-354`）。注入面不是逐提示词召回而是「快照消息」：`agent/pre-step` 监听（`index.ts:548`，prepend）经 `snapshotMessage` 组装快照文本，与上一份逐字相同就不发（KV 缓存不动，`src/snapshot-message.ts:44-47` 的 `shouldSendSnapshot`），同源快照带取代语义（`SNAPSHOT_SUPERSEDE_NOTE`）。体检的指令基线读取在 `src/governance/instructions.ts`，`ReadInstructions` 返回的 `found` 形状是 `texts: readonly string[]`——**本来就是多段数组**。跨工作区门（`src/tools/workspace-gate.ts`）、密钥检测（`src/secrets.ts` 的 `detectSecrets`）、全局确认码（`confirmGlobal` 参数模式）都是可直接复用的门。

## 二、接线方案（按部件）

### 2.1 托管区块写入器泛化（新文件 `src/storage/doc-blocks.ts`）

现有 `agents-md.ts` 写死 `~/.dsh/AGENTS.md` 且是行级幂等。新写 `createDocBlockWriter(filePath, blockId)`：区块标记用 `<!-- dsh-doc:{blockId}:start/end -->`（与既有 `dsh-memory` 标记族同形），幂等按**条目 id**（每条带 `<!-- id: xxx -->` 注释锚）而非整行相等。写入器职责与 agents-md 完全同构：净化长得像边界标记的内容、区块外用户内容一字不碰、读改写整段串行。锁的差异：仓内文件不在 `memoryRoot` 下，`rootLock` 管不到——用 `WriteSection` 直接做进程内串行（`agents-md.ts` 的缺省路径就是它），仓文件不该有第二写者进程。目标文件三个：`STATUS.md` 沿用现有惯例（blockId `status`）、`LEDGER.md`（blockId `ledger`，条目带标题段与来源注记）、`MAP.md`（blockId `map`，模块段落结构）。文件不存在则在 `.agents/memory/` 下创建（目录权限照 AGENTS.md 的创建惯例）。

### 2.2 doc_write 工具（新文件对 `src/tools/doc-write.ts` + `doc-write-tool.ts`）

纯逻辑层签名照 save 模式：`executeDocWrite(args, exec, deps: DocWriteDeps)`。参数面（对齐 save-tool 的参数 DSL）：`target`（status、ledger、map 三枚举）、`action`（append、update、remove——update 按 id 定位条目整条替换）、`id`（update 与 remove 必填）、`title`、`body`、`sourceMode`（复用五枚举，决定条目上的来源标注）、`why`（ledger 必填：这条决策为什么这么定，对齐证据包格式）。

纯逻辑层按序跑五道门，全部复用现有件：第一道定位门，`deps.host.saveContextOf` 拿 `workspacePath`，无工作目录的会话直接返回引导文案（文档轨不存在全局目标）；git root 校验——目标 `.agents/memory/` 必须位于从 `workspacePath` 向上最近的 git root 之下，判定抄 project-memory 轨的 `isGitRoot` 攀爬（`dsh-overlays/project-memory/packages/project-memory/src/index.ts:77-93` 的 `readStatus` 攀爬含 git root 止步语义，抽成共享函数），防止把文件写到仓外任意路径。第二道密钥门，`detectSecrets` 套在 body 与 why 上，命中即拒（文档是明文仓文件，密钥面比库内更硬）。第三道子代理门，`registerWrite` 自带的 subagent-gate 天然继承，初版直接拒绝子代理调用（直写仓文件绕过待确认机制的风险不可接受，返回引导让主会话代写）。第四道结构门，STATUS 的 append 校验行数预算（对齐 ai-memory 的六十行硬限，超限返回「压缩下推」引导）。第五道写入门，`docBlockWriter.append` 落盘。

框架绑定层 `createDocWriteTool(deps)`：`defineTool` 注册，description 写清分流规则（「项目级持久知识走本工具直写仓内文档，散粒事实走 memory_save」——这是分流主通道的引导面，措辞对齐 `SUBAGENT_RULES` 的条件段惯例）。渲染层复用 `toToolOutput`，成功返回照 save 的 `QUIET_NOTE` 风格。注册挂点：`index.ts:310` 附近（forget 与 snapshot 之间），经 `registerWrite`，不随治理开关联动（常驻，分流是主通道不是治理功能）。

### 2.3 影子指针：零新增注入代码

这是本次源码分析最重要的发现。塑料的注入面是快照消息：索引行（`src/index-line.ts` 渲染 MEMORY.md 目录）本来就进快照文本，条目的 name 加 summary 天然就是两行指针。因此结晶产出的影子条目只要是一条正常 `reference` 型 record（content 一行摘要加文档路径加组 id，`recall` 档位 `search`），**注入、检索、索引、快照缓存全部自动工作，零新增注入代码**。唯一的增量是 `index-line.ts` 给影子条目加一行「文档：<路径>」尾注（按 content 里的路径模式判定），让模型知道 Tier-2 全文去哪读。读取全文走宿主 fs 工具（已有），不新增工具。

### 2.4 结晶兜底执行器（新目录 `src/crystallize/`）

`crystallize.ts` 纯逻辑（聚组、合成调度、影子写入、原条目 supersede、收据），`runCrystallize` 输入 memoryIds 加目标 workspace，输出对齐 `PipelineResult` 的结果形状。聚组用 `related` 边连通分量（`MemoryStore` 已有图的读取面）。合成调用复用治理的 LLM 通道（`src/governance/host-llm.ts` 是现成的宿主 LLM 调用面，体检建议生成已经在用它）——不新增模型路由，配置随治理的 LLM 键族。崩溃对账：收据落 `.state/crystallization/`（复用 `state-files.ts` 的状态文件基建），启动时对账未完成组。

兜底触发挂两处：体检建议的 `suggestedAction` 枚举加 `crystallize`（`src/governance/semantic-scan.ts` 的输出 schema 与 `decisions.ts` 的 `PendingKind` 各加一个值，账本、去重、基线指纹机制全部自动继承）；到期处置在 `rule-scan` 的过期建议链加结晶分支（project 类到期时若带 related 边则建议结晶而非过期）。显式工具 `memory_crystallize` 照 `snapshot-tool` 的形态注册（写工具，经 `registerWrite`）。

### 2.5 体检基线扩展（改 `src/governance/instructions.ts`）

最小改动：`found` 的 `texts` 数组在组装时追加 `.agents/memory/` 三文件的现读内容（经 2.1 的读取面）。做法是包一层 `createExtendedInstructionReader(base, scopeMemoryDirOf)`——不改现有函数签名，`index.ts:228` 的装配处换成包装版。文档不存在时行为等同现状（三文件缺席不产生段）。指纹与漂移检测机制自动生效：基线指纹变化、影子条目对不上区块，都会走现有 pending 账本。

## 三、新增文件与改动清单

新增六个纯逻辑文件加对应 spec：`storage/doc-blocks.ts`（区块写入器与安全测试：边界注入、区块外不动、幂等、崩溃对账）、`tools/doc-write.ts` 加 `doc-write-tool.ts`（分流五道门的测试）、`crystallize/crystallize.ts`（聚组、影子、supersede、收据的测试）、`crystallize` 的工具绑定并入 `tools/`。改动四个现有文件各一小处：`index.ts` 注册两工具加装配（约加二十行）、`instructions.ts` 加包装读取器、`decisions.ts` 与 `semantic-scan.ts` 各加一个枚举值、`index-line.ts` 影子尾注。全部改动面避开 `pipeline.ts` 与检索热路径，符合「新文件优先、热路径薄封装」的 merge 纪律。

## 四、实施顺序（对齐 master-plan 阶段 A）

第一步 doc-blocks 加测试（区块安全是整个文档轨的地基）；第二步 doc-write 工具对加注册，在 3086 实测「任务中直接写一条 LEDGER 决策零条目产生」；第三步影子条目加尾注（结晶的输出面先行，可手动造影子条目验证注入）；第四步 crystallize 执行器加体检触发；第五步 instructions 包装。每步独立可验收，4904 测试基线不得红。
