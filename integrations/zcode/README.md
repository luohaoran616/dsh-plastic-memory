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

ZCode 桌面端 Settings → Plugin Management → 本地目录 marketplace，指向
`integrations/zcode/dist/plastic-memory`（或 `--out` 指定的目录）。装好后在会话里确认两件事：

1. MCP 服务在：`tools/list` 里有六个 `memory_*`；
2. hook 在：新开会话的第一条 user 消息之前有一条 `source.kind = plastic-memory` 的注入。

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
