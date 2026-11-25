# 记忆页原版界面剖出与独立页面替换：设计说明（2026-11-25）

状态：已定稿，待实施。实施计划见 [2026-11-25-memory-ui-extraction-plan.md](2026-11-25-memory-ui-extraction-plan.md)。

## 目标

7788 端口上的独立页面换成 DSH 插件里的原版记忆页（项目分组、健康分、待处理角标、冲突卡片、改写建议、原文对照、最近删除），源码只留一份：DSH 插件与独立页面从同一批文件打包。独立页面背后补齐三样：原版界面依赖的数据网关的 HTTP 版、`/memory` 命令与视图写入的无宿主装配、体检打分与改写建议的模型线路。

## 已核实的事实（2026-11-25 实测）

- 记忆页界面的导入闭包从 `client/MemoryPage.tsx`、`client/ui/PanelShell.tsx`、`client/styles.ts`、`client/gateway.ts` 出发共 79 个文件，外部包只有 react、react-dom、zod、diff 与 `@plastic/core`。闭包里对 `@deepseek-ai/*` 没有运行时导入，也到不了插件入口 `client/index.tsx`。
- 组件只认 `client/gateway.ts` 的 `MemoryGateway` 接口（十一个成员，见该文件第 56 至 91 行）。DSH 的实现在同一个文件的 `createHostGateway`。
- `/memory` 命令处理器（`src/gui/commands.ts` 的 `createMemoryCommand`）、视图写入器（`src/gui/view-writer.ts` 的 `ViewWriter`）、体检后续段（`src/gui/checkup-suggestions.ts`）都是依赖注入，运行时不引框架包。从它们出发的 42 个文件里，`@deepseek-ai/*` 全是类型导入。
- 侧表（待决账本、快照、扫描缓存、建议忽略、体检记录、自动体检设置）在 `@plastic/core` 的 `SidecarStore` 里有文件实现，写锁是跨进程的。
- 根包编译产物里的包名导入保留 `.ts` 后缀（例如 `from '@plastic/core/store.ts'`），由 Node 24 的类型擦除直接加载。`packages/mcp` 的产物同样如此。
- zcode-proxy（`127.0.0.1:3091`）只开放 Anthropic Messages 格式，路径正则是 `/^\/api\/anthropic\/v1\/(messages|models)$/`。14:34 实测非流式调用 1.3 秒返回；请求体带 `thinking: {type: "disabled"}` 时不返回思维块，正文是完整的 JSON。入站 `x-api-key` 在未设 `ZCODE_PROXY_INGRESS_KEY` 时不校验。DSH 的 `glm-zcode` 路由（`baseURL: http://127.0.0.1:3091/api/anthropic`）用的模型是 GLM-5.3-Flash 与 GLM-5.3。
- 共享记忆根 `~/.dsh/memories/.state/` 目前只有 `lock/` 与 `recall-stats.json`，治理侧表与视图文件都没有生成过。独立页面是这份记忆根上第一个治理使用者。
- 宿主主题令牌 `--dsw-*` 的定义在 DSH 源码 `packages/client/ui-theme/src/styles/design-platform.css`，亮色写在 `body {…}`，暗色写在 `body[data-ds-dark-theme] {…}`。记忆页自己的 `--pm-*` 在 `client/ui/theme.ts` 里指向这些令牌。

## 设计决定

### D1 记忆页界面留在上游路径，根包开放子路径导出

`client/` 下的文件不搬家。根包 `package.json` 的 `exports` 增加两条子路径：`"./client/*": "./client/*"` 与 `"./lib/standalone/*": "./lib/standalone/*"`。发布时 `publishConfig.exports` 整体覆盖导出表，发布物不受影响。

理由有两个。两个消费者都是从源码打包（DSH 侧是 `scripts/build-client.ts` 的 esbuild，独立侧是 Vite），不需要一个运行时包。文件留在上游路径，以后合并上游时界面改动不会变成改名冲突。

### D2 边界靠测试守住

根包新增 `tests/standalone-boundary.spec.ts`，用 `tests/helpers/import-closure.ts` 算导入闭包并断言两件事。第一，界面闭包（D1 事实里的四个起点）的外部包是 react、react-dom、zod、diff、`@plastic/core` 的子集，没有 `@deepseek-ai/*` 运行时导入，到不了 `client/index.tsx`。第二，无宿主装配闭包（`src/standalone/plane.ts` 与 `src/gui/commands.ts` 等九个起点）没有 `@deepseek-ai/*` 运行时导入，到不了 `src/index.ts`、`src/cordis-host-session.ts`、`src/domain-spec.ts` 与 `src/tools/*-tool.ts`。

### D3 无宿主装配放根包 `src/standalone/`

根包已经拥有全部不依赖框架的业务代码，`src/standalone/` 是与 `src/index.ts` 并列的第二个装配入口，区别只在它不接 DSH。编译后从 `lib/standalone/plane.js` 加载，`plastic-mcp serve` 在启动时动态导入它；stdio 模式（ZCode、Antigravity）不加载。

`src/standalone/` 有三个文件。

- `llm.ts` 导出 `createAnthropicLlm(options): SemanticLlm`，把 Anthropic Messages 调用包成语义层要的 `complete({ system, user }, signal, onUsage)`。请求体固定带 `thinking: {type: "disabled"}`，正文只拼接 `type === "text"` 的块。`stop_reason` 为 `max_tokens` 时抛错，不把截断的半截 JSON 交给上层解析。
- `host.ts` 导出 `createStandaloneHost({ project, llm })`，返回命令处理器要的宿主会话读取器：项目固定为配置的那一个，子 agent 深度恒为 0，会话 id 恒为 `standalone`，模型由 `llm()` 现读。
- `plane.ts` 导出 `createGuiPlane(options): Promise<GuiPlane>`，装配根写锁、侧表、存储、待决账本、快照、类型表、AGENTS.md 写入器、指令文件读取器、体检后续段、视图写入器与命令处理器，装配方式逐项对照 `src/index.ts` 第 162 行至第 407 行。`GuiPlane` 对外只有五个动作：跑一条命令行、读一份视图原文、读记忆根内的文件、打开或显示记忆根内的文件、释放。

`src/index.ts` 不动。两处装配重复约四十行，记为后续项。

### D4 HTTP 接口

全部挂在现有 `/api` 前缀下，由 `packages/mcp/src/gui-http.ts` 的 `handleGuiRequest` 处理，鉴权沿用 `serve` 的 Bearer 规则。

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/gui/commands` | `{"line": "/memory …"}` | 200，命令处理器的结果 `{"kind":"success"\|"error","text"}`；命令失败也是 200 |
| `GET /api/gui/views/<name>` | name 取 pending、health、library、deleted、checkups、workspaces | 200 视图文件原文；文件不存在 404 `gui/view-missing`；名字不认识 404 `gui/unknown-view` |
| `GET /api/gui/file?path=<绝对路径>` | 记忆根内的文件 | 200 `{"text"}`；读不到或根外 404 `gui/file-unavailable` |
| `POST /api/gui/open` | `{"path","action":"open"\|"reveal"}` | 200 `{"ok":boolean}` |

命令行由页面用契约里现成的 `encodeMemoryCommand` 生成，服务端不经对象形态的命令，校验由命令处理器里的 `parseMemoryCommand` 完成。

### D5 页面侧网关

`packages/webui/src/gateway.http.ts` 导出 `createHttpGateway(options): MemoryGateway`，与 DSH 的宿主网关实现同一个接口，原版 `MemoryPage` 不改一行即可挂载。行为对照 `client/gateway.ts` 第 357 行至第 576 行的宿主实现，换掉的是三样底层动作：读视图文件换成 `GET /api/gui/views/<name>`，跑命令换成 `POST /api/gui/commands`，借会话换成恒定就绪的一个假会话。

- 视图缺失或版本不认识时自动发一次 `refresh-views` 再读一次，仍缺就停在缺失，不轮询。
- 命令成功、或失败码在 `VIEW_BEHIND_CODES` 里时，已读过的视图全部重读一次（服务端在回结果前已重写视图）。
- 记忆页挂载时刷新一次。标签页从后台回到前台、且距上次刷新超过 5 秒时再刷新一次：ZCode、Antigravity 的 stdio 进程写记忆后不会重写视图，原版只在打开时刷新。
- `useConfig` 恒为 `undefined`，`setConfig` 恒为 `false`：独立页面没有 DSH 配置系统，原版界面在 `undefined` 时隐藏依赖配置的控件。
- `useModel` 的语义与宿主一致，每个网关只问一次 `model-info`。

### D6 安全

- 服务仍只绑 `127.0.0.1`。
- 两个 POST 接口要求 `content-type: application/json`，否则 415 `gui/content-type`；带了 `Origin` 且不是服务自己的来源时 403 `gui/bad-origin`。这样别的网页无法借浏览器对本机服务发跨站写请求。
- 读文件与打开文件都先对记忆根和目标各做一次 `realpath`，再比较前缀。符号链接指向根外一律拒绝。打开文件的默认实现是 `xdg-open`，`reveal` 打开所在目录。
- 请求体上限 256 KiB，命令行上限 64 KiB，且必须以 `/memory` 开头。

### D7 模型线路

环境变量四个：`PLASTIC_LLM_BASE_URL`（本机填 `http://127.0.0.1:3091/api/anthropic`，适配器在后面接 `/v1/messages`）、`PLASTIC_LLM_MODEL`（本机填 `GLM-5.3-Flash`，与 DSH 压缩回退腿同一个便宜模型）、`PLASTIC_LLM_API_KEY`（可选，进 `x-api-key`）、`PLASTIC_LLM_MAX_TOKENS`（可选，缺省 4096）。前两个必须同时给或同时不给：都不给时没有模型，`model-info` 回 `llm-unavailable`，体检与改写建议按各自的既有路径记原因。单次调用超时 120 秒，超时抛错，由体检记成失败而不是挂起。

### D8 自动体检缺省不跑

自动体检调度器要在后台定时调模型。独立服务是常驻的 systemd 单元，缺省开启等于无人看着时花额度，所以缺省不启动，`PLASTIC_AUTO_CHECKUP=1` 才启动，启动时在日志里写明状态。体检视图里的自动体检设置照常可读可写，但缺省配置下不会由独立服务执行。

### D9 旧的管理面删除

手写的独立页面（`packages/webui/src/screens`、`components` 等）与它专用的 REST 记录面（`packages/mcp/src/rest.ts` 的记录读写、搜索、健康、提升、归档接口及其用例）在新页面可用后一并删除。`serve.ts` 只留 `/mcp`、`/api/gui/*`、静态托管与 Bearer 鉴权。原版界面经 `/memory` 命令走真正的执行器，自动快照与撤销由执行器保证，此前记录的「提升没有快照与撤销」「健康分与插件不一致」两项遗留随之消失。

## 不做的事

- 不搬 `client/`，也不把 `src/gui`、`src/governance` 抽成独立包。
- 不剖对话里的记忆卡片、输入框按钮、右侧栏、插件设置页。
- 独立页面不带 `--token` 运行：页面没有输口令的地方，保持仅本机绑定。
- 独立页面没有「这次对话」视图。
- 不重构 `src/index.ts`。

## 验收

1. 根包 `pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿；`pnpm build` 在 `lib/standalone/` 产出 JS 与 d.ts。
2. `@plastic/mcp` 与 `@plastic/webui` 的 `test`、`typecheck`、`build` 全绿。
3. `plastic-mcp serve` 启动后：`POST /api/gui/commands` 跑 `/memory info` 回 `ok: true`；`GET /api/gui/views/library` 回合法的库视图；带外来源的 POST 与 `text/plain` 的 POST 被拒；`/api/gui/file?path=/etc/passwd` 回 404。
4. 浏览器打开 `http://127.0.0.1:7788`：三栏原版记忆页、健康分、项目分组可见，中英文可切换，暗色跟随系统。
5. DSH 侧不回归：3086 实例的记忆页照常渲染。
6. ZCode、Antigravity 用的 stdio 模式不受影响：`@plastic/mcp` 既有用例全绿。
