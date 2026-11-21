export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'pdfnote.theme'
const MEDIA = '(prefers-color-scheme: dark)'

export function readThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    /* localStorage 不可用时按系统走 */
  }
  return 'system'
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  return typeof window !== 'undefined' && window.matchMedia(MEDIA).matches ? 'dark' : 'light'
}

/** 写 `html[data-theme]`：所有深色规则都挂在这个属性上，切换不需要重渲染。 */
export function applyTheme(mode: ThemeMode): void {
  const theme = resolveTheme(mode)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* 存不下不影响本次会话 */
  }
  applyTheme(mode)
  // 多个组件各自持有主题 hook：写盘后广播，顶栏与设置面板才能同步。
  window.dispatchEvent(new CustomEvent('pdfnote:theme-changed', { detail: { mode } }))
}

/** 系统主题变化时（mode = system）跟着切。返回取消订阅函数。 */
export function watchSystemTheme(mode: ThemeMode, onChange: () => void): () => void {
  if (mode !== 'system' || typeof window === 'undefined') return () => undefined
  const media = window.matchMedia(MEDIA)
  const handler = () => onChange()
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}
