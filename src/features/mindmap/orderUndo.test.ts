import { describe, expect, it } from 'vitest'
import type { Card } from '../../domain/card'
import { orderDiff, snapshotOrder } from './orderUndo'

function card(id: string, parent: string | null, order: number): Card {
  return {
    id,
    document_id: null,
    page: null,
    bbox: null,
    excerpt: '',
    user_note: '',
    question: id,
    parent_id: parent,
    sort_order: order,
    collapsed: false,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due: '2026-01-01T00:00:00.000Z',
    last_review: null,
    reps: 0,
    lapses: 0,
    review_state: 'new',
    surface_pdf: false,
    surface_mindmap: true,
    surface_review: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    excerpt_image: null,
    link_aliases: '',
    tags: [],
  } as unknown as Card
}

describe('大纲结构快照', () => {
  it('快照只保留 id / 父节点 / 排序', () => {
    const snapshot = snapshotOrder([card('a', null, 1)])
    expect(snapshot).toEqual([{ id: 'a', parent_id: null, sort_order: 1 }])
  })

  it('只返回真正变化的条目', () => {
    const before = snapshotOrder([card('a', null, 1), card('b', null, 2), card('c', 'a', 1)])
    const after = snapshotOrder([card('a', null, 2), card('b', null, 1), card('c', 'b', 1)])
    expect(orderDiff(before, after)).toEqual([
      { id: 'a', parent_id: null, sort_order: 1 },
      { id: 'b', parent_id: null, sort_order: 2 },
      { id: 'c', parent_id: 'a', sort_order: 1 },
    ])
  })

  it('没有变化时返回空数组（不往撤销栈里塞空操作）', () => {
    const state = snapshotOrder([card('a', null, 1), card('b', 'a', 1)])
    expect(orderDiff(state, state)).toEqual([])
  })

  it('新建或删除的卡片不参与结构撤销', () => {
    const before = snapshotOrder([card('a', null, 1)])
    const after = snapshotOrder([card('a', null, 1), card('new', null, 2)])
    expect(orderDiff(before, after)).toEqual([])
    expect(orderDiff(after, before)).toEqual([])
  })
})
