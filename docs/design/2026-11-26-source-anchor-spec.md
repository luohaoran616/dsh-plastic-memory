# plastic-memory 真来源锚：独立端写入带会话锚、第七个工具 memory_source（设计说明，2026-11-26）

状态：已拍板（2026-11-26）——A5 做，回查暂不套密钥遮罩，按计划开工。唯一未决：Antigravity 的 MCP 调用形状实测（计划 Task 0，用户配合触发）。实施计划见 [2026-11-26-source-anchor-plan.md](2026-11-26-source-anchor-plan.md)。
上一轮的 [通用 MCP 设计说明](2026-11-26-general-mcp-spec.md) 把这件事列在「独立端与 DSH 的已知差异」里，
本文取代其中「写入的来源锚是通道标识」那一条。

## 目标

1. ZCode、Antigravity 经 MCP 写入的记忆带真锚：`source` 指得回产生它的那个会话、那一轮对话。
2. 独立端能回查：新增 `memory_source`，与 DSH 的同名工具同参、同上限、同渲染。
3. 对不上就不锚：定位失败、存储读不了、格式变了，一律退回现状（`mcp:<client>`、`[0, 0]`），不挡写入、不猜。
4. （可删）DSH 会话里也能回查外端写的锚。

## 已核实的事实（2026-11-26 实测）

- **DSH 的锚怎么来的**：`src/pipeline.ts` 在落盘前填
  `source = { sessionId: session.id, eventRange: [当轮 turn/start 的 seq, 保存时刻的 seq], sourceMode }`，
  两个数都是宿主给的机械事实——模型上下文里没有 seq，模型填的区间一律算编造。
  回查 `memory_source`（`src/tools/source.ts`）：按 id 取记录 → 跨项目门、子会话门 → 宿主 `sessionQuery.readEvent`
  从当轮起点往后开窗，至多 24 个事件、每条至多 400 字，渲染成 `- [seq] role: text`。
- **锚的字段形状不用动**：core 的 `source` 是 `{ sessionId: string, eventRange: [number, number], sourceMode }`，
  `sessionId` 就是任意字符串，frontmatter 的键序表也不管它的内部结构。ZCode 导入器已有先例：`imported-from: zcode:<originSessionId>`。
- **MCP 不把「谁在调用」递给服务器**：
  - ZCode：每个会话各起一个 stdio 进程（实测：应用启动时两个打开的会话对应两个同时刻起的进程，
    12:15 新开会话时多出第三个，比会话记录早 9 秒），
    但进程环境里只有 `CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT` 这类标准变量，没有会话 id。文档把 `${CLAUDE_SESSION_ID}`
    列在 hooks 一节；`zcode.cjs` 里不带会话上下文的插件变量解析器对它直接抛错
    （`Plugin variable requires a runtime session context`）。写进 MCP 的 env 会不会展开没有实测，本设计不依赖它。
  - ZCode 的 hooks 拿得到 `session_id`，但输出 schema 严格，没有「改写入参」的通道。
  - Antigravity：MCP 配置是静态 env，没有 hooks。
- **但调用本身先于执行落进了客户端自己的存储，而且带着完整入参**。这是本设计的地基：
  - **ZCode**：规范会话库 `~/.zcode/cli/db/db.sqlite`（2.6 GB，WAL）。
    `message(session_id, sequence, time_created, data)`，`sequence` 是每会话从 0 起、唯一、单调的序号，
    `data` 里有 `role` 与 `synthetic`（用户的原话是 `role: user` 且非 synthetic；工具结果是 `role: user` + `synthetic: true`）。
    `part(message_id, session_id, data)`，`type` 取 `text` / `tool` / `reasoning`，tool 部分的 `state.input` 就是模型发出的入参对象。
    另有 `session_runtime_presence`（在线的会话）、`tool_usage(session_id, turn_id, tool_call_id, …)`。
    索引：`message(session_id, sequence, …)`、`message(session_id, time_created, id)`、`part(message_id, id)`、`part(session_id)`。
    三次真实 MCP 调用实测：这条 tool 部分的落库时间比工具开始执行早 12、21、28 毫秒，`state.input` 与服务器收到的入参一字不差。
    补充实测（同日）：会话 id 全部是 `sess_` 前缀（259 个会话，没有旧格式）；`tool_usage.tool_name` 记的就是完整工具名
    （`mcp__plugin_plastic-memory_plastic-memory__memory_save`、`mcp__plastic-memory__memory_search` 等），
    且有 `(started_at, tool_name)` 索引——候选会话的发现可以纯索引走时间窗；`session_runtime_presence` 的列是
    `(session_id, owner_id, process_id)`，有行即在线（没有 presence 列）。
  - **Antigravity**：每个会话一份明文转写
    `~/.gemini/antigravity/brain/<会话 id>/.system_generated/logs/transcript.jsonl`（现有 8 个会话目录全有），每行一步：
    `{ step_index, source: USER_EXPLICIT | MODEL | SYSTEM, type: USER_INPUT | PLANNER_RESPONSE | GENERIC | SYSTEM_MESSAGE | CHECKPOINT, status, created_at, content?, tool_calls?: [{ name, args }], truncated_fields? }`。
    模型发出工具调用的那行（`PLANNER_RESPONSE`）先于工具执行写入（样例：响应 03:06:16Z，工具 03:06:21Z 才开始跑）。
    `tool_calls[].args` 有两种形态：JSON 字符串，或「值是 JSON 编码字符串」的对象。
  - **已实测（Task 0，2026-11-26 19:08，brain/bdebe3c4… 的 memory_search 调用）**：MCP 调用在转写里是包装名
    `call_mcp_tool`——真工具名在 `args.ToolName`（JSON 编码字符串）、完整入参在 `args.Arguments`（JSON 字符串，
    与服务器收到的一字不差），PLANNER_RESPONSE 行（11:08:25Z）先于结果步（11:08:27Z）落盘。
    精确比对可行，写入侧按 A2 全做（截断退避仍保留，防大入参被 truncated_fields 截断）。
- **`node:sqlite` 开箱可用**：Node v24.19.0 里不带任何 flag 就能 `import`，SQLite 3.53.3；`@types/node` 26.2.0 自带类型。
  零新增依赖。
- **只读连接也会在库目录留文件**：实测常规只读连接（`readOnly: true`）关闭后留下 0 字节的 `-wal` 与 32 KB 的 `-shm`
  （调研时用同样方式探查 Antigravity 的会话库，就留下了这样的空壳，已清）；`file:<路径>?immutable=1` 的只读连接关闭后什么都不留。
- **不用的两处**：`~/.zcode/cli/rollout/model-io-*.jsonl` 是模型请求的调试轨迹（214 行 53 MB，只留最近几个会话）；
  Antigravity 的 `conversations/<id>.db` 是 protobuf，`conversation_summaries.db` 的 FTS 是截断过的搜索索引。

## 设计决定

### A1 锚的编码：客户端前缀进 `sessionId`，`eventRange` 用该端自己的序号

| 写入方 | `source.sessionId` | `source.eventRange` |
|---|---|---|
| DSH（不变） | 会话 id | `[当轮首个事件的 seq, 保存时刻的 seq]` |
| ZCode | `zcode:sess_…` | `[当轮首条用户消息的 sequence, 保存时刻的最大 sequence]` |
| Antigravity | `antigravity:<uuid>` | `[当轮首个 USER_INPUT 的 step_index, 保存时刻的最大 step_index]` |
| 没定位到 | `mcp:<client>`（现状） | `[0, 0]`（现状） |

三点含义与 DSH 一致：起点是这一轮的开头（触发保存的用户原话必在窗内），终点是保存时刻，读不到起点时取 0（整会话锚）。

core 的 schema、frontmatter、键序表都不动。旧版本代码把 `sessionId` 当不认识的字符串原样保留，
回查时交给宿主读不到，按既有的 `unavailable` 降级。

### A2 写入侧：按参数相关性找到「刚刚发出这次调用的会话」

`memory_save` 进管线之前，服务器拿自己收到的 `title` 与 `text`，到各客户端的存储里找刚刚发出同一次调用的那条记录：

- ZCode：在在线的与最近更新过的会话里，找最近十分钟的 tool 部分中 `tool` 以 `memory_save` 结尾、
  `state.input.title` 与 `state.input.text` 都与入参全等的那一条。全等才认。
- Antigravity：在最近十分钟改动过的转写里，从尾部往前找 `tool_calls` 里有 `memory_save` 的 `PLANNER_RESPONSE` 行。
  参数先按解析后的字段精确比；解析不出（编码形态未知或被截断）时退回转义后的子串比对（`title` 全等、`text` 前 120 字）。
- 对上之后：会话 id 给 `sessionId`；起点往前找当轮首条用户输入，找不到取 0；终点取该会话此刻的最大序号。
- 时间盒：总计至多 500 毫秒，首次没找到时在 100、250 毫秒各补一次（防转写还没刷盘）。任何一步出错或超时都算没找到。
- 只给 `memory_save` 定位（只有它落记录）；更新同样重新锚定到发起更新的会话（与 DSH 一致）。
- **对不上就不锚**。宁可留通道标识，不做「最近活跃的会话」这类猜测。

管线本身不改：定位结果填进 `session: { id, turnStartSeq, lastSeq }`，`eventRange` 仍由 `src/pipeline.ts` 算
（它的入参本来就是这个形状，`turnStartSeq` 缺省 0 的整会话兜底也在）。

### A3 适配器：每端一个，「定位」与「开窗读」两件事放一起

三个执行器层模块，位置与 `tools/workspace-gate.ts` 同类（不新增层，不改依赖方向守卫）：

- `src/tools/anchor.ts`：scheme 编解码（`zcode:` / `antigravity:` / `mcp:`）、id 形状校验
  （ZCode `sess_` 或旧会话的 `session_` + UUID，Antigravity UUID；不合形状的直接当读不了，不拼路径）、
  按前缀分发、公共上限、定位的调度（候选适配器、时间盒、补试、日志）。
- `src/tools/anchor-zcode.ts`：只读打开 `db.sqlite`，定位与开窗。只走索引：候选会话来自 `tool_usage` 的时间窗
  （`(started_at, tool_name)` 索引 + `tool_name LIKE '%memory_save'`），消息按 `(session_id, time_created)` 取近十分钟的，
  部分按 `(message_id, id)` 取；
  用 SQL 的 `LIKE` / `json_extract` / `substr` 在库里预筛与截取，不搬整块工具输出、不做全表扫描。
  打开方式看 `db.sqlite-wal` 在不在：在（ZCode 在线，定位时的常态）就按常规只读打开，用已有的旁路文件；
  不在就按 `immutable` 打开，不留任何文件。极端情况（检查完 ZCode 恰好退出）下自己建出来的旁路文件，
  关闭后 `-wal` 是 0 字节就删掉，不是 0 字节的不动。
- `src/tools/anchor-antigravity.ts`：按目录 mtime 挑近期会话，定位只读尾部（256 KB），开窗按行流式读，
  窗口外的行只看 `step_index` 不整体解析。

共同的约束：只读；根目录可注入（缺省 `~/.zcode/cli`、`~/.gemini/antigravity`，环境变量 `PLASTIC_ZCODE_DIR`、
`PLASTIC_ANTIGRAVITY_DIR` 可改）；根目录不存在则该适配器不启用；`node:sqlite` 在函数内动态加载，
宿主的 Node 没有它时回「读不了」，不影响模块加载。

### A4 回查：独立端第七个工具 `memory_source`

- 入参 `{ memoryId, window? }`，与 DSH 相同。逻辑复用 `src/tools/source.ts` 的 `executeSource`，只加一步按前缀分发：
  无前缀走宿主 `readEvent`（DSH 原路）；`zcode:` / `antigravity:` 走适配器开窗；`mcp:` 直接回 `unavailable`，不去读宿主。
- 上限与方向照 DSH：从起点往后开窗，默认覆盖 `[起点, 终点]`，`window` 收窄，至多 24 个事件，每条至多 400 字，
  起点前多读 2 个作上下文。ZCode 的一个事件是一条消息，消息里的可读块各成一行（文本块按角色，工具块标 `tool`，
  `reasoning` 与步进标记计入「未显示的结构事件」）；Antigravity 的一个事件是转写的一行
  （`USER_INPUT` → user，只取 `<USER_REQUEST>` 里的正文；`PLANNER_RESPONSE` → assistant，有正文取正文，没有则列工具调用名；
  `GENERIC` → tool）。
- 权限照 DSH：只回查当前项目与全局的记忆，别的项目的 workspace 记忆回 `forbidden`。
  独立端没有子会话委派信息，子会话门不适用。
- MCP 的输出与其余六个工具一致，是一段 JSON：结构化结果（`kind`、`lines`、`range`、`reason` 等）加一段 `text`，
  内容与 DSH 的渲染逐字相同（含「原始证据不可用…当作先验使用」那句降级指引）。
- 各种结果的措辞：读不了、已删除、不在本机 → `unavailable` 带原因；
  DSH 写的锚在独立端回查 → `unavailable`（这条记忆出自 DeepSeek Harness 会话，请在 DSH 里回查）；
  `mcp:` → `unavailable`（经 MCP 写入时没有定位到原始对话）。
- 快照里那句「每条记忆都带有来源锚…可用 memory_source 回查」从此在独立端成立，文案不动。

### A5 跨面回读（可删的任务）

DSH 的 `memory_source` 用同一个 `executeSource`，所以只要接线处把适配器递进去，DSH 会话里也能回查 ZCode、Antigravity 写的锚——
三端共用一个记忆根，这是迟早会碰到的场景。代价是动 `src/tools/source.ts`（分发那几行）与 `src/index.ts`（一行接线），
是「DSH 插件侧零改动」的一次有意例外。体检建议的出处回查（`src/gui/suggestion-source.ts`）对外端锚跳过，不调宿主。

### A6 开关与可观测

- `PLASTIC_ANCHOR=off`：整个定位关掉，写入维持现状。回查不受影响。
- `memory_save` 的成功结果多一个 `source` 字段（就是记录里的 `source`），模型与人都看得到这次锚没锚上。
- 服务器日志（stderr）：每次定位的结果一行（`锚定 zcode:sess_… [713, 730]` 或 `未定位：…`）；
  适配器的探针失败（表不在、列不对）每个进程每端只警告一次。
- `plastic-mcp anchor-doctor`：对本机的两个存储各跑一遍探针，输出 JSON（根目录在不在、库结构认不认得、ZCode 在线的会话数）。
  私有的格式，客户端升级后先跑它。

## 考虑过、没选的

- **让客户端递会话 id**（ZCode 的 MCP env 模板、PreToolUse hook 登记簿）：ZCode 一端尚可（且未经实证），
  Antigravity 没有任何通道，两头就得做两套。参数相关性两头同一条路，且是精确对上，不是推断。
- **读 rollout 文件**：调试轨迹，留存与开关都不归我们管。
- **给 core 的 `source` 加字段**（如 `client`、`turnId`）：要动 schema、frontmatter 键序、旧版本兼容；前缀方案零改动，且有导入器的先例。
- **解析 Antigravity 的 protobuf**：明文转写已经够用。

## 不做的事

- 独立端回查 DSH 写的锚（DSH 的会话文件按 profile 分根、zstd 压缩，是第三个适配器，另立）。
- 页面（7788）上看出处、REST 的回查端点。
- ZCode 子 agent 会话经独立端写入时标 `delegation`（维持现状：不标，锚指向子会话本身）。
- 回查结果的脱敏（与 DSH 一致，返回对话原文）。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 两个存储都是别家应用的私有格式，升级可能变 | 探针 + 优雅降级（退回通道标识 / `unavailable`）+ `anchor-doctor` + 用真实结构的样例做契约用例；锚的字段形状不变，格式变了只是新写入锚不上，旧记录照样可读 |
| Antigravity 的 MCP 调用形状未实测 | 计划的 Task 0 是闸门：先实测再写适配器；转写里没有可比的参数时，Antigravity 的写入侧维持现状，回查侧与 ZCode 照做 |
| 读其他应用的存储涉及隐私 | 只读、只走索引、只看与这次调用相关的近期行；回查只能按记忆 id 发起，位置由记录里的锚决定，模型构造不出任意读取 |
| 回查返回的是对话原文，可能带出当时的敏感信息 | 与 DSH 的 `memory_source` 同一暴露面；要不要给回查行套密钥遮罩，见「待拍板」 |
| 长轮次里证据离起点远，24 个事件够不着 | 与 DSH 相同的已知取舍（起点优先保用户原话） |
| 读 ZCode 的库会在它目录里留旁路文件 | 有 `-wal` 时用已有的；没有时按 `immutable` 打开，不留文件；竞态下自己建的空壳关闭后删掉（用例守「打开前后目录不变」） |

## 验收

1. 四包 `typecheck`、`lint`、`test` 全绿；根包与 mcp 包 `build` 全过。
2. 单元与契约用例：按真实 DDL 建临时库、按真实行形状造转写，定位得到正确的锚；入参差一个字就不认；
   库结构变了回「没定位到」且只警告一次；开窗的方向、上限、跳过计数与 DSH 的 `source.spec` 对齐；`mcp:` 与 DSH 锚在独立端的措辞。
3. ZCode 实测：新会话里 `memory_save` 的结果带 `source.sessionId = zcode:sess_<本会话>`，`eventRange` 非 `[0, 0]`；
   `memory_source` 的第一行是本轮用户的原话；换一个会话、再到 DSH 会话里回查同一条，读到同一段。
4. Antigravity 实测：同上，`source.sessionId = antigravity:<会话 id>`。
5. `plastic-mcp serve` 的 `/mcp` 列出七个工具；7788 重启后 settings、snapshot 端点不回归。
6. DSH 侧不回归：`scripts/host-contract/verify-plugin.ts` 照过，DSH 原生锚的回查用例不变。
7. 关掉 `PLASTIC_ANCHOR` 后写入回到 `mcp:<client>`、`[0, 0]`。

## 拍板结果（2026-11-26）

1. A5（DSH 回读外端锚）：**做**（Task 5 转正）。
2. 回查行不套密钥遮罩：**本轮不做**，保持与 DSH 一致。
3. Task 0 的 Antigravity 实测**已完成**（2026-11-26 19:08，见「已核实的事实」）：形状可识别、参数可精确比对，
   Antigravity 适配器按 A2 全做。
