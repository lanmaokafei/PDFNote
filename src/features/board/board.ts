import type { Card, Document, ReviewState } from '../../domain/card'

/** 看板一级分组：标签 / 所属文档 / 复习状态。 */
export type GroupMode = 'tag' | 'document' | 'state'
/** 列内二级分组，`none` 表示不分。 */
export type SubMode = 'none' | 'tag' | 'document'
export type StateFilter = ReviewState | 'all'

export const UNTAGGED_ID = '__untagged__'
export const NO_DOCUMENT_ID = '__no_document__'

export interface BoardFilters {
  /** 关键词：问题 / 摘录 / 笔记 / 标签。 */
  query: string
  /** null = 全部文档。 */
  documentId: string | null
  /** null = 全部标签。 */
  tag: string | null
  state: StateFilter
  /** 只看已经到期（due ≤ now）的卡片。 */
  dueOnly: boolean
}

export const EMPTY_FILTERS: BoardFilters = {
  query: '',
  documentId: null,
  tag: null,
  state: 'all',
  dueOnly: false,
}

export interface BoardSubgroup {
  id: string
  label: string
  cards: Card[]
}

export interface BoardColumn {
  id: string
  label: string
  /** 分组说明，如「12 张」。 */
  hint: string
  cards: Card[]
  subgroups: BoardSubgroup[]
}

export interface GroupOptions {
  mode: GroupMode
  subMode: SubMode
  documents: Document[]
  /** 全部标签（含暂时没有卡片的），用于给拖拽准备空列。 */
  tags: string[]
}

const STATE_LABELS: Record<'new' | 'learning' | 'review', string> = {
  new: '新卡',
  learning: '学习中',
  review: '复习中',
}

const STATE_ORDER: Array<'new' | 'learning' | 'review'> = ['new', 'learning', 'review']

/** 复习状态归并：relearning 并入「学习中」，避免出现四列只有一张卡的空荡感。 */
export function stateBucket(state: ReviewState): 'new' | 'learning' | 'review' {
  if (state === 'new') return 'new'
  if (state === 'learning' || state === 'relearning') return 'learning'
  return 'review'
}

export function cardTitle(card: Card): string {
  return card.question.trim() || card.excerpt.trim() || card.user_note.trim() || '未命名卡片'
}

export function cardDocumentId(card: Card): string | null {
  return card.source_ref?.document_id ?? null
}

function documentLabel(documentId: string | null, titles: Map<string, string>): string {
  if (!documentId) return '未关联文档'
  return titles.get(documentId) ?? '已删除的文档'
}

export function matchesFilters(
  card: Card,
  filters: BoardFilters,
  now: number,
): boolean {
  if (filters.documentId && cardDocumentId(card) !== filters.documentId) return false
  if (filters.tag && !card.tags.includes(filters.tag)) return false
  if (filters.state !== 'all') {
    // 界面上只有「新卡 / 学习中 / 复习中」三档，relearning 归到学习中；
    // 直接比较枚举会让 relearning 卡片在这三档里都消失。
    const matched = filters.state === 'relearning'
      ? card.review_state === 'relearning'
      : stateBucket(card.review_state) === filters.state
    if (!matched) return false
  }
  if (filters.dueOnly) {
    const due = Date.parse(card.due)
    if (Number.isNaN(due) || due > now) return false
  }
  const query = filters.query.trim().toLowerCase()
  if (!query) return true
  const haystack = [
    card.question,
    card.excerpt,
    card.user_note,
    card.link_aliases,
    card.tags.join(' '),
  ].join('\n').toLowerCase()
  return haystack.includes(query)
}

export function filterCards(cards: Card[], filters: BoardFilters, now: number): Card[] {
  return cards.filter((card) => matchesFilters(card, filters, now))
}

function sortByTitle(left: Card, right: Card): number {
  return cardTitle(left).localeCompare(cardTitle(right), 'zh-CN')
}

function buildSubgroups(cards: Card[], mode: SubMode, titles: Map<string, string>): BoardSubgroup[] {
  if (mode === 'none') return []
  const byKey = new Map<string, BoardSubgroup>()
  for (const card of cards) {
    const keys: Array<{ id: string; label: string }> = []
    if (mode === 'tag') {
      if (card.tags.length === 0) keys.push({ id: UNTAGGED_ID, label: '未分组' })
      else for (const tag of card.tags) keys.push({ id: tag, label: `#${tag}` })
    } else {
      const documentId = cardDocumentId(card)
      keys.push({ id: documentId ?? NO_DOCUMENT_ID, label: documentLabel(documentId, titles) })
    }
    for (const key of keys) {
      const group = byKey.get(key.id) ?? { id: key.id, label: key.label, cards: [] }
      group.cards.push(card)
      byKey.set(key.id, group)
    }
  }
  return [...byKey.values()]
    .map((group) => ({ ...group, cards: [...group.cards].sort(sortByTitle) }))
    .sort((left, right) => {
      if (left.id === UNTAGGED_ID) return 1
      if (right.id === UNTAGGED_ID) return -1
      return left.label.localeCompare(right.label, 'zh-CN')
    })
}

function makeColumn(id: string, label: string, cards: Card[], subMode: SubMode, titles: Map<string, string>): BoardColumn {
  const sorted = [...cards].sort(sortByTitle)
  return {
    id,
    label,
    hint: `${sorted.length} 张`,
    cards: sorted,
    subgroups: buildSubgroups(sorted, subMode, titles),
  }
}

export function groupCards(cards: Card[], options: GroupOptions): BoardColumn[] {
  const titles = new Map(options.documents.map((document) => [document.id, document.title]))
  const columns: BoardColumn[] = []

  if (options.mode === 'tag') {
    const byTag = new Map<string, Card[]>()
    for (const tag of options.tags) byTag.set(tag, [])
    const untagged: Card[] = []
    for (const card of cards) {
      if (card.tags.length === 0) {
        untagged.push(card)
        continue
      }
      for (const tag of card.tags) {
        const bucket = byTag.get(tag) ?? []
        bucket.push(card)
        byTag.set(tag, bucket)
      }
    }
    const tags = [...byTag.keys()].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    for (const tag of tags) {
      columns.push(makeColumn(tag, `#${tag}`, byTag.get(tag) ?? [], options.subMode, titles))
    }
    // 未分组放最后：它通常是收纳区，不让它占据视觉起点。
    columns.push(makeColumn(UNTAGGED_ID, '未分组', untagged, options.subMode, titles))
    return columns
  }

  if (options.mode === 'document') {
    const byDocument = new Map<string, Card[]>()
    for (const card of cards) {
      const key = cardDocumentId(card) ?? NO_DOCUMENT_ID
      const bucket = byDocument.get(key) ?? []
      bucket.push(card)
      byDocument.set(key, bucket)
    }
    const ordered = [...byDocument.entries()].sort((left, right) => {
      if (left[0] === NO_DOCUMENT_ID) return 1
      if (right[0] === NO_DOCUMENT_ID) return -1
      return documentLabel(left[0], titles).localeCompare(documentLabel(right[0], titles), 'zh-CN')
    })
    for (const [documentId, bucket] of ordered) {
      const label = documentLabel(documentId === NO_DOCUMENT_ID ? null : documentId, titles)
      columns.push(makeColumn(documentId, label, bucket, options.subMode, titles))
    }
    return columns
  }

  const byState = new Map<string, Card[]>()
  for (const card of cards) {
    const bucket = stateBucket(card.review_state)
    const list = byState.get(bucket) ?? []
    list.push(card)
    byState.set(bucket, list)
  }
  for (const bucket of STATE_ORDER) {
    columns.push(makeColumn(bucket, STATE_LABELS[bucket], byState.get(bucket) ?? [], options.subMode, titles))
  }
  return columns
}

/** 卡片当前所在的分组标签（拖拽起点用）；非标签分组返回 null。 */
export function tagOfColumn(columnId: string): string | null {
  if (columnId === UNTAGGED_ID) return null
  return columnId
}

/** 拖到某个标签列后的新标签集合；目标列是「未分组」时不允许落点。 */
export function tagsAfterDrop(card: Card, sourceColumnId: string, targetColumnId: string): string[] | null {
  if (targetColumnId === UNTAGGED_ID) return null
  const next = new Set(card.tags)
  const sourceTag = tagOfColumn(sourceColumnId)
  if (sourceTag) next.delete(sourceTag)
  next.add(targetColumnId)
  return [...next].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 到期文案：当天 / 逾期 / 几天后；无有效时间返回空。 */
export function formatDue(due: string, now: number): string {
  const time = Date.parse(due)
  if (Number.isNaN(time)) return ''
  const dayStart = (value: number) => Math.floor(value / DAY_MS)
  const diff = dayStart(time) - dayStart(now)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff > 1) return `${diff} 天后`
  return `逾期 ${-diff} 天`
}
