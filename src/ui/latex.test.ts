import { describe, expect, it } from 'vitest'
import { looksLikeLatex, splitMathText } from './latex'

describe('looksLikeLatex', () => {
  it('recognizes the formula returned by the AI gateway', () => {
    expect(looksLikeLatex('H = -\\sum_{i=1}^{n} P(x_i) \\log_2 P(x_i)')).toBe(true)
  })

  it('recognizes short inline math', () => {
    expect(looksLikeLatex('E = mc^2')).toBe(true)
    expect(looksLikeLatex('x_i + x_{i+1}')).toBe(true)
    expect(looksLikeLatex('a^2 + b^2 = c^2')).toBe(true)
  })

  it('keeps ordinary prose as text', () => {
    expect(looksLikeLatex('典型胸痛 + ST 段改变 + 心肌酶升高')).toBe(false)
    expect(looksLikeLatex('这是一段关于熵的笔记')).toBe(false)
    expect(looksLikeLatex('This is a note about entropy.')).toBe(false)
    expect(looksLikeLatex('')).toBe(false)
  })

  it('rejects very long text so notes are never swallowed', () => {
    expect(looksLikeLatex(`\\sum ${'a'.repeat(600)}`)).toBe(false)
  })
})

describe('splitMathText', () => {
  it('treats a bare latex string as one display formula', () => {
    const segments = splitMathText('H = -\\sum_{i=1}^{n} P(x_i) \\log_2 P(x_i)')
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe('math')
    expect(segments[0].display).toBe(true)
  })

  it('splits inline delimiters and keeps surrounding text', () => {
    const segments = splitMathText('熵的定义是 $H = -\\sum p\\log p$，单位是 bit。')
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'math', 'text'])
    expect(segments[1].value).toContain('\\sum')
    expect(segments[1].display).toBe(false)
    expect(segments[2].value).toContain('单位是 bit')
  })

  it('supports display delimiters', () => {
    const segments = splitMathText('推导：\n$$E = mc^2$$\n完成')
    const math = segments.find((segment) => segment.kind === 'math')
    expect(math?.display).toBe(true)
    expect(math?.value).toBe('E = mc^2')
  })

  it('keeps unmatched delimiters as plain text', () => {
    const segments = splitMathText('价格 $5 元')
    expect(segments.every((segment) => segment.kind === 'text')).toBe(true)
  })

  it('returns plain text unchanged', () => {
    const segments = splitMathText('普通笔记')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ kind: 'text', value: '普通笔记', display: false })
  })
})
