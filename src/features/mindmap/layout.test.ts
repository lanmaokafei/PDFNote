import { describe, expect, it } from 'vitest'
import type { Card } from '../../domain/card'
import { buildTreeLayout, getOrderedMindmapCards } from './layout'

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

describe('buildTreeLayout 紧凑森林布局', () => {
  const boundingBox = (positions: Record<string, { x: number; y: number }>) => {
    const values = Object.values(positions)
    const minX = Math.min(...values.map((point) => point.x))
    const minY = Math.min(...values.map((point) => point.y))
    const maxX = Math.max(...values.map((point) => point.x))
    const maxY = Math.max(...values.map((point) => point.y))
    return { width: maxX - minX + 254, height: maxY - minY + 190 }
  }

  it('大量独立卡片排成紧凑网格，而不是一根细长竖条', () => {
    const forest = Array.from({ length: 26 }, (_, index) => card(`c${index}`))
    const positions = buildTreeLayout(forest)
    expect(Object.keys(positions)).toHaveLength(26)
    const box = boundingBox(positions)
    expect(box.height / box.width).toBeLessThan(1.5)
    // 旧实现会纵向堆 26 × 310 ≈ 8000px；新布局应显著更矮。
    expect(box.height).toBeLessThan(2600)
  })

  it('网格中的卡片互不重叠', () => {
    const forest = Array.from({ length: 26 }, (_, index) => card(`c${index}`))
    const values = Object.values(buildTreeLayout(forest))
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        const overlaps = Math.abs(values[i].x - values[j].x) < 254
          && Math.abs(values[i].y - values[j].y) < 190
        expect(overlaps).toBe(false)
      }
    }
  })

  it('单棵树仍保持左父右子，父节点纵向居中', () => {
    const tree = [card('root'), card('a', 'root', 0), card('b', 'root', 1)]
    const positions = buildTreeLayout(tree)
    expect(positions.root.x).toBeLessThan(positions.a.x)
    expect(positions.root.x).toBeLessThan(positions.b.x)
    expect(positions.a.x).toBe(positions.b.x)
    expect(positions.root.y).toBeCloseTo((positions.a.y + positions.b.y) / 2)
  })

  it('环状父子关系不会丢卡片', () => {
    const cycle = [card('a', 'b'), card('b', 'a')]
    expect(Object.keys(buildTreeLayout(cycle))).toHaveLength(2)
  })
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
