import { describe, expect, it } from 'vitest'
import type { Card, Document } from '../../domain/card'
import {
  EMPTY_FILTERS,
  NO_DOCUMENT_ID,
  UNTAGGED_ID,
  filterCards,
  formatDue,
  groupCards,
  stateBucket,
  tagsAfterDrop,
} from './board'

const NOW = Date.parse('2026-11-08T12:00:00.000Z')

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    source_ref: null,
    excerpt: '',
    user_note: '',
    question: '',
    tags: [],
    parent_id: null,
    sort_order: 0,
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
    ...overrides,
  }
}

const documents: Document[] = [
  {
    id: 'doc1',
    title: '内科学',
    stored_path: 'pdfs/a.pdf',
    original_path: null,
    content_hash: 'h1',
    file_size: 1,
    page_count: 10,
    file_status: 'ready',
    last_page: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  },
  {
    id: 'doc2',
    title: '药理学',
    stored_path: 'pdfs/b.pdf',
    original_path: null,
    content_hash: 'h2',
    file_size: 1,
    page_count: 20,
    file_status: 'ready',
    last_page: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  },
]

const source = (documentId: string, page = 1) => ({
  document_id: documentId,
  page,
  bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
})

describe('filterCards', () => {
  const cards = [
    card({ id: 'a', question: '心肌梗死再灌注', tags: ['心内'], review_state: 'review', due: '2026-11-08T00:00:00.000Z' }),
    card({ id: 'b', excerpt: '受体拮抗剂', tags: ['药理', '心内'], review_state: 'learning' }),
    card({ id: 'c', user_note: '待整理', source_ref: source('doc2'), due: '2026-11-20T00:00:00.000Z' }),
  ]

  it('关键词同时搜问题、摘录、笔记与标签', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: '再灌注' }, NOW).map((item) => item.id)).toEqual(['a'])
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: '拮抗' }, NOW).map((item) => item.id)).toEqual(['b'])
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: '待整理' }, NOW).map((item) => item.id)).toEqual(['c'])
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: '药理' }, NOW).map((item) => item.id)).toEqual(['b'])
  })

  it('按文档 / 标签 / 状态过滤，并支持只看到期', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, documentId: 'doc2' }, NOW).map((item) => item.id)).toEqual(['c'])
    expect(filterCards(cards, { ...EMPTY_FILTERS, tag: '心内' }, NOW).map((item) => item.id)).toEqual(['a', 'b'])
    expect(filterCards(cards, { ...EMPTY_FILTERS, state: 'learning' }, NOW).map((item) => item.id)).toEqual(['b'])
    // relearning 也应该出现在「学习中」这一档，否则卡片会在三档筛选里全部消失。
    const relearning = card({ id: 'd', review_state: 'relearning' })
    expect(filterCards([...cards, relearning], { ...EMPTY_FILTERS, state: 'learning' }, NOW).map((item) => item.id))
      .toEqual(['b', 'd'])
    // b 的 due 是 11-09（未到），c 是 11-20，只有 a 已到期。
    expect(filterCards(cards, { ...EMPTY_FILTERS, dueOnly: true }, NOW).map((item) => item.id)).toEqual(['a'])
  })

  it('条件之间是「与」关系', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, tag: '心内', state: 'review' }, NOW).map((item) => item.id)).toEqual(['a'])
    expect(filterCards(cards, { ...EMPTY_FILTERS, documentId: 'doc2', tag: '心内' }, NOW)).toEqual([])
  })
})

describe('groupCards', () => {
  it('标签分组：多标签卡片出现在每一列，未分组排最后，空标签也保留供拖拽', () => {
    const cards = [
      card({ id: 'a', question: 'A', tags: ['心内', '药理'] }),
      card({ id: 'b', question: 'B', tags: ['心内'] }),
      card({ id: 'c', question: 'C' }),
    ]
    const columns = groupCards(cards, { mode: 'tag', subMode: 'none', documents, tags: ['心内', '药理', '空标签'] })
    const byId = new Map(columns.map((column) => [column.id, column]))
    expect(byId.get('心内')?.cards.map((item) => item.id)).toEqual(['a', 'b'])
    expect(byId.get('药理')?.cards.map((item) => item.id)).toEqual(['a'])
    expect(byId.get('空标签')?.cards).toEqual([])
    expect(columns[columns.length - 1].id).toBe(UNTAGGED_ID)
    expect(columns[columns.length - 1].cards.map((item) => item.id)).toEqual(['c'])
  })

  it('文档分组：用文档标题命名，未关联文档垫底', () => {
    const cards = [
      card({ id: 'a', question: 'A', source_ref: source('doc2') }),
      card({ id: 'b', question: 'B', source_ref: source('doc1') }),
      card({ id: 'c', question: 'C' }),
    ]
    const columns = groupCards(cards, { mode: 'document', subMode: 'none', documents, tags: [] })
    const labels = new Map(columns.map((column) => [column.id, column.label]))
    expect(labels.get('doc1')).toBe('内科学')
    expect(labels.get('doc2')).toBe('药理学')
    expect(columns[columns.length - 1].id).toBe(NO_DOCUMENT_ID)
    expect(columns[columns.length - 1].label).toBe('未关联文档')
  })

  it('状态分组固定三列，relearning 并入学习中', () => {
    const cards = [
      card({ id: 'a', question: 'A', review_state: 'relearning' }),
      card({ id: 'b', question: 'B', review_state: 'review' }),
    ]
    const columns = groupCards(cards, { mode: 'state', subMode: 'none', documents, tags: [] })
    expect(columns.map((column) => column.label)).toEqual(['新卡', '学习中', '复习中'])
    expect(columns[1].cards.map((item) => item.id)).toEqual(['a'])
    expect(stateBucket('relearning')).toBe('learning')
    expect(stateBucket('review')).toBe('review')
  })

  it('二级分组：文档列内再按标签分块，未分组块最后', () => {
    const cards = [
      card({ id: 'a', question: 'A', tags: ['心内'], source_ref: source('doc1') }),
      card({ id: 'b', question: 'B', tags: ['药理'], source_ref: source('doc1') }),
      card({ id: 'c', question: 'C', source_ref: source('doc1') }),
    ]
    const columns = groupCards(cards, { mode: 'document', subMode: 'tag', documents, tags: [] })
    const docColumn = columns.find((column) => column.id === 'doc1')!
    expect(docColumn.subgroups.map((group) => group.label)).toEqual(['#心内', '#药理', '未分组'])
    expect(docColumn.hint).toBe('3 张')
  })
})

describe('tagsAfterDrop', () => {
  const target = card({ tags: ['心内', '药理'] })

  it('拖到另一列：去掉来源列标签，加上目标标签', () => {
    expect(tagsAfterDrop(target, '心内', '临床')).toEqual(['临床', '药理'])
  })

  it('从未分组拖出只加不减', () => {
    expect(tagsAfterDrop(card(), UNTAGGED_ID, '心内')).toEqual(['心内'])
  })

  it('不允许拖回未分组（避免静默丢标签）', () => {
    expect(tagsAfterDrop(target, '心内', UNTAGGED_ID)).toBeNull()
  })
})

describe('formatDue', () => {
  it('给出当天 / 明天 / 几天后 / 逾期', () => {
    expect(formatDue('2026-11-08T09:00:00.000Z', NOW)).toBe('今天')
    expect(formatDue('2026-11-09T09:00:00.000Z', NOW)).toBe('明天')
    expect(formatDue('2026-11-12T09:00:00.000Z', NOW)).toBe('4 天后')
    expect(formatDue('2026-11-05T09:00:00.000Z', NOW)).toBe('逾期 3 天')
    expect(formatDue('not-a-date', NOW)).toBe('')
  })
})
