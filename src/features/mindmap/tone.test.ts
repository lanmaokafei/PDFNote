import { beforeEach, describe, expect, it } from 'vitest'
import {
  SOLAR_TONES,
  clearToneOverride,
  readToneOverride,
  resetToneCache,
  rootIdOf,
  saveToneOverride,
  toneAt,
  toneIndexMap,
  toneIndexOf,
} from './tone'

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 相对亮度（sRGB 线性化）。 */
function wcagLuminance(hex: string): number {
  const value = hex.replace('#', '')
  const channel = (offset: number) => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

function contrast(foreground: string, background: string): number {
  const a = wcagLuminance(foreground)
  const b = wcagLuminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

function installStorage() {
  const map = new Map<string, string>()
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  return map
}

describe('二十四节气色板', () => {
  it('覆盖 24 个节气，节气与色名都不重复', () => {
    expect(SOLAR_TONES).toHaveLength(24)
    expect(new Set(SOLAR_TONES.map((tone) => tone.term)).size).toBe(24)
    expect(new Set(SOLAR_TONES.map((tone) => tone.color)).size).toBe(24)
  })

  it('每个色都是合法十六进制，且浅底更亮、深字更暗', () => {
    for (const tone of SOLAR_TONES) {
      for (const value of [tone.bar, tone.wash, tone.ink]) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/)
      }
      expect(luminance(tone.wash)).toBeGreaterThan(luminance(tone.bar))
      expect(luminance(tone.ink)).toBeLessThan(luminance(tone.bar))
      expect(tone.ring).toMatch(/^rgba\(/)
    }
  })

  it('淡底上的深色字对比度至少 4.5:1（可读性下限）', () => {
    for (const tone of SOLAR_TONES) {
      const ratio = contrast(tone.ink, tone.wash)
      expect(ratio, `${tone.term}·${tone.color} 对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('实心标题栏的字色对比度同样至少 4.5:1', () => {
    for (const tone of SOLAR_TONES) {
      expect(tone.onBar).toMatch(/^#[0-9a-f]{6}$/)
      const ratio = contrast(tone.onBar, tone.bar)
      expect(ratio, `${tone.term}·${tone.color} 实心头对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
    // 深色相用白字，浅色相用压深的同族色——不能一律白字。
    expect(SOLAR_TONES[18].onBar).toBe('#ffffff')
    expect(SOLAR_TONES[0].onBar).not.toBe('#ffffff')
  })

  it('色相覆盖春黄、夏红、秋蓝、冬紫四个象限', () => {
    const hueOf = (index: number) => {
      const hex = SOLAR_TONES[index].bar.replace('#', '')
      const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max === min) return 0
      const delta = max - min
      if (max === r) return ((g - b) / delta + (g < b ? 6 : 0)) * 60
      if (max === g) return ((b - r) / delta + 2) * 60
      return ((r - g) / delta + 4) * 60
    }
    const spring = SOLAR_TONES.slice(0, 6).map((_, index) => hueOf(index))
    const summer = SOLAR_TONES.slice(6, 12).map((_, index) => hueOf(index + 6))
    const winter = SOLAR_TONES.slice(18, 24).map((_, index) => hueOf(index + 18))
    // 春以暖色为主：嫩黄、黄绿、桃粉、暖褐、草绿（+ 一朵雾紫）
    expect(spring.filter((hue) => hue < 140 || hue > 340).length).toBeGreaterThanOrEqual(5)
    // 夏出现红（<20° 或 >340°）与蓝（180°–250°）
    expect(summer.some((hue) => hue < 20 || hue > 340)).toBe(true)
    expect(summer.some((hue) => hue > 180 && hue < 250)).toBe(true)
    // 冬以蓝紫为主
    expect(winter.filter((hue) => hue > 180 && hue < 340).length).toBeGreaterThanOrEqual(3)
  })

  it('toneAt 越界回绕', () => {
    expect(toneAt(0).term).toBe('立春')
    expect(toneAt(24).term).toBe('立春')
    expect(toneAt(-1).term).toBe('大寒')
    expect(toneAt(999).term).toBe(SOLAR_TONES[999 % 24].term)
  })
})

describe('色调分配', () => {
  it('同一 id 永远落在同一色相', () => {
    expect(toneIndexOf('card-alpha')).toBe(toneIndexOf('card-alpha'))
    expect(toneIndexOf('card-alpha')).toBeGreaterThanOrEqual(0)
    expect(toneIndexOf('card-alpha')).toBeLessThan(24)
  })

  it('不同 id 会分散到多个色相，而不是挤在一两个上', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `card-${index}`)
    const used = new Set(ids.map(toneIndexOf))
    expect(used.size).toBeGreaterThan(8)
  })

  it('沿父子链找到子树根，整棵树同色', () => {
    const parents = new Map<string, string | null>([
      ['root', null],
      ['a', 'root'],
      ['b', 'a'],
      ['c', 'b'],
      ['other', null],
    ])
    expect(rootIdOf('c', parents)).toBe('root')
    expect(rootIdOf('a', parents)).toBe('root')
    expect(rootIdOf('root', parents)).toBe('root')
    expect(rootIdOf('other', parents)).toBe('other')
    // 根 id 相同 → 色相相同
    expect(toneIndexOf(rootIdOf('c', parents))).toBe(toneIndexOf(rootIdOf('a', parents)))
  })

  it('父子链成环时不死循环', () => {
    const parents = new Map<string, string | null>([['x', 'y'], ['y', 'x']])
    expect(['x', 'y']).toContain(rootIdOf('x', parents))
  })

  it('父节点不在表里时退回自身', () => {
    expect(rootIdOf('orphan', new Map([['orphan', 'ghost']]))).toBe('orphan')
  })

  it('批量算色：同一棵树同色，不同树分散，手动覆盖优先生效', () => {
    const parents = new Map<string, string | null>([
      ['a', null],
      ['a1', 'a'],
      ['a2', 'a1'],
      ['b', null],
      ['b1', 'b'],
      ['b2', 'b1'],
    ])
    const tones = toneIndexMap(parents)
    expect(tones.get('a1')).toBe(tones.get('a'))
    expect(tones.get('a2')).toBe(tones.get('a'))
    expect(tones.get('b1')).toBe(tones.get('b'))
    expect(tones.get('b2')).toBe(tones.get('b'))
    expect(tones.size).toBe(6)

    const overridden = toneIndexMap(parents, { a1: 9 })
    expect(overridden.get('a1')).toBe(9)
    expect(overridden.get('a2')).toBe(tones.get('a'))
    expect(overridden.get('a')).toBe(tones.get('a'))
  })
})

describe('手动换色', () => {
  beforeEach(() => {
    installStorage()
    resetToneCache()
  })

  it('写入后能读回，并持久化到 localStorage', () => {
    expect(readToneOverride('card-1')).toBeNull()
    saveToneOverride('card-1', 7)
    expect(readToneOverride('card-1')).toBe(7)
    resetToneCache()
    expect(readToneOverride('card-1')).toBe(7)
  })

  it('越界序号回绕到 0–23', () => {
    saveToneOverride('card-2', 30)
    expect(readToneOverride('card-2')).toBe(6)
    saveToneOverride('card-2', -1)
    expect(readToneOverride('card-2')).toBe(23)
  })

  it('清除后恢复按子树自动配色', () => {
    saveToneOverride('card-3', 4)
    clearToneOverride('card-3')
    expect(readToneOverride('card-3')).toBeNull()
  })

  it('没有 localStorage 时仍能在当前会话内生效', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
    resetToneCache()
    saveToneOverride('card-4', 3)
    expect(readToneOverride('card-4')).toBe(3)
  })
})
