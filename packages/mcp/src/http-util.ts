import type { ServerResponse } from 'node:http'

/**
 * HTTP 层的公共出口：路径前缀与两个 JSON 响应写出函数。
 * 旧的 REST 管理面（记录读写）已删，这个文件是它留下的最后一点公共件：独立页面接口与静态托管都用它。
 */

/** 独立页面接口的路径前缀：serve.ts 据此把 `/api` 与 `/mcp`、静态托管分开。 */
export const API_PREFIX = '/api'

/** JSON 响应统一入口：serve.ts 的鉴权失败、MCP 错误响应与界面接口都用它。 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/** 扁平错误体 `{ error: string }`：静态托管与鉴权失败用它（界面接口的错误体带 code，见 gui-http.ts）。 */
export function sendError(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error }, headers)
}
