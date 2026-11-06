import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CARD_STYLE,
  MINDMAP_THEMES,
  applyTheme,
  isDefaultCardStyle,
  readCardStyle,
  resolveCardStyle,
  saveCardStyle,
} from './style'

function installStorage() {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
      removeItem: (key: string) => { map.delete(key) },
      clear: () => map.clear(),
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() { return map.size },
    },
  })
  return map
}

describe('卡片样式主题', () => {
  it('5 套主题，id 与名称都不重复', () => {
    expect(MINDMAP_THEMES).toHaveLength(5)
    expect(new Set(MINDMAP_THEMES.map((theme) => theme.id)).size).toBe(5)
    expect(new Set(MINDMAP_THEMES.map((theme) => theme.name)).size).toBe(5)
  })

  it('默认样式跟随宣纸主题', () => {
    const resolved = resolveCardStyle(DEFAULT_CARD_STYLE)
    expect(resolved).toEqual({ surface: 'paper', radius: 'soft', density: 'normal' })
    expect(isDefaultCardStyle(DEFAULT_CARD_STYLE)).toBe(true)
  })

  it('自定义覆盖优先于主题预设', () => {
    const resolved = resolveCardStyle({ theme: 'ink', surface: 'paper', radius: null, density: 'roomy' })
    expect(resolved.surface).toBe('paper')
    expect(resolved.radius).toBe('soft')
    expect(resolved.density).toBe('roomy')
  })

  it('未知主题回落到第一套，不抛错', () => {
    const resolved = resolveCardStyle({ theme: 'nope' as never, surface: null, radius: null, density: null })
    expect(resolved.surface).toBe(MINDMAP_THEMES[0].surface)
  })

  it('换主题会清掉自定义覆盖', () => {
    const custom = { theme: 'paper' as const, surface: 'ink' as const, radius: 'round' as const, density: null }
    expect(applyTheme('minimal')).toEqual({ theme: 'minimal', surface: null, radius: null, density: null })
    expect(isDefaultCardStyle(custom)).toBe(false)
  })
})

describe('样式持久化', () => {
  beforeEach(() => {
    installStorage()
  })

  it('按画布分别保存，互不影响', () => {
    saveCardStyle('canvas-a', { theme: 'ink', surface: null, radius: null, density: null })
    saveCardStyle('canvas-b', { theme: 'tint', surface: 'tint', radius: 'round', density: null })
    expect(readCardStyle('canvas-a').theme).toBe('ink')
    expect(readCardStyle('canvas-b').theme).toBe('tint')
    expect(readCardStyle('canvas-b').radius).toBe('round')
    expect(readCardStyle('canvas-c').theme).toBe('paper')
  })

  it('脏数据被清洗成合法值', () => {
    localStorage.setItem('pdfnote.mindmap.style.canvas-x', JSON.stringify({
      theme: 'ghost', surface: 'neon', radius: 42, density: 'huge',
    }))
    const style = readCardStyle('canvas-x')
    expect(style).toEqual({ theme: 'paper', surface: null, radius: null, density: null })
  })

  it('损坏的 JSON 不抛错', () => {
    localStorage.setItem('pdfnote.mindmap.style.canvas-y', '{oops')
    expect(readCardStyle('canvas-y')).toEqual(DEFAULT_CARD_STYLE)
  })

  it('没有 localStorage 时返回默认值', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
    expect(readCardStyle('canvas-z')).toEqual(DEFAULT_CARD_STYLE)
    expect(saveCardStyle('canvas-z', { theme: 'ink', surface: null, radius: null, density: null }).theme).toBe('ink')
  })
})
