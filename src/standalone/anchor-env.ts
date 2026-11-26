/**
 * 来源锚定位的环境翻译（设计说明 2026-11-26-source-anchor §A3/§A6），两端共用一份语义：
 * `PLASTIC_ANCHOR=off` 整个关掉；两端的根目录可用 `PLASTIC_ZCODE_DIR` / `PLASTIC_ANTIGRAVITY_DIR`
 * 覆盖缺省根（~/.zcode/cli、~/.gemini/antigravity）。目录不存在由定位器按「该适配器不启用」处理，这里不探。
 * 放 standalone 面让 mcp 的 bin 按包名动态加载（与 DSH 插件的 src/index.ts 同一份语义）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AnchorLocatorOptions } from '../tools/anchor.ts'

export function anchorOptionsFromEnv(env: NodeJS.ProcessEnv, log?: (line: string) => void): AnchorLocatorOptions {
  const off = env.PLASTIC_ANCHOR?.trim() === 'off'
  if (off) log?.('来源锚定位已关闭（PLASTIC_ANCHOR=off）：写入维持 mcp:<client>')
  const dir = (name: string, ...fallback: string[]): string => {
    const value = env[name]?.trim() ?? ''
    return value !== '' ? value : join(homedir(), ...fallback)
  }
  return {
    enabled: !off,
    zcodeDir: dir('PLASTIC_ZCODE_DIR', '.zcode', 'cli'),
    antigravityDir: dir('PLASTIC_ANTIGRAVITY_DIR', '.gemini', 'antigravity'),
    ...(log === undefined ? {} : { log }),
  }
}
