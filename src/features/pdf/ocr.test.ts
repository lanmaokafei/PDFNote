import { describe, expect, it } from 'vitest'
import { looksLikeMathFormula } from './ocr'

describe('looksLikeMathFormula', () => {
  it('识别典型的 OCR 公式输出', () => {
    // 用户实际遇到的香农熵公式误识输出。
    expect(looksLikeMathFormula('小任及及里，衣现为贝熵，W异2 H =-[P(x) 10g, P(x:)')).toBe(true)
    expect(looksLikeMathFormula('H = -∑P(xi)log2P(xi)')).toBe(true)
    expect(looksLikeMathFormula('f(x) = ax² + bx + c')).toBe(true)
    expect(looksLikeMathFormula('∫f(x)dx = F(b)-F(a)')).toBe(true)
    expect(looksLikeMathFormula('y=1n(x)+C')).toBe(true)
    // 文字层里的常见写法：单变量等式 + ^ 上标。
    expect(looksLikeMathFormula('E = mc^2')).toBe(true)
    expect(looksLikeMathFormula('x_1 + x_2 = 0')).toBe(true)
    expect(looksLikeMathFormula('a^n + b^n = c^n')).toBe(true)
  })

  it('普通中文摘录不误判', () => {
    expect(looksLikeMathFormula('信息系统项目管理包括启动、规划、执行、监控和收尾五个过程组。')).toBe(false)
    expect(looksLikeMathFormula('熵是系统无序度的度量，表现为信息熵的计算公式。')).toBe(false)
    expect(looksLikeMathFormula('质量管理包括质量规划、质量保证与质量控制。')).toBe(false)
    expect(looksLikeMathFormula('')).toBe(false)
    expect(looksLikeMathFormula('第 3 页')).toBe(false)
    expect(looksLikeMathFormula('（1）项目范围管理。')).toBe(false)
  })
})
