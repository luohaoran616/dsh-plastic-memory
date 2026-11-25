/**
 * 宿主调色板桥：复制过来的组件（theme.ts 与各组件的 CSS）用 `--dsw-*` 令牌指向 DSH 宿主的颜色与圆角，
 * 独立 WebUI 里没有宿主定义这些变量。这里给同一批令牌配上等价的值（浅色 + `prefers-color-scheme: dark`），
 * 让副本不用改一行 CSS 也能正常显示。
 *
 * 银藤强调色（`--pm-accent*`）在副本的 theme.ts 里自带字面量，不在这里重复。
 * 宿主换皮肤时这里的值不会跟着变——那是预期：WebUI 不是宿主面板，只借它的观感。
 */

/** 暗色主题：theme.ts 的暗色分支挂在 `body[data-ds-dark-theme]` 上，由 `main.tsx` 按系统偏好打这个属性。 */
export const hostTokensCss = `
:root {
  --dsw-alias-label-primary: #1f2023;
  --dsw-alias-label-secondary: #5c5f66;
  --dsw-alias-label-tertiary: #8b8f96;
  --dsw-alias-label-caption: #a5aab2;
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-3: #f7f8f9;
  --dsw-alias-bg-module-platform: #f4f5f6;
  --dsw-alias-border-l2: #ebedf0;
  --dsw-alias-border-l3: #e1e4e8;
  --dsw-alias-border-l4: #d5d9de;
  --dsw-alias-interactive-bg-hover: #f2f3f5;
  --dsw-alias-interactive-bg-active: #e7eaee;
  --dsw-alias-state-warn-primary: #d97706;
  --dsw-alias-state-error-primary: #dc2626;
  --dsw-alias-state-success-primary: #16a34a;
  --dsw-alias-state-business-primary: #4d6bfe;
  --dsw-alias-state-business-tertiary: #eef1ff;
  --dsw-static-neutral-bluish-00: #ffffff;
  --dsw-static-neutral-bluish-400: #c7ccd6;
  --dsw-focus-ring-color: #4d6bfe;
  --dsw-focus-ring-width: 2px;
  --dsw-radius-sm: 8px;
  --dsw-radius-md: 12px;
  --dsw-radius-lg: 16px;
}
body[data-ds-dark-theme] {
  --dsw-alias-label-primary: #e8eaed;
  --dsw-alias-label-secondary: #a7acb4;
  --dsw-alias-label-tertiary: #82888f;
  --dsw-alias-label-caption: #6b7178;
  --dsw-alias-bg-base: #16171a;
  --dsw-alias-bg-layer-1: #1c1d21;
  --dsw-alias-bg-layer-3: #232428;
  --dsw-alias-bg-module-platform: #24252a;
  --dsw-alias-border-l2: #2c2e33;
  --dsw-alias-border-l3: #35373d;
  --dsw-alias-border-l4: #41444b;
  --dsw-alias-interactive-bg-hover: #2a2c31;
  --dsw-alias-interactive-bg-active: #33363c;
  --dsw-alias-state-warn-primary: #f0b429;
  --dsw-alias-state-error-primary: #f26b6b;
  --dsw-alias-state-success-primary: #43c08a;
  --dsw-alias-state-business-primary: #8fa3ff;
  --dsw-alias-state-business-tertiary: #262a3d;
  --dsw-static-neutral-bluish-00: #16171a;
  --dsw-static-neutral-bluish-400: #4a4e56;
  --dsw-focus-ring-color: #8fa3ff;
}
`
