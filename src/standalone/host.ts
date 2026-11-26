import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { ContextHost, HostSession } from '../tools/host-session.ts'

/** 无宿主装配借用的会话 id：/memory 命令、会话视图、会话归属都按它记。 */
export const STANDALONE_SESSION_ID = 'standalone'

/** 无宿主装配给命令处理器的会话上下文：一个固定的项目、子 agent 深度 0、固定会话 id。 */
export interface StandaloneContext {
  workspacePath: string | undefined
  delegationDepth: number
  session: { id: string }
}

/**
 * 无宿主时的 ContextHost：没有真会话，contextOf 忽略入参，一律给固定项目与会话；llmOf 每次现读注入的模型
 * （null = 拿不到）。只供 src/standalone 装配用，不依赖框架运行时。
 */
export function createStandaloneHost(deps: { project: string; llm: () => SemanticLlm | null }):
  ContextHost<StandaloneContext> & Pick<HostSession, 'llmOf'> {
  const context: StandaloneContext = {
    workspacePath: deps.project,
    delegationDepth: 0,
    session: { id: STANDALONE_SESSION_ID },
  }
  return {
    contextOf: async (_exec: ToolRunContext) => context,
    llmOf: () => deps.llm(),
  }
}
