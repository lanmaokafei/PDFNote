import { describe, expect, it } from 'vitest'
import { activeDayCount, averagePerDay, currentStreak, longestStreak, monthTotals } from './yearReview'

const days = [
  { day: '2026-01-02', seconds: 600 },
  { day: '2026-01-03', seconds: 300 },
  { day: '2026-01-05', seconds: 900 },
  { day: '2026-02-01', seconds: 120 },
  { day: '2026-02-02', seconds: 60 },
  { day: '2026-02-03', seconds: 60 },
  { day: '2025-12-31', seconds: 999 },
]

describe('年度回顾', () => {
  it('按月汇总，跨年与零秒记录不计入', () => {
    const months = monthTotals([...days, { day: '2026-03-01', seconds: 0 }], 2026)
    expect(months[0]).toBe(1800)
    expect(months[1]).toBe(240)
    expect(months[2]).toBe(0)
    expect(months.reduce((sum, value) => sum + value, 0)).toBe(2040)
  })

  it('活跃天数按自然日去重', () => {
    expect(activeDayCount([...days, { day: '2026-01-02', seconds: 1 }])).toBe(7)
  })

  it('最长连续只算自然日相邻的记录', () => {
    expect(longestStreak(days)).toBe(3)
    expect(longestStreak([{ day: '2026-01-01', seconds: 1 }, { day: '2026-01-03', seconds: 1 }])).toBe(1)
  })

  it('当前连续：今天没读但昨天读了，仍算连着', () => {
    const recent = [
      { day: '2026-03-08', seconds: 60 },
      { day: '2026-03-09', seconds: 60 },
      { day: '2026-03-10', seconds: 60 },
    ]
    expect(currentStreak(recent, '2026-03-11')).toBe(3)
    expect(currentStreak(recent, '2026-03-10')).toBe(3)
    expect(currentStreak(recent, '2026-03-13')).toBe(0)
  })

  it('平均值按阅读日算，没有阅读日时为 0', () => {
    expect(averagePerDay(3000, 3)).toBe(1000)
    expect(averagePerDay(3000, 0)).toBe(0)
  })
})
