import { describe, expect, it } from 'vitest'
import type { Card } from '../../domain/card'
import { buildOutlineForest, flattenOutline, outlineTitle, outlineToMarkdown } from './outline'

const base = {
  source_ref: null,
  user_note: '',
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
  surface_pdf: true,
  surface_mindmap: true,
  surface_review: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function card(partial: Partial<Card> & { id: string }): Card {
  return { ...base, excerpt: '', question: '', parent_id: null, ...partial }
}

describe('outline', () => {
  const cards = [
    card({ id: 'root', question: '根问题', sort_order: 2 }),
    card({ id: 'root-1', question: '先出现的根', sort_order: 1 }),
    card({ id: 'child-b', parent_id: 'root', question: '子 B', sort_order: 2 }),
    card({ id: 'child-a', parent_id: 'root', question: '子 A', sort_order: 1 }),
    card({ id: 'orphan', parent_id: 'missing', question: '孤儿卡片' }),
    card({ id: 'hidden', question: '不在脑图', surface_mindmap: false }),
  ]

  it('按 sort_order 排列，并把缺失父节点的卡片提升为根', () => {
    const forest = buildOutlineForest(cards)
    expect(forest.map((node) => node.card.id)).toEqual(['orphan', 'root-1', 'root'])
    const root = forest.find((node) => node.card.id === 'root')
    expect(root?.children.map((node) => node.card.id)).toEqual(['child-a', 'child-b'])
    expect(forest.some((node) => node.card.id === 'hidden')).toBe(false)
  })

  it('折叠节点后不展开其后代', () => {
    const forest = buildOutlineForest(cards)
    const open = flattenOutline(forest, () => false).map((node) => node.card.id)
    expect(open).toContain('child-a')
    const collapsed = flattenOutline(forest, (id) => id === 'root').map((node) => node.card.id)
    expect(collapsed).toContain('root')
    expect(collapsed).not.toContain('child-a')
  })

  it('生成带层级、摘录引用与页码的 Markdown', () => {
    const forest = buildOutlineForest([
      card({
        id: 'a',
        question: '为什么会忘？',
        excerpt: '间隔重复能显著降低遗忘',
        source_ref: { document_id: 'doc', page: 18, bbox: { x: 0, y: 0, width: 0.2, height: 0.1 } },
      }),
      card({ id: 'b', parent_id: 'a', question: '如何复习？', user_note: '先自测再翻书' }),
    ])
    const markdown = outlineToMarkdown(forest, '测试脑图')
    expect(markdown).toContain('# 测试脑图')
    expect(markdown).toContain('- 为什么会忘？')
    expect(markdown).toContain('  > 摘录：第 18 页 · 间隔重复能显著降低遗忘')
    expect(markdown).toContain('  - 如何复习？')
    expect(markdown).toContain('    > 笔记：先自测再翻书')
  })

  it('标题回退到摘录、笔记，最后才是未命名', () => {
    expect(outlineTitle(card({ id: 'x', question: '  ' }))).toBe('未命名卡片')
    expect(outlineTitle(card({ id: 'x', excerpt: '摘录' }))).toBe('摘录')
    expect(outlineTitle(card({ id: 'x', user_note: '笔记' }))).toBe('笔记')
  })
})
