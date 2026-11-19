import { describe, expect, it } from 'vitest'
import { buildSnippet, findHits, linesFromOcr, linesFromTextContent } from './pageSearch'

describe('PDF 全文搜索', () => {
  it('按子串大小写不敏感地找全部命中', () => {
    const lines = [
      { text: 'Entropy is a measure of disorder', rects: [{ x: 0, y: 0, width: 0.5, height: 0.02 }] },
      { text: 'entropy 与能量', rects: [{ x: 0, y: 0.1, width: 0.3, height: 0.02 }] },
    ]
    const hits = findHits(lines, 'ENTROPY', 3)
    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => hit.page === 3)).toBe(true)
    expect(hits[0].rects[0].y).toBe(0)
  })

  it('同一行多次出现都要出命中', () => {
    const lines = [{ text: 'ATP 生成 ATP 再消耗 ATP', rects: [{ x: 0, y: 0, width: 0.6, height: 0.02 }] }]
    expect(findHits(lines, 'ATP', 1)).toHaveLength(3)
  })

  it('空查询返回空数组，命中数受上限约束', () => {
    const lines = [{ text: 'a a a a a', rects: [{ x: 0, y: 0, width: 0.4, height: 0.02 }] }]
    expect(findHits(lines, '   ', 1)).toEqual([])
    expect(findHits(lines, 'a', 1, 2)).toHaveLength(2)
  })

  it('摘要截取命中附近并补省略号', () => {
    const text = `${'前言'.repeat(20)}关键概念${'后记'.repeat(20)}`
    const snippet = buildSnippet(text, text.indexOf('关键概念'), 4)
    expect(snippet).toContain('关键概念')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThan(text.length)
  })

  it('短文本摘要不加省略号', () => {
    expect(buildSnippet('关键概念', 0, 4)).toBe('关键概念')
  })

  it('OCR 行按归一化矩形转成可搜索行', () => {
    const lines = linesFromOcr([
      { text: '  第一章  绪论 ', x: 0.1, y: 0.2, width: 0.3, height: 0.02 },
      { text: '   ', x: 0, y: 0, width: 0.1, height: 0.01 },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('第一章 绪论')
    expect(lines[0].rects[0]).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.02 })
  })

  it('文字层项按 transform 换算成归一化框', () => {
    // viewport 缩放 1、无旋转：transform = [1,0,0,-1,0,800]，页面 600×800。
    const lines = linesFromTextContent(
      [{ str: 'Hello', transform: [10, 0, 0, 10, 50, 700], width: 40, height: 10 }],
      { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
    )
    expect(lines).toHaveLength(1)
    const rect = lines[0].rects[0]
    expect(rect.x).toBeCloseTo(50 / 600, 5)
    // 基线在距顶 100px 处，字高 10 → 文本盒顶部 90px。
    expect(rect.y).toBeCloseTo((800 - 700 - 10) / 800, 5)
    expect(rect.width).toBeCloseTo(40 / 600, 5)
    expect(rect.height).toBeCloseTo(10 / 800, 5)
  })

  it('空文本项与非法变换直接跳过', () => {
    const lines = linesFromTextContent(
      [
        { str: '   ', transform: [10, 0, 0, 10, 0, 0], width: 10, height: 10 },
        { str: 'bad', transform: [0, 0, 0, 0, 0, 0], width: 10, height: 10 },
        { str: 'ok', transform: [10, 0, 0, 10, 0, 700], width: 10, height: 10 },
      ],
      { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
    )
    expect(lines.map((line) => line.text)).toEqual(['ok'])
  })
})
