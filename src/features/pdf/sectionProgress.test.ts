import { describe, expect, it } from 'vitest'
import { buildSectionProgress, type ProgressCardLike } from './sectionProgress'

const entries = [
  { cardId: 'ch1', page: 1, title: '第一章', level: 0 },
  { cardId: 's11', page: 3, title: '1.1 背景', level: 1 },
  { cardId: 's12', page: 8, title: '1.2 问题', level: 1 },
  { cardId: 'ch2', page: 20, title: '第二章', level: 0 },
]

const card = (id: string, parent: string | null, reps = 0): ProgressCardLike => ({ id, parent_id: parent, reps })

describe('章节进度', () => {
  it('按子树统计卡片数与复习数，骨架节点本身不算卡片', () => {
    const cards = [
      card('ch1', null),
      card('s11', 'ch1'),
      card('s12', 'ch1'),
      card('c1', 's11', 2),
      card('c2', 's11'),
      card('c3', 'c1', 1),
      card('c4', 'ch2', 3),
    ]
    const progress = buildSectionProgress(entries, cards, 1)
    const byId = new Map(progress.flat.map((node) => [node.cardId, node]))
    // 1.1 自己有两张卡，加上子卡 c3 共 3 张，复习过 2 张
    expect(byId.get('s11')).toMatchObject({ cardCount: 3, reviewedCount: 2 })
    expect(byId.get('s12')).toMatchObject({ cardCount: 0, reviewedCount: 0 })
    expect(byId.get('ch2')).toMatchObject({ cardCount: 1, reviewedCount: 1 })
    // 章节行算子树，所以「有卡的节」包含第一章；总数按唯一卡片算
    expect(progress).toMatchObject({ sections: 4, sectionsWithCards: 3, cards: 4, reviewed: 3 })
  })

  it('页码范围取下一节起始页减一，最后一节留空', () => {
    const progress = buildSectionProgress(entries, [], 1)
    expect(progress.flat.map((node) => node.endPage)).toEqual([2, 7, 19, null])
  })

  it('当前小节按页码定位', () => {
    expect(buildSectionProgress(entries, [], 1).currentCardId).toBe('ch1')
    expect(buildSectionProgress(entries, [], 7).currentCardId).toBe('s11')
    expect(buildSectionProgress(entries, [], 30).currentCardId).toBe('ch2')
    expect(buildSectionProgress(entries, [], 0).currentCardId).toBeNull()
  })

  it('层级挂成树，兄弟不会串到上一节下面', () => {
    const progress = buildSectionProgress(entries, [], 1)
    expect(progress.roots.map((node) => node.cardId)).toEqual(['ch1', 'ch2'])
    expect(progress.roots[0].children.map((node) => node.cardId)).toEqual(['s11', 's12'])
  })

  it('卡片 parent 成环时不会死循环', () => {
    const progress = buildSectionProgress(
      [{ cardId: 'ch1', page: 1, title: '第一章', level: 0 }],
      [card('a', 'b'), card('b', 'a')],
      1,
    )
    expect(progress.cards).toBe(0)
  })

  it('空骨架返回全 0，不抛错', () => {
    const progress = buildSectionProgress([], [card('c1', null, 2)], 1)
    expect(progress).toMatchObject({ sections: 0, cards: 0, reviewed: 0, currentCardId: null })
    expect(progress.flat).toEqual([])
  })

  it('卡片挂在不存在的父节点下时不会崩', () => {
    const progress = buildSectionProgress(entries, [card('orphan', 'missing', 1)], 1)
    expect(progress.cards).toBe(0)
  })
})
