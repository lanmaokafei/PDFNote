import { describe, expect, it } from 'vitest'
import { MATCH_LABELS, evaluateAnswer, normalizeAnswerText } from './answerMatch'

const reference = [
  '线粒体是细胞的能量工厂，负责通过氧化磷酸化产生 ATP。',
  'ATP 是细胞内通用的能量货币。',
]

describe('normalizeAnswerText', () => {
  it('剥离 HTML、LaTeX 命令、实体并把全角标点统一成空格', () => {
    expect(normalizeAnswerText('<p>E＝mc²，&nbsp;能量！</p>'))
      .toBe('e mc2 能量')
  })

  it('保留公式里的命令名与字母数字，丢弃反斜杠与括号', () => {
    expect(normalizeAnswerText('$H = -\\sum p \\log_2 p$ bit'))
      .toBe('h sum p log 2 p bit')
  })
})

describe('evaluateAnswer', () => {
  it('完整复述参考答案时接近满分，且要点全部命中', () => {
    const result = evaluateAnswer(reference.join(''), reference)
    expect(result.level).toBe('excellent')
    expect(result.score).toBeGreaterThan(0.95)
    expect(result.matched.length).toBeGreaterThan(0)
    expect(result.missing).toHaveLength(0)
  })

  it('大小写、标点与 HTML 差异不影响匹配', () => {
    const answer = '<p>The entropy is $H = -\\sum p \\log p$ bits.</p>'
    const plain = 'The entropy is H p log p bits.'
    expect(evaluateAnswer(plain, [answer]).level).toBe('excellent')
  })

  it('只写核心关键词也能得到部分命中反馈', () => {
    const result = evaluateAnswer('线粒体产生 ATP', reference)
    expect(['partial', 'good', 'excellent']).toContain(result.level)
    expect(result.score).toBeGreaterThan(0.12)
    expect(result.matched.some((point) => point.includes('线粒体'))).toBe(true)
  })

  it('按要点片段区分已覆盖与待补内容', () => {
    const result = evaluateAnswer(reference[0], reference)
    expect(result.matched.some((point) => point.includes('线粒体'))).toBe(true)
    expect(result.missing.some((point) => point.includes('货币'))).toBe(true)
  })

  it('未输入时只提示直接查看答案，不泄露任何要点', () => {
    const result = evaluateAnswer('   \n ', reference)
    expect(result.level).toBe('empty')
    expect(result.score).toBe(0)
    expect(result.matched).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
  })

  it('卡片没有文字答案时给出明确说明', () => {
    const result = evaluateAnswer('我记住了', ['', '   '])
    expect(result.level).toBe('no-answer')
    expect(result.score).toBe(0)
    expect(result.summary).toContain('没有可对比')
  })

  it('卡片没有文字答案且未输入时，优先说明卡片情况', () => {
    const result = evaluateAnswer('', ['', ''])
    expect(result.level).toBe('no-answer')
    expect(result.matched).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
  })

  it('完全无关的输入判为偏差较大', () => {
    const result = evaluateAnswer('今天天气很好适合散步', reference)
    expect(result.level).toBe('miss')
    expect(result.score).toBeLessThan(0.12)
  })

  it('把整章内容连同答案一起粘贴会被精准度惩罚', () => {
    const exact = evaluateAnswer(reference.join(''), reference)
    const padded = evaluateAnswer(
      `${reference.join('')} 蛋白质合成与核糖体结构、内质网运输、高尔基体加工、溶酶体降解、细胞骨架与有丝分裂的全部过程`,
      reference,
    )
    expect(padded.score).toBeLessThan(exact.score)
    expect(padded.score).toBeLessThan(0.68)
  })

  it('要点片段最多各展示 4 条，且不重复', () => {
    const many = Array.from({ length: 8 }, (_, index) => `第${index + 1}个独立概念：核糖体组装因子`)
    const result = evaluateAnswer(many[0], many)
    expect(result.matched.length).toBeLessThanOrEqual(4)
    expect(result.missing.length).toBeLessThanOrEqual(4)
    expect(new Set([...result.matched, ...result.missing]).size)
      .toBe(result.matched.length + result.missing.length)
  })

  it('每个分档都有中文标签', () => {
    for (const level of ['empty', 'no-answer', 'excellent', 'good', 'partial', 'miss'] as const) {
      expect(MATCH_LABELS[level].length).toBeGreaterThan(0)
    }
  })
})
