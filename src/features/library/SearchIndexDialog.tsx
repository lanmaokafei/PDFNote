import { useEffect, useRef, useState } from 'react'
import { Database, X } from 'lucide-react'
import { listDocuments, listNotebooks, pageIndexStats, type PageIndexStats } from '../../services/pdfnote'
import type { Document, Notebook } from '../../domain/card'
import { buildLibraryIndex, type LibraryIndexProgress, type LibraryIndexSummary } from './libraryIndex'
import { indexNotebooks, type NotebookIndexProgress, type NotebookIndexSummary } from '../notebook/notebookIndex'
import './SearchIndexDialog.css'

interface SearchIndexDialogProps {
  onClose: () => void
}

/**
 * 全库搜索索引：先把每本文档的文本层抽一遍，可选把扫描页也 OCR 掉。
 * OCR 是逐页跑 Apple Vision，速度按页算，所以给了进度、取消和「只做文本层」的开关。
 */
export function SearchIndexDialog({ onClose }: SearchIndexDialogProps) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [stats, setStats] = useState<PageIndexStats | null>(null)
  const [withOcr, setWithOcr] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<LibraryIndexProgress | null>(null)
  const [summary, setSummary] = useState<LibraryIndexSummary | null>(null)
  const [notebookSummary, setNotebookSummary] = useState<NotebookIndexSummary | null>(null)
  const [notebookProgress, setNotebookProgress] = useState<NotebookIndexProgress | null>(null)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [list, current, books] = await Promise.all([listDocuments(), pageIndexStats(), listNotebooks()])
        setDocuments(list)
        setStats(current)
        setNotebooks(books)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => controllerRef.current?.abort()
  }, [])

  async function start() {
    if (running) return
    const controller = new AbortController()
    controllerRef.current = controller
    setRunning(true)
    setSummary(null)
    setNotebookSummary(null)
    setNotebookProgress(null)
    setError('')
    try {
      const result = await buildLibraryIndex(documents, {
        ocr: withOcr,
        signal: controller.signal,
        onProgress: setProgress,
      })
      setSummary(result)
      // 手写本只有 OCR 才能索引：笔迹本身没有文字。
      if (withOcr && !result.cancelled && notebooks.length > 0) {
        const bookResult = await indexNotebooks(notebooks, {
          signal: controller.signal,
          onProgress: setNotebookProgress,
        })
        setNotebookSummary(bookResult)
      }
      setStats(await pageIndexStats())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRunning(false)
      controllerRef.current = null
    }
  }

  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0

  return (
    <div className="index-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !running) onClose()
    }}>
      <section className="index-dialog" role="dialog" aria-modal="true" aria-label="搜索索引" data-testid="search-index-dialog">
        <header>
          <div>
            <small>SEARCH INDEX</small>
            <h2><Database size={17} strokeWidth={1.8} /> 全库搜索索引</h2>
          </div>
          <button type="button" onClick={() => { controllerRef.current?.abort(); onClose() }} aria-label="关闭" data-testid="search-index-close">
            <X size={15} />
          </button>
        </header>

        <p className="index-intro">
          跨库搜索的「页面」结果来自每页正文。文档首次打开时会自动抽文本层；这里可以一次把整库补全，
          勾选 OCR 后还会识别没有文本的扫描页（逐页运行 Apple Vision，速度较慢）。
        </p>

        <div className="index-stats">
          <div><span>已索引文档</span><strong>{stats ? stats.documents : '—'}</strong></div>
          <div><span>已索引页</span><strong>{stats ? stats.pages : '—'}</strong></div>
          <div><span>其中 OCR</span><strong>{stats ? stats.ocrPages : '—'}</strong></div>
          <div><span>手写本 / 页</span><strong>{stats ? `${stats.notebooks} / ${stats.notebookPages}` : '—'}</strong></div>
          <div><span>可建索引</span><strong>{documents.filter((doc) => doc.file_status === 'ready').length + notebooks.length}</strong></div>
        </div>

        <label className="index-option">
          <input
            type="checkbox"
            checked={withOcr}
            disabled={running}
            data-testid="search-index-ocr"
            onChange={(event) => setWithOcr(event.target.checked)}
          />
          <span>识别扫描页（OCR）</span>
          <small>关闭后只抽文本层，几百页只需几秒；扫描版教材需要打开。</small>
        </label>

        {progress && (
          <div className="index-progress" data-testid="search-index-progress">
            <div className="index-progress-head">
              <span>{progress.title}</span>
              <span>{progress.documentIndex + 1} / {progress.documentTotal} 本</span>
            </div>
            <div className="index-progress-bar"><i style={{ width: `${percent}%` }} /></div>
            <small>
              本本进度 {progress.done} / {progress.total} 页
              {progress.phase === 'ocr' ? '（含 OCR）' : ''}
            </small>
          </div>
        )}

        {notebookProgress && !notebookSummary && (
          <div className="index-progress" data-testid="notebook-index-progress">
            <div className="index-progress-head">
              <span>手写本 · {notebookProgress.title}</span>
              <span>{notebookProgress.notebookIndex + 1} / {notebookProgress.notebookTotal} 本</span>
            </div>
            <div className="index-progress-bar">
              <i style={{ width: `${notebookProgress.total ? Math.round((notebookProgress.done / notebookProgress.total) * 100) : 0}%` }} />
            </div>
            <small>本本进度 {notebookProgress.done} / {notebookProgress.total} 页</small>
          </div>
        )}

        {summary && (
          <div className="index-summary" data-testid="search-index-summary">
            <strong>{summary.cancelled ? '已取消' : '索引完成'}</strong>
            <p>
              补了 {summary.documents} 本文档：文本层 {summary.textPages} 页、OCR {summary.ocrPages} 页
              {summary.skipped > 0 ? `、跳过 ${summary.skipped} 页` : ''}。
            </p>
            {notebookSummary && (
              <p>
                手写本 {notebookSummary.notebooks} 本：识别 {notebookSummary.pages} 页
                {notebookSummary.skipped > 0 ? `、跳过 ${notebookSummary.skipped} 页` : ''}。
              </p>
            )}
            {(summary.failed.length > 0 || (notebookSummary?.failed.length ?? 0) > 0) && (
              <ul>
                {[...summary.failed, ...(notebookSummary?.failed ?? [])].slice(0, 4).map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </div>
        )}

        {error && <p className="index-error" role="alert">{error}</p>}

        <footer>
          <span className="index-foot-hint">索引是可重建的派生数据，恢复备份后会重新建立。</span>
          {running ? (
            <button type="button" onClick={() => controllerRef.current?.abort()} data-testid="search-index-cancel">
              取消
            </button>
          ) : (
            <button type="button" className="is-primary" onClick={() => void start()} data-testid="search-index-start">
              {running ? '正在建立…' : '开始建立'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
