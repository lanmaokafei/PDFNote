import { describe, expect, it } from 'vitest'
import { buildWeeklyReport, weekStartIso, type ReviewStatLike, type WeeklyCardLike } from './weeklyReport'

const entries = [
  { cardId: 'ch1', page: 1, title: '第一章', level: 0 },
  { cardId: 's11', page: 3, title: '1.1 背景', level: 1 },
  { cardId: 'ch2', page: 20, title: '第二章', level: 0 },
]

const card = (id: string, parent: string | null, created: string): WeeklyCardLike => ({
  id, parent_id: parent, created_at: created,
})

const stat = (cardId: string, reviews: number, again: number, hard: number, good: number, easy = 0): ReviewStatLike => ({
  cardId, reviews, again, hard, good, easy,
})

describe('本周起点', () => {
  it('取当地时间的本周一 00:00', () => {
    // 2026-11-18 是周三，本周一应为 11-16。
    const start = new Date(weekStartIso(new Date(2026, 10, 18, 15, 30)))
    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(10)
    expect(start.getDate()).toBe(16)
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
  })

  it('周一当天不会倒退一周', () => {
    expect(new Date(weekStartIso(new Date(2026, 10, 16, 9, 0))).getDate()).toBe(16)
  })
})

describe('本周学习报告', () => {
  const weekStart = new Date(2026, 10, 16, 0, 0).toISOString()
  const cards = [
    card('ch1', null, '2026-10-01T00:00:00.000Z'),
    card('s11', 'ch1', '2026-10-01T00:00:00.000Z'),
    card('ch2', null, '2026-10-01T00:00:00.000Z'),
    card('c1', 's11', '2026-11-17T09:00:00.000Z'),
    card('c2', 's11', '2026-11-10T09:00:00.000Z'),
    card('c3', 'ch2', '2026-11-18T09:00:00.000Z'),
  ]
  const stats = [
    stat('c1', 4, 2, 1, 1),
    stat('c2', 3, 0, 1, 2),
    stat('c3', 2, 0, 0, 2),
  ]

  it('写卡只算本周新建、且排除骨架节点', () => {
    const report = buildWeeklyReport({ entries, cards, stats, weekStart })
    expect(report.cardsWritten).toBe(2)
  })

  it('复习次数、复习卡片数与正确率', () => {
    const report = buildWeeklyReport({ entries, cards, stats, weekStart })
    expect(report.reviews).toBe(9)
    expect(report.reviewedCards).toBe(3)
    expect(report.correctRate).toBeCloseTo(5 / 9, 5)
  })

  it('章节行按子树累计复习数据', () => {
    const report = buildWeeklyReport({ entries, cards, stats, weekStart })
    // 第一章 4+3=7 次，1.1 是 4+3，第二章 2 次
    expect(report.sectionsTouched).toBe(3)
  })

  it('把「复习多且重来/困难占比高」的小节标成卡住', () => {
    const report = buildWeeklyReport({ entries, cards, stats, weekStart })
    // 1.1 的 7 次里 3 次 again/hard（0.43）→ 卡住；父章节不再重复报，第二章 2 次不够门槛
    expect(report.stuck.map((section) => section.cardId)).toEqual(['s11'])
    // c1（again2 hard1）+ c2（hard1）合计：7 次、2 次重来、2 次困难
    expect(report.stuck[0]).toMatchObject({ reviews: 7, again: 2, hard: 2 })
  })

  it('卡住按重来次数排序，同分看复习次数', () => {
    const report = buildWeeklyReport({
      entries,
      cards,
      stats: [stat('c1', 5, 3, 0, 2), stat('c3', 6, 3, 1, 2)],
      weekStart,
    })
    // 父章节 ch1 被 s11 取代，只剩最具体的小节；同是 3 次重来，复习次数多的排前面
    expect(report.stuck.map((section) => section.cardId)).toEqual(['ch2', 's11'])
  })

  it('骨架卡自己的复习也计入所在小节', () => {
    const report = buildWeeklyReport({
      entries,
      cards,
      stats: [stat('s11', 4, 3, 0, 1)],
      weekStart,
    })
    const section = report.stuck.find((item) => item.cardId === 's11')
    expect(section).toMatchObject({ reviews: 4, again: 3 })
    expect(report.reviews).toBe(4)
  })

  it('没有复习记录时正确率为 0、不报错', () => {
    const report = buildWeeklyReport({ entries, cards, stats: [], weekStart })
    expect(report).toMatchObject({ reviews: 0, reviewedCards: 0, correctRate: 0, stuck: [], sectionsTouched: 0 })
    expect(report.cardsWritten).toBe(2)
  })

  it('不在骨架子树里的卡片不计入写卡与复习（与章节进度同口径）', () => {
    const report = buildWeeklyReport({
      entries: [entries[0]],
      cards: [...cards, card('orphan', null, '2026-11-18T00:00:00.000Z')],
      stats: [...stats, stat('orphan', 5, 5, 0, 0)],
      weekStart,
    })
    expect(report.cardsWritten).toBe(1)
    expect(report.reviews).toBe(7)
  })
})
