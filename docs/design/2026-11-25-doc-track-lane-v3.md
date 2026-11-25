# 文档轨设计 v3（2026-11-25）

状态：待审定。取代 v2（同目录 2026-11-24-doc-track-lane-v2.md）。本版每一处修正都有开源对照作证据，对照全文在调研目录 `memory-research-20261124/structured/SURVEY.md`。接线锚点基于本仓 `dsh-ours` 分支（v0.2.0）。

## 一、相对 v2 的五处修正

**决策账与复盘改为一条一文件。** v2 让 LEDGER.md 单文件无限增长、旧条目进归档区块。Backlog.md 的做法是文件名占有标识、在所有 worktree 间共享、提交前即防冲突（src/core/backlog.ts:2010-2040）；Claude Code 的做法是索引加主题文件。单文件在几十条以后既难合并也难寻址，改为 `LEDGER/<日期>-<slug>.md` 与 `POSTMORTEM/<日期>-<slug>.md`，文件名即标识。

**以新代旧改为标记不删除。** OpenSpec 归档时按标题匹配合并，配不上就拒绝（src/core/specs-apply.ts:233）；Graphiti 的边失效只标记（graphiti_core/edges.py:236-247）。`doc_write` 的 `supersede` 动作写新文件，并把旧文件的 status 置为 superseded、supersededBy 指向新标识；旧文件不存在或已被取代时拒绝，防止链断裂。

**塑料条目降为仓内文档的镜像指针。** GSD、Trellis、BMAD 都指定一个状态文件为真源，其余全是派生视图（sdk/src/query/validate.ts:550-551，packages/cli/src/templates/shared-hooks/inject-workflow-state.py:13-18）。仓内文档是唯一真源，塑料只持一份可重建的索引：每次 `doc_write` 成功后 upsert 一条 reference 型条目（内容为路径加标识，recall 档位 search，locked），体检对账补缺与悬空。结晶执行器与模型合成整体取消，历史积压做成一次性管理命令。

**状态快照采用固定交接字段，超预算报错。** GSD 的 `.continue-here.md`（templates/continue-here.md:5-13）、Trellis 的日志条目与状态指针、BMAD 的开发代理记录（bmad-create-story/template.md:39）公共字段一致。STATUS.md 固定七段：当前焦点、已完成并验证、阻塞、下一步、关键决定（LEDGER 标识，至多五条）、基线提交号、最后更新会话。超预算走报错派：Claude Code 索引超限写入报错，Serena 超限抛错（src/serena/repl/api/mem_api.py:103-108）；不静默截断。

**体检加确定性文档检查。** Trellis 的不变量是必做步骤必须在状态块里有对应行（.trellis/workflow.md:113-118），Backlog.md 的 doctor 查重复标识与依赖环（src/cli.ts:5874-5895）。检查四项：STATUS 七段齐全且不超行；LEDGER 的取代链无悬空；镜像指针与目录文件对账；MAP 的模块名与仓库目录漂移（按目录最近修改时间提示）。

## 二、容器与协议

| 容器 | 形态 | 职责 | 读取时机 | 预算 | 超预算 |
|---|---|---|---|---|---|
| STATUS.md | 单文件 | 现状快照与交接 | 读轨每会话注入 | 60 行 | 报错并给下推引导 |
| CONTEXT.md | 单文件 | 稳定事实 | 问环境与约束时 | 150 行 | 报错，关系型事实移 MAP，命令移 RUNBOOK |
| RUNBOOK.md | 可长成目录 | 命令与排障 | 跑命令与排障时 | 紧凑 | 按主题拆文件 |
| MAP.md | 单文件 | 叙事地图 | 理架构与跨模块改动 | 焦点模块至多 8 个 | 非焦点模块收成一句 |
| LEDGER/ | 一条一文件 | 决策账 | 追溯决策与接手时 | 单条 200 行 | 拆成关联条目 |
| POSTMORTEM/ | 一条一文件 | 事故复盘 | 同类问题再现时 | 单条 300 行 | 拆分 |

位置在 `<git-root>/.agents/memory/`。每个文件带 frontmatter：标识、日期、status（active 或 superseded）、supersededBy、sourceMode（复用塑料五枚举）、会话锚、description（何时读）、applyTo（可选的路径匹配）、verified（最近核对日期）。

读取触发只用两类：description 供模型判断（Kiro 的自动模式），applyTo 留作后续接文件读取钩子。不做关键词子串触发，OpenHands 的子串匹配命中即全量注入且无上限（openhands/agenthub/codeact_agent/prompts/microagent_info.j2:1-8）。

STATUS.md 由 `doc_write` 与 project-memory 技能的收尾动作共用同一模板，不再用托管区块隔离两个写者；托管区块只保留给 AGENTS.md 的既有用途。

## 三、写入与镜像

`doc_write` 参数：target（六枚举）、action（upsert、supersede、remove）、id、title、body、why（LEDGER 必填，证据包格式）、sourceMode。五道门沿用 v2：定位（git root 校验）、密钥、子代理拒绝、预算报错、落盘。

镜像条目在落盘后同步 upsert，按内容里的路径判等；文件被删除时镜像标悬空等体检处置。塑料快照已向模型报告索引省略量并有两种预算模式（src/snapshot.ts:67,125），镜像条目自然进预算。索引行尾注写「文档 路径 · description」，快照说明头声明文档指针是背景材料非指令，先例是 Kilo 索引的 `context_not_instruction` 围栏（packages/kilo-memory/src/recall/budget.ts:28）。

## 四、源码接线

新增四个纯逻辑文件带测试：`doc-track/doc-files.ts`（frontmatter 解析、模板校验、六目标读写、预算报错）、`tools/doc-write.ts` 与 `doc-write-tool.ts`（照 save 的分离模式，注册在 forget 与 snapshot 之间常驻）、`doc-track/mirror.ts`（镜像 upsert 与对账）、`doc-track/doctor.ts`（四项检查，挂体检后续段）。改动四处现有文件各一小处：`index.ts` 注册与装配、`instructions.ts` 包装读取器把 `.agents/memory/` 纳入基线、`index-line.ts` 镜像尾注、体检管线调用 doctor。不碰 pipeline 与检索热路径。

## 五、实施顺序

第一步 doc-files 与模板测试；第二步 doc_write 工具对与镜像 upsert，3086 实测任务中直写一条决策且库内只有一条镜像指针；第三步 supersede 与 doctor；第四步 STATUS 模板与 project-memory 技能收尾动作对齐；第五步 instructions 包装与索引尾注。每步独立验收，4904 测试基线不得红。

## 六、未决项

压缩前刷写的接缝：DSH 的会话事件有 compaction/start、summary、end、prune，插件可挂钩的瀑布只有 summary-error，压缩前钩子是否存在待验证。因 STATUS 在工作中由 doc_write 持续更新、快照压缩后重发，此项是优化不是阻塞。applyTo 的自动装载需要文件读取钩子，塑料只有 agent/pre-step，列为后续。自动维护架构叙述在开源界没有成熟实现，MAP 靠改动时同步更新的约定加体检漂移提示。
