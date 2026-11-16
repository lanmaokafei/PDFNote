/** 阅读目标与阅读统计的纯函数：不碰 DOM、不发请求，方便单测。 */

/** 本地日期的 `YYYY-MM-DD`（给后端当分组键，避免时区漂移）。 */
export function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 今年 1 月 1 日（本地），用于年度排行。 */
export function yearStartKey(date: Date): string {
  return `${date.getFullYear()}-01-01`
}

/** 阅读时长显示：不足 1 小时用 `m:ss`，超过 1 小时用 `h:mm:ss`。 */
export function formatReadingClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours}:${`${minutes}`.padStart(2, '0')}:${`${rest}`.padStart(2, '0')}`
  return `${minutes}:${`${rest}`.padStart(2, '0')}`
}

/** 目标进度：0–100 的百分比，达到目标后封顶 100。 */
export function readingGoalPercent(seconds: number, goalMinutes: number): number {
  const goal = Math.max(1, Math.round(goalMinutes)) * 60
  return Math.min(100, Math.round((Math.max(0, seconds) / goal) * 100))
}

/** 年度阅读目标（本数）与还差几本。 */
export const YEARLY_BOOK_GOAL = 12

export function booksToGoal(finishedBooks: number, goal = YEARLY_BOOK_GOAL): number {
  return Math.max(0, goal - Math.max(0, Math.floor(finishedBooks)))
}

/** 排行榜取前 N 本，过滤掉今年没读过的书。 */
export function topReadingBooks<T extends { yearSeconds: number }>(books: readonly T[], count = 3): T[] {
  return books.filter((book) => book.yearSeconds > 0).slice(0, Math.max(1, count))
}

const GOAL_STORAGE_KEY = 'pdfnote.reading.goalMinutes'
export const DEFAULT_GOAL_MINUTES = 5
export const GOAL_CHOICES = [5, 10, 15, 20, 30] as const

export function readGoalMinutes(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(GOAL_STORAGE_KEY) ?? DEFAULT_GOAL_MINUTES)
    return Number.isFinite(value) && value >= 1 && value <= 240 ? Math.round(value) : DEFAULT_GOAL_MINUTES
  } catch {
    return DEFAULT_GOAL_MINUTES
  }
}

export function saveGoalMinutes(minutes: number): void {
  try {
    globalThis.localStorage?.setItem(GOAL_STORAGE_KEY, String(Math.round(minutes)))
  } catch {
    // 隐私模式下只在本会话生效。
  }
}
