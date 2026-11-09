import { beforeEach, describe, expect, it } from 'vitest'
import {
  ERASER_RADIUS_MAX,
  ERASER_RADIUS_MIN,
  PEN_WIDTH_DEFAULT,
  PEN_WIDTH_MAX,
  PEN_WIDTH_MIN,
  clampSize,
  formatSize,
  previewDiameter,
  readSizePreference,
  saveSizePreference,
  sizeRange,
} from './size'

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

describe('尺寸范围', () => {
  it('橡皮最小值就是「小」，最大值就是「特大」', () => {
    const range = sizeRange('eraser')
    expect(range.min).toBe(8)
    expect(range.max).toBe(56)
    expect(ERASER_RADIUS_MIN).toBe(8)
    expect(ERASER_RADIUS_MAX).toBe(56)
  })

  it('笔宽两端是原来的细 / 粗，默认值在范围内', () => {
    const range = sizeRange('pen')
    expect(range.min).toBe(PEN_WIDTH_MIN)
    expect(range.max).toBe(PEN_WIDTH_MAX)
    expect(PEN_WIDTH_DEFAULT).toBeGreaterThan(range.min)
    expect(PEN_WIDTH_DEFAULT).toBeLessThan(range.max)
  })
})

describe('clampSize', () => {
  it('越界、NaN 都回落到默认值', () => {
    expect(clampSize('eraser', 3)).toBe(18)
    expect(clampSize('eraser', 999)).toBe(18)
    expect(clampSize('eraser', Number.NaN)).toBe(18)
    expect(clampSize('pen', 0)).toBe(PEN_WIDTH_DEFAULT)
  })

  it('两端值与中间值原样保留', () => {
    expect(clampSize('eraser', 8)).toBe(8)
    expect(clampSize('eraser', 56)).toBe(56)
    expect(clampSize('eraser', 31)).toBe(31)
    expect(clampSize('pen', 0.0042)).toBe(0.0042)
  })
})

describe('显示与预览', () => {
  it('笔宽用千分比、橡皮用 px', () => {
    expect(formatSize('pen', 0.0028)).toBe('2.8')
    expect(formatSize('eraser', 56)).toBe('56')
  })

  it('预览圆点随数值单调变大，且不会撑破控件', () => {
    expect(previewDiameter('eraser', 56)).toBeGreaterThan(previewDiameter('eraser', 8))
    expect(previewDiameter('eraser', 56)).toBeLessThanOrEqual(40)
    expect(previewDiameter('pen', PEN_WIDTH_MIN)).toBeGreaterThanOrEqual(3)
  })
})

describe('尺寸偏好', () => {
  beforeEach(() => installStorage())

  it('笔宽与橡皮分别记住，两个工作区共享', () => {
    saveSizePreference('pen', 0.005)
    saveSizePreference('eraser', 42)
    expect(readSizePreference('pen')).toBe(0.005)
    expect(readSizePreference('eraser')).toBe(42)
  })

  it('损坏的偏好 JSON 与越界值都回落默认值', () => {
    localStorage.setItem('pdfnote.ink.size', '{not-json')
    expect(readSizePreference('eraser')).toBe(18)
    localStorage.setItem('pdfnote.ink.size', JSON.stringify({ eraser: 9999 }))
    expect(readSizePreference('eraser')).toBe(18)
  })
})
