# plastic-memory 的 ZCode 插件

把「六个 `memory_*` 工具」和「会话启动注入记忆快照」装成一个 ZCode 插件，装一次两样都有。
产物不是自包含的：`plugin.json` 指向仓库里已构建好的 `packages/mcp/lib/bin.js`，所以只适合本机使用。

## 生成

```sh
# 前置：仓库根目录构建两处产物
pnpm build && pnpm --filter @plastic/mcp build

# 打包（记忆根缺省 ~/.dsh/memories，可用 --root 覆盖）
node scripts/build-zcode-plugin.ts
# → integrations/zcode/dist/plastic-memory/.zcode-plugin/plugin.json
```

## 安装

打包同时在产物目录的上一级写一份本地测试市场（`dist/marketplace.json`，source 指向 `./plastic-memory`）。
ZCode 桌面端 Settings → Plugin Management → Discover → **+** 添加本地目录
`integrations/zcode/dist`（即 marketplace.json 所在目录），然后在市场里安装 plastic-memory。
装好后在会话里确认两件事：

1. MCP 服务在：Settings → MCP 里 `plugin:plastic-memory:plastic-memory` 已连接，`tools/list` 有六个 `memory_*`；
2. hook 在：新开会话的第一条 user 消息之前有一条 `source.kind = plastic-memory` 的注入。

**装好并确认之后**，再去掉用户配置里旧的 `plastic-memory` MCP 条目（两份并存会出两套同名工具；
`config.json` 已先备份为 `config.json.bak-20261126-before-plastic-plugin`）。

**模板展开的实证办法**：装好后开一个工作区会话，看服务进程的环境变量——

```sh
pgrep -f 'bin.js stdio' | head -1 | xargs -I{} tr '\0' '\n' < /proc/{}/environ | grep PLASTIC_PROJECT
```

官方文档（zcode-guide）写明模板 `${CLAUDE_PROJECT_DIR}` 等只对插件提供的 MCP 服务展开、配置文件的条目不展开；
env 值按同一节理解，但以这条实测为准。不成立时按下面的回退办法。

## 模板变量（待实测）

插件给 MCP 服务的 `PLASTIC_PROJECT` 写的是 `${CLAUDE_PROJECT_DIR}`：插件提供的 MCP 服务会展开
这个模板变量（按工作区解析项目）。**`env` 的值是否展开没有实证**——

- 成立：每个工作区的会话按工作区目录解析项目，写入与快照落在对应项目；
- 不成立：`PLASTIC_PROJECT` 原样传给服务，项目映射维持写死（回退到环境变量缺省值的行为，见仓库 README）。

## 回退办法（不装插件）

直接在 `~/.zcode/cli/config.json` 手配：

```json
{
  "mcp": { "servers": { "plastic-memory": { "command": "node", "args": ["<仓库>/packages/mcp/lib/bin.js"], "env": { "PLASTIC_MEMORY_ROOT": "/home/me/.dsh/memories", "PLASTIC_CLIENT": "zcode", "PLASTIC_PROJECT": "/home/me/projects/alpha" } } } },
  "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node <仓库>/packages/mcp/lib/bin.js hook-snapshot" } ] } ] }
}
```

hook 脚本读 stdin 里的 `cwd` 问本机 7788 的快照接口（3 秒超时），任何失败都静默退出 0，
不挡会话；`PLASTIC_WEB_PORT` 可换端口。这条路径下项目映射维持写死，快照按 hook 输入的 `cwd` 解析——
两者可能不一致（快照按会话目录、写入落 `PLASTIC_PROJECT`），属已知取舍，不改设计。
