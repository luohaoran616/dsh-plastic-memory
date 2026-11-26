# plastic-memory 通用 MCP：实施计划（2026-11-26）

> **For agentic workers:** 按任务逐个实施，每任务一次 commit。步骤用复选框（`- [x]`）跟踪。设计依据见 [2026-11-26-general-mcp-spec.md](2026-11-26-general-mcp-spec.md)。

**Goal:** 让独立端（MCP server 与 7788 页面）具备可改的设置面、带规则的 `memory_save`、可带入的快照，写入走与 DSH 同一条管线。

**Architecture:** core 增一张设置文档表；插件把设置语义放进 governance 层，把「存储 + 类型表 + 设置 + 快照 + 管线 + 检索」抽成无宿主的上下文平面；stdio 与 GUI 平面都建在它上面；页面侧补 HTTP 的 `ConfigForm` 并挂原版设置页；ZCode 经 `SessionStart` hook 带入快照。

**分支：** `feat/general-mcp`（起点 `dsh-ours` 的 `5732c9f`），完成后快进并回 `dsh-ours`。

## Task 0: 设计说明与计划

- [x] `docs/design/2026-11-26-general-mcp-spec.md`
- [x] `docs/design/2026-11-26-general-mcp-plan.md`
- [x] Commit `docs: spec and plan for the general MCP (settings, rules, snapshot)`

## Task 1: 设置文档表与设置语义

**Files:**
- Modify: `packages/core/src/storage/schema.ts`（`settingsDocSchema`）、`packages/core/src/storage/sidecar.ts`（`settings` 表、文件清单注释）
- Create: `packages/core/src/storage/settings-doc.ts`、`packages/core/src/storage/settings-doc.spec.ts`
- Create: `src/governance/memory-settings.ts`、`tests/memory-settings.spec.ts`、`tests/memory-settings-mirror.spec.ts`

**Interfaces:**
- core：`SettingsDoc = { version: 1; revision: number; set: Record<string, unknown>; unset: string[][] }`；`SettingsDocTable.read()` 回 `missing | ready | corrupt`，`mutate(fn, expectedRevision?)` 在记忆根写锁内读改写，版本不符回 `conflict`，坏文件回 `corrupt`，`fn` 抛错时不写。`SidecarStore.settings` 住 `.state/settings.json`。
- 插件：`DEFAULT_MEMORY_SETTINGS`、`resolveMemorySettings(doc)`、`validateMemorySettings(value)`、`applySettingsOps(doc, ops)`、`MemorySettings`（`current`、`snapshot`、`mutate`）、`createSettingsRegistry(settings)`。

- [x] 失败测试：core 表的读、写、版本冲突、坏文件不覆盖、签名缓存；插件的出厂值、叠加、unset、ops 落法、校验拒绝、镜像 `Config`。
- [x] 实现到测试通过。
- [x] Commit `feat(settings): shared settings document in the memory root`

## Task 2: 上下文平面

**Files:**
- Modify: `packages/core/src/factory.ts`（抽出 `createMemorySearch`，`createMemoryCore` 改用它）、`src/type-registry.ts`（`renderSaveDescription(surface)`、`CONTENT_WRITING_GUIDE`、MCP 工具面）、`src/tools/save-tool.ts`（改引 `CONTENT_WRITING_GUIDE`，DSH 描述逐字不变）
- Create: `src/standalone/context.ts`、`tests/standalone-context.spec.ts`
- Modify: `tests/standalone-boundary.spec.ts`（平面根加入 `context.ts`）

**Interfaces:**
- `createContextPlane({ memoryRoot, project?, client?, log?, now?, lock? })` 回 `ContextPlane`：`store`、`registry`（转发）、`settings`、`snapshots`、`decisions`、`sidecar`、`lock`、`refresh()`、`resolveProject(project?)`、`search(input)`、`snapshot(workspacePath)`、`save(input, workspacePath, sessionId)`。
- `renderSaveDescription(surface)` 缺省参数下输出与改动前逐字相同（既有用例守住）。

- [x] 失败测试：设置变了 `refresh` 回 true 且类型表换成新场景；`snapshot` 与 DSH 的 `assembleSnapshot` 同文；`save` 经管线被去重与密钥拦下；`resolveProject` 的三种取值。
- [x] 实现到测试通过。
- [x] Commit `feat(standalone): context plane with settings-backed registry, snapshot and save pipeline`

## Task 3: GUI 平面接设置与快照，REST 三个端点

**Files:**
- Modify: `src/standalone/plane.ts`（建在上下文平面上；`GuiPlane` 增 `context`、`readSettings`、`mutateSettings`、`snapshot`）
- Modify: `packages/mcp/src/gui-http.ts`（`GuiPlanePort` 增三个成员；`GET/POST /api/gui/settings`、`GET /api/gui/snapshot`）、`packages/mcp/src/serve.ts`（`/mcp` 的工具用平面的上下文）
- Modify: `packages/mcp/src/gui-http.spec.ts`、`packages/mcp/src/serve.spec.ts`、`tests/standalone-plane.spec.ts`

- [x] 失败测试：设置读回有效值与版本号；提交后版本号加一且类型表已重建；415、403、409、400；`snapshot` 对不存在路径 400。（`/mcp` 的 `tools/list` 是六个随 Task 5 的六工具面落地，见 exec-log 偏差注记）
- [x] 实现到测试通过。
- [x] Commit `feat(mcp): settings and snapshot endpoints on the GUI plane`

## Task 4: 独立页挂设置页

**Files:**
- Create: `packages/webui/src/config-form.http.ts`、`packages/webui/src/config-form.http.spec.ts`、`packages/webui/src/shell.css`
- Modify: `packages/webui/src/gateway.http.ts`（`useConfig`、`setConfig` 接 `ConfigForm`）、`packages/webui/src/App.tsx`（记忆与设置两个视图、hash 路由、记忆页「设置」入口）、`packages/webui/src/App.spec.tsx`、`packages/webui/src/locale.ts`
- Modify: `client/settings/SettingsPage.tsx`（可选属性 `inert`：置灰项与原因）、`client/locales/settings.ts`、`client/locales.ts`
- Modify: `tests/standalone-boundary.spec.ts`（界面闭包的起点加入设置页）

- [x] 失败测试：`ConfigForm` 读、提交、409 后重读并回 false、400 回 false；`useConfig` 给出有效值；页面能在两个视图间切换；设置页在独立端的置灰项。
- [x] 实现到测试通过。
- [x] Commit `feat(webui): mount the original settings page over an HTTP config form`

## Task 5: MCP 工具面

**Files:**
- Modify: `packages/mcp/src/tools.ts`（`createMemoryTools(context, options)`、六个工具、规则描述、热更新）、`packages/mcp/src/bin.ts`、`packages/mcp/src/tools.spec.ts`、`packages/mcp/src/concurrency.spec.ts`、`packages/mcp/src/global-guard.spec.ts`

**Interfaces:**
- `MemoryContextPort`：MCP 包只认这个结构（`client`、`project`、`refresh`、`resolveProject`、`store`、`search`、`snapshot`、`save`、`saveSurface`）。
- `memory_save` 入参见设计说明 D4；`memory_recall` 入参 `{ project? }`，回快照原文。

- [x] 失败测试：入参映射（旧值与新值、更新时沿用目标字段）；去重与密钥的返回形状；全局目标被拒；`memory_recall` 与 `snapshot` 同文；设置变了重注册。
- [x] 实现到测试通过。
- [x] Commit `feat(mcp): memory_save through the save pipeline with type rules, plus memory_recall`

## Task 6: 快照 hook 与 ZCode 插件

**Files:**
- Create: `packages/mcp/src/hook-snapshot.ts`、`packages/mcp/src/hook-snapshot.spec.ts`、`scripts/build-zcode-plugin.ts`、`integrations/zcode/`（模板与说明）
- Modify: `README.md`（「跨端接入」章：六个工具、设置页、hook、插件）

- [x] 失败测试：有服务时输出 `{ hookEventName, additionalContext }`；服务不通、超时、空文本时无输出且退出码 0；`cwd` 缺失时的回退。
- [x] 实现到测试通过。
- [x] Commit `feat(zcode): session-start snapshot hook and plugin packaging`

## Task 7: 全量验证、上线、文档

- [x] 根包与三个子包的 `typecheck`、`lint`、`test` 全绿。
- [x] `git merge --ff-only` 并回 `dsh-ours`；根包与 `@plastic/mcp`、`@plastic/webui` 构建。
- [x] 重启 `plastic-memory-web.service`，按设计说明的验收 3 至 5 实测（临时记忆根跑 stdio 与 serve；7788 页面走查）。
- [x] README 与 `docs/design/exec-log-20261126.md`（裁决与上线记录）。
- [x] Commit `docs: cross-client onboarding for the general MCP`

## Task 8: ZCode 接入

- [ ] 实测插件提供的 MCP 服务是否展开 `env` 里的 `${CLAUDE_PROJECT_DIR}`。
- [ ] 成立：装插件，去掉 `~/.zcode/cli/config.json` 里旧的 `plastic-memory` 条目（先备份）。不成立：退回手改 `config.json` 加两条 hook。
- [ ] hook 脚本手喂样例输入验证。

## 风险与缓解

1. **stdio 模式从此依赖根包构建产物**（上下文平面在 `lib/standalone/`）：缺产物时给出「先在仓库根目录跑 pnpm build」的提示，与 serve 模式同一句。
2. **`memory_save` 入参是破坏性变化**：`type` 新建必填。调用方只有模型，描述里写清；旧值 `origin` 仍收。
3. **hook 的 `cwd` 与 MCP 的 `PLASTIC_PROJECT` 可能不一致**（模板展开不成立时）：快照按会话目录、写入落 alpha。届时在收尾里写明，不改设计。
4. **设置页闭包带进宿主依赖**：边界用例守着，带入即红。
