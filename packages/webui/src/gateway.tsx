/**
 * 页面与 REST gateway 之间的边：组件只认 `MemoryGateway`（`gateway.impl.ts` 的实现），不直接调 fetch。
 * 上游 `client/gateway.ts` 在这一层绑的是 DSH 宿主通道（借会话、订阅视图文件、执行 `/memory` 命令），
 * 独立 SPA 没有宿主，所以这里只有一个 provider 与取用函数。
 */
import { createContext, useContext } from 'react'
import type { MemoryGateway } from './gateway.impl.ts'

const GatewayContext = createContext<MemoryGateway | null>(null)

export const GatewayProvider = GatewayContext.Provider

export function useGateway(): MemoryGateway {
  const gateway = useContext(GatewayContext)
  if (gateway === null) throw new Error('plastic-webui: useGateway outside GatewayProvider')
  return gateway
}
