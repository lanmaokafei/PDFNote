import type { Card, CardOrderUpdate } from '../../domain/card'

/** 结构快照：只留撤销需要的最小字段。 */
export interface OrderSnapshot {
  id: string
  parent_id: string | null
  sort_order: number
}

export function snapshotOrder(cards: readonly Card[]): OrderSnapshot[] {
  return cards.map((card) => ({ id: card.id, parent_id: card.parent_id, sort_order: card.sort_order }))
}

/**
 * 两个快照之间真正变化的条目。
 *
 * `from` 是「要恢复成的状态」，`to` 是「当前状态」——返回的更新可以直接交给
 * `apply_card_order`；只出现在一侧的卡片（新建 / 删除）不参与结构撤销。
 */
export function orderDiff(from: readonly OrderSnapshot[], to: readonly OrderSnapshot[]): CardOrderUpdate[] {
  const current = new Map(to.map((item) => [item.id, item]))
  const updates: CardOrderUpdate[] = []
  for (const item of from) {
    const before = current.get(item.id)
    if (!before) continue
    if (before.parent_id !== item.parent_id || before.sort_order !== item.sort_order) {
      updates.push({ id: item.id, parent_id: item.parent_id, sort_order: item.sort_order })
    }
  }
  return updates
}
