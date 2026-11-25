# 记忆页原版界面剖出与独立页面替换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 7788 端口的独立页面换成 DSH 插件里的原版记忆页，界面源码只留一份，独立页面背后补齐 HTTP 版数据网关、`/memory` 命令的无宿主装配与模型线路。

**Architecture:** 记忆页界面留在根包 `client/` 不动，根包用子路径导出开放给 `packages/webui`（Vite 从同一份源码打包）。根包新增 `src/standalone/`，是与 `src/index.ts` 并列的无宿主装配入口，产出 `lib/standalone/plane.js`。`packages/mcp` 的 `serve` 模式在 `/api/gui/*` 下把它暴露成四个 HTTP 接口并托管页面。`packages/webui` 用一个 HTTP 版 `MemoryGateway` 挂载原版 `MemoryPage`。

**Tech Stack:** TypeScript（Node 24 类型擦除加载 `.ts` 深路径）、React 18、zod 4、Vite 7、vitest 3、node:http、Anthropic Messages 格式（zcode-proxy）。

**Spec:** [../design/2026-11-25-memory-ui-extraction-spec.md](../design/2026-11-25-memory-ui-extraction-spec.md)

## 开工前（编排者做，不单独成任务）

- [ ] 在独立工作树里开发，主检出留给正在运行的 7788 服务与 3085、3086 实例：

```bash
cd /home/luo/projects/202611/dsh-plastic-memory
git worktree add ../dsh-plastic-memory-ui -b feat/memory-ui-standalone
cd ../dsh-plastic-memory-ui
pnpm install --prefer-offline
pnpm typecheck && pnpm --filter @plastic/mcp test
```

  预期：安装无报错，typecheck 无输出，`@plastic/mcp` 用例全绿。此后所有路径都相对 `/home/luo/projects/202611/dsh-plastic-memory-ui`。
- [ ] 读一遍 spec 的「设计决定」与下面「全局约束」，再派第一个任务。

## Global Constraints

- 不改 `client/` 下任何文件。`src/gui`、`src/governance`、`src/tools`、`src/type-registry.ts` 也不改；装配确实需要一个未导出的已有函数时才加 `export`，改动最小，并在交付卡里单列。
- `src/standalone/*.ts` 只用可擦除语法：不写 `enum`、构造器参数属性、`namespace`。运行时加载走 Node 的类型擦除。
- 零新运行时依赖：HTTP 层只用 `node:http`、`node:fs`、`node:path`、`node:child_process`；模型适配器用全局 `fetch`。`packages/webui` 新增的依赖只有 `dsh-plastic-memory`（工作区）、`zod`、`diff` 与测试库。
- 新导出都带一行 JSDoc 说明契约；注释密度与周围代码一致。文件以单个换行结尾。
- 每个任务提交前跑通：该任务的测试、根目录 `pnpm lint`、改动涉及的包的 `typecheck`。
- 构建顺序固定：`@plastic/core` → 根包 → `@plastic/mcp` → `@plastic/webui`。后两个包的类型检查读前者的 `lib/*.d.ts`。

## Review Focus

1. 读记忆根之外的文件（`../../etc/passwd`、根内符号链接指向根外）必须被拒绝。测试在 Task 3。
2. 别的网页借浏览器对本机服务发跨站写请求（带外来源的 `Origin`，或 `text/plain` 的简单请求）必须被拒。测试在 Task 4。
3. 模型代理排队或卡死时调用不能无限等：120 秒超时抛错，体检记失败。测试在 Task 2。
4. 模型输出被 `max_tokens` 截断时不能把半截 JSON 交给上层：抛带 `max_tokens` 字样的错误。测试在 Task 2。
5. 视图文件还没生成（首次启动、别的进程删了 `.state/gui`）时页面不能停在空白：自动发一次 `refresh-views` 后显示。测试在 Task 3 与 Task 5。

---

### Task 1: 根包子路径导出、声明产物与边界门禁

**Files:**
- Modify: `package.json`（`exports`）、`tsconfig.build.json`（`declaration`）
- Create: `tests/helpers/import-closure.ts`、`tests/standalone-boundary.spec.ts`

**Interfaces:**
- Produces: 根包可按 `dsh-plastic-memory/client/<file>` 与 `dsh-plastic-memory/lib/standalone/<file>` 导入；`lib/**/*.d.ts` 随 `pnpm build` 产出。
- Produces: `importClosure(roots: readonly string[]): { files: string[]; externals: Map<string, Set<string>>; runtimeImports: Array<{ file: string; spec: string }> }`，相对导入按 `.ts`、`.tsx`、`index.ts` 补全，跳过 `*.spec.*`；`runtimeImports` 只收不是 `import type` 、也不是 `import { type X }` 形式的导入。

- [ ] **Step 1: 写失败的门禁用例**

`tests/standalone-boundary.spec.ts` 两个用例。

```ts
const PAGE_ROOTS = ['client/MemoryPage.tsx', 'client/ui/PanelShell.tsx', 'client/styles.ts', 'client/gateway.ts']
const PLANE_ROOTS = [
  'src/gui/commands.ts', 'src/gui/view-writer.ts', 'src/gui/checkup-suggestions.ts', 'src/gui/auto-checkup.ts',
  'src/governance/instructions.ts', 'src/type-registry.ts',
]

it('记忆页界面闭包不依赖宿主运行时', () => {
  const c = importClosure(PAGE_ROOTS)
  expect([...c.externals.keys()].sort()).toEqual(['@plastic/core', 'diff', 'react', 'react-dom', 'zod'])
  expect(c.runtimeImports.filter(r => r.spec.startsWith('@deepseek-ai/'))).toEqual([])
  expect(c.files).not.toContain('client/index.tsx')
})

it('无宿主装配闭包不含框架运行时导入', () => {
  const c = importClosure(PLANE_ROOTS)
  expect(c.runtimeImports.filter(r => r.spec.startsWith('@deepseek-ai/'))).toEqual([])
  expect(c.files.filter(f => /src\/index\.ts$|cordis-host-session|domain-spec|-tool\.ts$/.test(f))).toEqual([])
})
```

- [ ] **Step 2: 跑它确认失败**

Run: `pnpm vitest run --project node tests/standalone-boundary.spec.ts`
预期：FAIL，`Cannot find module './helpers/import-closure.ts'`。

- [ ] **Step 3: 实现 `tests/helpers/import-closure.ts`**

正则同时匹配 `from '…'`、`import('…')` 与裸 `import '…'`；判定类型导入用两条正则（`import type … '<spec>'` 与行首空白 `type … '<spec>'`）。实现照本次设计核对时用过的脚本：`client` 闭包 79 个文件、外部包恰为列出的五个。

- [ ] **Step 4: 改导出表与声明产物**

`package.json` 的 `exports` 加 `"./client/*": "./client/*"` 与 `"./lib/standalone/*": "./lib/standalone/*"`；`publishConfig.exports` 不动。`tsconfig.build.json` 里 `"declaration": false` 改 `true`。

- [ ] **Step 5: 验证**

Run: `pnpm vitest run --project node tests/standalone-boundary.spec.ts && pnpm lint && pnpm typecheck && pnpm build && ls lib/gui/commands.d.ts lib/index.d.ts`
预期：两个用例 PASS，lint 无输出，`ls` 列出两个 d.ts。

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.build.json tests/helpers/import-closure.ts tests/standalone-boundary.spec.ts docs/design
git commit -m "feat(standalone): export client and standalone subpaths, emit declarations, add boundary gate"
```

（`lib/` 在 `.gitignore` 里，构建产物不进提交。）

---

### Task 2: 模型线路适配器 `createAnthropicLlm`

**Files:**
- Create: `src/standalone/llm.ts`、`tests/standalone-llm.spec.ts`

**Interfaces:**
- Consumes: `SemanticLlm`（`src/governance/semantic-scan.ts` 第 7 行：`model?`、`complete(input, signal?, onUsage?)`）。
- Produces:

```ts
export interface AnthropicLlmOptions {
  /** 形如 http://127.0.0.1:3091/api/anthropic；适配器在后面接 /v1/messages。 */
  baseUrl: string
  model: string
  /** 进 x-api-key；不给就不带这个头。 */
  apiKey?: string
  /** 缺省 4096。 */
  maxTokens?: number
  /** 缺省 120_000。 */
  timeoutMs?: number
  fetch?: typeof fetch
}
export function createAnthropicLlm(options: AnthropicLlmOptions): SemanticLlm
```

- [ ] **Step 1: 写失败用例**（`tests/standalone-llm.spec.ts`，注入记录调用的假 `fetch`）

  - `只拼接正文块并带全请求字段`：响应 `content` 为一个 `thinking` 块加两个 `text` 块，`complete` 返回两段文本；请求 URL 以 `/v1/messages` 结尾；请求体 `model`、`max_tokens: 4096`、`thinking: {type: 'disabled'}`、`system`、`messages: [{role: 'user', content}]` 逐项相等；头有 `anthropic-version: 2023-06-01`，没给 `apiKey` 时没有 `x-api-key`。
  - `按实际用量回调一次`：`usage` 为 `{input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2}` 时 `onUsage` 收到 `42`。
  - `非 2xx 抛出带状态码与上游消息的错误`：响应 401 `{"msg":"令牌已过期"}`，错误消息同时含 `401` 与 `令牌已过期`。
  - `输出被 max_tokens 截断时抛错`：`stop_reason: "max_tokens"` 时抛错，消息含 `max_tokens`。
  - `调用前已取消则不发请求`：传入已 abort 的 signal，假 `fetch` 没被调用，抛出的错误 `name` 为 `AbortError`。
  - `超时抛错`：假 `fetch` 永不返回但响应 signal，`timeoutMs: 20`，20 毫秒量级内 reject。

- [ ] **Step 2: 确认失败**

Run: `pnpm vitest run --project node tests/standalone-llm.spec.ts`
预期：FAIL，找不到 `src/standalone/llm.ts`。

- [ ] **Step 3: 实现 `src/standalone/llm.ts`**

超时用 `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`；中止时抛 `signal.reason`（是 `DOMException` 时 `name` 即 `AbortError`）。

- [ ] **Step 4: 验证**

Run: `pnpm vitest run --project node tests/standalone-llm.spec.ts && pnpm lint && pnpm typecheck`
预期：六个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/standalone/llm.ts tests/standalone-llm.spec.ts
git commit -m "feat(standalone): Anthropic Messages model adapter for the governance plane"
```

---

### Task 3: 无宿主装配 `createGuiPlane`

**Files:**
- Create: `src/standalone/host.ts`、`src/standalone/plane.ts`、`tests/standalone-plane.spec.ts`
- Modify: `tests/standalone-boundary.spec.ts`（`PLANE_ROOTS` 加 `'src/standalone/plane.ts'`、`'src/standalone/host.ts'`、`'src/standalone/llm.ts'`）

**Interfaces:**
- Consumes: `createMemoryCommand`（`src/gui/commands.ts:130`）、`ViewWriter`（`src/gui/view-writer.ts:185`）、`CheckupSuggestions`、`collectGlobalViews`、`collectCheckupView`、`AutoCheckupScheduler`（`src/gui/auto-checkup.ts`）、`SidecarStore`、`createRootLock`、`createAgentsMdWriter`、`agentsMdPath`、`buildTypeRegistry`、`PRESET_SCENES`、`goneCopies`、四个 schema、`createInstructionReader`。
- Produces:

```ts
export const STANDALONE_SESSION_ID = 'standalone'
export function createStandaloneHost(deps: { project: string; llm: () => SemanticLlm | null }):
  ContextHost<{ workspacePath: string | undefined; delegationDepth: number; session: { id: string } }> & Pick<HostSession, 'llmOf'>

export type GuiViewName = 'pending' | 'health' | 'library' | 'deleted' | 'checkups' | 'workspaces'
export interface GuiPlaneOptions {
  memoryRoot: string
  /** 各端配置里写死的那个项目（PLASTIC_PROJECT）；不带作用域的命令按它定位。 */
  project: string
  llm?: SemanticLlm | null
  /** 缺省 false：不启动自动体检调度器（spec D8）。 */
  autoCheckup?: boolean
  /** 打开与显示文件的实现；缺省 xdg-open。 */
  open?: (path: string, action: 'open' | 'reveal') => Promise<boolean>
  instructions?: ReadInstructions
  log?: MemoryLogger
  now?: () => number
}
export interface GuiPlane {
  readonly memoryRoot: string
  readonly project: string
  /** 跑一条 `/memory` 命令行，与宿主命令处理器同一个入口。 */
  run(rawInput: string): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  readView(name: GuiViewName): Promise<{ status: 'ready'; text: string } | { status: 'missing' }>
  /** 记忆根内的文件全文；根外（含符号链接指向根外）或读不到为 undefined。 */
  readFile(path: string): Promise<string | undefined>
  /** 根外拒绝并返回 false。 */
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
  dispose(): Promise<void>
}
export async function createGuiPlane(options: GuiPlaneOptions): Promise<GuiPlane>
```

- [ ] **Step 1: 写失败用例**（`tests/standalone-plane.spec.ts`，临时目录做记忆根；建记忆、写记录的夹具写法照 `tests/gui-commands.spec.ts` 开头）

  - `创建时写出全局视图并登记项目归属`：`readView('library')` 为 ready 且文本过 `libraryViewSchema`；`readView('workspaces')` 的 JSON 里 `cwds[project] === project`。
  - `命令走同一个处理器`：`run('/memory info')` 的 `kind` 为 `success`，`JSON.parse(text)` 的 `ok` 为 true 且 `info.memoryRoot` 等于传入的根；`run('/memory 不存在的子命令')` 的 `kind` 为 `error`。
  - `model-info 反映模型有无`：给假 `llm`（`model: 'm'`，`complete` 原样返回）时结果 `ok: true, model: 'm'`；不给时 `ok: false, code: 'llm-unavailable'`。
  - `忘记后出现在最近删除、撤销后回来`：对一条已有记录跑 `forget`（写法照 `tests/gui-commands.spec.ts` 里的 forget 用例），`readView('deleted')` 含该 id；跑 `undo` 后库视图里该 id 回来。
  - `记忆根外的文件读不到`：`readFile(join(tmp, 'outside.txt'))` 为 `undefined`；在根内建一个指向它的符号链接，读链接也是 `undefined`；根内普通文件返回全文。
  - `记忆根外的路径不打开`：注入的 `open` 记录调用，根外路径返回 `false` 且 `open` 没被调用；根内路径返回注入实现的 `true`。
  - `释放后不留计时器`：`autoCheckup: true` 创建后 `dispose()`，`vi.getTimerCount()` 为 0。
  - `指令文件读取不抛错`：默认的 `instructions({kind: 'global'})` 与 `instructions({kind: 'workspace', workspacePath: tmp})` 都能落到三种结果之一。

- [ ] **Step 2: 确认失败**

Run: `pnpm vitest run --project node tests/standalone-plane.spec.ts`
预期：FAIL，找不到 `src/standalone/plane.ts`。

- [ ] **Step 3: 实现 `host.ts`**

`contextOf` 忽略入参，返回 `{ workspacePath: deps.project, delegationDepth: 0, session: { id: STANDALONE_SESSION_ID } }`；`llmOf` 返回 `deps.llm()`。

- [ ] **Step 4: 实现 `plane.ts`**

装配逐项对照 `src/index.ts`：根写锁第 162 行、侧表第 168 行（`openLegacyKv` 不给）、文件表与存储第 205 至 214 行（`formatIndexLine` 同款）、五个治理存储第 216 至 225 行、类型表第 143 行（入参取 schema 缺省：`template: 'custom'`、`customTypes: {}`、`scenes: PRESET_SCENES`、`removedPresetTypes: []`）、AGENTS.md 第 278 行、指令读取器第 228 行、体检后续段第 361 行、`collectViews` 第 367 行、视图写入器第 389 行、命令处理器第 399 行。创建时 `await writer.requestWorkspace(project, project)` 与 `await writer.rewriteAll()`，再 `await writer.requestCheckups()`。`autoCheckup` 为 true 时按第 426 至 449 行建调度器，`timer` 用 `setTimeout`、`setInterval` 的停掉函数。`readView` 的路径按契约的 `GUI_VIEW_DIR`、`GUI_VIEW_FILES`、`GUI_CHECKUP_VIEW_FILE`、`GUI_WORKSPACE_MAP_FILE` 拼，`ENOENT` 回 missing。`readFile` 与 `openPath` 共用一个根内判定：对根与目标各 `realpath` 后比较路径前缀，前缀比较按路径段而不是字符串前缀。

- [ ] **Step 5: 边界门禁补起点并验证**

Run: `pnpm vitest run --project node tests/standalone-plane.spec.ts tests/standalone-boundary.spec.ts && pnpm lint && pnpm typecheck && pnpm build`
预期：全部 PASS，`ls lib/standalone/plane.d.ts` 存在。

- [ ] **Step 6: Commit**

```bash
git add src/standalone tests/standalone-plane.spec.ts tests/standalone-boundary.spec.ts
git commit -m "feat(standalone): host-free assembly of the /memory command and view plane"
```

---

### Task 4: HTTP 接口 `handleGuiRequest` 与 `serve` 接线

**Files:**
- Create: `packages/mcp/src/gui-http.ts`、`packages/mcp/src/gui-http.spec.ts`、`packages/mcp/src/serve.spec.ts`
- Modify: `packages/mcp/package.json`、`packages/mcp/src/serve.ts`、`packages/mcp/src/bin.ts`

**Interfaces:**
- Consumes: Task 3 的 `GuiPlane`（结构一致即可）；`dsh-plastic-memory/src/gui/contract.ts` 里的 `GUI_VIEW_FILES`。
- Produces:

```ts
export interface GuiPlanePort {
  memoryRoot: string
  run(rawInput: string): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  readView(name: string): Promise<{ status: 'ready'; text: string } | { status: 'missing' }>
  readFile(path: string): Promise<string | undefined>
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
  dispose(): Promise<void>
}
/** 路径归它管时处理并返回 true。allowedOrigin 是服务自己的来源（如 http://127.0.0.1:7788）。 */
export async function handleGuiRequest(plane: GuiPlanePort, req: IncomingMessage, res: ServerResponse, url: URL, allowedOrigin: string): Promise<boolean>
```

- [ ] **Step 1: 写失败用例**（`gui-http.spec.ts`，假 plane 记调用；用 node:http 起随机端口的真服务发真请求，响应读取写成一个 `send(path, init)` 助手）

  - `命令行交给 plane 并原样回结果`：`POST /api/gui/commands`，体 `{"line":"/memory info"}`，`content-type: application/json` → 200，体等于 plane 的返回；plane 收到的 `rawInput` 就是那一行。
  - `命令行不合规回 400`：`line` 不是以 `/memory` 开头的字符串 → 400 `gui/bad-line`；体不是 JSON 对象 → 400 `gui/bad-request`；plane 没被调用。
  - `写接口拒绝非 JSON 与外来源`：`content-type: text/plain` → 415 `gui/content-type`；`origin: https://evil.example` → 403 `gui/bad-origin`；`origin` 等于 `allowedOrigin` → 200。
  - `请求体超限回 413`：体长 256 KiB 加一字节 → 413 `gui/too-large`。
  - `视图按名字读`：ready → 200，响应体是原文，`content-type` 为 `application/json`；missing → 404 `gui/view-missing`；`/api/gui/views/nope` → 404 `gui/unknown-view`。
  - `文件接口`：`readFile` 回文本 → 200 `{"text": …}`；回 `undefined` → 404 `gui/file-unavailable`。
  - `打开接口`：`action` 不是 `open`、`reveal` → 400；合法 → 200 `{"ok":true}`。
  - `不归它管的路径返回 false`：`/api/records` → false，响应没被写。

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @plastic/mcp test -- gui-http`
预期：FAIL，找不到 `./gui-http.ts`。

- [ ] **Step 3: 实现 `gui-http.ts`**

读体上限 256 KiB，超限 413 `gui/too-large`；命令行上限 64 KiB。错误体统一 `{"error":{"code":"…","message":"…"}}`，复用 `rest.ts` 导出的 `sendError`、`sendJson`。`origin` 头存在且不等于 `allowedOrigin` 即拒。

- [ ] **Step 4: 接进 `serve.ts` 与 `bin.ts`，并写 `serve.spec.ts`**

`MemoryHttpServerOptions` 加 `gui?: GuiPlanePort`：有它时 `/api/gui/` 前缀先交 `handleGuiRequest`，鉴权与 `/api` 同规则；`close()` 里 `await gui.dispose()`。`bin.ts` 的 `serve` 分支在 `runServeCli` 之前读环境变量并动态导入 `dsh-plastic-memory/lib/standalone/plane.js` 的 `createGuiPlane`；导入失败时 `fail('独立页面需要根包的构建产物：先在仓库根目录跑 pnpm build')`。`serve.ts` 新增并导出：

```ts
/** serve 模式的界面与模型线路配置，全部来自环境变量（spec D7、D8）。 */
export function parseGuiEnv(env: NodeJS.ProcessEnv): { project: string; llm: { baseUrl: string; model: string; apiKey?: string; maxTokens?: number } | undefined; autoCheckup: boolean }
```

规则：`PLASTIC_PROJECT` 必填且为绝对路径，缺了抛带变量名的错误；`PLASTIC_LLM_BASE_URL` 与 `PLASTIC_LLM_MODEL` 必须同给同缺，只给一个抛错；`PLASTIC_LLM_MAX_TOKENS` 不是正整数抛错；`PLASTIC_AUTO_CHECKUP` 等于 `1` 才是 true。给 `parseGuiEnv` 写四个用例（缺项目、只给一个模型变量、完整、`AUTO_CHECKUP`）。`serve.spec.ts` 一个用例：带假 `gui` 与临时 `webuiDir` 起服务（端口 0），`GET /` 回 `index.html`，`POST /api/gui/commands` 通，`close()` 后假 plane 的 `dispose` 被调用。`bin.ts` 在界面装配完成后写一行日志，说明自动体检调度器是开是关。

- [ ] **Step 5: 加依赖并验证**

`packages/mcp/package.json` 的 `dependencies` 加 `"dsh-plastic-memory": "workspace:*"`，跑 `pnpm install --prefer-offline`。

Run: `pnpm build && pnpm --filter @plastic/mcp typecheck && pnpm --filter @plastic/mcp test && pnpm --filter @plastic/mcp build && pnpm lint`
预期：全绿。`bin.ts` 里 `createGuiPlane` 的返回值直接赋给 `gui`，类型检查通过即证明 Task 3 的 `GuiPlane` 与 `GuiPlanePort` 结构一致。

- [ ] **Step 6: Commit**

```bash
git add packages/mcp package.json pnpm-lock.yaml
git commit -m "feat(mcp): expose the GUI plane over /api/gui and wire it into serve"
```

---

### Task 5: 页面侧 HTTP 网关 `createHttpGateway`

**Files:**
- Create: `packages/webui/src/gateway.http.ts`、`packages/webui/src/gateway.http.spec.tsx`、`packages/webui/src/test-setup.ts`
- Modify: `packages/webui/package.json`、`packages/webui/vitest.config.ts`

**Interfaces:**
- Consumes: `MemoryGateway`、`ViewState`、`parseView`、`decodeExecution`、`useGateway`（`dsh-plastic-memory/client/gateway.ts`）；`createDeletionStore`（`dsh-plastic-memory/client/deletions.ts`）；`encodeMemoryCommand`、`memoryCommandResultSchema`、`VIEW_BEHIND_CODES`（`@plastic/core/gui/contract.ts`）。
- Produces:

```ts
export const GUI_API = '/api/gui'
export interface HttpGatewayOptions {
  fetch?: typeof fetch
}
export function createHttpGateway(options?: HttpGatewayOptions): MemoryGateway
```

- [ ] **Step 1: 写失败用例**（用 `@testing-library/react` 的 `renderHook`，注入假 `fetch` 按路径与次数回放；jest-dom 与 `cleanup` 放在 `test-setup.ts`，`vitest.config.ts` 设 `environment: 'jsdom'` 与 `setupFiles`）

  - `首次读视图从读取中到就绪`：`useView(session, 'library')` 先 `loading`，`GET /api/gui/views/library` 回合法库视图后 `ready`。
  - `视图缺失时自动刷新一次再读`：第一次 404、第二次 200 → 终态 ready，且恰好发过一次 `POST /api/gui/commands`，体为 `{"line":"/memory refresh-views"}`。
  - `刷新后仍不认识就停在过时`：两次都回 `version` 不对的 JSON → 终态 `outdated`，`refresh-views` 只发一次。
  - `命令成功后已读视图重读`：先读 library 就绪，`execute(sessionId, {cmd: 'info'})` 成功 → library 又被读一次；`cmd` 失败且 `code` 不在 `VIEW_BEHIND_CODES` 时不重读。
  - `模型只问一次`：两处同时 `useModel(session)` → `model-info` 命令只发一次；回 `llm-unavailable` 时状态为 `unavailable`；`shouldAsk: false` 时不发。
  - `挂载时刷新一次`：`useFreshViews(session)` → 恰好一次 `refresh-views`。
  - `回到前台满五秒才再刷新`：挂载后立刻发一次 `visibilitychange`（`document.visibilityState` 为 `visible`），距挂载不足 5000 毫秒，不再发；假时钟推进 5000 毫秒后再发一次 → `refresh-views` 共两次。
  - `会话恒定就绪`：`useSession(undefined)` 为 `{kind: 'ready', sessionId: 'standalone', cwd: undefined}`；`useCurrentWorkspace()` 为 `{status: 'ready', workspacePath: undefined}`；`useConfig()` 为 `undefined`。
  - `忘记后删除状态记下`：`execute` 跑一条成功的 forget（结果形状照 `memoryCommandResultSchema` 里 forget 的成功分支）→ `useDeletions().of(id)` 为 `'soft'`。
  - `网络失败折成 failed`：`fetch` reject → `execute` 的结果 `ok: false, code: 'failed'`。
  - `读文件`：200 `{"text":"a"}` → `'a'`；404 → `undefined`。

- [ ] **Step 2: 确认失败**

`packages/webui/package.json` 的 `dependencies` 加 `"zod": "4.4.3"`、`"diff": "^9.0.0"`，`devDependencies` 加 `"dsh-plastic-memory": "workspace:*"`、`"@testing-library/react": "^16.3.3"`、`"@testing-library/jest-dom": "^6.9.1"`、`"jsdom": "29.1.1"`，`pnpm install --prefer-offline`。

Run: `pnpm --filter @plastic/webui test -- gateway.http`
预期：FAIL，找不到 `./gateway.http.ts`。

- [ ] **Step 3: 实现 `gateway.http.ts`**

网关对象只建一次（`useMemo` 不适用：在 React 之外创建，成员是 hook）。内部三份 store（视图状态、模型状态、删除状态）用 `useSyncExternalStore` 订阅。`useFreshViews` 另加 `visibilitychange` 监听：回到前台且距上次刷新满 5000 毫秒才刷新。`execute` 把 HTTP 结果包成 `{ok: true, value: {commandId: '', result}}` 交给 `decodeExecution`；网络错误包成 `{ok: false, error: {code: 'http', message}}`。视图 ready 且名为 `deleted` 或 `library` 时调 `deletions.settle`，与宿主实现第 399 至 400 行一致。

- [ ] **Step 4: 验证**

Run: `pnpm --filter @plastic/webui typecheck && pnpm --filter @plastic/webui test`
预期：新用例全绿，既有 `gateway.impl.spec.ts` 仍绿（Task 7 才删）。

- [ ] **Step 5: Commit**

```bash
git add packages/webui package.json pnpm-lock.yaml
git commit -m "feat(webui): HTTP gateway implementing MemoryGateway for the standalone page"
```

---

### Task 6: 挂载原版记忆页，主题令牌与语言切换

**Files:**
- Create: `packages/webui/src/host-tokens.css`、`packages/webui/src/host-tokens.spec.ts`、`packages/webui/src/locale.ts`、`packages/webui/src/locale.spec.tsx`、`packages/webui/src/App.tsx`、`packages/webui/src/App.spec.tsx`
- Modify: `packages/webui/src/main.tsx`、`packages/webui/index.html`

**Interfaces:**
- Consumes: `PanelShell`、`PM_CSS`（`dsh-plastic-memory/client/ui/PanelShell.tsx`）；`slotCss`（`dsh-plastic-memory/client/styles.ts`）；`MemoryPage`（`dsh-plastic-memory/client/MemoryPage.tsx`）；`createNavStore`（`dsh-plastic-memory/client/nav.ts`）；`createTranslator`、`zh`、`en`（`dsh-plastic-memory/client/i18n.tsx`、`client/locales.ts`）；Task 5 的 `createHttpGateway`。
- Produces:

```ts
/** 独立页面的语言：缺省中文，选择记在 localStorage 的 plastic-memory.webui.locale。 */
export function useStandaloneTranslate(): { t: Translate; locale: 'zh' | 'en'; setLocale(locale: 'zh' | 'en'): void }
/** 独立页面根组件；gateway 缺省用 createHttpGateway()，用例注入假网关。 */
export function App(props: { gateway?: MemoryGateway }): JSX.Element
```

- [ ] **Step 1: 写失败的用例**

  - `host-tokens.spec.ts`（CSS 用 Vite 的 `?raw` 导入）：`PM_CSS + slotCss('page')` 里引用的每个 `--dsw-*` 变量都在 `host-tokens.css` 里有定义（亮色与暗色两块取并集）。
  - `locale.spec.tsx`：缺省 `zh`；`setLocale('en')` 后 localStorage 键值为 `en`，`t` 给出英文。
  - `App.spec.tsx`（注入假网关，写法照根包 `client/MemoryPage.spec.tsx` 开头的假网关构造，根包 `client/gateway.fake.ts` 可直接用）：渲染后能找到「待处理」「记忆查看」「最近删除」三个页签；切到英文后页签换成英文。

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @plastic/webui test`
预期：三个新用例文件 FAIL。

- [ ] **Step 3: 令牌与语言**

`host-tokens.css` 从 DSH 源码 `/home/luo/projects/202608/alpha/dsh/packages/client/ui-theme/src/styles/design-platform.css` 抄两段：第一个 `body {…}` 块与第一个 `body[data-ds-dark-theme] {…}` 块里的全部 `--dsw-*` 定义，外加第一个 `body` 块的 `font-family`、`color`、`background` 相关声明。文件头注释写明来源路径与抄录日期。

- [ ] **Step 4: `App.tsx` 与 `main.tsx`**

`App` 渲染：`PanelShell`（`className="pm-root--page webui-root"`，`extraCss={slotCss('page')}`）里先放一条页眉（标题走字典 `nav.label`，右侧一个中英文切换按钮，按钮文案也走字典），下面是 `MemoryPage`，导航 store 用 `createNavStore()`。`main.tsx` 导入 `host-tokens.css`，按 `matchMedia('(prefers-color-scheme: dark)')` 给 `document.body` 设或删 `data-ds-dark-theme` 并监听变化，再挂载 `App`。页面根容器给满视口（`height: 100dvh`、纵向 flex、`overflow: hidden`），`MemoryPage` 所在容器 `flex: 1; min-height: 0`；动手前先读 `MemoryPage.tsx` 导出的 `memoryPageCss` 第一条规则，按它对容器的假设（容器查询、百分比高度）补齐。`index.html` 设 `lang="zh-CN"`、标题「记忆」。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @plastic/webui typecheck && pnpm --filter @plastic/webui test && pnpm --filter @plastic/webui build && ls -la packages/webui/dist/assets`
预期：全绿，`dist/index.html` 引用一个 JS 与一个 CSS 产物。

- [ ] **Step 6: Commit**

```bash
git add packages/webui
git commit -m "feat(webui): mount the original memory page with host tokens and locale toggle"
```

---

### Task 7: 删除旧的管理面与手写页面

**Files:**
- Delete: `packages/webui/src/screens/`、`packages/webui/src/components/`、`packages/webui/src/gateway.impl.ts`、`packages/webui/src/gateway.impl.spec.ts`、`packages/webui/src/records.ts`、`packages/webui/src/i18n.tsx`、`packages/webui/src/locales.ts`、`packages/webui/src/locales/`、`packages/webui/src/styles.ts`、`packages/webui/src/styles/`、`packages/webui/src/path.ts`（先 `grep` 确认 `App.tsx`、`gateway.http.ts`、`locale.ts` 都不引用再删）
- Modify: `packages/mcp/src/rest.ts`（只留 `API_PREFIX`、`sendJson`、`sendError`）、`packages/mcp/src/serve.ts`（去掉旧 REST 的接线，`MemoryHttpServerOptions` 里只被旧 REST 用到的字段一并删除）、`packages/mcp/src/bin.ts`（`serve` 分支跟着少传参数）
- Delete: `packages/mcp/src/rest.spec.ts` 里对应已删接口的用例（或整份）

- [ ] **Step 1: 删除并接线**

`serve.ts` 的路由只剩 `/mcp`、`/api/gui/*`、静态托管。`createRestHandler` 与它的依赖一并删除；`API_PREFIX`、`sendJson`、`sendError` 搬进 `gui-http.ts` 或留在一个新的 `http-util.ts`，名字不变。

- [ ] **Step 2: 验证**

Run: `pnpm --filter @plastic/mcp typecheck && pnpm --filter @plastic/mcp test && pnpm --filter @plastic/mcp build && pnpm --filter @plastic/webui typecheck && pnpm --filter @plastic/webui test && pnpm --filter @plastic/webui build && pnpm lint`
预期：全绿；`grep -rn "createRestHandler\|gateway.impl" packages/` 无结果。

- [ ] **Step 3: Commit**

```bash
git add -A packages/mcp packages/webui
git commit -m "refactor: remove the hand-rolled WebUI and its record REST plane"
```

---

### Task 8: 文档与执行记录

**Files:**
- Modify: `README.md`（「跨端接入」里的 Web 面板一段）、`docs/design/exec-log-20261125.md`

- [ ] **Step 1: README**

Web 面板一段写清四件事：页面就是 DSH 里的原版记忆页，源码在 `client/`；启动 `plastic-mcp serve` 前的构建顺序（根包 `pnpm build`，再 `@plastic/mcp`、`@plastic/webui` 各自 `build`）；模型线路的四个环境变量与缺省无模型的行为；自动体检缺省不跑与打开方式。

- [ ] **Step 2: 执行记录**

`exec-log-20261125.md` 追加「记忆页剖出」一节：裁决编号接着现有编号往下排；每条裁决写问题、结论、理由一句话；末尾列后续项（`src/index.ts` 与 `src/standalone/plane.ts` 的装配重复、`--token` 与页面不配套、自动体检在独立服务缺省关闭）。

- [ ] **Step 3: Commit**

```bash
git add README.md docs/design
git commit -m "docs: standalone page now serves the original memory page; record rulings"
```

---

### Task 9: 上线与验证（主会话执行）

- [ ] **Step 1: 合并回主检出**

```bash
cd /home/luo/projects/202611/dsh-plastic-memory
git merge --ff-only feat/memory-ui-standalone
```

- [ ] **Step 2: 按顺序构建**

```bash
pnpm build && pnpm --filter @plastic/mcp build && pnpm --filter @plastic/webui build
```

- [ ] **Step 3: 给服务单元加模型线路**（用 drop-in，不改原单元）

`~/.config/systemd/user/plastic-memory-web.service.d/10-llm.conf`：

```ini
[Service]
Environment=PLASTIC_LLM_BASE_URL=http://127.0.0.1:3091/api/anthropic
Environment=PLASTIC_LLM_MODEL=GLM-5.3-Flash
Environment=PLASTIC_LLM_API_KEY=plastic-webui
```

```bash
systemctl --user daemon-reload && systemctl --user restart plastic-memory-web.service && sleep 2 && systemctl --user is-active plastic-memory-web.service
```

- [ ] **Step 4: 接口证据**

```bash
curl -s -X POST 127.0.0.1:7788/api/gui/commands -H 'content-type: application/json' -d '{"line":"/memory info"}'
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:7788/api/gui/views/library
curl -s -X POST 127.0.0.1:7788/api/gui/commands -H 'content-type: text/plain' -d '{}'
curl -s -X POST 127.0.0.1:7788/api/gui/commands -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' '127.0.0.1:7788/api/gui/file?path=/etc/passwd'
curl -s -X POST 127.0.0.1:7788/api/gui/commands -H 'content-type: application/json' -d '{"line":"/memory model-info"}'
```

预期：第一条 `ok: true`；第二条 `200`；第三条 `415`；第四条 `403`；第五条 `404`；第六条 `ok: true` 且 `model` 为 `GLM-5.3-Flash`。

- [ ] **Step 5: 页面与回归**

浏览器打开 `http://127.0.0.1:7788`，`browser_a11y` 确认三个页签与健康分，截图落盘。打开 `http://127.0.0.1:3086` 的记忆页确认照常渲染。`journalctl --user -u plastic-memory-web.service -n 20` 有「HTTP 模式已启动」。
