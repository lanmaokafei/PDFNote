import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CARD_STYLE,
  MINDMAP_THEMES,
  applyTheme,
  isDefaultCardStyle,
  readCardStyle,
  resolveCardStyle,
  saveCardStyle,
  type MindmapCardStyle,
} from './style'

function style(overrides: Partial<MindmapCardStyle> = {}): MindmapCardStyle {
  return { ...DEFAULT_CARD_STYLE, ...overrides }
}

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
  it('6 套主题，id 与名称都不重复', () => {
    expect(MINDMAP_THEMES).toHaveLength(6)
    expect(new Set(MINDMAP_THEMES.map((theme) => theme.id)).size).toBe(6)
    expect(new Set(MINDMAP_THEMES.map((theme) => theme.name)).size).toBe(6)
  })

  it('默认样式跟随宣纸主题', () => {
    const resolved = resolveCardStyle(DEFAULT_CARD_STYLE)
    expect(resolved).toEqual({
      surface: 'paper',
      radius: 'soft',
      density: 'normal',
      header: 'tint',
      edge: 'hairline',
      border: 'normal',
      link: 'neutral',
      linkLabels: true,
    })
    expect(isDefaultCardStyle(DEFAULT_CARD_STYLE)).toBe(true)
  })

  it('色块主题：实心头 + 深墨连线 + 无链接标签', () => {
    const resolved = resolveCardStyle(applyTheme('block'))
    expect(resolved.header).toBe('solid')
    expect(resolved.edge).toBe('ink')
    expect(resolved.border).toBe('hairline')
    expect(resolved.link).toBe('tone')
    expect(resolved.linkLabels).toBe(false)
  })

  it('老主题的观感不变：仍是淡底头 + 发丝连线', () => {
    for (const id of ['paper', 'minimal', 'tint'] as const) {
      const resolved = resolveCardStyle(applyTheme(id))
      expect(resolved.header).toBe('tint')
      expect(resolved.edge).toBe('hairline')
      expect(resolved.link).toBe('neutral')
      expect(resolved.linkLabels).toBe(true)
    }
    expect(resolveCardStyle(applyTheme('outline')).header).toBe('plain')
    expect(resolveCardStyle(applyTheme('ink')).header).toBe('plain')
  })

  it('自定义覆盖优先于主题预设', () => {
    const resolved = resolveCardStyle(style({ theme: 'ink', surface: 'paper', density: 'roomy' }))
    expect(resolved.surface).toBe('paper')
    expect(resolved.radius).toBe('soft')
    expect(resolved.density).toBe('roomy')
  })

  it('标题栏 / 连线 / 边框 / 链接标签可单项覆盖', () => {
    const resolved = resolveCardStyle(style({
      theme: 'paper',
      header: 'solid',
      edge: 'tone',
      border: 'none',
      link: 'tone',
      linkLabels: false,
    }))
    expect(resolved.header).toBe('solid')
    expect(resolved.edge).toBe('tone')
    expect(resolved.border).toBe('none')
    expect(resolved.link).toBe('tone')
    expect(resolved.linkLabels).toBe(false)
  })

  it('未知主题回落到第一套，不抛错', () => {
    const resolved = resolveCardStyle(style({ theme: 'nope' as never }))
    expect(resolved.surface).toBe(MINDMAP_THEMES[0].surface)
  })

  it('换主题会清掉自定义覆盖', () => {
    const custom = style({ theme: 'paper', surface: 'ink', radius: 'round', header: 'solid' })
    expect(applyTheme('minimal')).toEqual({
      theme: 'minimal',
      surface: null,
      radius: null,
      density: null,
      header: null,
      edge: null,
      border: null,
      link: null,
      linkLabels: null,
    })
    expect(isDefaultCardStyle(custom)).toBe(false)
  })
})

describe('样式持久化', () => {
  beforeEach(() => {
    installStorage()
  })

  it('按画布分别保存，互不影响', () => {
    saveCardStyle('canvas-a', style({ theme: 'ink' }))
    saveCardStyle('canvas-b', style({ theme: 'tint', surface: 'tint', radius: 'round' }))
    expect(readCardStyle('canvas-a').theme).toBe('ink')
    expect(readCardStyle('canvas-b').theme).toBe('tint')
    expect(readCardStyle('canvas-b').radius).toBe('round')
    expect(readCardStyle('canvas-c').theme).toBe('paper')
  })

  it('新的标题栏 / 连线设置能存能读', () => {
    saveCardStyle('canvas-block', style({ theme: 'block', header: 'solid', edge: 'tone', linkLabels: false }))
    const restored = readCardStyle('canvas-block')
    expect(restored.theme).toBe('block')
    expect(restored.header).toBe('solid')
    expect(restored.edge).toBe('tone')
    expect(restored.linkLabels).toBe(false)
  })

  it('脏数据被清洗成合法值', () => {
    localStorage.setItem('pdfnote.mindmap.style.canvas-x', JSON.stringify({
      theme: 'ghost', surface: 'neon', radius: 42, density: 'huge',
      header: 'neon', edge: 'rainbow', border: 7, link: 'purple', linkLabels: 'yes',
    }))
    const parsed = readCardStyle('canvas-x')
    expect(parsed).toEqual({ ...DEFAULT_CARD_STYLE })
  })

  it('旧版本存的样式（没有新字段）仍能读出来', () => {
    localStorage.setItem('pdfnote.mindmap.style.canvas-old', JSON.stringify({
      theme: 'ink', surface: 'ink', radius: 'sharp', density: 'roomy',
    }))
    const parsed = readCardStyle('canvas-old')
    expect(parsed.theme).toBe('ink')
    expect(parsed.header).toBeNull()
    expect(parsed.edge).toBeNull()
    expect(parsed.linkLabels).toBeNull()
  })

  it('损坏的 JSON 不抛错', () => {
    localStorage.setItem('pdfnote.mindmap.style.canvas-y', '{oops')
    expect(readCardStyle('canvas-y')).toEqual(DEFAULT_CARD_STYLE)
  })

  it('没有 localStorage 时返回默认值', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
    expect(readCardStyle('canvas-z')).toEqual(DEFAULT_CARD_STYLE)
    expect(saveCardStyle('canvas-z', style({ theme: 'ink' })).theme).toBe('ink')
  })
})
