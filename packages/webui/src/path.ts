/**
 * 副本来源：`client/path.ts`（仓库根下同一路径），复制于 2026-11-25。
 * 为什么复制：它所在的组件树经 `useGateway` / `host.ts` 连进 DSH 宿主通道（借会话、订阅 `<memoryRoot>/.state/gui/*.json` 视图文件、
 * 执行 `/memory` 命令），独立 WebUI 走 REST、没有宿主，只能借样子与语义（Task 6 context §1 的裁决与判定标准）。
 * 与上游的差异：无改动。 上游改动不会自动同步到这里，改上游对应文件时一并看这份副本。
 */
/** 路径的最后一段（项目目录名）；纯函数，给不依赖 React 的模块（如对话卡的文本解析）用。 */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** 在 macOS 上：「在访达中显示」和别的系统的「在文件管理器中显示」用这个判断选文案。 */
export const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
