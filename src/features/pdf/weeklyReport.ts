import type { SkeletonEntryLike } from './pdfOutline'

export interface WeeklyCardLike {
  id: string
  parent_id: string | null
  created_at: string
}

export interface ReviewStatLike {
  cardId: string
  reviews: number
  again: number
  hard: number
  good: number
  easy: number
}

export interface WeeklySection {
  cardId: string
  title: string
  page: number
  level: number
  reviews: number
  again: number
  hard: number
}

export interface WeeklyReport {
  weekStart: string
  /** 本周（周一 00:00 起）新建的知识卡片数，不含目录骨架节点。 */
  cardsWritten: number
  /** 本周复习次数（review_logs 条数）。 */
  reviews: number
  /** 本周复习过的卡片数。 */
  reviewedCards: number
  /** 本周评分 ≥ 3（记得）的比例，0–1；没有复习时为 0。 */
  correctRate: number
  /** 本周有过复习的小节数。 */
  sectionsTouched: number
  /** 卡住的小节：复习够多但「重来 + 困难」占比高。 */
  stuck: WeeklySection[]
}

/** 「卡住」的下限：至少复习这么多次才谈得上卡住。 */
export const STUCK_MIN_REVIEWS = 3
/** 「重来 + 困难」占比达到这个值就算卡住。 */
export const STUCK_RATIO = 0.34

/** 本周起点：当地时间的本周一 00:00（ISO 字符串，给后端做 since）。 */
export function weekStartIso(now: Date): string {
  const start = new Date(now.getTime())
  const offset = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - offset)
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}

function timeOf(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 本周学习报告：写卡、复习次数与正确率，以及哪些小节「卡住」。
 *
 * 只统计挂在目录骨架子树下的卡片——骨架节点本身是结构，不算写卡；
 * 复习数据按卡片聚合后沿子树累加，所以章节行包含子节。
 */
export function buildWeeklyReport(input: {
  entries: readonly SkeletonEntryLike[]
  cards: readonly WeeklyCardLike[]
  stats: readonly ReviewStatLike[]
  weekStart: string
}): WeeklyReport {
  const { entries, cards, stats, weekStart } = input
  const since = timeOf(weekStart)
  const skeletonIds = new Set(entries.map((entry) => entry.cardId))
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const childrenOf = new Map<string, string[]>()
  for (const card of cards) {
    if (!card.parent_id) continue
    const list = childrenOf.get(card.parent_id) ?? []
    list.push(card.id)
    childrenOf.set(card.parent_id, list)
  }

  const statById = new Map(stats.map((stat) => [stat.cardId, stat]))

  // 只统计挂在骨架子树下的卡片：和「章节进度」口径一致，直接落在根上的卡不进报告。
  const reachable = new Set<string>()
  const pending = entries.map((entry) => entry.cardId)
  while (pending.length > 0) {
    const id = pending.pop() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    pending.push(...(childrenOf.get(id) ?? []))
  }

  let cardsWritten = 0
  let reviews = 0
  let reviewedCards = 0
  let correct = 0
  for (const card of cards) {
    if (!reachable.has(card.id)) continue
    // 骨架节点是自动建的，不算「本周写卡」；但用户复习它时照样计入复习。
    if (!skeletonIds.has(card.id) && since > 0 && timeOf(card.created_at) >= since) cardsWritten += 1
    const stat = statById.get(card.id)
    if (!stat || stat.reviews <= 0) continue
    reviews += stat.reviews
    reviewedCards += 1
    correct += stat.good + stat.easy
  }

  // 条目之间的父子关系：用来把「父章节也卡住」这种重复项去掉，只留最具体的小节。
  const parentIndex: Array<number | null> = []
  const open: number[] = []
  entries.forEach((entry, index) => {
    while (open.length > 0 && entries[open[open.length - 1]].level >= entry.level) open.pop()
    parentIndex[index] = open.length > 0 ? open[open.length - 1] : null
    open.push(index)
  })

  const sections: WeeklySection[] = []
  for (const entry of entries) {
    const visited = new Set<string>([entry.cardId])
    const stack = [...(childrenOf.get(entry.cardId) ?? [])]
    // 小节自己的骨架卡也可能被复习，先算它，再累加子树。
    const own = statById.get(entry.cardId)
    let sectionReviews = own?.reviews ?? 0
    let again = own?.again ?? 0
    let hard = own?.hard ?? 0
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (visited.has(id)) continue
      visited.add(id)
      stack.push(...(childrenOf.get(id) ?? []))
      if (!cardById.has(id)) continue
      const stat = statById.get(id)
      if (!stat) continue
      sectionReviews += stat.reviews
      again += stat.again
      hard += stat.hard
    }
    if (sectionReviews > 0) {
      sections.push({
        cardId: entry.cardId, title: entry.title, page: entry.page, level: entry.level,
        reviews: sectionReviews, again, hard,
      })
    }
  }

  const stuckIndexes = new Set(
    sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.reviews >= STUCK_MIN_REVIEWS
        && (section.again + section.hard) / section.reviews >= STUCK_RATIO)
      .map(({ index }) => index),
  )
  // 子节也卡住时只报子节：把「有卡住后代」的祖先全部划掉，避免「第一章 + 1.1」重复刷屏。
  const redundant = new Set<number>()
  for (const index of stuckIndexes) {
    let parent = parentIndex[index]
    while (parent !== null) {
      if (stuckIndexes.has(parent)) redundant.add(parent)
      parent = parentIndex[parent]
    }
  }
  const stuck = sections
    .filter((_, index) => stuckIndexes.has(index) && !redundant.has(index))
    .sort((a, b) => b.again - a.again || b.reviews - a.reviews || a.page - b.page)

  return {
    weekStart,
    cardsWritten,
    reviews,
    reviewedCards,
    correctRate: reviews === 0 ? 0 : correct / reviews,
    sectionsTouched: sections.length,
    stuck,
  }
}
