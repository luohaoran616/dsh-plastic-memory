# plastic-memory 通用 MCP：设置面、类型规则注入、快照带入（设计说明，2026-11-26）

状态：已实施并上线（2026-11-26，见 [exec-log-20261126.md](exec-log-20261126.md)）。实施计划见 [2026-11-26-general-mcp-plan.md](2026-11-26-general-mcp-plan.md)。

## 目标

独立端（MCP server 与 7788 页面）在「模型自己判断、主动记录」这件事上与 DSH 插件对等：

1. 设置有落点、改得动：记忆类型（场景、自建类型、预设）与参数（带入上限、超限处理、证据下钻）在 7788 页面上可查可改，独立端各进程按同一份设置运行。
2. 写侧规则（各类型记什么、什么时候记）随 `memory_save` 的工具描述进任何 MCP 客户端的上下文。
3. 读侧规则（各类型带入后怎么用）连同记忆本体经快照带入：ZCode 走 hook 自动带入，其余客户端由模型调 `memory_recall`。
4. MCP 写入走与 DSH 同一条管线（结构去重、疑似密钥拦截、更新、取代、有效期、撤销快照）。

## 已核实的事实（2026-11-26 实测）

- **3085 新会话的上下文组成**（解码 `~/dsh-clean/home/sessions/…/session-987d0ca3…/session.v4.jsonl.zstd`）：系统提示词 10,820 字、35 段，没有一段来自 plastic；工具表 55 个共 52,968 字，其中 9 个 `memory_*` 占 12,848 字（`memory_save` 一条 6,052 字）；快照消息是排在用户第一句话之前的一条 user 消息（`source.kind = plastic-memory`），冷启动 106 字，6 条记忆时 2,361 字。台账记的 B0 是 16,647 token，约 7.1K 归因于这 9 个工具。
- **类型规则走两条通道，不进系统提示词。** 写侧：`memory_save` 的工具描述 = 通用层 `SAVE_GUIDE` + 每类的 `description` 与 `whenToSave`（`src/type-registry.ts` 的 `renderSaveDescription`），另有 `content` 参数说明里的一段正文写法。读侧：快照尾部的「各类记忆怎么用」（每类的 `howToUse`，`src/snapshot.ts` 的 `usageNote`）。快照在 `agent/pre-step` 发出，每会话冻结一份，压缩或配置热更新后文本变了才重发。
- **ZCode 里能推上下文的只有两条通道。** MCP 的 resources/prompts 只在界面层被读取（`readMcpResourceForUi`、`listMcpResourcesForUi`、MCP App UI），没找到进模型请求的路径。hooks 的 `additionalContext` 会进对话；事件共七个，`SessionStart` 的 matcher 取 `startup`、`resume`、`clear`、`compact`，`UserPromptSubmit` 未实测。本机 engram 的 `SessionStart` 与 `PreToolUse` hook 是实证可用的。
- **独立端现状。** 页面只挂了 `client/MemoryPage.tsx`（`packages/webui/src/App.tsx`）；上一轮的设计说明把插件设置页列在「不做的事」里；HTTP 网关的 `useConfig` 恒为 `undefined`；无宿主装配在 `src/standalone/plane.ts` 里把类型表写死成出厂值；MCP 的 `memory_save` 描述只有五行机械说明，写入直接 `store.create`。
- **跨进程共用的设置放记忆根有先例。** `src/governance/auto-checkups.ts` 的注释写明「不放配置文件：设置要被桌面版、`dsh web`、命令行几个进程共用，各 profile 的配置文件做不到」。
- **项目映射是写死的。** ZCode、Antigravity、WebUI 三个进程的 `PLASTIC_PROJECT` 都是 `/home/luo/projects/202608/alpha`，ZCode 起的 MCP 进程工作目录是 `/home/luo`，按 cwd 推导不出项目。hook 的输入里带会话的 `cwd`。
- **DSH 实例各装各的副本。** `~/dsh-clean` 下各 profile 的 `node_modules/dsh-plastic-memory` 是真目录，不链到本仓库；本仓库的构建产物只有 7788 服务与两个 stdio 进程在用。

## 设计决定

### D1 设置文档：`.state/settings.json`，「显式改动叠在出厂值上」

文件形状：

```json
{ "version": 1, "revision": 3, "set": { "template": "coding", "snapshotTokenBudget": 3000 }, "unset": [] }
```

有效设置 = 出厂值，深合并 `set`，再删掉 `unset` 列的路径。`revision` 是版本号，每次写入加一，提交时带上次读到的版本号防冲突。

文件由 core 管（`packages/core/src/storage/settings-doc.ts`：原子写、记忆根写锁内读改写、按 inode/mtime/size 签名缓存解析结果），语义由插件管（`src/governance/memory-settings.ts`：出厂值、校验、路径操作怎么落到 `set` 与 `unset`）。

理由：与 DSH 宿主的配置模型同构（显式配置叠在 schema 默认值上，字典按键 set 与 unset）。DSH 插件下一轮接入时用「cordis 配置 ⊕ 同一份文档」即可，已有的 yaml 定制不会被整份覆盖；独立端的页面始终显示有效值（出厂值叠文档），看到什么就是什么。

坏文件的处理：文件在但读不出、或不合法时，各进程按出厂值运行并报一次错，页面显示不可用，写入被拒（不去覆盖一个读不出来的文件）。

### D2 独立端生效范围

| 设置组 | 独立端 |
|---|---|
| 记什么（场景、自建类型、预设、当前场景） | 全生效：`memory_save` 的描述与类型枚举、快照分组与用法、索引行的 passive 标注、记忆页的分组名、类型迁移命令 |
| 怎么用（带入上限、超限处理、证据下钻） | 对独立端快照生效（`memory_recall` 与 hook 带入的那一份） |
| 怎么管（提醒灵敏度、提升目标） | 独立端没有消费者：页面置灰并写明原因，值照存 |
| 外观（主题色） | 生效 |

`governance.enabled`、`subagent.maxSavesPerSession`、`search.userDictionaryPath` 不进页面；独立端的治理恒按开启运行（沿用上一轮的取舍）。

### D3 上下文平面 `src/standalone/context.ts`

无宿主装配里再抽一层「存储 + 类型表 + 设置 + 快照 + 写入管线依赖 + 检索」。stdio 模式直接用它（不加载界面平面）；GUI 平面在它上面装界面。serve 进程里 MCP 工具与 GUI 平面共用同一个平面：一张文件表、一份类型表、一份设置（顺带收掉上一轮记的「serve 进程里两个 FileTable 不互斥」）。

类型表是转发对象：设置文件变了就重建背后的表，各处手里的引用不用换。每次 MCP 工具调用前比对一次设置，变了重建类型表、重注册工具、发 `tools/list_changed`。

### D4 MCP 工具面：五个变六个

| 工具 | 变化 |
|---|---|
| `memory_save` | 入参在旧形状上加可选参数；描述带规则；写入走 `runSavePipeline` |
| `memory_recall` | 新增。返回项目（全局 + 该项目）的快照原文，与 hook 注入的是同一段文本 |
| `memory_search`、`memory_read`、`memory_forget`、`memory_health` | 形状不变 |

`memory_save` 的入参：

- `title`、`text`、`origin`、`project`、`type`：沿用。`type` 从自由字符串改成当前场景的类型枚举，新建时必填。`origin` 保留 `user-stated`、`model-observed` 两个旧值，另接受 DSH 的五档原名（`user-explicit`、`user-behavior`、`environment-observed`、`agent-inferred`、`agent-action-confirmed`），旧值是前两档的别名。
- 新增可选：`id`（更新目标）、`summary`、`tags`、`confidence`、`supersedes`、`validFrom`、`validTo`、`force`。

描述分三段：一句用途；规则（`renderSaveDescription` 按工具面渲染，与 DSH 同一份文字，只有参数名与两处工具面差异不同）；落盘说明（`project` 的解析、`"global"` 的落法、更新的写法）。`text` 的参数说明带 DSH `content` 参数里那段正文写法。

写入与 DSH 的差别只有两处：MCP 没有确认码通道，更新目标是全局记录时直接拒存并指引去记忆页面；新建带 `project: "global"` 照旧由管线降级成当前项目的全局提升候选。拒绝原因沿用管线原文，个别句子会提到 DSH 的参数名（`action`、`edits`）。

### D5 快照接口与 ZCode hook

`GET /api/gui/snapshot?project=<绝对路径>` 回 `{ text, usedTokens, injectedCount }`。纯读：不跑目录维护、不计召回（DSH 的冻结快照会做这两件事）。

ZCode 的 hook 在 `SessionStart` 上挂一条（不设 matcher，`startup`、`resume`、`clear`、`compact` 四种来源都命中），项目取 hook 输入里的 `cwd`，调上面的接口，把 `text` 作为 `additionalContext` 输出。这与 DSH「每会话冻结一份、压缩后重带」的语义一致，没有每轮开销。服务不可达、超时、返回为空时什么都不输出、退出码 0，不挡用户的会话。

### D6 独立页设置页

原版 `client/settings/SettingsPage.tsx` 一行不改地挂在 `/settings`。页面侧补一个走 HTTP 的 `ConfigForm`（读设置、带版本号提交、回到前台重读）；HTTP 网关的 `useConfig` 与 `setConfig` 接到同一份设置上，记忆页里依赖配置的控件（自建类型的显示名、主题色、带入上限的快捷修改）随之生效。记忆页自己的「设置」入口接通到这个视图。

### D7 ZCode 接入形态

以 ZCode 插件分发：清单里同时给 MCP 服务与 hook，装一次两样都有；MCP 服务的 `PLASTIC_PROJECT` 用 `${CLAUDE_PROJECT_DIR}`，按工作区解析项目。文档写明插件提供的 MCP 服务会展开模板变量，`env` 里的值是否展开要实测；实测不成立时退回「手改 `~/.zcode/cli/config.json` 加 hook，项目映射维持写死」。

## 安全

- `POST /api/gui/settings` 是写端点：只收 `application/json`，带 `Origin` 且不是服务自己的来源时拒绝（沿用 `gui-http.ts` 的 `acceptJsonWrite`）。
- 路径操作：路径的每一段必须是非空字符串，拒绝 `__proto__`、`constructor`、`prototype`。
- `snapshot` 的 `project`：必须是已存在目录的绝对路径，`realpath` 之后解析，只读全局与该项目两处目录。
- hook：只请求 `127.0.0.1`，端口取 `PLASTIC_WEB_PORT`（缺省 7788），超时 3 秒，任何失败都静默放行。

## 不做的事

- DSH 插件读同一份设置（下一轮；本轮不改 `src/index.ts`）。
- `UserPromptSubmit` 每轮检查快照是否变化；子 agent 写入门；`edits` 精确修改；在 MCP 端更新全局记忆。
- 独立端自动体检缺省开启（沿用上一轮 D8）。
- `memory_search`、`memory_read`、`memory_forget`、`memory_health` 的形状。

## 独立端与 DSH 的已知差异

- 快照不冻结、不计召回、不触发目录维护；只在会话事件时带入，别的进程改了记忆要等下一个会话事件或模型主动调 `memory_recall`。
- 提醒灵敏度、提升目标、子会话配额、用户词典路径在独立端不生效。
- 写入的来源锚是通道标识（`mcp:<client>`），事件区间是占位，`memory_source` 式的回查在独立端没有对应物。

## 验收

1. 根包 `pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿；`@plastic/core`、`@plastic/mcp`、`@plastic/webui` 的 `test`、`typecheck`、`build` 全绿。
2. 设置：临时记忆根上写入 `.state/settings.json` 后，另一个进程建出的平面按新场景与类型运行；两个进程用同一个旧版本号提交，后到的被拒；坏文件不被覆盖。
3. MCP：stdio 模式握手列出六个工具；`memory_save` 的描述含各类型规则，`type` 是当前场景的枚举；重复主题被去重拦下、疑似密钥被拦下、带 `id` 更新、`supersedes` 取代、`validTo` 到期后不再带入；`memory_recall` 与快照接口对同一项目回同一段文本。
4. `plastic-mcp serve`：`GET /api/gui/settings`、`POST /api/gui/settings`（415、403、409、400 各有对应用例）、`GET /api/gui/snapshot`。
5. 浏览器打开 7788：记忆页的「设置」入口能进设置页，改场景与上限后保存，记忆页与 `memory_save` 的描述随之变化；中英文可切。
6. hook 脚本手喂样例输入：有服务时输出一段合法 JSON，服务不通时无输出、退出码 0。
7. DSH 侧不回归：`src/index.ts` 不动，根包既有用例全绿。
