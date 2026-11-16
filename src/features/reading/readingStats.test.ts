import { describe, expect, it } from 'vitest'
import {
  booksToGoal,
  formatReadingClock,
  localDayKey,
  readingGoalPercent,
  topReadingBooks,
  yearStartKey,
} from './readingStats'

describe('阅读计时格式与日期', () => {
  it('本地日期键不随时区漂到前一天', () => {
    expect(localDayKey(new Date(2026, 10, 16, 0, 5))).toBe('2026-11-16')
    expect(localDayKey(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01')
  })

  it('年度起点是今年 1 月 1 日', () => {
    expect(yearStartKey(new Date(2026, 10, 16))).toBe('2026-01-01')
  })

  it('时长显示：不足一小时 / 超过一小时', () => {
    expect(formatReadingClock(0)).toBe('0:00')
    expect(formatReadingClock(65)).toBe('1:05')
    expect(formatReadingClock(600)).toBe('10:00')
    expect(formatReadingClock(3725)).toBe('1:02:05')
    expect(formatReadingClock(-5)).toBe('0:00')
  })
})

describe('阅读目标', () => {
  it('进度按目标分钟数折算并封顶 100', () => {
    expect(readingGoalPercent(0, 5)).toBe(0)
    expect(readingGoalPercent(150, 5)).toBe(50)
    expect(readingGoalPercent(300, 5)).toBe(100)
    expect(readingGoalPercent(6000, 5)).toBe(100)
  })

  it('目标值非法时至少按 1 分钟算，不除零', () => {
    expect(readingGoalPercent(30, 0)).toBe(50)
  })

  it('年度目标 12 本，已读超了就是 0', () => {
    expect(booksToGoal(0)).toBe(12)
    expect(booksToGoal(9)).toBe(3)
    expect(booksToGoal(20)).toBe(0)
  })
})

describe('年度排行', () => {
  const books = [
    { title: 'A', yearSeconds: 3600 },
    { title: 'B', yearSeconds: 0 },
    { title: 'C', yearSeconds: 600 },
    { title: 'D', yearSeconds: 60 },
  ]

  it('过滤没读过的书，取前三', () => {
    expect(topReadingBooks(books).map((book) => book.title)).toEqual(['A', 'C', 'D'])
  })

  it('不足三本时有多少给多少', () => {
    expect(topReadingBooks(books.slice(0, 2))).toHaveLength(1)
    expect(topReadingBooks([])).toEqual([])
  })
})
