import { describe, expect, it } from 'vitest'
import type { Card } from '../../domain/card'
import {
  buildChildMap,
  childrenOf,
  collectDescendants,
  dropPlan,
  indentPlan,
  insertAfterPlan,
  insertChildPlan,
  outdentPlan,
  outlineEditField,
  type CardOrderUpdate,
} from './outlineEdit'

function card(id: string, parentId: string | null, sortOrder: number): Card {
  return {
    id,
    source_ref: null,
    excerpt: '',
    user_note: '',
    question: id,
    tags: [],
    parent_id: parentId,
    sort_order: sortOrder,
    collapsed: false,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due: '2026-11-09T00:00:00.000Z',
    last_review: null,
    reps: 0,
    lapses: 0,
    review_state: 'new',
    surface_pdf: false,
    surface_mindmap: true,
    surface_review: true,
    excerpt_image: null,
    link_aliases: '',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  }
}

/** 把 updates 折成 parent → 有序 id 列表，便于断言最终结构。 */
function structure(updates: CardOrderUpdate[]): Record<string, string[]> {
  const groups = new Map<string, Array<{ id: string; order: number }>>()
  for (const update of updates) {
    const key = update.parent_id ?? 'root'
    const list = groups.get(key) ?? []
    list.push({ id: update.id, order: update.sort_order })
    groups.set(key, list)
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, list]) => [key, list.sort((a, b) => a.order - b.order).map((item) => item.id)]),
  )
}

const flat = [card('a', null, 0), card('b', null, 1), card('c', null, 2)]

describe('childrenOf', () => {
  it('按 sort_order 排序，同序按 id 稳定', () => {
    const cards = [card('b', 'p', 1), card('a', 'p', 0), card('c', 'p', 0)]
    expect(childrenOf(cards, 'p').map((item) => item.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('indentPlan', () => {
  it('第二个兄弟缩进为第一个兄弟的最后一个子节点', () => {
    const cards = [...flat, card('b1', 'b', 0)]
    const plan = indentPlan(cards, 'c')!
    expect(structure(plan)).toEqual({ root: ['a', 'b'], b: ['b1', 'c'] })
  })

  it('第一个兄弟没有上一项，不能缩进', () => {
    expect(indentPlan(flat, 'a')).toBeNull()
  })
})

describe('outdentPlan', () => {
  it('提升后排在原父节点后面，原父节点剩余子节点重新编号', () => {
    const cards = [card('a', null, 0), card('b', 'a', 0), card('c', 'a', 1), card('d', 'a', 2)]
    const plan = outdentPlan(cards, 'c')!
    expect(structure(plan)).toEqual({ root: ['a', 'c'], a: ['b', 'd'] })
  })

  it('根节点不能再提升', () => {
    expect(outdentPlan(flat, 'a')).toBeNull()
  })
})

describe('dropPlan', () => {
  it('拖到兄弟前面 / 后面：同级重排', () => {
    expect(structure(dropPlan(flat, 'c', 'a', 'before')!)).toEqual({ root: ['c', 'a', 'b'] })
    expect(structure(dropPlan(flat, 'a', 'c', 'after')!)).toEqual({ root: ['b', 'c', 'a'] })
  })

  it('拖到行中间：成为目标的最后一个子节点', () => {
    const cards = [...flat, card('b1', 'b', 0)]
    expect(structure(dropPlan(cards, 'a', 'b', 'inside')!)).toEqual({ root: ['b', 'c'], b: ['b1', 'a'] })
  })

  it('跨父节点拖拽：旧父节点重新编号', () => {
    const cards = [card('a', null, 0), card('b', null, 1), card('a1', 'a', 0), card('a2', 'a', 1)]
    // 只动 a 与 b 两层；根层顺序没变，不必重写。
    expect(structure(dropPlan(cards, 'a2', 'b', 'inside')!)).toEqual({ a: ['a1'], b: ['a2'] })
  })

  it('不能拖到自己的后代里，也不能拖到自己身上', () => {
    const cards = [card('a', null, 0), card('a1', 'a', 0), card('a2', 'a1', 0)]
    expect(dropPlan(cards, 'a', 'a2', 'inside')).toBeNull()
    expect(dropPlan(cards, 'a', 'a', 'after')).toBeNull()
  })
})

describe('新增行', () => {
  it('回车建同级：紧跟在当前行后面', () => {
    expect(structure(insertAfterPlan(flat, 'a', 'n')!)).toEqual({ root: ['a', 'n', 'b', 'c'] })
  })

  it('⌘+回车建子级：排在最后一个孩子', () => {
    const cards = [...flat, card('b1', 'b', 0)]
    // 只重排目标父节点这一层，其它层级不受影响。
    expect(structure(insertChildPlan(cards, 'b', 'n')!)).toEqual({ b: ['b1', 'n'] })
  })
})

describe('collectDescendants', () => {
  it('收集整棵子树（含孙节点）', () => {
    const cards = [card('a', null, 0), card('a1', 'a', 0), card('a2', 'a1', 0), card('b', null, 1)]
    expect([...collectDescendants(buildChildMap(cards), 'a')].sort()).toEqual(['a1', 'a2'])
  })
})

describe('outlineEditField', () => {
  it('改的是行里显示的那个字段：问题 → 摘录 → 笔记', () => {
    expect(outlineEditField(card('a', null, 0))).toBe('question')
    expect(outlineEditField({ ...card('a', null, 0), question: '', excerpt: '摘录' })).toBe('excerpt')
    expect(outlineEditField({ ...card('a', null, 0), question: '', user_note: '笔记' })).toBe('user_note')
  })

  it('三者全空（刚新建）写回问题，避免存进看不见的摘录', () => {
    expect(outlineEditField({ ...card('a', null, 0), question: '', excerpt: '', user_note: '' })).toBe('question')
  })
})
