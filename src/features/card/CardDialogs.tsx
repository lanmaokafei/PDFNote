import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Card, CardLink } from '../../domain/card'
import {
  askCard,
  generateCardQuestions,
  type QuestionDraft,
} from '../../services/ai'
import {
  createCardLink,
  deleteCardLink,
  listCardLinks,
  listTags,
  mergeCards,
  setCardTags,
} from '../../services/pdfnote'
import { buildLinkIndex, neighborsOf } from './backlinks'
import './CardDialogs.css'

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function cardTitle(card: Card): string {
  return card.question.trim() || card.excerpt.trim() || card.user_note.trim() || '未命名卡片'
}

interface ShellProps {
  eyebrow: string
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  wide?: boolean
}

function DialogShell({ eyebrow, title, description, onClose, children, footer, wide }: ShellProps) {
  return (
    <div className="card-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className={`card-dialog${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <small>{eyebrow}</small>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </header>
        <div className="card-dialog-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  )
}

interface TagDialogProps {
  card: Card
  onClose: () => void
  onSaved: (card: Card) => void
}

export function TagDialog({ card, onClose, onSaved }: TagDialogProps) {
  const [tags, setTags] = useState<string[]>(card.tags)
  const [input, setInput] = useState('')
  const [knownTags, setKnownTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void listTags().then(setKnownTags).catch(() => undefined)
  }, [])

  const suggestions = knownTags
    .filter((tag) => !tags.includes(tag))
    .filter((tag) => !input.trim() || tag.includes(input.trim()))
    .slice(0, 8)

  function addTag(raw: string) {
    const value = raw.trim().replace(/^#/, '').trim()
    if (!value) return
    if (value.length > 24) {
      setError('单个标签不能超过 24 个字符')
      return
    }
    if (tags.includes(value)) {
      setInput('')
      return
    }
    if (tags.length >= 12) {
      setError('每张卡片最多 12 个标签')
      return
    }
    setTags([...tags, value].sort())
    setInput('')
    setError('')
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const updated = await setCardTags(card.id, tags)
      if (!updated) throw new Error('标签保存失败：后端未返回有效卡片数据')
      onSaved(updated)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      eyebrow="TAGS"
      title="卡片标签"
      description={cardTitle(card)}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="is-primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存标签'}
          </button>
        </>
      )}
    >
      <div className="card-tag-list">
        {tags.length === 0 && <span className="card-dialog-empty">还没有标签，输入后回车即可添加。</span>}
        {tags.map((tag) => (
          <span className="card-tag" key={tag}>
            #{tag}
            <button type="button" onClick={() => setTags(tags.filter((item) => item !== tag))} aria-label={`移除标签 ${tag}`}>×</button>
          </span>
        ))}
      </div>
      <form className="card-tag-input" onSubmit={(event) => {
        event.preventDefault()
        addTag(input)
      }}>
        <input
          value={input}
          onChange={(event) => { setInput(event.target.value); setError('') }}
          placeholder="输入标签，回车添加（最多 12 个）"
          maxLength={24}
          autoFocus
        />
        <button type="submit" disabled={!input.trim()}>添加</button>
      </form>
      {suggestions.length > 0 && (
        <div className="card-tag-suggestions">
          <small>常用标签</small>
          <div>
            {suggestions.map((tag) => (
              <button type="button" key={tag} onClick={() => addTag(tag)}>#{tag}</button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="card-dialog-error">{error}</p>}
    </DialogShell>
  )
}

interface BacklinkDialogProps {
  card: Card
  cards: Card[]
  onClose: () => void
  /** 点某张卡：在不同视图里表现不同（脑图聚焦 / 打开编辑器）。 */
  onOpenCard?: (id: string) => void
  onChanged?: () => void
}

/**
 * 反向链接面板：谁引用我（入链）+ 我引用谁（出链）。
 * 两个方向都允许直接取消链接，不用回到「关联卡片」里找。
 */
export function BacklinkDialog({ card, cards, onClose, onOpenCard, onChanged }: BacklinkDialogProps) {
  const [links, setLinks] = useState<CardLink[] | null>(null)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void listCardLinks()
      .then(setLinks)
      .catch((reason) => setError(errorMessage(reason)))
  }, [card.id])

  const byId = useMemo(() => new Map(cards.map((item) => [item.id, item])), [cards])
  const neighbors = useMemo(() => neighborsOf(buildLinkIndex(links ?? []), card.id), [links, card.id])

  async function remove(link: CardLink) {
    if (busyId) return
    setBusyId(link.id)
    setError('')
    try {
      await deleteCardLink(link.id)
      setLinks((current) => (current ?? []).filter((item) => item.id !== link.id))
      window.dispatchEvent(new Event('pdfnote:links-changed'))
      onChanged?.()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId('')
    }
  }

  const row = (link: CardLink, direction: 'in' | 'out') => {
    const otherId = direction === 'in' ? link.source_card_id : link.target_card_id
    const other = byId.get(otherId)
    return (
      <div className="card-link-row is-backlink" key={link.id} data-testid={`backlink-${direction}-${otherId}`}>
        <div>
          <strong>{other ? cardTitle(other) : '卡片已删除'}</strong>
          <small>{direction === 'in' ? '引用了本卡' : '本卡引用它'}</small>
        </div>
        <div className="card-backlink-actions">
          {other && onOpenCard && (
            <button type="button" onClick={() => onOpenCard(other.id)}>打开</button>
          )}
          <button type="button" onClick={() => void remove(link)} disabled={busyId === link.id}>
            {busyId === link.id ? '处理中…' : '取消链接'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <DialogShell
      eyebrow="BACKLINKS"
      title="反向链接"
      description={cardTitle(card)}
      onClose={onClose}
      wide
      footer={<button type="button" onClick={onClose}>关闭</button>}
    >
      {error && <p className="card-dialog-error">{error}</p>}
      {links === null && <span className="card-dialog-empty">正在读取链接…</span>}
      {links !== null && (
        <>
          <section className="card-backlink-section">
            <h3>被引用 <em data-testid="backlink-inbound-count">{neighbors.inbound.length}</em></h3>
            {neighbors.inbound.length === 0
              ? <span className="card-dialog-empty">还没有卡片引用它。用「关联卡片」给别的卡加上指向这里的链接。</span>
              : <div className="card-link-list">{neighbors.inbound.map((link) => row(link, 'in'))}</div>}
          </section>
          <section className="card-backlink-section">
            <h3>引用出去 <em data-testid="backlink-outbound-count">{neighbors.outbound.length}</em></h3>
            {neighbors.outbound.length === 0
              ? <span className="card-dialog-empty">这张卡还没有指向任何卡片。</span>
              : <div className="card-link-list">{neighbors.outbound.map((link) => row(link, 'out'))}</div>}
          </section>
        </>
      )}
    </DialogShell>
  )
}

interface LinkDialogProps {
  card: Card
  cards: Card[]
  onClose: () => void
  onChanged: () => void
}

export function LinkDialog({ card, cards, onClose, onChanged }: LinkDialogProps) {
  const [links, setLinks] = useState<CardLink[] | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void listCardLinks()
      .then(setLinks)
      .catch((reason) => setError(errorMessage(reason)))
  }, [])

  const outgoing = useMemo(
    () => new Map((links ?? []).filter((link) => link.source_card_id === card.id).map((link) => [link.target_card_id, link])),
    [card.id, links],
  )
  const incoming = useMemo(
    () => new Set((links ?? []).filter((link) => link.target_card_id === card.id).map((link) => link.source_card_id)),
    [card.id, links],
  )
  const candidates = cards
    .filter((item) => item.id !== card.id)
    .filter((item) => {
      const keyword = query.trim().toLowerCase()
      if (!keyword) return true
      return `${cardTitle(item)} ${item.excerpt} ${item.tags.join(' ')}`.toLowerCase().includes(keyword)
    })
    .slice(0, 60)

  async function toggle(targetId: string) {
    if (busyId) return
    setBusyId(targetId)
    setError('')
    try {
      const existing = outgoing.get(targetId)
      if (existing) {
        await deleteCardLink(existing.id)
        setLinks((current) => (current ?? []).filter((link) => link.id !== existing.id))
      } else {
        const created = await createCardLink(card.id, targetId)
        if (!created) throw new Error('链接创建失败：后端未返回有效数据')
        setLinks((current) => [...(current ?? []), created])
      }
      window.dispatchEvent(new Event('pdfnote:links-changed'))
      onChanged()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId('')
    }
  }

  return (
    <DialogShell
      eyebrow="LINKS"
      title="关联卡片"
      description={`当前：${cardTitle(card)}`}
      onClose={onClose}
      wide
      footer={<button type="button" onClick={onClose}>完成</button>}
    >
      <label className="card-dialog-search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索卡片标题、摘录或标签" />
      </label>
      {error && <p className="card-dialog-error">{error}</p>}
      <div className="card-link-list">
        {links === null && <span className="card-dialog-empty">正在读取链接…</span>}
        {links !== null && candidates.length === 0 && <span className="card-dialog-empty">没有匹配的卡片。</span>}
        {candidates.map((item) => {
          const linked = outgoing.has(item.id)
          const reverse = incoming.has(item.id)
          return (
            <div className="card-link-row" key={item.id}>
              <div>
                <strong>{cardTitle(item)}</strong>
                <span>
                  {item.excerpt.trim() ? item.excerpt.trim().slice(0, 48) : '无摘录'}
                  {reverse ? ' · 已被对方链接' : ''}
                </span>
              </div>
              <button
                type="button"
                className={linked ? 'is-linked' : ''}
                onClick={() => void toggle(item.id)}
                disabled={busyId === item.id}
              >
                {busyId === item.id ? '处理中…' : linked ? '取消链接' : '链接'}
              </button>
            </div>
          )
        })}
      </div>
    </DialogShell>
  )
}

interface MergeDialogProps {
  cards: Card[]
  initialSelection?: string[]
  onClose: () => void
  onMerged: (card: Card) => void
}

export function MergeDialog({ cards, initialSelection = [], onClose, onMerged }: MergeDialogProps) {
  const [selected, setSelected] = useState<string[]>(initialSelection.filter((id) => cards.some((card) => card.id === id)))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const filtered = cards.filter((card) => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return true
    return `${cardTitle(card)} ${card.excerpt} ${card.tags.join(' ')}`.toLowerCase().includes(keyword)
  })

  function toggle(id: string) {
    setSelected((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id])
  }

  async function merge() {
    if (busy || selected.length < 2) return
    setBusy(true)
    setError('')
    try {
      const merged = await mergeCards(selected)
      if (!merged) throw new Error('合并失败：后端未返回有效卡片数据')
      onMerged(merged)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      eyebrow="MERGE"
      title="合并卡片"
      description="按选择顺序合并：第一张作为主体，其余内容、子节点、标注与标签都会并入。"
      onClose={onClose}
      wide
      footer={(
        <>
          <span className="card-dialog-count">已选 {selected.length} 张</span>
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="is-primary" onClick={() => void merge()} disabled={busy || selected.length < 2}>
            {busy ? '合并中…' : '合并所选'}
          </button>
        </>
      )}
    >
      <label className="card-dialog-search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索要合并的卡片" />
      </label>
      {error && <p className="card-dialog-error">{error}</p>}
      <div className="card-merge-list">
        {filtered.map((card) => {
          const index = selected.indexOf(card.id)
          return (
            <label className={`card-merge-row${index >= 0 ? ' is-selected' : ''}`} key={card.id}>
              <input type="checkbox" checked={index >= 0} onChange={() => toggle(card.id)} />
              <div>
                <strong>{cardTitle(card)}</strong>
                <span>{card.excerpt.trim() ? card.excerpt.trim().slice(0, 60) : '无摘录'}</span>
              </div>
              {index >= 0 && <i>{index === 0 ? '主体' : `#${index + 1}`}</i>}
            </label>
          )
        })}
        {filtered.length === 0 && <span className="card-dialog-empty">没有匹配的卡片。</span>}
      </div>
    </DialogShell>
  )
}


interface AiAskDialogProps {
  card: Card
  onClose: () => void
}

/** 围绕一张卡片问答：答案只显示在面板里，不写回笔记。 */
export function AiAskDialog({ card, onClose }: AiAskDialogProps) {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'ai'; text: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    const text = question.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    setMessages((current) => [...current, { role: 'user', text }])
    setQuestion('')
    try {
      const answer = (await askCard(card.id, text)).trim()
      setMessages((current) => [...current, { role: 'ai', text: answer || '（模型没有返回内容）' }])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      eyebrow="AI ASK"
      title="围绕这张卡提问"
      description={cardTitle(card)}
      onClose={onClose}
      wide
      footer={<button type="button" onClick={onClose}>关闭</button>}
    >
      <div className="card-ai-thread" data-testid="ai-ask-thread">
        {messages.length === 0 && (
          <span className="card-dialog-empty">答案只依据卡片内容，不会写回笔记。试试问「为什么」「举个例子」「和 X 有什么区别」。</span>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`card-ai-message is-${message.role}`} data-testid={`ai-ask-${message.role}`}>
            <small>{message.role === 'user' ? '我' : 'AI'}</small>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      {error && <p className="card-dialog-error">{error}</p>}
      <div className="card-ai-input">
        <input
          data-testid="ai-ask-input"
          value={question}
          placeholder="问点什么，例如：这个结论的推导前提是什么？"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          disabled={busy}
        />
        <button type="button" data-testid="ai-ask-submit" onClick={() => void submit()} disabled={busy || !question.trim()}>
          {busy ? '思考中…' : '提问'}
        </button>
      </div>
    </DialogShell>
  )
}

interface AiGenerateDialogProps {
  card: Card
  onClose: () => void
  /** 用户勾选后创建；调用方负责真正建卡。 */
  onCreate: (drafts: QuestionDraft[]) => Promise<void>
}

/** AI 出题：先出草稿，用户勾选确认后才建卡。 */
export function AiGenerateDialog({ card, onClose, onCreate }: AiGenerateDialogProps) {
  const [drafts, setDrafts] = useState<QuestionDraft[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    setDrafts(null)
    try {
      const items = await generateCardQuestions(card.id, 4)
      setDrafts(items)
      setSelected(new Set(items.map((_, index) => index)))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [card.id])

  useEffect(() => {
    void load()
    // 只在打开时出一次题；换卡片由外层重建组件。
  }, [load])

  async function create() {
    if (!drafts || busy) return
    const picked = drafts.filter((_, index) => selected.has(index))
    if (picked.length === 0) return
    setBusy(true)
    setError('')
    try {
      await onCreate(picked)
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      eyebrow="AI QUESTIONS"
      title="让 AI 出几道题"
      description={cardTitle(card)}
      onClose={onClose}
      wide
      footer={(
        <>
          <button type="button" onClick={() => void load()} disabled={busy}>重新出题</button>
          <button type="button" onClick={() => void create()} disabled={busy || selected.size === 0} data-testid="ai-generate-create">
            {busy ? '处理中…' : `创建 ${selected.size} 张卡`}
          </button>
        </>
      )}
    >
      {busy && <span className="card-dialog-empty">正在出题…</span>}
      {error && <p className="card-dialog-error">{error}</p>}
      {drafts && drafts.length === 0 && <span className="card-dialog-empty">没有生成可用的题目。</span>}
      {drafts && drafts.length > 0 && (
        <div className="card-ai-drafts" data-testid="ai-generate-list">
          {drafts.map((draft, index) => (
            <label key={index} className={`card-ai-draft${selected.has(index) ? ' is-selected' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(index)}
                onChange={() => {
                  const next = new Set(selected)
                  if (next.has(index)) next.delete(index)
                  else next.add(index)
                  setSelected(next)
                }}
              />
              <div>
                <strong>{draft.question}</strong>
                <p>{draft.answer}</p>
              </div>
            </label>
          ))}
        </div>
      )}
    </DialogShell>
  )
}
