import { describe, expect, it } from 'vitest'
import type { OcrLine } from '../../services/pdfnote'
import { ocrLinesToText } from './tocOcr'

function line(text: string, x: number, y: number, height = 0.02): OcrLine {
  return { text, x, y, width: 0.2, height, confidence: 0.9 }
}

describe('目录页 OCR 文本', () => {
  it('按 y 从上到下、同一行按 x 从左到右', () => {
    const lines = [
      line('1', 0.7, 0.12),
      line('第一章 绪论', 0.1, 0.10),
      line('1.1 研究背景', 0.1, 0.16),
      line('3', 0.7, 0.16),
    ]
    expect(ocrLinesToText(lines)).toBe('第一章 绪论 1\n1.1 研究背景 3')
  })

  it('同一行的行高不同也不拆成两行', () => {
    const lines = [line('第二章 方法', 0.1, 0.2, 0.03), line('20', 0.8, 0.206, 0.012)]
    expect(ocrLinesToText(lines)).toBe('第二章 方法 20')
  })

  it('相邻两行间距足够时不会合并', () => {
    const lines = [line('第一章', 0.1, 0.1), line('1.1 小节', 0.1, 0.14)]
    expect(ocrLinesToText(lines)).toBe('第一章\n1.1 小节')
  })

  it('忽略空白行并压缩多余空格', () => {
    const lines = [line('  ', 0.1, 0.1), line('第一章    绪论', 0.1, 0.2), line(' 5 ', 0.8, 0.2)]
    expect(ocrLinesToText(lines)).toBe('第一章 绪论 5')
  })

  it('没有可用行时返回空串', () => {
    expect(ocrLinesToText([])).toBe('')
    expect(ocrLinesToText([line('   ', 0.1, 0.1)])).toBe('')
  })
})
