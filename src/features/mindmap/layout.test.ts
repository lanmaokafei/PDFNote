import { describe, expect, it } from 'vitest'
import type { Card } from '../../domain/card'
import { getOrderedMindmapCards } from './layout'

const base = {
  source_ref: null,
  excerpt: '',
  user_note: '',
  question: '',
  tags: [],
  excerpt_image: null,
  link_aliases: '',
  parent_id: null as string | null,
  sort_order: 0,
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
  review_state: 'new' as const,
  surface_pdf: false,
  surface_mindmap: true,
  surface_review: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const card = (id: string, parent_id: string | null = null, sort_order = 0): Card => ({
  ...base, id, parent_id, sort_order,
})

describe('getOrderedMindmapCards 折叠可见性', () => {
  const tree = [
    card('root'),
    card('child-a', 'root', 0),
    card('child-b', 'root', 1),
    card('grand', 'child-a', 0),
  ]

  it('折叠根节点会隐藏整棵子树', () => {
    const visible = getOrderedMindmapCards(tree, new Set(['root']), 'order')
    expect(visible.map((item) => item.id)).toEqual(['root'])
  })

  it('折叠中间节点只隐藏它的后代', () => {
    const visible = getOrderedMindmapCards(tree, new Set(['child-a']), 'order')
    expect(visible.map((item) => item.id)).toEqual(['root', 'child-a', 'child-b'])
  })

  it('展开后子节点全部回来', () => {
    const visible = getOrderedMindmapCards(tree, new Set(), 'order')
    expect(visible).toHaveLength(4)
  })

  it('孤儿卡片仍然可见，不被误当作折叠隐藏', () => {
    const withOrphan = [...tree, card('orphan', 'missing')]
    const visible = getOrderedMindmapCards(withOrphan, new Set(['root']), 'order')
    expect(visible.map((item) => item.id)).toContain('orphan')
    expect(visible.map((item) => item.id)).not.toContain('grand')
  })

  it('环状父子关系仍可见，不会因折叠判断而消失', () => {
    const cycle = [card('a', 'b'), card('b', 'a')]
    const visible = getOrderedMindmapCards(cycle, new Set(), 'order')
    expect(visible.map((item) => item.id).sort()).toEqual(['a', 'b'])
  })
})
