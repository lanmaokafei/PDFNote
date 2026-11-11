import { useEffect, useMemo, useState } from 'react'
import { BookOpenCheck, ChevronRight, Repeat } from 'lucide-react'
import type { Document } from '../../domain/card'
import {
  createMindmapCanvas,
  listDocuments,
  listMindmapCanvases,
  updateDocumentMetadata,
} from '../../services/pdfnote'
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
      )}
    </div>
  )
}
