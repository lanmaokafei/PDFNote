import { nearestTocEntry, type SkeletonEntryLike } from './pdfOutline'

/** 进度只关心「这张卡在谁的子树下、复习过几次」，方便单测与复用。 */
export interface ProgressCardLike {
  id: string
  parent_id: string | null
  reps: number
}

export interface SectionProgressNode {
  cardId: string
  title: string
  page: number
  level: number
  /** 这一节的页码范围结束页（下一节起始页 - 1），最后一节为 null。 */
  endPage: number | null
  /** 子树里的知识卡片数（不含骨架节点本身）。 */
  cardCount: number
  reviewedCount: number
  children: SectionProgressNode[]
}

export interface SectionProgress {
  roots: SectionProgressNode[]
  /** 按目录顺序铺平，界面上按 level 缩进渲染。 */
  flat: SectionProgressNode[]
  sections: number
  sectionsWithCards: number
  cards: number
  reviewed: number
  /** 当前页落在哪一节（没有则 null）。 */
  currentCardId: string | null
}

/**
 * 把目录骨架 + 当前画布上的卡片算成「每节有多少卡、复习了多少」。
 *
 * 骨架节点本身不计入卡片数（它们是结构，不是知识）；卡片只算一次，
 * parent 成环时用 visited 兜住，不会死循环。
 */
export function buildSectionProgress(
  entries: readonly SkeletonEntryLike[],
  cards: readonly ProgressCardLike[],
  currentPage: number,
): SectionProgress {
  const skeletonIds = new Set(entries.map((entry) => entry.cardId))
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const childrenOf = new Map<string, string[]>()
  for (const card of cards) {
    if (!card.parent_id) continue
    const list = childrenOf.get(card.parent_id) ?? []
    list.push(card.id)
    childrenOf.set(card.parent_id, list)
  }

  const counts = new Map<string, { cardCount: number; reviewedCount: number }>()
  const visit = (rootId: string) => {
    const cached = counts.get(rootId)
    if (cached) return cached
    let cardCount = 0
    let reviewedCount = 0
    const visited = new Set<string>([rootId])
    const stack = [...(childrenOf.get(rootId) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (visited.has(id)) continue
      visited.add(id)
      stack.push(...(childrenOf.get(id) ?? []))
      if (skeletonIds.has(id)) continue
      const card = cardById.get(id)
      if (!card) continue
      cardCount += 1
      if (card.reps > 0) reviewedCount += 1
    }
    const result = { cardCount, reviewedCount }
    counts.set(rootId, result)
    return result
  }

  const roots: SectionProgressNode[] = []
  const flat: SectionProgressNode[] = []
  const stack: SectionProgressNode[] = []
  entries.forEach((entry, index) => {
    const next = entries[index + 1]
    const stats = visit(entry.cardId)
    const node: SectionProgressNode = {
      cardId: entry.cardId,
      title: entry.title,
      page: entry.page,
      level: entry.level,
      endPage: next && next.page > entry.page ? next.page - 1 : null,
      cardCount: stats.cardCount,
      reviewedCount: stats.reviewedCount,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop()
    if (stack.length > 0) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
    flat.push(node)
  })

  // 总数要按唯一卡片算：章节行显示的是子树合计，直接求和会把子节的卡重复计一遍。
  const seen = new Set<string>()
  let uniqueCards = 0
  let uniqueReviewed = 0
  const pending = entries.map((entry) => entry.cardId)
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop() as string
    if (visited.has(id)) continue
    visited.add(id)
    for (const childId of childrenOf.get(id) ?? []) {
      if (visited.has(childId)) continue
      pending.push(childId)
      if (skeletonIds.has(childId) || seen.has(childId)) continue
      seen.add(childId)
      const card = cardById.get(childId)
      if (!card) continue
      uniqueCards += 1
      if (card.reps > 0) uniqueReviewed += 1
    }
  }

  return {
    roots,
    flat,
    sections: entries.length,
    sectionsWithCards: flat.filter((node) => node.cardCount > 0).length,
    cards: uniqueCards,
    reviewed: uniqueReviewed,
    currentCardId: nearestTocEntry(entries, currentPage)?.cardId ?? null,
  }
}
