/**
 * SPA 自己的布局样式（上游 client/styles.ts 是宿主面板的记忆页布局，含侧栏与插槽外壳，独立页面用不上）。
 * 复制组件带来的样式在 `../styles.ts` 里与这份拼接，一起塞进页面里一个 `<style>`。
 */
export const appCss = `
html, body { height: 100%; }
body {
  margin: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.pm-app { max-width: 980px; margin: 0 auto; padding: 28px 20px 72px; display: flex; flex-direction: column; gap: 18px; }
.pm-app-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.pm-app-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; }
.pm-app-sub { margin: 0; font-size: 12px; color: var(--pm-text-2); }

.pm-tabs { display: flex; gap: 4px; align-items: center; border-bottom: 1px solid var(--pm-line); }
.pm-tab {
  padding: 6px 12px; border: 0; border-bottom: 2px solid transparent; background: none; font: inherit;
  font-size: 13px; color: var(--pm-text-2); cursor: pointer;
}
.pm-tab:hover { color: var(--pm-text); }
.pm-tab--on { color: var(--pm-text); border-bottom-color: var(--pm-accent); font-weight: 600; }

.pm-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
.pm-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pm-field-label { font-size: 12px; color: var(--pm-text-2); }
.pm-input, .pm-select, .pm-textarea {
  font: inherit; font-size: 13px; line-height: 1.5; color: var(--pm-text);
  padding: 5px 10px; border-radius: var(--dsw-radius-sm, 8px);
  border: 0.5px solid var(--pm-line-input); background: var(--pm-bg);
}
.pm-input:focus-visible, .pm-select:focus-visible, .pm-textarea:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 1px; }
.pm-input::placeholder, .pm-textarea::placeholder { color: var(--pm-caption); }
.pm-textarea { min-height: 180px; resize: vertical; white-space: pre-wrap; }
.pm-toolbar-search { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 260px; }

.pm-list { display: flex; flex-direction: column; }
.pm-row { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; border-top: 1px solid var(--pm-line); }
.pm-row:first-child { border-top: 0; }
.pm-row-head { display: flex; align-items: flex-start; gap: 12px; }
.pm-row-body { flex: 1; min-width: 0; }
.pm-row-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 14px; }

.pm-notice {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 12px; border-radius: var(--dsw-radius-sm, 8px); font-size: 12px; line-height: 1.6;
  background: var(--pm-bg-block); color: var(--pm-text);
}
.pm-notice--warn { background: color-mix(in srgb, var(--pm-warn) 12%, transparent); }
.pm-notice--error { background: color-mix(in srgb, var(--pm-error) 12%, transparent); }
.pm-notice--success { background: color-mix(in srgb, var(--pm-success) 12%, transparent); }
.pm-notice-spacer { flex: 1; }

.pm-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-panel-title { margin: 0; font-size: 13px; font-weight: 600; }
.pm-panel-sub { margin: 0; font-size: 12px; color: var(--pm-text-2); }
.pm-grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12px; line-height: 1.6; }
.pm-grid-term { color: var(--pm-text-2); white-space: nowrap; }
.pm-grid-desc { margin: 0; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.pm-prose { margin: 0; padding: 10px 12px; border-radius: var(--dsw-radius-sm, 8px); background: var(--pm-bg); border: 0.5px solid var(--pm-line-card); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }

.pm-editor { display: flex; flex-direction: column; gap: 10px; }
.pm-editor-row { display: flex; gap: 10px; flex-wrap: wrap; }
.pm-editor-actions { display: flex; gap: 8px; align-items: center; }

.pm-footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--pm-text-2); }
.pm-footer-spacer { flex: 1; }
.pm-section { display: flex; flex-direction: column; gap: 10px; }
`
