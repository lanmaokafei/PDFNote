import { describe, expect, it } from 'vitest'
import { COLLAPSE_THRESHOLD, isClampable } from './clamp'

describe('isClampable', () => {
  it('空内容和短笔记直接完整显示，不必点击', () => {
    expect(isClampable('')).toBe(false)
    expect(isClampable('   \n  ')).toBe(false)
    expect(isClampable('熵用来度量不确定性')).toBe(false)
  })

  it('AI 解析这类多段文本即使很短也要能展开', () => {
    expect(isClampable('是什么：熵\n为什么：分布均匀时最大')).toBe(true)
    expect(isClampable('【AI 解析】\n是什么：熵')).toBe(true)
  })

  it('一整段超长文字也要能展开并滚动', () => {
    expect(isClampable('熵'.repeat(COLLAPSE_THRESHOLD))).toBe(false)
    expect(isClampable('熵'.repeat(COLLAPSE_THRESHOLD + 1))).toBe(true)
  })

  it('公式本身不触发折叠，避免块级公式被裁切', () => {
    expect(isClampable('H = -\\sum_{i=1}^{n} P(x_i) \\log_2 P(x_i)')).toBe(false)
    expect(isClampable('$H = -\\sum p \\log p$')).toBe(false)
  })
})
