import type { Card, CardOrderUpdate } from '../../domain/card'

export type { CardOrderUpdate }

export type DropPosition = 'before' | 'after' | 'inside'

/** 一次批量落库的结构变更：谁是父、排第几。 */

/** 与 buildOutlineForest 同一套排序：sort_order 优先，同序按 id 稳定。 */
function byOrder(left: Card, right: Card): number {
  return left.sort_order - right.sort_order || left.id.localeCompare(right.id)
}

/**
 * 大纲行显示的是哪个字段，行内编辑就改哪个字段：
 * 问题 → 摘录 → 笔记；三者全空（刚新建）写回问题，避免存进看不见的摘录。
 */
export function outlineEditField(card: Card): 'question' | 'excerpt' | 'user_note' {
  if (card.question.trim()) return 'question'
  if (card.excerpt.trim()) return 'excerpt'
  if (card.user_note.trim()) return 'user_note'
  return 'question'
}

export function childrenOf(cards: readonly Card[], parentId: string | null): Card[] {
  return cards
    .filter((card) => (card.parent_id ?? null) === parentId && card.surface_mindmap)
    .sort(byOrder)
}

/** 拖拽时不能把自己挂到自己的后代下面（后端也会拒，但前端先挡住更好懂）。 */
export function buildChildMap(cards: readonly Card[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const card of cards) {
    if (!card.parent_id) continue
    const list = map.get(card.parent_id) ?? []
    list.push(card.id)
    map.set(card.parent_id, list)
  }
  return map
}

export function collectDescendants(childMap: Map<string, string[]>, id: string): Set<string> {
  const result = new Set<string>()
  const stack = [...(childMap.get(id) ?? [])]
  while (stack.length) {
    const next = stack.pop()!
    if (result.has(next)) continue
    result.add(next)
    stack.push(...(childMap.get(next) ?? []))
  }
  return result
}

/**
 * 把一组同父节点的 id 按顺序重编号；同一个 plan 里后写入的覆盖先写入的，
 * 因此可以「先从旧父节点移出、再挂到新父节点」。
 */
class OrderPlan {
  private updates = new Map<string, CardOrderUpdate>()

  setSiblings(parentId: string | null, ids: string[]): void {
    ids.forEach((id, index) => {
      this.updates.set(id, { id, parent_id: parentId, sort_order: index })
    })
  }

  result(): CardOrderUpdate[] {
    return [...this.updates.values()]
  }
}

function findCard(cards: readonly Card[], id: string): Card | null {
  return cards.find((card) => card.id === id) ?? null
}

function siblingIds(cards: readonly Card[], parentId: string | null, exclude?: string): string[] {
  return childrenOf(cards, parentId)
    .filter((card) => card.id !== exclude)
    .map((card) => card.id)
}

/** Tab：变成上一个兄弟的最后一个子节点。第一个兄弟没有上一项，返回 null。 */
export function indentPlan(cards: readonly Card[], cardId: string): CardOrderUpdate[] | null {
  const card = findCard(cards, cardId)
  if (!card) return null
  const siblings = childrenOf(cards, card.parent_id)
  const index = siblings.findIndex((item) => item.id === cardId)
  if (index <= 0) return null
  const previous = siblings[index - 1]
  const plan = new OrderPlan()
  plan.setSiblings(card.parent_id, siblings.filter((item) => item.id !== cardId).map((item) => item.id))
  plan.setSiblings(previous.id, [...childrenOf(cards, previous.id).map((item) => item.id), cardId])
  return plan.result()
}

/** Shift+Tab：提升一级，排到原父节点的后面。根节点无法再提升。 */
export function outdentPlan(cards: readonly Card[], cardId: string): CardOrderUpdate[] | null {
  const card = findCard(cards, cardId)
  if (!card || !card.parent_id) return null
  const parent = findCard(cards, card.parent_id)
  if (!parent) return null
  const grandParentId = parent.parent_id
  const parentSiblings = childrenOf(cards, grandParentId).map((item) => item.id)
  const parentIndex = parentSiblings.indexOf(parent.id)
  if (parentIndex < 0) return null
  const nextSiblings = [...parentSiblings]
  nextSiblings.splice(parentIndex + 1, 0, cardId)
  const plan = new OrderPlan()
  plan.setSiblings(parent.id, siblingIds(cards, parent.id, cardId))
  plan.setSiblings(grandParentId, nextSiblings)
  return plan.result()
}

/** 拖拽落点：目标行的上 / 中 / 下三段。 */
export function dropPlan(
  cards: readonly Card[],
  dragId: string,
  targetId: string,
  position: DropPosition,
): CardOrderUpdate[] | null {
  if (dragId === targetId) return null
  const drag = findCard(cards, dragId)
  const target = findCard(cards, targetId)
  if (!drag || !target) return null
  if (collectDescendants(buildChildMap(cards), dragId).has(targetId)) return null

  const plan = new OrderPlan()
  if (position === 'inside') {
    plan.setSiblings(drag.parent_id, siblingIds(cards, drag.parent_id, dragId))
    plan.setSiblings(targetId, [...childrenOf(cards, targetId).map((item) => item.id), dragId])
    return plan.result()
  }

  const newParentId = target.parent_id
  const targetSiblings = siblingIds(cards, newParentId, dragId)
  const targetIndex = targetSiblings.indexOf(targetId)
  if (targetIndex < 0) return null
  targetSiblings.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, dragId)
  if (drag.parent_id !== newParentId) {
    plan.setSiblings(drag.parent_id, siblingIds(cards, drag.parent_id, dragId))
  }
  plan.setSiblings(newParentId, targetSiblings)
  return plan.result()
}

/** 回车：在当前行后面插入一张同级的新卡。 */
export function insertAfterPlan(cards: readonly Card[], cardId: string, newId: string): CardOrderUpdate[] | null {
  const card = findCard(cards, cardId)
  if (!card) return null
  const ids = childrenOf(cards, card.parent_id).map((item) => item.id)
  const index = ids.indexOf(cardId)
  ids.splice(index + 1, 0, newId)
  const plan = new OrderPlan()
  plan.setSiblings(card.parent_id, ids)
  return plan.result()
}

/** ⌘/Ctrl+回车：把新卡挂到当前行下面，排最后一个。 */
export function insertChildPlan(cards: readonly Card[], cardId: string, newId: string): CardOrderUpdate[] | null {
  if (!findCard(cards, cardId)) return null
  const plan = new OrderPlan()
  plan.setSiblings(cardId, [...childrenOf(cards, cardId).map((item) => item.id), newId])
  return plan.result()
}


export type BatchOutlineAction = 'up' | 'down' | 'indent' | 'outdent'

function cloneCards(cards: readonly Card[]): Card[] {
  return cards.map((card) => ({ ...card }))
}

function applyUpdates(cards: Card[], updates: readonly CardOrderUpdate[]): Card[] {
  const map = new Map(updates.map((update) => [update.id, update]))
  return cards.map((card) => {
    const update = map.get(card.id)
    return update ? { ...card, parent_id: update.parent_id, sort_order: update.sort_order } : card
  })
}

/** 只输出 parent_id / sort_order 真正变化的行。 */
function diffOrder(before: readonly Card[], after: readonly Card[]): CardOrderUpdate[] {
  const original = new Map(before.map((card) => [card.id, card]))
  const updates: CardOrderUpdate[] = []
  for (const card of after) {
    const previous = original.get(card.id)
    if (!previous) continue
    if ((previous.parent_id ?? null) !== (card.parent_id ?? null) || previous.sort_order !== card.sort_order) {
      updates.push({ id: card.id, parent_id: card.parent_id, sort_order: card.sort_order })
    }
  }
  return updates
}

/**
 * 同父节点的整块上下移动：选中的卡片作为一个整体跨过相邻的一张。
 * 跨父节点的混选按各自的兄弟列表分别移动。
 */
export function batchShiftPlan(
  cards: readonly Card[],
  ids: readonly string[],
  direction: -1 | 1,
): CardOrderUpdate[] | null {
  let working = cloneCards(cards)
  const groups = new Map<string | null, string[]>()
  for (const id of ids) {
    const card = working.find((item) => item.id === id)
    if (!card) continue
    const key = card.parent_id ?? null
    groups.set(key, [...(groups.get(key) ?? []), id])
  }
  let changed = false
  for (const [parentId, group] of groups) {
    const siblings = childrenOf(working, parentId).map((card) => card.id)
    const selected = new Set(group)
    const positions = siblings.map((id, index) => (selected.has(id) ? index : -1)).filter((index) => index >= 0)
    if (positions.length === 0) continue
    const atEdge = direction < 0
      ? positions[0] === 0
      : positions[positions.length - 1] === siblings.length - 1
    if (atEdge) continue
    const block = siblings.filter((id) => selected.has(id))
    const rest = siblings.filter((id) => !selected.has(id))
    const insertAt = direction < 0 ? positions[0] - 1 : positions[0] + 1
    rest.splice(Math.max(0, Math.min(rest.length, insertAt)), 0, ...block)
    const order = new Map(rest.map((id, index) => [id, index]))
    working = working.map((card) => (
      order.has(card.id) ? { ...card, sort_order: order.get(card.id)! } : card
    ))
    changed = true
  }
  return changed ? diffOrder(cards, working) : null
}

/**
 * 批量缩进 / 提升：从后往前逐张模拟，避免前面的移动打乱后面的兄弟序号。
 * 单张失败（第一个兄弟无法缩进、顶层无法提升）会跳过，不影响其它卡片。
 */
export function batchOutlinePlan(
  cards: readonly Card[],
  ids: readonly string[],
  action: BatchOutlineAction,
): CardOrderUpdate[] | null {
  if (action === 'up' || action === 'down') {
    return batchShiftPlan(cards, ids, action === 'up' ? -1 : 1)
  }
  let working = cloneCards(cards)
  let changed = false
  // 缩进从前往后：整块并排挂到同一个父节点下；
  // 提升从后往前：每张都插到父节点正后方，倒序处理才能保持原有先后。
  const ordered = action === 'outdent' ? [...ids].reverse() : [...ids]
  for (const id of ordered) {
    const plan = action === 'indent' ? indentPlan(working, id) : outdentPlan(working, id)
    if (!plan) continue
    working = applyUpdates(working, plan)
    changed = true
  }
  return changed ? diffOrder(cards, working) : null
}
