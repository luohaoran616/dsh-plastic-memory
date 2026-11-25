import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * 三个 stdio spec 共用的小助手：起子进程用的干净环境，以及「调工具 → 取第一段文本 → 解析 JSON」的收窄。
 * 语义只在这里维护一份，免得三份逐字副本各漂各的。
 */

/** 外层环境只借 HOME/PATH 这类必要变量：PLASTIC_* 一律由用例显式给，避免宿主 shell 的同名变量串进断言。 */
export const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
for (const key of ['PLASTIC_MEMORY_ROOT', 'PLASTIC_CLIENT', 'PLASTIC_PROJECT', 'PLASTIC_MCP_TEST_HOLD_LOCK']) delete baseEnv[key]

/** 调一个工具并把第一段文本解析成 JSON；isError 或非文本块直接抛，免得断言在空值上噪声失败。 */
export async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  // SDK 的 callTool 返回联合类型（普通结果 / task 结果），按普通 CallToolResult 收窄
  const result = await client.callTool({ name, arguments: args }) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const block = result.content[0]
  if (result.isError === true || block === undefined || block.type !== 'text' || block.text === undefined) {
    throw new Error(`${name} 调用失败：${JSON.stringify(result)}`)
  }
  return JSON.parse(block.text) as T
}
