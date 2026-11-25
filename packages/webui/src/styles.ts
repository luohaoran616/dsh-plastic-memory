/**
 * 页面样式表：复制组件的 CSS 导出（与上游同一份字符串）+ 宿主令牌桥 + 本 SPA 的布局。
 * 做法对齐上游 `client/ui/PanelShell.tsx`（组件随渲染塞一个 `<style>`，卸载即移除），只是不套插槽外壳。
 */
import { appCss } from './styles/app.ts'
import { hostTokensCss } from './styles/host-tokens.ts'
import { buttonCss } from './components/Button.tsx'
import { chipCss } from './components/Chip.tsx'
import { emptyStateCss } from './components/EmptyState.tsx'
import { healthBannerCss } from './components/HealthBanner.tsx'
import { memoryCardCss } from './components/MemoryCard.tsx'
import { statusMarkerCss } from './components/StatusMarker.tsx'
import { themeCss } from './components/theme.ts'

export const APP_CSS = [
  hostTokensCss, themeCss, buttonCss, chipCss, statusMarkerCss, memoryCardCss, emptyStateCss, healthBannerCss, appCss,
].join('\n')
