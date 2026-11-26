# plastic-memory 真来源锚：实施计划（2026-11-26）

> **For agentic workers:** 按任务逐个实施，每任务一次 commit。步骤用复选框（`- [ ]`）跟踪。设计依据见 [2026-11-26-source-anchor-spec.md](2026-11-26-source-anchor-spec.md)。

**Goal:** ZCode、Antigravity 经 MCP 写入的记忆带真锚（`zcode:sess_…` / `antigravity:<uuid>` + 当轮区间），独立端新增第七个工具 `memory_source` 回查；对不上就不锚，任何失败都不挡写入。

**Architecture:** 三个执行器层模块做「定位」与「开窗读」（`src/tools/anchor*.ts`）；上下文平面的 `save` 在进管线前定位一次，`eventRange` 仍由管线算；回查复用 `executeSource`，按 `sessionId` 前缀分发。core、frontmatter、管线、DSH 写入路径都不动。

**分支：** `feat/source-anchor`（起点 `dsh-ours` 的 `120a7cb`），完成后快进并回 `dsh-ours`。不 push。

## Task 0: 实测闸门与文档

**Antigravity 的 MCP 调用形状是全案唯一没实测的一环，先测再写适配器。**

- [ ] 用户在 Antigravity 里开一个会话，让 agent 调一次 `memory_search`（只读，不落记忆）。
- [x] 2026-11-26 复查：现有全部转写里 `memory_` 的唯一命中是某个用户提示词的正文提到这几个字，尚无任何 MCP 调用；闸门保持未决，Task 1/3/4/5 先行。
- [ ] 读该会话的 `transcript.jsonl`，记下三件事并补进设计说明：`tool_calls[].name` 长什么样、`args` 是哪种编码形态、该行的 `created_at` 与后续 `GENERIC` 步的创建时间。
- [ ] 判定：
  - 名字可识别、`args` 里能拿到 `title` / `text` → Antigravity 适配器按 A2 做（Task 2 照做）。
  - `args` 被省略或截到没法比 → Antigravity 的**写入侧**维持现状（不锚），回查侧与 ZCode 照做；设计说明里记下结论，Task 2 缩成「只读」。
- [ ] 刷盘时序这一步证明不了，留给验收 4；实现里靠 A2 的补试兜底。
- [x] `docs/design/2026-11-26-source-anchor-spec.md`
- [x] `docs/design/2026-11-26-source-anchor-plan.md`
- [ ] Commit `docs: source anchor spec and plan`

## Task 1: 锚模块与 ZCode 适配器

**Files:**
- Create: `src/tools/anchor.ts`（scheme 编解码、id 形状校验、分发、公共上限、定位调度）
- Create: `src/tools/anchor-zcode.ts`
- Create: `tests/anchor.spec.ts`、`tests/anchor-zcode.spec.ts`
- Create: `tests/fixtures/zcode-schema.sql`（从本机库导出的 DDL：`session`、`message`、`part`、`tool_usage`、`session_runtime_presence` 与相关索引；只有结构，没有数据）

**Interfaces:**
- `schemeOf(sessionId)` → `'dsh' | 'zcode' | 'antigravity' | 'mcp'`；`SourceAnchor = { sessionId, eventRange }`。
- `AnchorAdapter`：`locateCall({ title, text }, now)` → `SourceAnchor | undefined`；`readWindow(anchor, window?)` → `{ events: { seq, role, text }[], skipped, range }`。
- `createAnchorLocator({ enabled?, zcodeDir?, antigravityDir?, retryDelaysMs?, log? })` → `{ locate(args), reader(scheme) }`。缺省目录 `~/.zcode/cli`、`~/.gemini/antigravity`；根目录不存在的适配器不启用。
- `ANCHOR_WINDOW_CAP = 24`，与 `source.ts` 的 `WINDOW_CAP` 同值（用例守它们相等）。

- [x] 失败测试：
  - 编解码：`zcode:sess_…`、`antigravity:<uuid>`、`mcp:zcode`、裸 DSH id；不合形状的 id 不拼路径、读不了。
  - ZCode 定位（临时库按真实 DDL 建，行按真实形状造）：全等的最新一条命中，锚的起点是当轮首条非 synthetic 的用户消息、终点是该会话最大 `sequence`；`title` 或 `text` 差一个字不认；只找近十分钟的行；起点找不到取 0。
  - 库结构变了（缺表、缺列）→ `undefined`，每个进程只警告一次；根目录不存在 → 不启用、零 I/O。
  - 开窗：从起点往后、默认覆盖 `[起点, 终点]`、`window` 收窄、封顶 24 行、每行 400 字、`reasoning` 与步进标记计入 `skipped`。
  - `enabled: false` → `locate` 回 `undefined` 且不碰库。
  - 不留文件：没有 `-wal` 时按 `immutable` 打开，关闭后库目录与打开前逐项相同；有 `-wal` 时用已有的旁路文件、不新建；
    自己建出来的旁路文件关闭后，`-wal` 为 0 字节的删掉，非空的留着（该路径正常流程到不了，`sweepOwnSidecars` 单测直守）。
- [x] 实现到测试通过（26/26；候选会话改走 `tool_usage` 的时间窗索引，见设计说明 §A3 的更新）。
- [x] Commit `feat(anchor): scheme codec and the ZCode session adapter`

## Task 2: Antigravity 适配器

**Task 0 闸门未决时可先做 Task 3–5，本任务等实测再动工。**

**Files:**
- Create: `src/tools/anchor-antigravity.ts`、`tests/anchor-antigravity.spec.ts`
- Create: `tests/fixtures/antigravity-transcript.jsonl`（Task 0 的真实行，内容换成合成文本，结构原样）
- Modify: `src/tools/anchor.ts`（登记适配器）

- [ ] 失败测试（按 Task 0 的实测形状）：尾部命中 `memory_save` 的 `PLANNER_RESPONSE` 行；`args` 的两种编码各能比；被截断时退回 `title` 全等 + `text` 前 120 字；只看近十分钟改动过的会话；起点是最近的 `USER_INPUT` 行、终点是文件里最大的 `step_index`；开窗只取 `<USER_REQUEST>` 的正文、`GENERIC` 标 `tool`、`SYSTEM_MESSAGE` 计入 `skipped`。
- [ ] 补试：第一次没读到时按 `retryDelaysMs` 补试，总时长封顶 500 毫秒。
- [ ] 实现到测试通过。
- [ ] Commit `feat(anchor): Antigravity transcript adapter`

## Task 3: 写入侧接入

**Files:**
- Modify: `src/standalone/context.ts`（`ContextPlaneOptions.anchors?`；`locateAnchor`；`save` 第三参从 `sessionId: string` 改成 `session: { id, turnStartSeq?, lastSeq? }`）
- Modify: `src/standalone/plane.ts`（把 anchors 选项透传给上下文平面）
- Modify: `packages/mcp/src/tools.ts`（`MemoryContextPort` 增 `locateAnchor`、`save` 改签名；`MemorySaveResult` 的成功分支增 `source`；缺省 `mcp:${client}`）
- Modify: `packages/mcp/src/bin.ts`、`packages/mcp/src/serve.ts`（`PLASTIC_ANCHOR`、`PLASTIC_ZCODE_DIR`、`PLASTIC_ANTIGRAVITY_DIR` → anchors 选项）
- Modify: `tests/standalone-context.spec.ts`、`tests/standalone-plane.spec.ts`、`packages/mcp/src/tools.spec.ts`、`packages/mcp/src/tools-mapping.spec.ts`、`packages/mcp/src/spec-helpers.ts`（假上下文补两个成员）

**Interfaces:**
- `ContextPlane.locateAnchor({ title, text })` → `SourceAnchor | undefined`（定位出错一律 `undefined`，日志一行）。
- `ContextPlane.save(input, workspacePath, session)`：`session` 是定位结果或缺省的 `{ id: 'mcp:<client>' }`；管线照原样算 `eventRange`。
- `memory_save` 成功结果的 JSON 多一个 `source`（记录里的 `source` 原样）。

- [x] 失败测试：定位命中 → 落盘记录的 `source` 是 `zcode:sess_…` 与真实区间；定位不中 → `mcp:<client>`、`[0, 0]`，写入照常成功；定位抛错 → 同不中；更新同样重新锚定；`PLASTIC_ANCHOR=off` → 不定位（context 6 例 + plane 透传 1 例 + mcp mapping 2 例；全量 4993 + mcp 76 绿）。
- [x] 实现到测试通过。偏差：计划里说的「spec-helpers.ts 假上下文补两个成员」不存在——mcp 的两份 spec 用的都是真平面/真子进程，假适配器直接经 `anchors.adapters` 注入；端口的定位返回型是 `AnchorLocation`（无 sourceMode，落盘时管线才知道）。
- [x] Commit `feat(standalone): anchor memory_save to the calling session`

## Task 4: 第七个工具 `memory_source`

**Files:**
- Modify: `src/tools/source.ts`（`SourceToolDeps` 增 `readExternal?`；按前缀分发；`mcp:` 直接 `unavailable`，不调宿主；`SourceResult` 不变）
- Modify: `src/standalone/context.ts`（`source(input, workspacePath)` → `executeSource` + 渲染）
- Modify: `packages/mcp/src/tools.ts`（端口增 `source`；注册 `memory_source`；`MemoryTools` 增一员；「六个」改「七个」）
- Modify: `tests/source.spec.ts`、`packages/mcp/src/tools.spec.ts`、`packages/mcp/src/tools-mapping.spec.ts`

**Interfaces:**
- `MemoryTools.source({ memoryId, window? })` → `{ ...SourceResult, text: string }`；`text` 与 DSH 的 `renderSourceResult` 同一段。
- 工具描述照 DSH 的 `memory_source`（只说能力，不说姿态——姿态归快照里的证据下钻档位管）。

- [ ] 失败测试：握手列出七个工具；外端锚经适配器开窗，渲染与 DSH 同格式；`mcp:`、DSH 锚、存储不在本机三种 `unavailable` 的原因文案；别的项目的 workspace 记录回 `forbidden`；`PLASTIC_ANCHOR=off` 不影响回查。
- [ ] 实现到测试通过。
- [ ] Commit `feat(mcp): memory_source on the standalone surface`

## Task 5: DSH 回读外端锚（已拍板：做）

**Files:**
- Modify: `src/index.ts`（`createSourceTool` 多递一个 `readExternal`，一行）
- Modify: `src/gui/suggestion-source.ts`（外端锚与 `mcp:` 跳过，不调宿主）
- Modify: `tests/source.spec.ts`、`tests/suggestion-source.spec.ts`、`tests/bindings.spec.ts`

- [ ] 失败测试：`zcode:` 记录经适配器读到行、宿主 `readEvent` 不被调用；适配器缺席 → `unavailable`；DSH 原生锚的既有用例一条不改。
- [ ] 实现到测试通过。
- [ ] Commit `feat(source): dereference external anchors from DSH sessions`

## Task 6: doctor、文档、上线与实测

**Files:**
- Create: `src/standalone/anchor-doctor.ts`（两个存储各跑一遍探针，回 JSON 报告；不读内容）
- Modify: `packages/mcp/src/bin.ts`（`anchor-doctor` 子命令，动态加载，缺构建产物时给 `BUILD_HINT`）
- Modify: `tests/standalone-boundary.spec.ts`（平面根加入 `anchor-doctor.ts`）
- Modify: `README.md`（「六个」改「七个」、独立端与 DSH 的差异一节）、`integrations/zcode/README.md`、`scripts/build-zcode-plugin.ts`（插件描述）、`CHANGELOG.md`、`docs/design/2026-11-26-general-mcp-spec.md`（差异一节指向本文）

- [ ] 根包与三个包的 `typecheck`、`lint`、`test`、`build` 全过。
- [ ] 重启 7788（`plastic-memory-web.service`，先请示）；`/mcp` 列出七个工具，settings、snapshot 端点不回归。
- [ ] ZCode 实测（验收 3）：**新开会话**（已开着的会话的 stdio 进程还是旧代码）→ `memory_save` 的结果带 `zcode:sess_<本会话>` → `memory_source` 第一行是本轮用户原话 → 换一个会话回查同一条。
- [ ] Antigravity 实测（验收 4）。
- [ ] `plastic-mcp anchor-doctor` 两端都认得；`PLASTIC_ANCHOR=off` 下写入回 `mcp:<client>`（验收 7）。
- [ ] DSH 不回归：`scripts/host-contract/verify-plugin.ts` 照过。
- [ ] Commit `feat(mcp): anchor-doctor`、`docs: source anchors for ZCode and Antigravity`

## Task 7: 收尾

- [ ] `docs/design/exec-log-20261126.md` 追加本轮（commit 清单、逐任务偏差、实测记录、遗留）。
- [ ] 设计说明状态改「已实施并上线」；计划复选框打勾。
- [ ] 快进并回 `dsh-ours`。
- [ ] Commit `docs: exec log for the source anchor round`

## 回退

- 运行期：`PLASTIC_ANCHOR=off` 让写入立刻回到现状，不用回滚代码。
- 代码：按 commit 逐个 revert。带真锚的记录对旧代码是合法数据（`sessionId` 是字符串），旧版回查它们时按既有路径降级成 `unavailable`。
- 两端的存储全程只读，没有需要清理的写入。
