# plastic-memory 跨端共享（MCP Server + 独立 WebUI）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** plastic-memory 的记忆库成为 DSH、ZCode、Antigravity 三端共享的单一库，并提供不依赖 DSH GUI 的独立 Web 治理界面。

**Architecture:** 把现有 `src/` 里与 DSH 无关的存储与检索层抽成 `packages/core`，其上新增两个入口：`packages/mcp`（MCP stdio server，可切换 HTTP 模式并同进程托管 REST 与 WebUI 静态产物）与 `packages/webui`（Vite React SPA，复用 `client/` 组件、gateway 换 REST 实现）。多进程并发安全由现有 root-lock 保证，不需要常驻 daemon 收敛写入。

**Tech Stack:** TypeScript ESM、node:sqlite（锁）、@modelcontextprotocol/sdk（MCP）、Vite + React（WebUI）、jieba 分词（复用）。

**Spec:** 本文档第一至三节（设计决策）即本计划的 spec；第四至十节是任务分解。

## 一、已确认的关键事实（设计依据）

1. **锁协议已跨进程安全，无需改造**。`src/storage/root-lock.ts` 用 `<memoryRoot>/.state/lock/write-lock.sqlite` 上的 `BEGIN IMMEDIATE` 做跨进程互斥，持锁进程崩溃由操作系统立即释放；文件头注释明确「锁库路径、加锁方式与 user_version = 1 是跨版本契约：新旧版本同开时要锁同一个文件、用同一种方式才互斥」。MCP server 只要走同一个 core 的锁，就与 DSH 插件实例天然互斥。**禁止在 MCP 侧另造锁**。
2. `MemoryStore` 构造签名为 `(table: MemoryTable, log?: MemoryLogger, stats: BatchKvTable<RecallStats>)`，依赖全部来自 `src/storage/` 与 `src/search/`，无 DSH 宿主类型。抽包可行。
3. `client/gateway.ts` 是数据网关抽象且带 fake 实现，页面组件不直连数据层——独立 WebUI 复用组件只需新写一个 REST gateway。
4. ZCode 记忆库在 `~/.zcode/cli/memories/projects/<hash>/memory/*.md`，Markdown + YAML frontmatter（name、description、type、originSessionId）+ `[[wiki 链接]]` + MEMORY.md 索引。
5. Antigravity 不做数据导入、不做专门适配（2026-11-25 决策）：只接 MCP 配置。
6. 仓库 `pnpm-workspace.yaml` 目前是单包（`packages: ['.']`）。

## 二、设计决策（实现者不得偏离）

### D1 包结构

```
packages/core/     # MemoryStore + storage/ + search/ + record-schema + root-lock，零 DSH 依赖
packages/mcp/      # MCP server（stdio 与 HTTP 两种模式）+ REST 管理面 + 静态托管
packages/webui/    # Vite React SPA，构建产物由 packages/mcp 托管
.                  # 原 DSH 插件包，依赖 packages/core（workspace 成员）
```

pnpm-workspace.yaml 的 `packages` 改为 `['.', 'packages/*']`。原 `src/` 中的 DSH 接线层（`cordis-host-session.ts`、`gui/`、`tools/*.ts` 的工具注册面）留在插件包不动。

### D2 MCP 工具面（五个，snake_case）

| 工具 | 输入 | 输出 | 语义 |
|---|---|---|---|
| `memory_save` | `{ title, text, project?, type?, origin }` | `{ id, path }` | origin 必填，取 `user-stated` 或 `model-observed`；写入 frontmatter `source: mcp` 与客户端标识 |
| `memory_search` | `{ query, project?, topK? }` | `{ hits: [{ id, title, summary, path }] }` | 复用 core 检索打分，topK 缺省 8 |
| `memory_read` | `{ id }` | 完整记录（frontmatter + 正文） | 对应插件 source 工具的溯源下钻 |
| `memory_forget` | `{ id }` | `{ ok }` | 走 `softDelete`（进 `.archive/`，可恢复），禁止 MCP 端 hardDelete |
| `memory_health` | 无 | `{ score, issueCount, topIssues }` | 只读简版；完整体检拍板在 WebUI |

不做 promote、scan、confirm：治理与提升是「关键抉择由人拍板」的范畴，入口收敛在 WebUI 与 DSH GUI。

### D3 作用域规则

- `project` 缺省时按 MCP 进程 cwd 推导 workspacePath（与客户端会话目录对齐）。
- 写全局：显式 `project: "global"`；frontmatter 追加 `needs-promote-review: true`，WebUI 待办里出现，人确认后才转为正式全局记忆。
- ZCode/Antigravity 的 project 参数由各端配置里写死映射（见 D6），不从对话内容猜测。

### D4 进程与传输

- bin `plastic-mcp`：缺省 stdio（ZCode、Antigravity 各起一个进程实例）；`plastic-mcp serve` 起 HTTP 模式，监听 `127.0.0.1:7788`（可选 `--port`、`--token`；仅本机绑定，token 缺省关闭）。
- HTTP 模式同进程暴露三样：`/mcp`（streamable HTTP MCP 端点）、`/api/*`（REST 管理）、`/`（webui 构建产物静态托管）。
- stdio 模式不提供 UI 与 REST。三端同时写由 root-lock 保证串行，无需 daemon。

### D5 WebUI 功能清单（一期）

浏览（按项目/全局分组）、搜索（复用 core 打分）、查看溯源、编辑（`updateIfLive`，冲突提示）、软删与恢复（`.archive/` 列表）、健康分与体检待办处理（逐条 accept/dismiss）、全局提升审核（处理 D3 的 `needs-promote-review`）。不做：会话内注入面板、对话卡片——这些留在 DSH 插件 GUI。

### D6 客户端接入配置

ZCode（`~/.zcode/cli/setting.json` 的 `mcp` 键）与 Antigravity 的 MCP 配置里加 stdio server：`command: node, args: [<repo>/packages/mcp/lib/bin.js], env: { PLASTIC_MEMORY_ROOT: <memoryRoot>, PLASTIC_CLIENT: zcode | antigravity, PLASTIC_PROJECT: <固定映射> }`。客户端标识写入每条新增记录的 frontmatter `source` 字段，WebUI 按来源过滤展示。

### D7 ZCode 导入映射表

| ZCode 字段 | plastic 记录字段 |
|---|---|
| `name` | title（幂等键的一部分） |
| `description` | summary |
| 正文 | 正文原样保留，`[[wiki 链接]]` 不转换、保留原文 |
| `type` | 已知值映射表（project→project、user→preference 等），未知值归 general 并在导入报告警告 |
| `originSessionId` | frontmatter `imported-from: zcode:<sessionId>` |
| MEMORY.md 索引 | 不迁 |

幂等规则：已存在 title 相同且 `imported-from` 前缀为 zcode 的记录即跳过。项目 hash 目录与真实项目路径的对应关系由人工维护的映射文件给出（`--map <file>`，缺省 dry-run 只报告不写入）。写入必须走 core（享受同一锁协议），不走直写文件。

### D8 上游同步策略

core 抽取只移动文件与 import 路径，不改任何逻辑；upstream merge 时冲突预期集中在 import 行与 workspace 配置。每任务一次 commit，保证可逐段回溯。

## 三、Global Constraints

- Node `^22.19.0 || >=24`，ESM only，与现仓库一致。
- 锁库路径 `<memoryRoot>/.state/lock/write-lock.sqlite`、`user_version = 1`、`BEGIN IMMEDIATE` 加锁方式：一字不改。
- 记录 schema 变更必须经 `packages/core` 的 schema 校验；MCP/WebUI/导入器不得绕过 core 直写文件。
- MCP 端无 GUI 确认流，因此禁止 hardDelete 与全局直写（见 D2、D3）。
- WebUI 与 REST 仅绑定 127.0.0.1。
- 每任务独立 commit；测试框架沿用 vitest。

## 四、Review Focus

1. **跨进程并发**：MCP 进程与 DSH 插件同秒写同一记忆根——期望两写都成功且互不覆盖，靠 root-lock 串行。钉子测试：Task 3 的并发实证测试。
2. **崩溃恢复**：MCP 进程持锁中被 kill -9——期望 DSH 插件下次写入立即拿到锁（OS 释放），无 stale lock 等待。同上测试覆盖。
3. **软删恢复一致性**：MCP forget 后 WebUI 恢复，id 与正文不漂移。Task 6 REST 测试覆盖。
4. **导入幂等**：同一映射文件连跑两次 apply，第二次必须零写入。Task 4 测试覆盖。
5. **全局直写绕行**：MCP memory_save 带 `project: "global"` 时必须带 `needs-promote-review: true`，否则拒绝。Task 3 测试覆盖。

## 五、任务分解

### Task 1: 抽出 packages/core

**Files:**
- Create: `packages/core/package.json`、`packages/core/src/`（移入 `store.ts`、`storage/`、`search/`、`record-schema.ts`、`record-freshness.ts`、`validity.ts`、`text.ts`、`errors.ts`、`kv-table.ts`、`root-lock.ts`、`types.ts`、`scope.ts`、`index-line.ts` 等零 DSH 依赖模块）
- Modify: `pnpm-workspace.yaml`（packages 改 `['.', 'packages/*']`）、原 `src/` 各 import 改指 `@plastic/core`、根 `package.json`（workspace 依赖）

**Interfaces:**
- Produces: `@plastic/core` 导出 `MemoryStore`、`MemoryTable` 及其实现工厂、`createRootLock`、`defaultRootLock`、检索打分入口，导出面与移动前逐名一致。

- [ ] Step 1: 写迁移守卫测试 `tests/core-surface.spec.ts`：断言 `@plastic/core` 具名导出清单与抽取前 `src/store.ts` 等的导出名快照一致（先对旧导出面生成快照再抽）。
- [ ] Step 2: 跑测试确认快照通过（记录基线）。
- [ ] Step 3: `git mv` 移动文件到 `packages/core/src/`，建包（`main: lib/index.ts` 风格对齐现仓库），插件包 import 改路径；不改任何实现行。
- [ ] Step 4: `pnpm install && pnpm -r test`，全部通过；`pnpm --filter ./ -r typecheck` 通过。
- [ ] Step 5: Commit `refactor: extract @plastic/core from plugin src (move-only)`。

### Task 2: core 组装工厂 `createMemoryCore`

**Files:**
- Create: `packages/core/src/factory.ts`、`packages/core/src/factory.spec.ts`

**Interfaces:**
- Produces: `createMemoryCore(opts: { root: string; client: string; log?: MemoryLogger }): Promise<MemoryCore>`，其中 `MemoryCore = { store: MemoryStore; search(query: SearchInput): Promise<SearchResult>; close(): Promise<void> }`。工厂内部建 MemoryTable（注入 `createRootLock({ root, log })`）、recall-stats 侧表（`.state/recall-stats.json`）、jieba 分词器。这是 Task 3/4/5/6 的唯一接线入口。

- [ ] Step 1: 失败测试：临时目录建 core，save 一条（走 store.create）后 `search` 能按 title 命中；`close` 后锁库连接关闭（再次 create 同 root 不报占用）。
- [ ] Step 2: 跑测确认失败（factory 不存在）。
- [ ] Step 3: 实现 factory：组装逻辑从插件接线层（`cordis-host-session.ts` 现有组装段）平移，不发明新行为。
- [ ] Step 4: 跑测通过；插件包既有测试不受影响。
- [ ] Step 5: Commit `feat(core): createMemoryCore assembly factory`。

### Task 3: MCP stdio server（五工具 + 并发实证）

**Files:**
- Create: `packages/mcp/package.json`、`packages/mcp/src/bin.ts`、`packages/mcp/src/tools.ts`、`packages/mcp/src/tools.spec.ts`、`packages/mcp/src/concurrency.spec.ts`、`packages/mcp/src/global-guard.spec.ts`
- Modify: 根 `package.json`（workspace bin 说明）

**Interfaces:**
- Consumes: Task 2 的 `createMemoryCore`。
- Produces: bin `plastic-mcp`（stdio）；工具 schema 按 D2 一字不差；每条写入 frontmatter `source: mcp:<PLASTIC_CLIENT>`。

- [ ] Step 1: 失败测试 `tools.spec.ts`：stdio 环境下按 MCP 协议列出工具恰为 D2 五个名字；`memory_save` 后 `memory_search` 命中、`memory_read` 全文一致、`memory_forget` 后 `memory_read` 返回已删状态。
- [ ] Step 2: 失败测试 `global-guard.spec.ts`：`memory_save` 带 `project: "global"` 且未走提升通道时写入的记录含 `needs-promote-review: true`；工具不提供任何绕过 frontmatter 的路径。
- [ ] Step 3: 失败测试 `concurrency.spec.ts`：同 root 下一个 core 实例 + 一个子进程 `plastic-mcp` 并发各写 20 条，全部成功；随后 kill -9 子进程（模拟持锁崩溃），主实例下一笔写立即成功（等待时间 < 1s）。
- [ ] Step 4: 跑三个测试确认失败。
- [ ] Step 5: 用 `@modelcontextprotocol/sdk` 实现五工具，全部经 `createMemoryCore`。
- [ ] Step 6: 跑测全通过。
- [ ] Step 7: Commit `feat(mcp): stdio server with five memory tools`。

### Task 4: ZCode 导入器

**Files:**
- Create: `packages/mcp/src/import-zcode.ts`、`packages/mcp/src/import-zcode.spec.ts`

**Interfaces:**
- Consumes: Task 2 工厂、D7 映射表。
- Produces: CLI `plastic-mcp import-zcode --src <dir> --root <root> --map <file> [--apply]`；缺省 dry-run 输出 JSON 报告（将迁条数、跳过数、未知类型清单），`--apply` 才写。

- [ ] Step 1: 失败测试：fixture 目录（含 frontmatter、wiki 链接、未知 type、MEMORY.md）dry-run 报告条数正确且零写入；apply 后条目 title、summary、`imported-from` 按映射表逐一断言；同参数二次 apply 零写入。
- [ ] Step 2: 跑测确认失败。
- [ ] Step 3: 实现：frontmatter 解析复用 `@plastic/core` 的 frontmatter 模块；写入走 `store.create`。
- [ ] Step 4: 跑测通过。
- [ ] Step 5: Commit `feat(mcp): zcode memory importer with dry-run and idempotency`。

### Task 5: HTTP 模式与 REST 管理面

**Files:**
- Create: `packages/mcp/src/serve.ts`、`packages/mcp/src/rest.ts`、`packages/mcp/src/rest.spec.ts`
- Modify: `packages/mcp/src/bin.ts`（加 `serve` 子命令）

**Interfaces:**
- Consumes: Task 2 工厂、Task 3 工具的内部函数（REST 与 MCP 工具共用同一实现层，不复制逻辑）。
- Produces: `plastic-mcp serve [--port 7788] [--token <t>]`；REST 面 `GET /api/records?scope=&q=`、`GET /api/records/:id`、`PUT /api/records/:id`、`DELETE /api/records/:id`（软删）、`POST /api/records/:id/restore`、`GET /api/health`、`GET /api/promotions`（needs-promote-review 队列）。仅绑 127.0.0.1；token 启用时校验 `Authorization: Bearer`。

- [ ] Step 1: 失败测试 `rest.spec.ts`：逐端点 CRUD 往返；软删后 restore 的 id 与正文不变；`PUT` 并发过期（isChanged 命中）返回 409；非本机绑定被拒（构造时断言 listen 参数）。
- [ ] Step 2: 跑测确认失败。
- [ ] Step 3: 实现（node:http，零新运行时依赖），静态托管目录指向 `packages/webui/dist`（存在则挂载）。
- [ ] Step 4: 跑测通过。
- [ ] Step 5: Commit `feat(mcp): serve mode with REST management plane`。

### Task 6: WebUI SPA

**Files:**
- Create: `packages/webui/package.json`、`packages/webui/vite.config.ts`、`packages/webui/src/`（入口 + REST gateway 实现 `gateway.impl.ts`）、`packages/webui/src/gateway.impl.spec.ts`
- Modify: 无（复用组件从原 `client/` 以相对路径或复制导入，见 Step 3 说明）

**Interfaces:**
- Consumes: Task 5 REST 面；原 `client/gateway.ts` 的类型与接口约定；复用组件清单 = MemoryPage、library、checkup 相关页面组件及 i18n。
- Produces: `packages/webui/dist/` 静态产物，功能清单按 D5。

- [ ] Step 1: 失败测试 `gateway.impl.spec.ts`：REST gateway 对 fake HTTP 服务完成 list/get/put/delete/restore 往返，错误码 409 映射为冲突提示。
- [ ] Step 2: 跑测确认失败。
- [ ] Step 3: 实现 gateway（fetch 封装）。页面组件来源二选一并写入 commit 说明：首选从 `client/` 直接 import（workspace 内相对引用，保持单一实现）；若 Vite 对该目录的宿主依赖（`host.ts` 依赖 DSH 宿主 API）导致无法打包，则把纯展示组件复制进 webui 并在文件头标注副本来源与上游路径。
- [ ] Step 4: `pnpm --filter webui build` 产物存在；手动在浏览器完成 D5 清单走查（浏览、搜索、编辑冲突提示、软删恢复、体检待办、提升审核）。
- [ ] Step 5: Commit `feat(webui): standalone SPA over REST gateway`。

### Task 7: 三端接入与文档收尾

**Files:**
- Modify: `README.md`（新增「跨端接入」章：ZCode/Antigravity 配置片段、serve 用法、导入器用法）、`docs/design/` 新增客户端配置样例文件

- [ ] Step 1: 在 3085 隔离实例（`dsh-clean-web`）配置 plastic 插件指向测试记忆根，与 stdio MCP 实例对同一根并发写入，人工确认互不覆盖、注入正常。
- [ ] Step 2: 对 ZCode 真实库（`~/.zcode/cli/memories`）跑 dry-run，报告落盘人工过目后再 `--apply`（人工关卡：导入是破坏性较低但不可自动判定质量的动作，报告先行）。
- [ ] Step 3: ZCode setting.json 与 Antigravity MCP 配置按 D6 加片段，各自会话实测 save/search 往返。
- [ ] Step 4: README 与配置样例落盘；Commit `docs: cross-client onboarding`。

## 六、阶段与验收对照

| 阶段 | 任务 | 验收 |
|---|---|---|
| 一 | Task 1、2 | 插件全部测试通过，3085 试跑注入行为不变 |
| 二 | Task 3 | 五工具往返通过，三端并发写实证无覆盖 |
| 三 | Task 4 | dry-run 报告人工过目，apply 幂等 |
| 四 | Task 5、6 | 浏览器完成 D5 全清单走查 |
| 五 | Task 7 | ZCode/Antigravity 真机会话实测往返 |

## 七、风险与缓解

1. **fork 上游合并**：core 抽取 move-only + 每任务一 commit，冲突面集中在 import 行；upstream 有实质动作时先 rebase 本地分支再继续新任务。
2. **client 组件对宿主的隐性依赖**：Task 6 Step 3 已给判定与退路（复制并标注来源）。
3. **WebUI 治理流与 DSH GUI 并存的双入口混乱**：一期把体检拍板收敛到 WebUI，DSH GUI 的记忆页入口保留但不再新增治理功能；分叉点在 README 写明。
4. **node:sqlite 实验警告**：锁实现已含警告抑制，core 抽取原样带走，不重复处理。
