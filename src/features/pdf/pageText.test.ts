import { describe, expect, it } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { OcrLine } from '../../services/pdfnote'
import {
  extractTextFromLines,
  linesFromTextContent,
  normalizeLines,
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
