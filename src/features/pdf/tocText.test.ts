import { describe, expect, it } from 'vitest'
import { assignSkeletonParents } from './pdfOutline'
import { parseTocText } from './tocText'

describe('粘贴目录：各种分隔形式', () => {
  it('点线、省略号、Tab、空格都能认出标题与页码', () => {
    const { entries, skipped } = parseTocText(
      [
        '第一章 绪论 ........ 1',
        '1.1 研究背景\t3',
        '1.2 研究问题 6',
        '第二章 方法 ………… 20',
      ].join('\n'),
    )
    expect(skipped).toEqual([])
    expect(entries).toEqual([
      { title: '第一章 绪论', page: 1, level: 0 },
      { title: '1.1 研究背景', page: 3, level: 1 },
      { title: '1.2 研究问题', page: 6, level: 1 },
      { title: '第二章 方法', page: 20, level: 0 },
    ])
  })

  it('页码带范围（12–14）取起始页', () => {
    const { entries } = parseTocText('第三章 结果 12-14')
    expect(entries).toEqual([{ title: '第三章 结果', page: 12, level: 0 }])
  })

  it('中文顿号编号与括号编号推层级', () => {
    const { entries } = parseTocText(['一、总论 1', '（一）定义 2', '二、方法 9'].join('\n'))
    expect(entries.map((entry) => entry.level)).toEqual([0, 1, 0])
  })

  it('只用缩进表达层级', () => {
    const { entries } = parseTocText(['绪论 1', '  背景 3', '    细节 4', '方法 9'].join('\n'))
    expect(entries.map((entry) => entry.level)).toEqual([0, 1, 2, 0])
  })
})

describe('粘贴目录：该跳过的行', () => {
  it('没有页码的行不猜，但会带回去给用户看', () => {
    const { entries, skipped } = parseTocText(['第一章 绪论 1', '这是一段说明文字', '第二章 方法 9'].join('\n'))
    expect(entries.map((entry) => entry.title)).toEqual(['第一章 绪论', '第二章 方法'])
    expect(skipped).toEqual(['这是一段说明文字'])
  })

  it('「绪论12」这种没有分隔的行不当成页码', () => {
    expect(parseTocText('绪论12').entries).toEqual([])
  })

  it('「目 录」「Contents」标题行不算条目', () => {
    expect(parseTocText(['目 录', 'Contents', '第一章 绪论 1'].join('\n')).entries).toHaveLength(1)
  })

  it('页码离谱（0 或 5000）的行跳过', () => {
    const { entries, skipped } = parseTocText(['零页 0', '离谱 5000', '正常 8'].join('\n'))
    expect(entries.map((entry) => entry.title)).toEqual(['正常'])
    expect(skipped).toHaveLength(2)
  })

  it('空文本 / 只有空白不会崩', () => {
    expect(parseTocText('').entries).toEqual([])
    expect(parseTocText('\n \n\t\n').entries).toEqual([])
  })
})

describe('粘贴目录：层级与上限', () => {
  it('层级一次最多往下一层，跳级会被压平', () => {
    const { entries } = parseTocText(['第一章 1', '1.1.1 很深的节 3'].join('\n'))
    expect(entries.map((entry) => entry.level)).toEqual([0, 1])
  })

  it('第一条永远是一级（否则整棵树没有根）', () => {
    const { entries } = parseTocText('1.1 背景 3')
    expect(entries[0].level).toBe(0)
  })

  it('重复的相邻行只留一条', () => {
    const { entries } = parseTocText(['第一章 绪论 1', '第一章 绪论 1'].join('\n'))
    expect(entries).toHaveLength(1)
  })

  it('条目数受上限约束', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `第 ${index} 节 ${index + 1}`)
    expect(parseTocText(lines.join('\n'), { maxEntries: 5 }).entries).toHaveLength(5)
  })

  it('解析结果能直接接树：二级挂到上一级', () => {
    const { entries } = parseTocText(
      ['第一章 绪论 1', '1.1 背景 3', '1.2 问题 6', '第二章 方法 20'].join('\n'),
    )
    expect(assignSkeletonParents(entries).map((node) => node.parentIndex)).toEqual([null, 0, 0, null])
  })
})
