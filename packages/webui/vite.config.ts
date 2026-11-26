import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 构建产物的落点：`packages/webui/dist`，由 `plastic-mcp serve` 同源托管（`/` 是页面，`/api/gui/*` 是页面接口）。
 * 所以页面里一律请求相对路径 `/api/gui/...`，端口可换而代码不动。
 *
 * 开发态跑 `vite` 时没有同源服务，靠这里的代理把 `/api` 转给本机 serve，保持开发态与生产态同一个 base：
 * 目标端口是 `serve` 的缺省端口（D4），换端口时改这一行。
 */
const SERVE_ORIGIN = 'http://127.0.0.1:7788'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    proxy: { '/api': { target: SERVE_ORIGIN, changeOrigin: false } },
  },
})
