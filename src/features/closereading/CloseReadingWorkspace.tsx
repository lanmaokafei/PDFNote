import { useEffect, useMemo, useState } from 'react'
import { BookOpenCheck, ChevronRight, Repeat } from 'lucide-react'
import type { Document } from '../../domain/card'
import {
  createMindmapCanvas,
  getReadingDays,
  getReadingStats,
  getStudyOverview,
  listDocuments,
  listMindmapCanvases,
  updateDocumentMetadata,
  type ReadingStats,
  type ReadingDay,
  type StudyOverview,
} from '../../services/pdfnote'
import {
  formatReadingClock,
  localDayKey,
  readGoalMinutes,
  readingGoalPercent,
  saveGoalMinutes,
  yearStartKey,
  GOAL_CHOICES,
} from '../reading/readingStats'
import {
  activeDayCount,
  averagePerDay,
  currentStreak,
  longestStreak,
  monthTotals,
} from '../reading/yearReview'
import { closeReadingCanvasName } from '../mindmap/canvas'
import { StudyWorkspace } from '../study/StudyWorkspace'
import './CloseReadingWorkspace.css'

interface CloseReadingWorkspaceProps {
  onCardsChanged: () => void
  /** 从脑图卡片点页码跳过来：留在本工作区，只换 PDF 的页。 */
  jumpTarget?: { documentId: string; page: number; token: number } | null
  onJumpHandled?: () => void
}

const ROUGH_STEPS = [
  '先定问题：这本书要解决我什么？写 1–3 个问题。',
  '看外围：封面、目录、序言、后记、索引。',
  '快速翻页：每章标题、开头、结尾、图表、小结。',
  '抓结构：画目录树，标出核心章 / 案例章 / 可跳过。',
  '写三句话：主旨、作者怎么论证、和我什么关系。',
  '列精读清单：3–5 个最相关的章节与没弄懂的问题。',
]

const CLOSE_STEPS = [
  '带着问题读：每章先写「这一章要回答什么」。',
  '逐节慢读 + 批注：定义、论点、证据、反例、疑问。',
  '合书复述：读完一节就用自己的话讲一遍。',
  '做概念卡：概念—定义—例子—易混点—我的理解。',
  '画论证图：主张 → 理由 → 证据 → 可能反驳。',
  '批判提问：证据可靠吗？前提成立吗？有反例吗？',
  '联系应用：我能用在哪里、改变什么行动。',
  '输出：200–500 字摘要 / 讲给别人听 / 导图。',
  '间隔复习：1 天后、1 周后回看笔记与问题。',
]

/**
 * 粗读精读工作区：独立入口、独立画布。
 *
 * 「粗读—精读」按一本书展开：先粗读建地图，判断哪几章值得精读，再精读挖重点。
 * 这里给每本书建一张「精读 · 书名」画布，PDF 标注按画布过滤，
 * 所以进来看到的是一块新桌面，不会把资料库里的原有标记混进来。
 */
export function CloseReadingWorkspace({ onCardsChanged, jumpTarget, onJumpHandled }: CloseReadingWorkspaceProps) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Document | null>(null)
  const [canvasId, setCanvasId] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [methodOpen, setMethodOpen] = useState(false)
  const [jump, setJump] = useState<{ documentId: string; page: number; token: number } | null>(null)
  // 阅读目标：今日累计时长来自 reading_daily，目标分钟数存 localStorage。
  const [readingStats, setReadingStats] = useState<ReadingStats | null>(null)
  const [goalMinutes, setGoalMinutes] = useState(readGoalMinutes)
  // 年度回顾：跨书阅读日历 + 今年的写卡/复习。
  const [yearOpen, setYearOpen] = useState(false)
  const [yearDays, setYearDays] = useState<ReadingDay[]>([])
  const [yearStudy, setYearStudy] = useState<StudyOverview | null>(null)
  const [yearBusy, setYearBusy] = useState(false)
  const [lastDocId, setLastDocId] = useState<string | null>(() => {
    try {
      return globalThis.localStorage?.getItem('pdfnote.reading.lastDocument') ?? null
    } catch {
      return null
    }
  })

  useEffect(() => {
    let active = true
    setLoading(true)
    listDocuments()
      .then((list) => {
        if (active) setDocuments(list)
      })
      .catch((reason: unknown) => {
        if (active) setError(`无法读取文档列表：${reason instanceof Error ? reason.message : String(reason)}`)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  // 回到书单页就刷新今日阅读时长（刚读完一本书时数字要立刻变）。
  useEffect(() => {
    if (selected) return
    let active = true
    const now = new Date()
    getReadingStats(localDayKey(now), yearStartKey(now))
      .then((stats) => {
        if (active) setReadingStats(stats)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [selected, documents.length])

  /** 年度回顾：一次拉齐阅读日历与学习汇总，弹窗里再算月度与连续天数。 */
  const openYearReview = () => {
    setYearOpen(true)
    setYearBusy(true)
    const now = new Date()
    const year = now.getFullYear()
    Promise.all([
      getReadingDays(`${year}-01-01`, `${year}-12-31`).catch(() => [] as ReadingDay[]),
      getReadingStats(localDayKey(now), `${year}-01-01`).catch(() => null),
      getStudyOverview(new Date(year, 0, 1).toISOString()).catch(() => null),
    ])
      .then(([days, stats, study]) => {
        setYearDays(days)
        if (stats) setReadingStats(stats)
        setYearStudy(study)
      })
      .finally(() => setYearBusy(false))
  }

  /** 进入一本书：确保「精读 · 书名」画布存在，把它钉给 PDF 与脑图。 */
  const openDocument = async (document: Document) => {
    if (preparing) return
    setPreparing(true)
    setError('')
    try {
      const name = closeReadingCanvasName(document.title)
      const canvases = await listMindmapCanvases(document.id)
      const existing = canvases.find((canvas) => canvas.document_id === document.id && canvas.name === name)
      const canvas = existing ?? await createMindmapCanvas({ name, document_id: document.id })
      setCanvasId(canvas.id)
      setSelected(document)
      setMethodOpen(false)
      setJump(null)
      setLastDocId(document.id)
      try {
        globalThis.localStorage?.setItem('pdfnote.reading.lastDocument', document.id)
      } catch {
        // 隐私模式下不记住上次读的书。
      }
    } catch (reason) {
      setError(`无法准备这本书的精读画布：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setPreparing(false)
    }
  }

  // 外部请求跳页：同一本书就直接交给 StudyWorkspace，换了书先切过去。
  useEffect(() => {
    if (!jumpTarget) return
    let cancelled = false
    void (async () => {
      try {
        if (selected?.id !== jumpTarget.documentId) {
          const target = documents.find((item) => item.id === jumpTarget.documentId)
            ?? (await listDocuments()).find((item) => item.id === jumpTarget.documentId)
          if (!target || cancelled) return
          await openDocument(target)
          if (cancelled) return
        }
        setJump(jumpTarget)
        onJumpHandled?.()
      } catch {
        onJumpHandled?.()
      }
    })()
    return () => {
      cancelled = true
    }
    // jumpTarget.token 保证同页重复点击也能触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget?.token])

  const handlePageCount = async (count: number) => {
    if (!selected || selected.page_count === count) return
    try {
      await updateDocumentMetadata(selected.id, selected.title, count)
      setSelected({ ...selected, page_count: count })
      setDocuments((list) => list.map((item) => (item.id === selected.id ? { ...item, page_count: count } : item)))
    } catch {
      // 页数只是元数据，写不进去不影响阅读。
    }
  }

  const sorted = useMemo(
    () => documents.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [documents],
  )

  const sortedList = sorted
  const continueTarget = sortedList.find((document) => document.id === lastDocId) ?? sortedList[0] ?? null
  const todaySeconds = readingStats?.todaySeconds ?? 0
  const goalPercent = readingGoalPercent(todaySeconds, goalMinutes)

  const year = new Date().getFullYear()
  const yearTotals = monthTotals(yearDays, year)
  const yearSeconds = yearTotals.reduce((sum, value) => sum + value, 0)
  const yearPeak = Math.max(1, ...yearTotals)
  const yearActiveDays = activeDayCount(yearDays)
  const yearLongest = longestStreak(yearDays)
  const yearStreak = currentStreak(yearDays, localDayKey(new Date()))

  return (
    <div className="close-reading">
      <header className="close-reading-head">
        <div>
          <p className="close-reading-eyebrow">ROUGH READ · CLOSE READ</p>
          <h1>粗读精读</h1>
          <p>
            {selected
              ? '这本书的脑图与标记存在专属画布里，不会和资料库里的原有笔记混在一起。'
              : '一本书先粗读建地图，判断哪几章值得精读，再精读挖重点。'}
          </p>
        </div>
        <div className="close-reading-actions">
          {selected && (
            <button type="button" onClick={() => { setSelected(null); setCanvasId(null) }} disabled={preparing}>
              <Repeat size={14} />
              换一本书
            </button>
          )}
          <button type="button" onClick={() => setMethodOpen((open) => !open)} aria-expanded={methodOpen}>
            <BookOpenCheck size={14} />
            方法
          </button>
        </div>
      </header>

      {error && <p className="close-reading-error" role="alert">{error}</p>}

      {methodOpen && (
        <section className="close-reading-method" aria-label="粗读精读方法">
          <div>
            <h2>粗读 · 建地图</h2>
            <p className="close-reading-method-note">30–60 分钟，读完比读细重要。</p>
            <ol>{ROUGH_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
          <div>
            <h2>精读 · 挖重点</h2>
            <p className="close-reading-method-note">只精读核心章，按章推进、重在输出。</p>
            <ol>{CLOSE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
          <p className="close-reading-principle">
            一句话：粗读像看地图，精读像走关键路线——先判断哪里值得走，再慢走、复述、输出。
          </p>
        </section>
      )}

      {selected && canvasId ? (
        <div className="close-reading-study">
          <div className="close-reading-docbar">
            <strong>{selected.title}</strong>
            <span>专属画布 · {closeReadingCanvasName(selected.title)}</span>
          </div>
          <StudyWorkspace
            document={selected}
            showMindmap
            closeReading
            canvasId={canvasId}
            jumpTarget={jump}
            onJumpHandled={() => setJump(null)}
            onPageCount={(count) => void handlePageCount(count)}
            onCardsChanged={onCardsChanged}
          />
        </div>
      ) : loading ? (
        <div className="close-reading-empty" role="status">
          <span />
          <p>正在读取书单…</p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="close-reading-empty">
          <strong>还没有导入 PDF</strong>
          <p>先到资料库导入一本书，再回来做粗读精读。</p>
        </div>
      ) : (
        <>
        <section className="close-reading-goal" aria-label="阅读目标" data-testid="reading-goal">
          <div className="close-reading-goal-head">
            <div>
              <strong>今日阅读</strong>
              <span>{goalPercent >= 100 ? '目标已完成，继续保持' : `目标 ${goalMinutes} 分钟`}</span>
            </div>
            <button
              type="button"
              className="close-reading-year-open"
              data-testid="year-review-open"
              onClick={openYearReview}
            >
              年度回顾
            </button>
            <select
              aria-label="每日阅读目标"
              data-testid="reading-goal-select"
              value={goalMinutes}
              onChange={(event) => {
                const next = Number(event.target.value)
                setGoalMinutes(next)
                saveGoalMinutes(next)
              }}
            >
              {GOAL_CHOICES.map((choice) => (
                <option key={choice} value={choice}>{choice} 分钟</option>
              ))}
            </select>
          </div>
          <div className="close-reading-goal-body">
            <p className="close-reading-goal-clock" data-testid="reading-goal-clock">
              {formatReadingClock(todaySeconds)}
            </p>
            <div className="close-reading-goal-track">
              <span style={{ width: `${goalPercent}%` }} data-testid="reading-goal-fill" />
            </div>
            <div className="close-reading-goal-meta">
              <span>目标 {goalMinutes} 分钟 · 完成 {goalPercent}%</span>
              <span>
                {readingStats
                  ? `今年 ${readingStats.books.length} 本 · ${formatReadingClock(readingStats.yearSeconds)}`
                  : '今年还没有阅读记录'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="close-reading-goal-cta"
            data-testid="reading-goal-continue"
            onClick={() => { if (continueTarget) void openDocument(continueTarget) }}
            disabled={preparing || !continueTarget}
          >
            {continueTarget ? `继续阅读：${continueTarget.title}` : '先导入一本书'}
          </button>
        </section>
        <ul className="close-reading-list" aria-label="选择要粗读精读的书">
          {sorted.map((document) => (
            <li key={document.id}>
              <button type="button" onClick={() => void openDocument(document)} disabled={preparing}>
                <span className="close-reading-book">
                  <strong>{document.title}</strong>
                  <small>{document.page_count ? `${document.page_count} 页` : '页数未知'} · 独立画布</small>
                </span>
                <ChevronRight size={16} />
              </button>
            </li>
          ))}
        </ul>
        </>
      )}
      {yearOpen && (
        <div className="close-reading-year-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setYearOpen(false)
        }}>
          <section className="close-reading-year" role="dialog" aria-modal="true" aria-labelledby="year-review-title" data-testid="year-review">
            <header>
              <div>
                <small>YEAR IN REVIEW</small>
                <h2 id="year-review-title">{year} 年度回顾</h2>
              </div>
              <button type="button" onClick={() => setYearOpen(false)} aria-label="关闭年度回顾">×</button>
            </header>
            {yearBusy ? (
              <p className="close-reading-year-loading">正在汇总这一年的阅读…</p>
            ) : (
              <>
                <div className="close-reading-year-metrics" data-testid="year-metrics">
                  <div><strong>{formatReadingClock(yearSeconds)}</strong><span>阅读时长</span></div>
                  <div><strong>{yearActiveDays}</strong><span>阅读天数</span></div>
                  <div><strong>{yearLongest}</strong><span>最长连续</span></div>
                  <div><strong>{yearStudy?.cardsWritten ?? 0}</strong><span>写卡</span></div>
                </div>
                <div className="close-reading-year-chart" data-testid="year-chart">
                  {yearTotals.map((seconds, index) => (
                    <div
                      key={index}
                      className="close-reading-year-bar"
                      title={`${index + 1} 月：${formatReadingClock(seconds)}`}
                      data-month={index + 1}
                      data-seconds={seconds}
                    >
                      <span style={{ height: `${Math.max(seconds > 0 ? 6 : 0, Math.round((seconds / yearPeak) * 100))}%` }} />
                      <em>{index + 1}</em>
                    </div>
                  ))}
                </div>
                <p className="close-reading-year-line">
                  今年复习 {yearStudy?.reviews ?? 0} 次 · 复习过 {yearStudy?.reviewedCards ?? 0} 张卡
                  · 平均每个阅读日 {formatReadingClock(averagePerDay(yearSeconds, yearActiveDays))}
                  {yearStreak > 0 ? ` · 当前连续 ${yearStreak} 天` : ''}
                </p>
                <h3 className="close-reading-year-subtitle">读过的书（按阅读时长）</h3>
                {(readingStats?.books.length ?? 0) === 0 ? (
                  <p className="close-reading-year-empty">今年还没有阅读记录，打开一本书就会开始计时。</p>
                ) : (
                  <ul className="close-reading-year-books" data-testid="year-books">
                    {readingStats?.books.slice(0, 6).map((book) => (
                      <li key={book.documentId}>
                        <span>{book.title}</span>
                        <strong>{formatReadingClock(book.yearSeconds)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
                <footer>
                  <button type="button" onClick={() => setYearOpen(false)}>关闭</button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
