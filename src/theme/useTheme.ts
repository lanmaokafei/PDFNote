import { useCallback, useEffect, useState } from 'react'
import { applyTheme, readThemeMode, resolveTheme, saveThemeMode, watchSystemTheme, type ThemeMode } from './theme'

/** 主题状态：三档模式 + 实际生效的明暗，挂在 App 顶层即可。 */
export function useTheme(): {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
  toggle: () => void
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readThemeMode())
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(readThemeMode()))

  // 别的组件（设置面板）改了主题时同步过来。
  useEffect(() => {
    const handler = () => setModeState(readThemeMode())
    window.addEventListener('pdfnote:theme-changed', handler)
    return () => window.removeEventListener('pdfnote:theme-changed', handler)
  }, [])

  useEffect(() => {
    applyTheme(mode)
    setResolved(resolveTheme(mode))
    return watchSystemTheme(mode, () => {
      applyTheme(mode)
      setResolved(resolveTheme(mode))
    })
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    saveThemeMode(next)
    setResolved(resolveTheme(next))
  }, [])

  const toggle = useCallback(() => {
    // 从「跟随系统」直接切时，按当前实际明暗取反，符合直觉。
    setMode(resolved === 'dark' ? 'light' : 'dark')
  }, [resolved, setMode])

  return { mode, resolved, setMode, toggle }
}
