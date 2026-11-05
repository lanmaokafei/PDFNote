import { useCallback, useMemo, useState } from 'react'
import { BookOpen, Loader2, Sparkles, X } from 'lucide-react'
import {
  analyzeBookChunk,
  applyBookOutline,
  clearBookAnalysis,
  listBookNotes,
  synthesizeBook,
  type BookOutline,
  type DigestMode,
  type DigestPage,
  type OutlineNode,
} from '../../services/book'
import {
  countOutlineNodes,
  DEPTH_OPTIONS,
  outlineDepth,
  readDepth,
  saveDepth,
} from './depth'
import { notifyMindmapChanged, readCanvasId } from '../mindmap/canvas'
import './BookDigestDialog.css'

interface BookDigestDialogProps {
  documentId: string
  documentTitle: string
  pageCount: number
  currentPage: number
  /** 由 PDF 工作区提供：取某页文字与文字区域包围盒（文字层优先，扫描页回退 OCR 缓存）。 */
  getPageText: (page: number) => Promise<DigestPage>
  onClose: () => void
  onApplied: () => void
}

const MODES: Array<{ id: DigestMode; label: string; hint: string }> = [
  { id: 'structure', label: '结构', hint: '背景 / 方法 / 结果 / 讨论，或章节要点' },
  { id: 'dictionary', label: '智能词典', hint: '抽术语与别名，可直接喂给标题链接' },
  { id: 'vocabulary', label: '英文生词', hint: '按 CEFR 等级抽词，附原句与释义' },
  { id: 'questions', label: '题目', hint: '按问题组织，而不是按章节堆叠' },
]

const errorMessage = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

function OutlineTree({ nodes, depth = 0 }: { nodes: OutlineNode[]; depth?: number }) {
  if (!nodes.length) return null
  return (
    <ul className="digest-tree">
      {nodes.map((node, index) => (
        <li
          key={`${depth}-${index}-${node.title}`}
          data-depth={depth}
          className={depth >= 2 ? 'is-deep' : ''}
          style={{ paddingLeft: depth === 0 ? 0 : Math.min(depth, 5) * 14 }}
        >
          <div className="digest-tree-row">
            <span className="digest-tree-level">L{depth + 1}</span>
            <span className="digest-tree-title">{node.title}</span>
            {node.page !== null && <span className="digest-tree-page">P{node.page}</span>}
            {node.aliases && <span className="digest-tree-alias">{node.aliases}</span>}
          </div>
          {node.excerpt && <p className="digest-tree-excerpt">{node.excerpt}</p>}
          <OutlineTree nodes={node.children} depth={depth + 1} />
        </li>
      ))}
    </ul>
  )
}

export function BookDigestDialog({
  documentId,
  documentTitle,
  pageCount,
  currentPage,
  getPageText,
  onClose,
  onApplied,
}: BookDigestDialogProps) {
  const [mode, setMode] = useState<DigestMode>('structure')
  /** 读者自己决定拆多深：默认 2 层，最细 5 层，选择会记住。 */
  const [depth, setDepth] = useState<number>(() => readDepth())
  const [startPage, setStartPage] = useState(1)
  const [endPage, setEndPage] = useState(pageCount)
  const [chunkSize, setChunkSize] = useState(8)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [outline, setOutline] = useState<BookOutline | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const range = useMemo(() => {
    const start = Math.max(1, Math.min(startPage, pageCount))
    const end = Math.max(start, Math.min(endPage, pageCount))
    const total = Math.max(1, Math.ceil((end - start + 1) / Math.max(1, chunkSize)))
    return { start, end, total }
  }, [chunkSize, endPage, pageCount, startPage])

  const resetAll = useCallback(() => {
    setOutline(null)
    setProgress({ done: 0, total: 0 })
    setError('')
    setNotice('')
  }, [])

  const changeDepth = (raw: string) => {
    const next = saveDepth(Number(raw))
    setDepth(next)
    // 旧骨架是按旧深度生成的，必须重新汇总；分块笔记仍保留，可直接再汇总一次。
    setOutline(null)
    setError('')
    setNotice(
      `已设为 ${next} 层（会记住）。请重新「汇总骨架」；若想让阶段一按新深度重抽名词与定义，可点「清空重来」再分析。`,
    )
  }

  const runAnalysis = useCallback(async () => {
    if (running) return
    setRunning(true)
    setError('')
    setNotice('')
    try {
      const existing = await listBookNotes(documentId, mode)
      const done = new Set(existing.map((note) => note.chunk_index))
      setProgress({ done: existing.length, total: range.total })
      let analyzed = 0
      for (let index = 0; index < range.total; index += 1) {
        if (done.has(index)) continue
        const from = range.start + index * chunkSize
        const to = Math.min(range.end, from + chunkSize - 1)
        const pages: DigestPage[] = []
        for (let page = from; page <= to; page += 1) {
          const pageText = await getPageText(page)
          if (pageText.text.trim()) pages.push(pageText)
        }
        if (pages.length === 0) {
          setProgress((current) => ({ ...current, done: current.done + 1 }))
          continue
        }
        await analyzeBookChunk({
          document_id: documentId,
          mode,
          chunk_index: index,
          pages,
          depth,
        })
        analyzed += 1
        setProgress((current) => ({ ...current, done: current.done + 1 }))
      }
      setNotice(analyzed > 0 ? `已完成 ${analyzed} 个分块，接着可以汇总骨架。` : '所有分块都已完成，直接汇总即可。')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRunning(false)
    }
  }, [chunkSize, depth, documentId, getPageText, mode, range.end, range.start, range.total, running])

  const runSynthesis = useCallback(async () => {
    if (running) return
    setRunning(true)
    setError('')
    setNotice('')
    try {
      const result = await synthesizeBook(documentId, mode, depth)
      setOutline(result)
      const actual = outlineDepth(result.nodes)
      if (actual < depth) {
        setNotice(
          `目标 ${depth} 层，模型只给出 ${actual} 层（${countOutlineNodes(result.nodes)} 个节点）。可再汇总一次，或缩小每块页数让信息更集中。`,
        )
      } else {
        setNotice(
          `骨架已生成：${result.nodes.length} 个一级主题 · ${countOutlineNodes(result.nodes)} 个节点 · ${actual} 层。确认后写入脑图。`,
        )
      }
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRunning(false)
    }
  }, [depth, documentId, mode, running])

  const apply = useCallback(async () => {
    if (running) return
    setRunning(true)
    setError('')
    try {
      // 与右侧脑图当前选中的画布保持一致，避免骨架写进另一张脑图。
      const canvasId = readCanvasId(documentId)
      const created = await applyBookOutline(documentId, mode, canvasId)
      setNotice(created > 0 ? `已写入 ${created} 张卡片，可在脑图查看。` : '这些节点已经在脑图里了，没有重复创建。')
      notifyMindmapChanged(canvasId)
      onApplied()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRunning(false)
    }
  }, [documentId, mode, onApplied, running])

  const reset = useCallback(async () => {
    if (running) return
    setRunning(true)
    setError('')
    try {
      await clearBookAnalysis(documentId, mode)
      resetAll()
      setNotice('已清空该模式的拆书中间结果（已生成的卡片保留）。')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRunning(false)
    }
  }, [documentId, mode, resetAll, running])

  return (
    <div className="digest-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !running) onClose()
    }}>
      <section className="digest-dialog" role="dialog" aria-modal="true" aria-labelledby="digest-title">
        <header>
          <div>
            <small>AI 拆书</small>
            <h2 id="digest-title">{documentTitle || '把这本书拆成可学的结构'}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={running} aria-label="关闭"><X size={16} /></button>
        </header>

        <p className="digest-intro">
          <Sparkles size={14} />
          先逐块做笔记，再汇总成问题驱动的骨架，最后写成卡片挂到脑图上。
          超过 100 页也能跑：按块分析、可中断，下次接着来。
        </p>

        <div className="digest-modes" role="radiogroup" aria-label="拆书模式">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={mode === item.id}
              className={mode === item.id ? 'is-active' : ''}
              onClick={() => { setMode(item.id); resetAll() }}
              disabled={running}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>

        <div className="digest-depth">
          <label htmlFor="digest-depth-select">拆分层级</label>
          <select
            id="digest-depth-select"
            data-testid="digest-depth"
            value={depth}
            disabled={running}
            onChange={(event) => changeDepth(event.target.value)}
          >
            {DEPTH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} 层 · {option.label}{option.value === 2 ? '（默认）' : ''}
              </option>
            ))}
          </select>
          <span className="digest-depth-hint">{DEPTH_OPTIONS[depth - 1]?.hint}</span>
        </div>

        <div className="digest-range">
          <label>
            <span>起始页</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={startPage}
              disabled={running}
              onChange={(event) => setStartPage(Number(event.target.value) || 1)}
            />
          </label>
          <label>
            <span>结束页</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={endPage}
              disabled={running}
              onChange={(event) => setEndPage(Number(event.target.value) || pageCount)}
            />
          </label>
          <label>
            <span>每块页数</span>
            <input
              type="number"
              min={2}
              max={30}
              value={chunkSize}
              disabled={running}
              onChange={(event) => setChunkSize(Number(event.target.value) || 8)}
            />
          </label>
          <button
            type="button"
            className="digest-link"
            disabled={running}
            onClick={() => { setStartPage(1); setEndPage(pageCount) }}
          >
            全书
          </button>
          <button
            type="button"
            className="digest-link"
            disabled={running}
            onClick={() => {
              setStartPage(Math.max(1, currentPage - 4))
              setEndPage(Math.min(pageCount, currentPage + 4))
            }}
          >
            当前页附近
          </button>
        </div>

        <p className="digest-meta">
          共 {range.end - range.start + 1} 页 · {range.total} 块 · 目标 {depth} 层（1–5 层可选，会自动记住）· 模型未配置时无法运行
        </p>

        {progress.total > 0 && (
          <div className="digest-progress" role="status">
            <div className="digest-progress-bar">
              <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
            <span>{progress.done} / {progress.total} 块</span>
          </div>
        )}

        {running && (
          <p className="digest-running" role="status">
            <Loader2 size={14} className="digest-spin" />
            正在处理，模型可能需要几十秒…
          </p>
        )}
        {error && <p className="digest-error" role="alert">{error}</p>}
        {notice && <p className="digest-notice" role="status">{notice}</p>}

        {outline && (
          <div className="digest-outline">
            <div className="digest-outline-head">
              <BookOpen size={14} />
              <strong>{outline.title || '骨架预览'}</strong>
              <span>
                {outline.nodes.length} 个主题 · {countOutlineNodes(outline.nodes)} 节点 ·{' '}
                {outlineDepth(outline.nodes)} 层 / 目标 {outline.depth || depth} 层
              </span>
            </div>
            <div className="digest-outline-body">
              <OutlineTree nodes={outline.nodes} />
            </div>
          </div>
        )}

        <footer>
          <button type="button" onClick={() => void reset()} disabled={running}>清空重来</button>
          <span className="digest-spacer" />
          <button type="button" onClick={() => void runAnalysis()} disabled={running}>
            {progress.done > 0 ? '继续分析' : '开始分析'}
          </button>
          <button type="button" onClick={() => void runSynthesis()} disabled={running || progress.done === 0}>
            汇总骨架
          </button>
          <button type="button" className="is-primary" onClick={() => void apply()} disabled={running || !outline}>
            写入脑图
          </button>
        </footer>
      </section>
    </div>
  )
}
