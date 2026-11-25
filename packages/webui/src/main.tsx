import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

/**
 * 暗色：复制过来的 `components/theme.ts` 把暗色令牌挂在 `body[data-ds-dark-theme]` 上（那是宿主打的属性）。
 * 独立页面没有宿主，按系统偏好自己打这个属性，并跟随系统切换。
 */
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const syncColorScheme = (): void => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
syncColorScheme()
dark.addEventListener('change', syncColorScheme)

const container = document.getElementById('root')
if (container === null) throw new Error('plastic-webui: 找不到挂载点 #root')
createRoot(container).render(<App />)
