import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, FileText, RefreshCw, Search } from 'lucide-react'
import type { Card, Document } from '../../domain/card'
import { isTauriRuntime, listCards, listDocuments, listTags, setCardTags } from '../../services/pdfnote'
import {
  EMPTY_FILTERS,
  cardTitle,
  filterCards,
  formatDue,
  groupCards,
  stateBucket,
  tagsAfterDrop,
  type BoardFilters,
  type GroupMode,
  type SubMode,
} from './board'
import './BoardWorkspace.css'

interface BoardWorkspaceProps {
  /** 没有原文位置的知识卡片：切到脑图查看。 */
  onOpenMindmap: () => void
  onCardsChanged: () => void
}

/** 每列先渲染这么多，避免 1483 张卡一次性挂满 DOM。 */
const COLUMN_PAGE = 40
const COLUMN_MORE = 60
const GROUP_KEY = 'pdfnote.board.group'

const GROUP_TABS: Array<{ value: GroupMode; label: string }> = [
  { value: 'tag', label: '标签' },
  { value: 'document', label: '书目' },
  { value: 'state', label: '状态' },
]

const STATE_OPTIONS: Array<{ value: BoardFilters['state']; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'new', label: '新卡' },
  { value: 'learning', label: '学习中' },
  { value: 'review', label: '复习中' },
]

function readGroupMode(): GroupMode {
  try {
    const saved = window.localStorage.getItem(GROUP_KEY)
    if (saved === 'tag' || saved === 'document' || saved === 'state') return saved
  } catch {
    /* localStorage 不可用时用默认值 */
  }
  return 'tag'
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function BoardWorkspace({ onOpenMindmap, onCardsChanged }: BoardWorkspaceProps) {
  const [cards, setCards] = useState<Card[]>([])
  const [documents, setDocuments] = useState<Document[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroupMode)
  const [subMode, setSubMode] = useState<SubMode>('none')
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS)
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [dragging, setDragging] = useState<{ card: Card; columnId: string } | null>(null)
  // dragover/drop 与 dragstart 是不同事件批次，靠 state 判断可能拿到上一帧的 null；
  // 用 ref 同步记录起点，避免第一次拖拽被忽略。
  const dragRef = useRef<{ card: Card; columnId: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [busyCardId, setBusyCardId] = useState('')

  const desktop = isTauriRuntime()

  const refresh = useCallback(async () => {
    if (!desktop) {
      setLoading(false)
      setError('卡片盒需要在桌面应用中运行')
      return
    }
    setLoading(true)
    try {
      const [nextCards, nextDocuments, nextTags] = await Promise.all([
        listCards(10_000),
        listDocuments(),
        listTags(),
      ])
      setCards(nextCards)
      setDocuments(nextDocuments)
      setTags(nextTags)
      setError('')
      setNow(Date.now())
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [desktop])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 换分组或过滤条件时回到首屏，避免上一列展开到 500 张后换组仍然很长。
  useEffect(() => {
    setLimits({})
    setDropTarget(null)
  }, [groupMode, subMode, filters])

  const documentTitles = useMemo(
    () => new Map(documents.map((document) => [document.id, document.title])),
    [documents],
  )

  const allTags = useMemo(() => {
    const merged = new Set(tags)
    for (const card of cards) for (const tag of card.tags) merged.add(tag)
    return [...merged].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  }, [cards, tags])

  const filtered = useMemo(() => filterCards(cards, filters, now), [cards, filters, now])
  const columns = useMemo(
    () => groupCards(filtered, {
      mode: groupMode,
      subMode,
      documents,
      tags: groupMode === 'tag' ? allTags : [],
    }),
    [allTags, documents, filtered, groupMode, subMode],
  )

  const stats = useMemo(() => {
    const tagged = cards.filter((card) => card.tags.length > 0).length
    const due = cards.filter((card) => {
      const time = Date.parse(card.due)
      return !Number.isNaN(time) && time <= now
    }).length
    return { total: cards.length, tagged, untagged: cards.length - tagged, due }
  }, [cards, now])

  function changeGroupMode(next: GroupMode) {
    setGroupMode(next)
    try {
      window.localStorage.setItem(GROUP_KEY, next)
    } catch {
      /* 存不下不影响使用 */
    }
  }

  function openCard(card: Card) {
    if (card.source_ref) {
      window.dispatchEvent(new CustomEvent('pdfnote:open-source', {
        detail: { documentId: card.source_ref.document_id, page: card.source_ref.page },
      }))
      return
    }
    // 知识卡片没有原文可回，交给脑图查看（那里有完整卡片与 AI 解析）。
    onOpenMindmap()
  }

  async function applyTags(card: Card, next: string[], targetLabel: string) {
    setBusyCardId(card.id)
    try {
      const updated = await setCardTags(card.id, next)
      setCards((current) => current.map((item) => (item.id === card.id ? updated : item)))
      setNotice(`已归入 ${targetLabel}`)
      onCardsChanged()
    } catch (reason) {
      setError(`标签保存失败：${errorMessage(reason)}`)
    } finally {
      setBusyCardId('')
    }
  }

  function handleDrop(targetColumnId: string, targetLabel: string) {
    setDropTarget(null)
    const active = dragRef.current
    // 有些环境（含自动化拖拽）不会补发 dragend，这里主动收尾，避免卡片一直半透明。
    dragRef.current = null
    setDragging(null)
    if (!active) return
    const next = tagsAfterDrop(active.card, active.columnId, targetColumnId)
    if (!next) {
      setNotice('「未分组」是自动收纳列，不能拖进去')
      return
    }
    const before = [...active.card.tags].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    if (next.join('\u0000') === before.join('\u0000')) return
    void applyTags(active.card, next, targetLabel)
  }

  const canDrag = groupMode === 'tag' && !busyCardId
  const dragActive = canDrag && dragging !== null

  return (
    <div className="board">
      <header className="board-heading">
        <div>
          <p className="board-eyebrow">CARD BOX</p>
          <h1>卡片盒</h1>
          <p>
            按标签、书目与复习状态分栏。拖动卡片到另一个标签列即可重新归类；点卡片回到原文位置。
          </p>
        </div>
        <div className="board-stats">
          <div><span>卡片</span><strong>{stats.total}</strong></div>
          <div><span>已打标签</span><strong>{stats.tagged}</strong></div>
          <div><span>未分组</span><strong>{stats.untagged}</strong></div>
          <div><span>待复习</span><strong>{stats.due}</strong></div>
        </div>
      </header>

      <div className="board-toolbar">
        <label className="board-search">
          <Search size={14} strokeWidth={1.8} />
          <input
            type="search"
            value={filters.query}
            placeholder="搜索问题、摘录、笔记或标签"
            aria-label="搜索卡片"
            data-testid="board-search"
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
          />
        </label>

        <div className="board-segments" role="tablist" aria-label="分组方式">
          {GROUP_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={groupMode === tab.value}
              data-testid={`board-group-${tab.value}`}
              className={groupMode === tab.value ? 'is-active' : ''}
              onClick={() => changeGroupMode(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <label className="board-select">
          <span>二级</span>
          <select
            value={subMode}
            data-testid="board-sub"
            aria-label="二级分组"
            onChange={(event) => setSubMode(event.target.value as SubMode)}
          >
            <option value="none">不分</option>
            <option value="tag">标签</option>
            <option value="document">书目</option>
          </select>
        </label>

        <label className="board-select">
          <span>书目</span>
          <select
            value={filters.documentId ?? ''}
            data-testid="board-doc"
            aria-label="按书目过滤"
            onChange={(event) => setFilters((current) => ({ ...current, documentId: event.target.value || null }))}
          >
            <option value="">全部</option>
            {documents.map((document) => (
              <option key={document.id} value={document.id}>{document.title}</option>
            ))}
          </select>
        </label>

        <label className="board-select">
          <span>标签</span>
          <select
            value={filters.tag ?? ''}
            data-testid="board-tag"
            aria-label="按标签过滤"
            onChange={(event) => setFilters((current) => ({ ...current, tag: event.target.value || null }))}
          >
            <option value="">全部</option>
            {allTags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
          </select>
        </label>

        <label className="board-select">
          <span>状态</span>
          <select
            value={filters.state}
            data-testid="board-state"
            aria-label="按复习状态过滤"
            onChange={(event) => setFilters((current) => ({
              ...current,
              state: event.target.value as BoardFilters['state'],
            }))}
          >
            {STATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`board-toggle${filters.dueOnly ? ' is-active' : ''}`}
          data-testid="board-due"
          aria-pressed={filters.dueOnly}
          onClick={() => setFilters((current) => ({ ...current, dueOnly: !current.dueOnly }))}
        >
          只看待复习
        </button>

        <button
          type="button"
          className="board-refresh"
          data-testid="board-refresh"
          title="重新载入卡片"
          aria-label="重新载入卡片"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'is-spinning' : ''} />
        </button>
      </div>

      {error && <p className="board-banner is-error" role="alert">{error}</p>}
      {notice && <p className="board-banner is-notice" role="status">{notice}</p>}
      {!loading && cards.length > 0 && filtered.length === 0 && (
        <p className="board-banner is-empty">
          没有符合条件的卡片。
          <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>清除筛选</button>
        </p>
      )}

      {loading && cards.length === 0 ? (
        <div className="board-loading"><span /><strong>正在整理卡片盒…</strong></div>
      ) : cards.length === 0 && !error ? (
        <div className="board-empty">
          <Boxes size={30} strokeWidth={1.4} />
          <h2>卡片盒还是空的</h2>
          <p>在 PDF 里划重点、做脑图或导入 Anki 牌组后，卡片会按标签自动归档到这里。</p>
        </div>
      ) : (
        <div className="board-columns" data-testid="board-columns">
          {columns.map((column) => {
            const limit = limits[column.id] ?? COLUMN_PAGE
            let budget = limit
            const renderCard = (card: Card) => {
              const source = card.source_ref
              const documentTitle = source ? documentTitles.get(source.document_id) ?? '未知文档' : ''
              const title = cardTitle(card)
              const excerpt = card.excerpt.trim()
              const due = formatDue(card.due, now)
              return (
                <article
                  key={card.id}
                  className={`board-card${dragging?.card.id === card.id ? ' is-dragging' : ''}`}
                  data-card-id={card.id}
                  data-card-tags={card.tags.join(',')}
                  draggable={canDrag}
                  role="button"
                  tabIndex={0}
                  title={source ? `回到 ${documentTitle} 第 ${source.page} 页` : '在脑图中查看这张知识卡片'}
                  onDragStart={(event) => {
                    const origin = { card, columnId: column.id }
                    dragRef.current = origin
                    setDragging(origin)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', card.id)
                  }}
                  onDragEnd={() => {
                    dragRef.current = null
                    setDragging(null)
                    setDropTarget(null)
                  }}
                  onClick={() => openCard(card)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    openCard(card)
                  }}
                >
                  <header>
                    <span className={`board-state is-${stateBucket(card.review_state)}`} aria-hidden="true" />
                    <h4>{title}</h4>
                  </header>
                  {excerpt && excerpt !== title && <p className="board-card-excerpt">{excerpt}</p>}
                  <div className="board-card-meta">
                    {source && (
                      <span className="board-card-source">
                        <FileText size={10} strokeWidth={1.8} />
                        {documentTitle} · P{source.page}
                      </span>
                    )}
                    {card.tags.slice(0, 3).map((tag) => (
                      <span className="board-card-tag" key={tag}>#{tag}</span>
                    ))}
                    {card.tags.length > 3 && <span className="board-card-tag">+{card.tags.length - 3}</span>}
                    {due && <span className="board-card-due">{due}</span>}
                  </div>
                </article>
              )
            }
            return (
              <section
                key={column.id}
                className={`board-column${dropTarget === column.id ? ' is-drop' : ''}`}
                data-column-id={column.id}
                data-column-label={column.label}
                onDragOver={(event) => {
                  if (!canDrag || !dragRef.current) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dropTarget !== column.id) setDropTarget(column.id)
                }}
                onDrop={(event) => {
                  if (!canDrag || !dragRef.current) return
                  event.preventDefault()
                  handleDrop(column.id, column.label)
                }}
              >
                <header>
                  <strong>{column.label}</strong>
                  <span>{column.hint}</span>
                </header>
                <div className="board-column-body">
                  {column.subgroups.length > 0
                    ? column.subgroups.map((group) => {
                        if (budget <= 0) return null
                        const slice = group.cards.slice(0, budget)
                        budget -= slice.length
                        return (
                          <div className="board-subgroup" key={group.id} data-subgroup-id={group.id}>
                            <h5>
                              {group.label}
                              <span>{group.cards.length}</span>
                            </h5>
                            {slice.map(renderCard)}
                            {group.cards.length > slice.length && (
                              <p className="board-subgroup-more">还有 {group.cards.length - slice.length} 张</p>
                            )}
                          </div>
                        )
                      })
                    : column.cards.slice(0, budget).map(renderCard)}
                </div>
                {column.cards.length > limit && (
                  <button
                    type="button"
                    className="board-more"
                    onClick={() => setLimits((current) => ({ ...current, [column.id]: limit + COLUMN_MORE }))}
                  >
                    再显示 {Math.min(COLUMN_MORE, column.cards.length - limit)} 张
                    <span>共 {column.cards.length} 张</span>
                  </button>
                )}
              </section>
            )
          })}
        </div>
      )}

      {dragActive && groupMode === 'tag' && (
        <p className="board-drag-hint" role="status">松手归入目标标签列</p>
      )}
    </div>
  )
}
