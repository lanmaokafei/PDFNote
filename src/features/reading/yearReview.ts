/** 年度回顾的纯计算：月度分布、活跃天数、连续阅读。 */

export interface ReadingDay {
  /** `YYYY-MM-DD`（本地日期）。 */
  day: string
  seconds: number
}

/** 12 个月的总秒数；索引 0 = 一月。不在当年的日期直接忽略。 */
export function monthTotals(days: readonly ReadingDay[], year: number): number[] {
  const totals = new Array<number>(12).fill(0)
  for (const item of days) {
    if (!item.day.startsWith(`${year}-`)) continue
    const month = Number(item.day.slice(5, 7))
    if (!Number.isInteger(month) || month < 1 || month > 12) continue
    if (item.seconds <= 0) continue
    totals[month - 1] += item.seconds
  }
  return totals
}

/** 有阅读记录的天数（同一天多条记录只算一次）。 */
export function activeDayCount(days: readonly ReadingDay[]): number {
  return new Set(days.filter((item) => item.seconds > 0).map((item) => item.day)).size
}

/** `YYYY-MM-DD` → UTC 日序号。纯日期计算必须用 UTC，本地时区的 Date.parse 会差 8 小时。 */
function dayIndex(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  if (!match) return null
  const [, year, month, date] = match
  const time = Date.UTC(Number(year), Number(month) - 1, Number(date))
  return Number.isNaN(time) ? null : Math.floor(time / 86_400_000)
}

function formatDay(index: number): string {
  const date = new Date(index * 86_400_000)
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

/** 最长连续阅读天数；跨月、跨年都按自然日连续算。 */
export function longestStreak(days: readonly ReadingDay[]): number {
  const unique = [...new Set(days.filter((item) => item.seconds > 0).map((item) => item.day))].sort()
  let best = 0
  let current = 0
  let previous: number | null = null
  for (const day of unique) {
    const stamp = dayIndex(day)
    if (stamp === null) continue
    current = previous !== null && stamp - previous === 1 ? current + 1 : 1
    previous = stamp
    if (current > best) best = current
  }
  return best
}

/**
 * 当前连续天数：从 `today`（含）或昨天往前数。
 * 今天还没读不算断——昨天的记录仍可延续。
 */
export function currentStreak(days: readonly ReadingDay[], today: string): number {
  const readDays = new Set(days.filter((item) => item.seconds > 0).map((item) => item.day))
  const start = dayIndex(today)
  if (start === null) return 0
  let stamp = start
  if (!readDays.has(formatDay(stamp))) stamp -= 1
  let streak = 0
  while (readDays.has(formatDay(stamp))) {
    streak += 1
    stamp -= 1
  }
  return streak
}

/** 平均每个阅读日的时长（秒）；没有阅读日时返回 0。 */
export function averagePerDay(totalSeconds: number, activeDays: number): number {
  if (activeDays <= 0) return 0
  return Math.round(totalSeconds / activeDays)
}
