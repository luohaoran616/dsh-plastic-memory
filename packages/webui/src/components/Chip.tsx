/**
 * 副本来源：`client/ui/Chip.tsx`（仓库根下同一路径），复制于 2026-11-25。
 * 为什么复制：它所在的组件树经 `useGateway` / `host.ts` 连进 DSH 宿主通道（借会话、订阅 `<memoryRoot>/.state/gui/*.json` 视图文件、
 * 执行 `/memory` 命令），独立 WebUI 走 REST、没有宿主，只能借样子与语义（Task 6 context §1 的裁决与判定标准）。
 * 与上游的差异：无改动。 上游改动不会自动同步到这里，改上游对应文件时一并看这份副本。
 */
/**
 * Chip（DESIGN.md「Chips」）：
 * - result：中性底 + 绿色小圆点 + 文字，例如「已按 A」；
 * - neutral：浅灰胶囊，例如版本号、「规划中」。
 */
import type { ReactNode } from 'react'

export interface ChipProps { variant: 'result' | 'neutral'; children: ReactNode }

export function Chip({ variant, children }: ChipProps) {
  return (
    <span className={`pm-chip pm-chip--${variant}`}>
      {variant === 'result' ? <span className="pm-chip-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}

export const chipCss = `
.pm-chip {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: 4px;
  color: var(--pm-text); white-space: nowrap;
}
.pm-chip--result { background: var(--pm-bg-block); }
.pm-chip-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--pm-success); }
.pm-chip--neutral { background: var(--pm-bg-block); color: var(--pm-text-2); border-radius: 999px; padding: 1px 8px; }
`
