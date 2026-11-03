import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Eye, Pencil, RefreshCw } from 'lucide-react'
import type { Card, Rating, ReviewStats } from '../../domain/card'
import { ContextMenu } from '../../ui/ContextMenu'
import { MathText } from '../../ui/MathText'
import { useContextMenu } from '../../ui/contextMenuCore'
import { getReviewStats, listDueCards, updateCardContent } from '../../services/pdfnote'
import { useCardStore } from '../../store/cardStore'
import { reviewCard } from './scheduler'
import './ReviewWorkspace.css'

interface ReviewWorkspaceProps {
  onCardsChanged: () => void
}

interface DraftContent {
  question: string
  excerpt: string
  user_note: string
}

const RATING_OPTIONS: Array<{
  rating: Rating
  label: string
  description: string
  className: string
}> = [
  { rating: 1, label: 'Again', description: '重来', className: 'again' },
  { rating: 2, label: 'Hard', description: '困难', className: 'hard' },
  { rating: 3, label: 'Good', description: '良好', className: 'good' },
  { rating: 4, label: 'Easy', description: '简单', className: 'easy' },
]

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function dayStartIso(): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.toISOString()
}

function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDue(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function buildFourteenDayTrend(stats: ReviewStats | null) {
  const daily = new Map((stats?.daily ?? []).map((item) => [item.day.slice(0, 10), item]))
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() - (13 - index))
    const key = localDayKey(date)
    const values = daily.get(key)
    return {
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      reviews: values?.reviews ?? 0,
      correct: values?.correct ?? 0,
    }
  })
}

export function ReviewWorkspace({ onCardsChanged }: ReviewWorkspaceProps) {
  const loadCards = useCardStore((state) => state.loadCards)
  const [queue, setQueue] = useState<Card[]>([])
  const [stats, setStats] = useState<ReviewStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DraftContent>({ question: '', excerpt: '', user_note: '' })
  const [savingContent, setSavingContent] = useState(false)
  const [ratingCardId, setRatingCardId] = useState<string | null>(null)
  const [ratingValue, setRatingValue] = useState<Rating | null>(null)
  const [completed, setCompleted] = useState(0)
  const [sessionTotal, setSessionTotal] = useState(0)
  const [lastReviewed, setLastReviewed] = useState<{ question: string; due: string; rating: Rating } | null>(null)
  const { menu, show, close } = useContextMenu()

  const mountedRef = useRef(false)
  const loadRequestRef = useRef(0)
  const ratingLockRef = useRef<string | null>(null)
  const sessionIdRef = useRef(crypto.randomUUID())
  const current = queue[0]
  const busy = savingContent || ratingCardId !== null

  const loadWorkspace = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setError('')
    try {
      const [cards, nextStats] = await Promise.all([
        listDueCards(new Date().toISOString(), 200),
        getReviewStats(dayStartIso()),
      ])
      if (!mountedRef.current || requestId !== loadRequestRef.current) return
      setQueue(cards)
      setStats(nextStats)
      setSessionTotal(cards.length)
      setCompleted(0)
      setRevealed(false)
      setEditing(false)
      setLastReviewed(null)
      setNotice('')
    } catch (reason) {
      if (!mountedRef.current || requestId !== loadRequestRef.current) return
      setError(`无法载入复习数据：${errorMessage(reason)}`)
    } finally {
      if (mountedRef.current && requestId === loadRequestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadWorkspace()
    return () => {
      mountedRef.current = false
      loadRequestRef.current += 1
    }
  }, [loadWorkspace])

  const refreshCommittedData = useCallback(async () => {
    const [cardsResult, statsResult] = await Promise.allSettled([
      loadCards(),
      getReviewStats(dayStartIso()),
    ])
    let callbackFailed = false
    try {
      onCardsChanged()
    } catch {
      callbackFailed = true
    }
    if (!mountedRef.current) return
    if (statsResult.status === 'fulfilled') setStats(statsResult.value)
    if (cardsResult.status === 'rejected' || statsResult.status === 'rejected' || callbackFailed) {
      setNotice('更改已持久化，但部分数据未能刷新。请稍后重新检查队列。')
    } else {
      setNotice('')
    }
  }, [loadCards, onCardsChanged])

  const handleRating = async (rating: Rating) => {
    if (!current || !revealed || editing || savingContent || ratingLockRef.current) return
    const card = current
    ratingLockRef.current = card.id
    setRatingCardId(card.id)
    setRatingValue(rating)
    setError('')
    setNotice('')

    try {
      const updated = await reviewCard(card, rating, 'flashcard', sessionIdRef.current)
      if (mountedRef.current) {
        setQueue((items) => items.filter((item) => item.id !== card.id))
        setCompleted((count) => count + 1)
        setLastReviewed({ question: card.question.trim() || '未命名卡片', due: updated.due, rating })
        setRevealed(false)
      }
      await refreshCommittedData()
    } catch (reason) {
      if (mountedRef.current) setError(`评分未保存：${errorMessage(reason)}`)
    } finally {
      if (ratingLockRef.current === card.id) ratingLockRef.current = null
      if (mountedRef.current) {
        setRatingCardId(null)
        setRatingValue(null)
      }
    }
  }

  const beginEditing = () => {
    if (!current || busy) return
    setDraft({ question: current.question, excerpt: current.excerpt, user_note: current.user_note })
    setEditing(true)
    setError('')
    setNotice('')
  }

  const saveContent = async () => {
    if (!current || ratingLockRef.current || savingContent) return
    if (!draft.question.trim() && !draft.excerpt.trim() && !draft.user_note.trim()) {
      setError('问题、原文摘录和个人笔记不能同时为空。')
      return
    }
    const card = current
    setSavingContent(true)
    setError('')
    setNotice('')
    try {
      const updated = await updateCardContent({ id: card.id, ...draft })
      if (mountedRef.current) {
        setQueue((items) => items.map((item) => (item.id === updated.id ? updated : item)))
        setEditing(false)
      }
      await refreshCommittedData()
    } catch (reason) {
      if (mountedRef.current) setError(`卡片未保存：${errorMessage(reason)}`)
    } finally {
      if (mountedRef.current) setSavingContent(false)
    }
  }

  const copyText = (text: string) => {
    if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  function handleCardContextMenu(event: React.MouseEvent<HTMLElement>) {
    const selected = window.getSelection()?.toString().trim() ?? ''
    const card = current
    show(event, {
      title: '复习卡片',
      sections: [
        { id: 'card', items: [
          { id: 'reveal', label: revealed ? '隐藏答案' : '显示答案', icon: Eye, disabled: !card || editing || busy, onSelect: () => setRevealed((value) => !value) },
          { id: 'edit', label: '编辑卡片', icon: Pencil, disabled: !card || busy || editing, onSelect: beginEditing },
          { id: 'copy-question', label: '复制问题', icon: Copy, disabled: !card?.question.trim(), onSelect: () => copyText(card?.question ?? '') },
          { id: 'copy-excerpt', label: '复制原文摘录', icon: Copy, disabled: !card?.excerpt.trim(), onSelect: () => copyText(card?.excerpt ?? '') },
        ] },
        { id: 'selection', items: [
          { id: 'copy-selection', label: '复制选中文字', icon: Copy, disabled: !selected, hint: selected ? `${selected.length} 字` : undefined, onSelect: () => copyText(selected) },
          { id: 'refresh', label: '重新检查到期卡片', icon: RefreshCw, disabled: busy || loading, onSelect: () => void loadWorkspace() },
        ] },
      ],
    })
  }

  const trend = useMemo(() => buildFourteenDayTrend(stats), [stats])
  const maxReviews = Math.max(1, ...trend.map((item) => item.reviews))
  const hasTrend = trend.some((item) => item.reviews > 0)
  const accuracy = stats && stats.completed_today > 0
    ? Math.round((stats.correct_today / stats.completed_today) * 100)
    : null
  const progress = sessionTotal > 0 ? Math.min(100, Math.round((completed / sessionTotal) * 100)) : 0
  const lastRatingLabel = lastReviewed
    ? RATING_OPTIONS.find((option) => option.rating === lastReviewed.rating)?.label
    : null

  return (
    <div className="review-workspace">
      <header className="review-header">
        <div>
          <p className="review-eyebrow">ACTIVE RECALL · FSRS</p>
          <h1>复习工作区</h1>
          <p>先回忆，再揭示答案。每次评分都会立即保存到本地数据库。</p>
        </div>
        <button className="review-refresh" type="button" onClick={() => void loadWorkspace()} disabled={busy || loading}>
          {loading ? '正在检查…' : '重新检查到期卡片'}
        </button>
      </header>

      <div className="review-layout">
        <section className="review-session" aria-label="到期复习队列" aria-busy={busy || loading}>
          <div className="review-session-heading">
            <div>
              <span className="review-section-kicker">今日队列</span>
              <strong>{loading ? '正在读取' : `${queue.length} 张待复习`}</strong>
            </div>
            <span>{completed} / {sessionTotal} 已完成</span>
          </div>
          <div className="review-progress" role="progressbar" aria-label="本轮复习进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>

          {lastReviewed && (
            <div className="review-last-result" role="status">
              <span>已保存 · {lastRatingLabel}</span>
              <p>「{lastReviewed.question}」下次复习：<strong>{formatDue(lastReviewed.due)}</strong></p>
            </div>
          )}
          {notice && <p className="review-notice" role="status">{notice}</p>}
          {error && <p className="review-error" role="alert">{error}</p>}

          {loading ? (
            <div className="review-loading" role="status">
              <span />
              <p>正在整理到期卡片与复习统计…</p>
            </div>
          ) : current ? (
            <article className="review-card" onContextMenu={handleCardContextMenu}>
              <div className="review-card-meta">
                <span>{current.source_ref ? `原文第 ${current.source_ref.page} 页` : '知识卡片'}</span>
                <span>本次到期 {formatDue(current.due)}</span>
                <button type="button" onClick={beginEditing} disabled={busy || editing}>编辑卡片</button>
              </div>

              {editing ? (
                <form className="review-edit-form" onSubmit={(event) => { event.preventDefault(); void saveContent() }}>
                  <label>
                    <span>正面问题</span>
                    <textarea
                      value={draft.question}
                      onChange={(event) => setDraft((value) => ({ ...value, question: event.target.value }))}
                      rows={3}
                      placeholder="输入需要主动回忆的问题"
                      disabled={savingContent}
                      autoFocus
                    />
                  </label>
                  <label>
                    <span>背面 · 原文摘录</span>
                    <textarea
                      value={draft.excerpt}
                      onChange={(event) => setDraft((value) => ({ ...value, excerpt: event.target.value }))}
                      rows={6}
                      placeholder="输入 PDF 原文或答案摘录"
                      disabled={savingContent}
                    />
                  </label>
                  <label>
                    <span>背面 · 个人笔记</span>
                    <textarea
                      value={draft.user_note}
                      onChange={(event) => setDraft((value) => ({ ...value, user_note: event.target.value }))}
                      rows={4}
                      placeholder="补充自己的理解、提示或易错点"
                      disabled={savingContent}
                    />
                  </label>
                  <div className="review-edit-actions">
                    <button type="button" onClick={() => setEditing(false)} disabled={savingContent}>取消</button>
                    <button className="primary" type="submit" disabled={savingContent}>
                      {savingContent ? '正在保存…' : '保存卡片内容'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="review-question">
                    <span className="review-face-label">正面 · 问题</span>
                    <h2>{current.question.trim() || '这张卡片尚未填写问题'}</h2>
                    {current.excerpt_image && (
                      <img
                        className="review-question-image"
                        src={current.excerpt_image}
                        alt="问题摘录图像"
                        loading="lazy"
                      />
                    )}
                    <p>请在心里组织答案，准备好后再查看背面。</p>
                  </div>

                  {revealed && (
                    <div className="review-answer">
                      <section>
                        <span className="review-face-label">背面 · 原文摘录</span>
                        {current.excerpt_image && (
                          <img
                            className="review-answer-image"
                            src={current.excerpt_image}
                            alt="原文摘录图像"
                            loading="lazy"
                          />
                        )}
                        <p>
                          {current.excerpt.trim()
                            ? <MathText text={current.excerpt.trim()} />
                            : '未填写原文摘录'}
                        </p>
                      </section>
                      <section>
                        <span className="review-face-label">个人笔记</span>
                        <p>
                          {current.user_note.trim()
                            ? <MathText text={current.user_note.trim()} />
                            : '未填写个人笔记'}
                        </p>
                      </section>
                    </div>
                  )}

                  <div className="review-card-actions">
                    {!revealed ? (
                      <button className="review-reveal" type="button" onClick={() => setRevealed(true)} disabled={busy}>
                        显示答案
                      </button>
                    ) : (
                      <div className="review-rating-area">
                        <p>这次回忆怎么样？评分后将立即保存并进入下一张。</p>
                        <div className="review-rating-grid">
                          {RATING_OPTIONS.map((option) => (
                            <button
                              key={option.rating}
                              className={`review-rating ${option.className}`}
                              type="button"
                              onClick={() => void handleRating(option.rating)}
                              disabled={busy}
                            >
                              <strong>{option.label}</strong>
                              <span>{ratingCardId === current.id && ratingValue === option.rating ? '保存中…' : option.description}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </article>
          ) : error ? (
            <div className="review-empty review-empty-error">
              <span className="review-empty-mark">!</span>
              <h2>暂时无法开始复习</h2>
              <p>请确认正在 PDFNote 桌面应用中运行，然后重试。已保存的评分不会受影响。</p>
              <button type="button" onClick={() => void loadWorkspace()}>重新载入</button>
            </div>
          ) : (
            <div className="review-empty">
              <span className="review-empty-mark">✓</span>
              <h2>{completed > 0 ? '本轮复习已完成' : '当前没有到期卡片'}</h2>
              <p>
                {completed > 0
                  ? `本轮 ${completed} 张卡片的评分均已提交持久化。你可以稍后重新检查是否有新卡片到期。`
                  : '新卡片到期后会自动出现在这里。也可以前往文档或脑图创建更多知识卡片。'}
              </p>
              <button type="button" onClick={() => void loadWorkspace()}>再次检查</button>
            </div>
          )}
        </section>

        <aside className="review-insights" aria-label="复习统计">
          <div className="review-insights-heading">
            <div>
              <span className="review-section-kicker">学习概览</span>
              <h2>今日复习</h2>
            </div>
            <span>本地统计</span>
          </div>
          <div className="review-stat-grid">
            <div><span>今日到期</span><strong>{stats?.due_now ?? '—'}</strong><small>当前可复习</small></div>
            <div><span>今日完成</span><strong>{stats?.completed_today ?? '—'}</strong><small>已提交评分</small></div>
            <div><span>今日正确率</span><strong>{accuracy === null ? '—' : `${accuracy}%`}</strong><small>{stats ? `${stats.correct_today} 次正确` : '等待数据'}</small></div>
            <div><span>复习积压</span><strong>{stats?.backlog ?? '—'}</strong><small>需要跟进</small></div>
          </div>

          <section className="review-trend">
            <div className="review-trend-heading">
              <div><h3>近 14 日趋势</h3><p>每日复习次数与正确次数</p></div>
              <div className="review-trend-legend"><span><i />复习</span><span><i />正确</span></div>
            </div>
            {!hasTrend && <p className="review-trend-empty">近 14 日暂无复习记录</p>}
            <div className="review-trend-scroll">
              <div className="review-trend-days">
                {trend.map((item) => {
                  const reviewHeight = item.reviews > 0 ? Math.max(8, (item.reviews / maxReviews) * 100) : 0
                  const correctHeight = item.reviews > 0 ? (item.correct / item.reviews) * 100 : 0
                  return (
                    <div
                      className="review-trend-day"
                      key={item.key}
                      title={`${item.key}：复习 ${item.reviews} 次，正确 ${item.correct} 次`}
                      aria-label={`${item.key}，复习 ${item.reviews} 次，正确 ${item.correct} 次`}
                    >
                      <span className="review-trend-value">{item.reviews || ''}</span>
                      <div className="review-trend-track">
                        <div className="review-trend-bar" style={{ height: `${reviewHeight}%` }}>
                          <span style={{ height: `${correctHeight}%` }} />
                        </div>
                      </div>
                      <span className="review-trend-date">{item.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
          <p className="review-stats-note">正确率按今日评分记录计算；积压与到期数以本地数据库为准。</p>
        </aside>
      </div>
      <ContextMenu state={menu} onClose={close} />
    </div>
  )
}

export default ReviewWorkspace
