import { describe, expect, it } from 'vitest'
import { decideFormulaRecognition } from './formulaRecognition'

const base = { excerpt: '', fromOcr: false, aiReady: true, hasImage: true }

describe('decideFormulaRecognition', () => {
  it('文字层里的公式也会走视觉模型（此前只覆盖 OCR 来源）', () => {
    const decision = decideFormulaRecognition({ ...base, excerpt: 'E = mc^2', fromOcr: false })
    expect(decision.isFormula).toBe(true)
    expect(decision.discardExcerpt).toBe(false)
    expect(decision.useVisionModel).toBe(true)
  })

  it('OCR 公式丢弃乱码原文，但仍走模型', () => {
    const decision = decideFormulaRecognition({ ...base, excerpt: 'P(A|B) = 0.3', fromOcr: true })
    expect(decision.isFormula).toBe(true)
    expect(decision.discardExcerpt).toBe(true)
    expect(decision.useVisionModel).toBe(true)
  })

  it('未配置模型时只保留原文与图像，不发起识别', () => {
    const decision = decideFormulaRecognition({ ...base, excerpt: 'E = mc^2', aiReady: false })
    expect(decision.useVisionModel).toBe(false)
  })

  it('没有选区图像时无法识别', () => {
    const decision = decideFormulaRecognition({ ...base, excerpt: 'E = mc^2', hasImage: false })
    expect(decision.useVisionModel).toBe(false)
  })

  it('普通文字不会触发公式识别', () => {
    const decision = decideFormulaRecognition({ ...base, excerpt: '信息系统项目管理师教程', fromOcr: true })
    expect(decision.isFormula).toBe(false)
    expect(decision.useVisionModel).toBe(false)
    expect(decision.discardExcerpt).toBe(false)
  })

  it('空文本不视为公式', () => {
    expect(decideFormulaRecognition({ ...base, excerpt: '   ' }).isFormula).toBe(false)
  })
})
