import { describe, expect, it } from 'vitest'
import { buildCloze, checkCloze, judgeClozeBlank } from './cloze'

const plain = (exercise: ReturnType<typeof buildCloze>) => exercise.segments
  .map((segment) => (segment.kind === 'text' ? segment.text : `【${segment.blank.answer}】`))
  .join('')

describe('挖空抽取', () => {
  it('中文句子挖掉信息量最高的短语，其余文字保留为线索', () => {
    const exercise = buildCloze('典型胸痛 + ST 段改变 + 心肌酶升高，需要尽快再灌注。')
    expect(exercise.reason).toBe('')
    expect(exercise.blanks.length).toBeGreaterThan(0)
    expect(exercise.blanks.length).toBeLessThanOrEqual(2)
    // 挖空后原文必须还能完整还原：段落文本 + 答案 === 摘录
    const restored = exercise.segments
      .map((segment) => (segment.kind === 'text' ? segment.text : segment.blank.answer))
      .join('')
    expect(restored).toBe(exercise.excerpt)
  })

  it('数字优先成为空：剂量、阈值比形容词更值得记', () => {
    const exercise = buildCloze('再灌注时间窗为 12 小时，超过后获益明显下降。')
    expect(exercise.blanks.some((blank) => blank.answer.includes('12'))).toBe(true)
  })

  it('不会把两个空挤在一起：中间必须留线索', () => {
    const exercise = buildCloze('急性心肌梗死需要尽快开通梗死相关动脉并恢复血流灌注。')
    expect(exercise.blanks.length).toBeLessThanOrEqual(2)
    const blankCount = exercise.segments.filter((segment) => segment.kind === 'blank').length
    const textLength = plain(exercise).replace(/【[^】]*】/g, '').length
    expect(blankCount).toBeLessThanOrEqual(2)
    expect(textLength).toBeGreaterThan(6)
  })

  it('公式片段不挖空，保留为可见文本', () => {
    const exercise = buildCloze('$H = -\\sum p \\log p$ 表示信息熵，单位是 bit。')
    expect(exercise.reason).toBe('')
    expect(exercise.blanks.every((blank) => !blank.answer.includes('sum'))).toBe(true)
    expect(plain(exercise)).toContain('$H')
  })

  it('纯公式或过短摘录直接退化，不硬挖', () => {
    expect(buildCloze('H = -\\sum_{i=1}^{n} P(x_i) \\log_2 P(x_i)').reason).not.toBe('')
    expect(buildCloze('熵').reason).not.toBe('')
    expect(buildCloze('').reason).not.toBe('')
  })

  it('英文摘录挖内容词，不挖 the/of 这类虚词', () => {
    const exercise = buildCloze('The mitral valve regulates blood flow between the left atrium and ventricle.')
    expect(exercise.reason).toBe('')
    const answers = exercise.blanks.map((blank) => blank.answer.toLowerCase())
    expect(answers).not.toContain('the')
    expect(answers).not.toContain('of')
  })

  it('最多挖 2 个空，可配置上限', () => {
    const text = '血红蛋白浓度持续下降，提示活动性出血，需要复查血常规并评估循环容量状态。'
    expect(buildCloze(text).blanks.length).toBeLessThanOrEqual(2)
    expect(buildCloze(text, { maxBlanks: 1 }).blanks.length).toBe(1)
  })

  it('每个空的提示保留首字与字数', () => {
    const exercise = buildCloze('患者出现急性左心衰竭，需要立即给予利尿治疗。')
    const blank = exercise.blanks[0]
    expect(blank.hint.startsWith(Array.from(blank.answer)[0])).toBe(true)
    expect(blank.hint).toContain(String(Array.from(blank.answer).length))
    expect(blank.length).toBe(Array.from(blank.answer).length)
  })
})

describe('每次会话换空', () => {
  const text = '患者出现急性左心衰竭，需要立即给予利尿治疗，并监测 24 小时尿量与体重变化。'

  const answersFor = (turn: number) => buildCloze(text, { turn }).blanks.map((blank) => blank.answer)

  it('同一个 turn 结果完全稳定（会话内不会跳）', () => {
    expect(answersFor(3)).toEqual(answersFor(3))
    expect(answersFor(0)).toEqual(answersFor(0))
  })

  it('不同 turn 会换一批词，且循环回起点', () => {
    const seen = new Set(Array.from({ length: 4 }, (_, turn) => answersFor(turn).join('|')))
    expect(seen.size).toBeGreaterThan(1)
    // 候选池是 4 个，turn 4 与 turn 0 取同一批
    expect(answersFor(4)).toEqual(answersFor(0))
  })

  it('轮换后仍然只挖高分候选，且两个空之间留着线索', () => {
    for (let turn = 0; turn < 8; turn += 1) {
      const exercise = buildCloze(text, { turn })
      expect(exercise.blanks).toHaveLength(2)
      // 重建可见文本，量一下两个空之间还剩多少字
      let visible = ''
      let firstEnd = -1
      let secondStart = -1
      for (const segment of exercise.segments) {
        if (segment.kind === 'text') visible += segment.text
        else {
          if (firstEnd < 0) firstEnd = visible.length
          else if (secondStart < 0) secondStart = visible.length
          visible += '【】'
        }
      }
      if (secondStart >= 0 && firstEnd >= 0) {
        expect(secondStart - firstEnd).toBeGreaterThanOrEqual(4)
      }
      // 轮换不能挖到泛化词
      expect(exercise.blanks.map((blank) => blank.answer)).not.toContain('定义')
    }
  })
})

describe('填空判定', () => {
  it('完全一致算对，忽略标点、空格与全半角', () => {
    expect(judgeClozeBlank('心肌酶升高', '心肌酶升高')).toBe('correct')
    expect(judgeClozeBlank(' 心肌酶升高，', '心肌酶升高')).toBe('correct')
    expect(judgeClozeBlank('ＢＩＴ', 'bit')).toBe('correct')
  })

  it('差一个字算接近，不算错', () => {
    expect(judgeClozeBlank('心肌酶上升', '心肌酶升高')).toBe('close')
    expect(judgeClozeBlank('再灌柱', '再灌注')).toBe('close')
  })

  it('答错与空着要区分开', () => {
    expect(judgeClozeBlank('右心衰竭', '左心衰竭')).toBe('close')
    expect(judgeClozeBlank('完全无关的答案', '心肌酶升高')).toBe('wrong')
    expect(judgeClozeBlank('   ', '心肌酶升高')).toBe('empty')
  })

  it('全部答对才算解决，接近不算', () => {
    const exercise = buildCloze('再灌注时间窗为 12 小时，超过后获益下降。')
    const answers = exercise.blanks.map((blank) => blank.answer)
    const solved = checkCloze(exercise, answers)
    expect(solved.solved).toBe(true)
    expect(solved.correct).toBe(solved.total)

    const near = checkCloze(exercise, answers.map((answer) => `${answer}错`))
    expect(near.solved).toBe(false)

    const blank = checkCloze(exercise, [])
    expect(blank.correct).toBe(0)
    expect(blank.items.every((item) => item.verdict === 'empty')).toBe(true)
  })
})
