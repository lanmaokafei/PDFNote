import { describe, expect, it } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { OcrLine } from '../../services/pdfnote'
import {
  extractTextFromLines,
  isSparseTextLayer,
  linesFromTextContent,
  normalizeLines,
  textLayerCoverage,
} from './pageText'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

const view = { x: 0, y: 0, width: 612, height: 792 }

const line = (
  text: string,
  x: number,
  y: number,
  width = 0.3,
  height = 0.03,
): OcrLine => ({ text, x, y, width, height, confidence: 1 })

describe('normalizeLines', () => {
  it('drops blank lines and clamps overscanned boxes', () => {
    const result = normalizeLines([
      line('   ', 0.1, 0.1),
      line('中文', -0.01, 0.2, 1.5, 0.04),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].x).toBe(0)
    expect(result[0].width).toBeCloseTo(1)
    expect(result[0].text).toBe('中文')
  })
})

describe('linesFromTextContent', () => {
  it('groups PDF text items into top-left-origin lines', () => {
    const content = {
      items: [
        { str: '信息', transform: [12, 0, 0, 12, 40, 700], width: 24, height: 12, hasEOL: false },
        { str: '系统', transform: [12, 0, 0, 12, 70, 700], width: 24, height: 12, hasEOL: true },
        { str: '第二行', transform: [12, 0, 0, 12, 40, 600], width: 36, height: 12, hasEOL: true },
      ],
    } as unknown as TextContent
    const lines = linesFromTextContent(content, view)
    expect(lines).toHaveLength(2)
    expect(lines[0].text).toBe('信息系统')
    expect(lines[1].text).toBe('第二行')
    expect(lines[0].y).toBeLessThan(lines[1].y)
    expect(lines[0].y).toBeGreaterThanOrEqual(0)
  })

  it('returns no lines for a scanned page', () => {
    const content = { items: [] } as unknown as TextContent
    expect(linesFromTextContent(content, view)).toEqual([])
  })
})

describe('extractTextFromLines', () => {
  const lines = [
    line('第一行文字', 0.1, 0.1),
    line('第二行文字', 0.1, 0.3),
  ]

  it('returns intersecting lines in reading order', () => {
    expect(extractTextFromLines(lines, { x: 0, y: 0, width: 1, height: 1 }))
      .toBe('第一行文字\n第二行文字')
  })

  it('ignores lines outside the selection', () => {
    expect(extractTextFromLines(lines, { x: 0, y: 0.28, width: 0.6, height: 0.06 }))
      .toBe('第二行文字')
  })

  it('returns an empty string when nothing intersects', () => {
    expect(extractTextFromLines(lines, { x: 0.8, y: 0.8, width: 0.1, height: 0.1 })).toBe('')
  })
})

describe('linesFromTextContent run geometry', () => {
  const item = (str: string, fontSize: number, x: number, baseline: number, width: number) => ({
    str,
    transform: [fontSize, 0, 0, fontSize, x, baseline],
    width,
    height: fontSize,
    hasEOL: true,
  })

  it('字号直接来自 transform，而不是行高估算', () => {
    const content = {
      items: [
        item('大标题', 21, 100, 700, 63),
        item('正文', 15, 100, 600, 30),
      ],
    } as unknown as TextContent
    const lines = linesFromTextContent(content, view)
    expect(lines).toHaveLength(2)
    expect(lines[0].runs?.[0].fontSize).toBeCloseTo(21 / 792, 5)
    expect(lines[0].runs?.[0].baselineTop).toBeCloseTo(1 - 700 / 792, 5)
    expect(lines[0].runs?.[0].x).toBeCloseTo(100 / 612, 5)
    expect(lines[0].runs?.[0].width).toBeCloseTo(63 / 612, 5)
    // 行包围盒按「基线 − 0.8×字号」折算，字号与行高一致
    expect(lines[0].height).toBeCloseTo(21 / 792, 5)
    expect(lines[0].y).toBeCloseTo(1 - 700 / 792 - (0.8 * 21) / 792, 5)
    expect(lines[1].runs?.[0].fontSize).toBeCloseTo(15 / 792, 5)
  })

  it('同一行内混排不同字号时按基线归组，取最大字号作为行高', () => {
    const content = {
      items: [
        item('正文', 15, 100, 700, 60),
        item('大字', 21, 160, 700, 42),
        item('继续', 15, 202, 700, 30),
      ],
    } as unknown as TextContent
    const lines = linesFromTextContent(content, view)
    expect(lines).toHaveLength(1)
    expect(lines[0].runs).toHaveLength(3)
    expect(lines[0].text).toBe('正文大字继续')
    expect(lines[0].height).toBeCloseTo(21 / 792, 5)
    expect(lines[0].width).toBeCloseTo(132 / 612, 5)
  })

  it('行间距不同的上下两行不会被合并', () => {
    const content = {
      items: [
        item('第一行', 15, 100, 700, 45),
        item('第二行', 15, 100, 680, 45),
      ],
    } as unknown as TextContent
    const lines = linesFromTextContent(content, view)
    expect(lines).toHaveLength(2)
  })
})

describe('sparse text layer detection', () => {
  const make = (text: string, width = 0.7, height = 0.02): OcrLine => ({
    text, x: 0.1, y: 0.2, width, height, confidence: 1,
  })

  it('只有页码的页视为稀疏', () => {
    expect(isSparseTextLayer([make('5', 0.02, 0.02)])).toBe(true)
  })

  it('正常正文页不稀疏', () => {
    const lines = Array.from({ length: 10 }, (_, index) => make(`第 ${index} 行正文内容`, 0.7, 0.02))
    expect(textLayerCoverage(lines)).toBeCloseTo(0.14, 5)
    expect(isSparseTextLayer(lines)).toBe(false)
  })

  it('字够多但覆盖面积很小（只有一行隐藏文字）也算稀疏', () => {
    expect(isSparseTextLayer([make('这是一行很长很长但只占页面一角的隐藏文字'.repeat(3), 0.3, 0.02)])).toBe(true)
  })
})
