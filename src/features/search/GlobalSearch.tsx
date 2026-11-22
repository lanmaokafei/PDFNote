import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, FileText, NotebookPen, Search } from 'lucide-react'
import { globalSearch, isTauriRuntime, type GlobalHit } from '../../services/pdfnote'
import { requestCardSelection } from '../mindmap/pendingSelection'
import './GlobalSearch.css'

interface GlobalSearchProps {
  open: boolean
  onClose: () => void
  /** 切到指定视图（脑图 / 笔记本）。 */
  onGoTo: (view: 'mindmap' | 'notebook') => void
}

const GROUP_LABELS: Record<GlobalHit['kind'], string> = {
  document: '文档',
  card: '卡片',
  notebook: '笔记本',
}

const KIND_ICONS = {
  document: FileText,
  card: BookOpen,
  notebook: NotebookPen,
} as const

/**
 * 跨库搜索面板（⌘K）。
 *
 * 文档与带页码的卡片都走 `pdfnote:open-source`：App 会设 activeDocument + jumpTarget，
 * 直接进文档工作区并跳到那一页；没有页码的卡片切到脑图选中；笔记本切视图并打开。
 */
export function GlobalSearch({ open, onClose, onGoTo }: GlobalSearchProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<GlobalHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setError('')
    setActive(0)
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  // Esc 不管焦点在不在输入框都能关：窗口级监听比只绑 input 更可靠。
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, open])

  useEffect(() => {
    if (!open) return
    const keyword = query.trim()
    if (!keyword) {
      setHits([])
      setLoading(false)
      return
    }
    if (!isTauriRuntime()) {
      setError('跨库搜索需要在桌面应用中运行')
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      void globalSearch(keyword)
        .then((result) => {
          if (cancelled) return
          setHits(result)
          setActive(0)
          setError('')
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          setError(reason instanceof Error ? reason.message : String(reason))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 130)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  const groups = useMemo(() => {
    const order: GlobalHit['kind'][] = ['card', 'document', 'notebook']
    return order
      .map((kind) => ({ kind, items: hits.filter((hit) => hit.kind === kind) }))
      .filter((group) => group.items.length > 0)
  }, [hits])

  const openHit = useCallback((hit: GlobalHit) => {
    onClose()
    if (hit.kind === 'notebook') {
      onGoTo('notebook')
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('pdfnote:open-notebook', { detail: { id: hit.id } }))
      }, 220)
      return
    }
    if (hit.documentId && hit.page) {
      window.dispatchEvent(new CustomEvent('pdfnote:open-source', {
        detail: { documentId: hit.documentId, page: hit.page },
      }))
      return
    }
    // 脑图是懒加载的：先把 id 交给工作区，挂载后自己取走；事件作为已挂载时的快捷路径。
    requestCardSelection(hit.id)
    onGoTo('mindmap')
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pdfnote:select-card', { detail: { cardId: hit.id } }))
    }, 240)
  }, [onClose, onGoTo])

  if (!open) return null

  const flat = groups.flatMap((group) => group.items)
  const activeHit = flat[active] ?? null

  return (
    <div className="global-search-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="global-search" role="dialog" aria-modal="true" aria-label="跨库搜索" data-testid="global-search">
        <div className="global-search-bar">
          <Search size={16} strokeWidth={1.8} />
          <input
            ref={inputRef}
            data-testid="global-search-input"
            value={query}
            placeholder="搜索文档、卡片内容或笔记本…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (flat.length === 0) return
                setActive((current) => (
                  event.key === 'ArrowDown'
                    ? (current + 1) % flat.length
                    : (current - 1 + flat.length) % flat.length
                ))
                return
              }
              if (event.key === 'Enter' && activeHit && !event.nativeEvent.isComposing) {
                event.preventDefault()
                openHit(activeHit)
              }
            }}
          />
          <kbd>esc</kbd>
        </div>

        <div className="global-search-body" data-testid="global-search-results">
          {!query.trim() && (
            <p className="global-search-hint">
              一次搜三处：文档标题、卡片的问题/摘录/笔记、笔记本标题。回收站里的内容不会被搜出来。
            </p>
          )}
          {query.trim() && loading && flat.length === 0 && <p className="global-search-hint">正在搜索…</p>}
          {query.trim() && !loading && flat.length === 0 && !error && (
            <p className="global-search-hint">没有找到「{query.trim()}」。</p>
          )}
          {error && <p className="global-search-error">{error}</p>}
          {groups.map((group) => (
            <div className="global-search-group" key={group.kind}>
              <h3>{GROUP_LABELS[group.kind]}<em>{group.items.length}</em></h3>
              {group.items.map((hit) => {
                const Icon = KIND_ICONS[hit.kind]
                const index = flat.indexOf(hit)
                return (
                  <button
                    key={`${hit.kind}-${hit.id}`}
                    type="button"
                    className={`global-search-item${index === active ? ' is-active' : ''}`}
                    data-testid="global-search-item"
                    data-kind={hit.kind}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => openHit(hit)}
                  >
                    <Icon size={14} strokeWidth={1.8} />
                    <span className="global-search-text">
                      <strong>{hit.title}</strong>
                      {hit.snippet && <small>{hit.snippet}</small>}
                    </span>
                    {hit.kind !== 'notebook' && (
                      <span className="global-search-meta">
                        {hit.documentId ? (hit.page ? `P${hit.page}` : '文档') : '脑图'}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <footer className="global-search-foot">
          <span>↑↓ 选择 · ↵ 打开 · esc 关闭</span>
          <span>{flat.length > 0 ? `${flat.length} 个结果` : ''}</span>
        </footer>
      </section>
    </div>
  )
}
