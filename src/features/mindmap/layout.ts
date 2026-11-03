import type { Card } from '../../domain/card'

export type MindmapSortMode = 'order' | 'urgency'

export interface Point {
  x: number
  y: number
}

export const TREE_X_GAP = 360
export const TREE_Y_GAP = 250
const TREE_ORIGIN_X = 80
const TREE_ORIGIN_Y = 80
const ROOT_GAP = 60

export function compareMindmapCards(a: Card, b: Card, mode: MindmapSortMode): number {
  if (mode === 'urgency') {
    const dueDifference = Date.parse(a.due) - Date.parse(b.due)
    if (Number.isFinite(dueDifference) && dueDifference !== 0) return dueDifference
  }
  return a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}

function graph(cards: Card[], mode: MindmapSortMode) {
  const ids = new Set(cards.map((card) => card.id))
  const children = new Map<string, Card[]>()
  const roots: Card[] = []

  for (const card of cards) {
    if (card.parent_id && ids.has(card.parent_id)) {
      const siblings = children.get(card.parent_id) ?? []
      siblings.push(card)
      children.set(card.parent_id, siblings)
    } else {
      roots.push(card)
    }
  }

  const compare = (a: Card, b: Card) => compareMindmapCards(a, b, mode)
  roots.sort(compare)
  for (const siblings of children.values()) siblings.sort(compare)
  return { children, roots }
}

/** Returns visible cards in parent-before-child order, skipping collapsed descendants. */
export function getOrderedMindmapCards(
  cards: Card[],
  collapsedIds: ReadonlySet<string>,
  mode: MindmapSortMode,
): Card[] {
  const { children, roots } = graph(cards, mode)
  const ordered: Card[] = []
  const visited = new Set<string>()

  const visit = (card: Card) => {
    if (visited.has(card.id)) return
    visited.add(card.id)
    ordered.push(card)
    if (!collapsedIds.has(card.id)) {
      for (const child of children.get(card.id) ?? []) visit(child)
    }
  }

  // 记录被折叠隐藏的整棵子树：它们不能在兜底循环里被当成孤儿再加回来。
  const hiddenByCollapse = new Set<string>()
  const markCollapsedDescendants = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (hiddenByCollapse.has(child.id)) continue
      hiddenByCollapse.add(child.id)
      markCollapsedDescendants(child.id)
    }
  }
  for (const collapsedId of collapsedIds) markCollapsedDescendants(collapsedId)

  for (const root of roots) visit(root)
  // Malformed legacy cycles and orphans still remain editable instead of
  // disappearing — but cards hidden by a collapsed ancestor must stay hidden.
  for (const card of cards) {
    if (hiddenByCollapse.has(card.id)) continue
    visit(card)
  }
  return ordered
}

/** A deterministic left-to-right tree. Existing layout coordinates are intentionally ignored. */
export function buildTreeLayout(cards: Card[]): Record<string, Point> {
  const { children, roots } = graph(cards, 'order')
  const positions: Record<string, Point> = {}
  const visited = new Set<string>()
  const visiting = new Set<string>()
  let nextY = TREE_ORIGIN_Y

  const place = (card: Card, depth: number): number => {
    if (visited.has(card.id)) return positions[card.id]?.y ?? TREE_ORIGIN_Y
    if (visiting.has(card.id)) return nextY

    visiting.add(card.id)
    const availableChildren = (children.get(card.id) ?? []).filter(
      (child) => !visited.has(child.id) && !visiting.has(child.id),
    )
    let y: number
    if (availableChildren.length === 0) {
      y = nextY
      nextY += TREE_Y_GAP
    } else {
      const childYs = availableChildren.map((child) => place(child, depth + 1))
      y = (childYs[0] + childYs[childYs.length - 1]) / 2
    }

    positions[card.id] = { x: TREE_ORIGIN_X + depth * TREE_X_GAP, y }
    visiting.delete(card.id)
    visited.add(card.id)
    return y
  }

  for (const root of roots) {
    place(root, 0)
    nextY += ROOT_GAP
  }
  for (const card of cards) {
    if (!visited.has(card.id)) {
      place(card, 0)
      nextY += ROOT_GAP
    }
  }
  return positions
}

export function nextSortOrder(cards: Card[], parentId: string | null): number {
  const orders = cards
    .filter((card) => card.parent_id === parentId)
    .map((card) => card.sort_order)
    .filter(Number.isFinite)
  return orders.length ? Math.max(...orders) + 1 : 0
}
