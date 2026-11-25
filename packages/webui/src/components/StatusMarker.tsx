/**
 * 副本来源：`client/ui/StatusMarker.tsx`（仓库根下同一路径），复制于 2026-11-25。
 * 为什么复制：它所在的组件树经 `useGateway` / `host.ts` 连进 DSH 宿主通道（借会话、订阅 `<memoryRoot>/.state/gui/*.json` 视图文件、
 * 执行 `/memory` 命令），独立 WebUI 走 REST、没有宿主，只能借样子与语义（Task 6 context §1 的裁决与判定标准）。
 * 与上游的差异：无改动。 上游改动不会自动同步到这里，改上游对应文件时一并看这份副本。
 */
/**
 * 状态标记（DESIGN.md「Status Marker」）：琥珀圆点 = 等你决定；红色小三角 = 有密钥（换形状照顾色弱）；
 * 绿色小圆点 = 运行中 / 良好；标注灰圆点 = 处理视图里已处理的条目；红色小圆点只给分数「有问题」那一档（分数旁的分档圆点：良好绿、需要留意琥珀、有问题红）。琥珀对白底只有 2.15:1，所以调用方要在同一行写清状态文字；
 * 传 label 时标记自己也带无障碍名称，不传则只是装饰。左栏图标上的抠洞版本在 MemoryIcon.tsx。
 */
export type MarkerKind = 'pending' | 'secret' | 'ok' | 'error' | 'done'

export function StatusMarker({ kind, label }: { kind: MarkerKind; label?: string }) {
  const a11y = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }
  if (kind === 'secret') {
    return (
      <svg className="pm-marker" data-pm-marker={kind} width={14} height={14} viewBox="0 0 14 14" {...a11y}>
        <path d="M7 1.4 13.2 12.4H.8Z" fill="var(--pm-error)" stroke="var(--pm-error)" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M7 5.2v3.4M7 10.4v.1" stroke="var(--pm-on-error)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  return <span className={`pm-marker pm-marker--dot pm-marker--${kind}`} data-pm-marker={kind} {...a11y} />
}

export const statusMarkerCss = `
.pm-marker { display: inline-block; flex-shrink: 0; vertical-align: middle; }
.pm-marker--dot { width: 8px; height: 8px; border-radius: 999px; }
.pm-marker--pending { background: var(--pm-warn); }
.pm-marker--ok { background: var(--pm-success); }
.pm-marker--error { background: var(--pm-error); }
.pm-marker--done { background: var(--pm-caption); }
`
