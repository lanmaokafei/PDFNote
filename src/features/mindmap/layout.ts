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
// 卡片实测尺寸约 254 × 120–180；森林分块时按上限预留，避免行与行叠在一起。
const NODE_WIDTH = 254
const NODE_HEIGHT = 190
const FOREST_COL_GAP = 90
const FOREST_ROW_GAP = 120
// 目标长宽比：森林整体尽量接近横向矩形，而不是一根细长竖条。
const FOREST_TARGET_ASPECT = 1.6

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

interface TreeBlock {
  points: Record<string, Point>
  width: number
  height: number
}

/**
 * 确定性的左→右树布局；已有坐标一律忽略。
 *
 * 多棵独立树（例如 26 张互不相连的卡片）不再纵向堆成一条几千像素的长条，
 * 而是每棵树先算出自身的包围盒，再按行打包成接近横向矩形的紧凑网格。
 * 这样 fitView 之后缩放仍可读，卡片看起来是「聚在一起」的。
 */
export function buildTreeLayout(cards: Card[]): Record<string, Point> {
  const { children, roots } = graph(cards, 'order')
  const positions: Record<string, Point> = {}
  const visited = new Set<string>()

  const buildTree = (root: Card): TreeBlock => {
    const points: Record<string, Point> = {}
    const visiting = new Set<string>()
    let nextY = 0
    let maxDepth = 0

    const place = (card: Card, depth: number): number => {
      if (visited.has(card.id)) return points[card.id]?.y ?? 0
      if (visiting.has(card.id)) return nextY

      visiting.add(card.id)
      maxDepth = Math.max(maxDepth, depth)
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

      points[card.id] = { x: depth * TREE_X_GAP, y }
      visiting.delete(card.id)
      visited.add(card.id)
      return y
    }

    place(root, 0)
    return {
      points,
      width: maxDepth * TREE_X_GAP + NODE_WIDTH,
      height: Math.max(NODE_HEIGHT, nextY - TREE_Y_GAP + NODE_HEIGHT),
    }
  }

  const blocks: TreeBlock[] = []
  for (const root of roots) blocks.push(buildTree(root))
  // 环与畸形父子关系仍要保证每张卡片都有坐标，与 getOrderedMindmapCards 的兜底一致。
  for (const card of cards) {
    if (!visited.has(card.id)) blocks.push(buildTree(card))
  }
  if (!blocks.length) return positions

  const singleRowWidth = blocks.reduce((sum, block) => sum + block.width, 0)
    + FOREST_COL_GAP * (blocks.length - 1)
  const packedArea = blocks.reduce(
    (sum, block) => sum + (block.width + FOREST_COL_GAP) * (block.height + FOREST_ROW_GAP),
    0,
  )
  const widest = Math.max(...blocks.map((block) => block.width))
  // 面积开方得到目标行宽：树少时保持单行，树多时自动换行。
  const rowLimit = blocks.length === 1
    ? singleRowWidth
    : Math.min(singleRowWidth, Math.max(widest, Math.sqrt(packedArea * FOREST_TARGET_ASPECT)))

  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  for (const block of blocks) {
    if (cursorX > 0 && cursorX + block.width > rowLimit) {
      cursorX = 0
      cursorY += rowHeight + FOREST_ROW_GAP
      rowHeight = 0
    }
    for (const [id, point] of Object.entries(block.points)) {
      positions[id] = {
        x: TREE_ORIGIN_X + cursorX + point.x,
        y: TREE_ORIGIN_Y + cursorY + point.y,
      }
    }
    cursorX += block.width + FOREST_COL_GAP
    rowHeight = Math.max(rowHeight, block.height)
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
