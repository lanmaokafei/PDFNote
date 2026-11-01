import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  ArchiveRestore,
  ArrowLeft,
  BookOpen,
  CloudOff,
  Network,
  Plus,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import './App.css'
import type { BootstrapStatus, Document } from './domain/card'
import { LibraryWorkspace } from './features/library/LibraryWorkspace'

const PdfWorkspace = lazy(() =>
  import('./features/pdf/PdfWorkspace').then((module) => ({ default: module.PdfWorkspace })),
)
const MindmapWorkspace = lazy(() =>
  import('./features/mindmap/MindmapWorkspace').then((module) => ({ default: module.MindmapWorkspace })),
)
const ReviewWorkspace = lazy(() =>
  import('./features/review/ReviewWorkspace').then((module) => ({ default: module.ReviewWorkspace })),
)
const BackupWorkspace = lazy(() =>
  import('./features/backup/BackupWorkspace').then((module) => ({ default: module.BackupWorkspace })),
)

function ViewLoading({ label }: { label: string }) {
  return <div className="app-view-loading"><span /><strong>{label}</strong></div>
}
import {
  autoBackup,
  getBootstrapStatus,
  isTauriRuntime,
  updateDocumentMetadata,
} from './services/pdfnote'
import { useCardStore } from './store/cardStore'

type View = 'library' | 'mindmap' | 'review' | 'backup'

const navigation = [
  { id: 'library' as const, label: '文档', icon: BookOpen, hint: 'PDF 与卡片' },
  { id: 'mindmap' as const, label: '脑图', icon: Network, hint: '知识结构' },
  { id: 'review' as const, label: '复习', icon: Sparkles, hint: 'FSRS 调度' },
  { id: 'backup' as const, label: '备份', icon: ArchiveRestore, hint: '本地安全' },
]

const viewMeta: Record<View, { title: string; eyebrow: string }> = {
  library: { title: '本地资料库', eyebrow: 'LIBRARY' },
  mindmap: { title: '知识脑图', eyebrow: 'MINDMAP' },
  review: { title: '主动复习', eyebrow: 'FSRS REVIEW' },
  backup: { title: '数据安全', eyebrow: 'BACKUP' },
}

function App() {
  const [view, setView] = useState<View>('library')
  const [activeDocument, setActiveDocument] = useState<Document | null>(null)
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [fatalError, setFatalError] = useState('')
  const loadCards = useCardStore((state) => state.loadCards)
  const cardsById = useCardStore((state) => state.cardsById)
  const desktop = isTauriRuntime()

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getBootstrapStatus())
      await loadCards()
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [loadCards])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!desktop) return
    // 启动后在后台触发智能备份；数据未变化时后端立即跳过，不会反复复制大 PDF。
    const timer = window.setTimeout(() => {
      void autoBackup().catch(() => undefined)
    }, 60_000)
    const interval = window.setInterval(() => {
      void autoBackup().catch(() => undefined)
    }, 30 * 60_000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [desktop])

  function goTo(next: View) {
    setActiveDocument(null)
    setView(next)
  }

  async function handlePageCount(count: number) {
    if (!activeDocument || activeDocument.page_count === count) return
    try {
      await updateDocumentMetadata(activeDocument.id, activeDocument.title, count)
      setActiveDocument({ ...activeDocument, page_count: count })
    } catch (reason) {
      setFatalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const cardCount = Object.keys(cardsById).length
  return (
    <div className={`app-shell ${activeDocument ? 'is-immersive' : ''}`}>
      <aside className="app-sidebar">
        <button type="button" className="app-brand" onClick={() => goTo('library')} aria-label="返回资料库">
          <span className="app-brand-mark">P</span>
          <span className="app-brand-text"><strong>PDFNote</strong><small>LOCAL STUDY</small></span>
        </button>

        <nav className="app-nav" aria-label="主要模块">
          <p className="app-nav-label">学习空间</p>
          {navigation.slice(0, 3).map((item) => {
            const Icon = item.icon
            const active = !activeDocument && view === item.id
            return (
              <button
                type="button"
                key={item.id}
                className={`app-nav-item ${active ? 'is-active' : ''}`}
                onClick={() => goTo(item.id)}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={17} strokeWidth={1.7} />
                <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                {item.id === 'library' && <i>{status?.document_count ?? 0}</i>}
                {item.id === 'mindmap' && <i>{cardCount}</i>}
              </button>
            )
          })}
          <p className="app-nav-label is-secondary">数据与交付</p>
          <button
            type="button"
            className={`app-nav-item ${!activeDocument && view === 'backup' ? 'is-active' : ''}`}
            onClick={() => goTo('backup')}
          >
            <ArchiveRestore size={17} strokeWidth={1.7} />
            <span><strong>备份与恢复</strong><small>导出 · 校验 · 迁移</small></span>
          </button>
        </nav>

        <div className="app-sidebar-note">
          <ShieldCheck size={15} />
          <div><strong>完全本地</strong><small>无账号 · 无云端 · 离线可用</small></div>
        </div>
      </aside>

      <main className="app-main">
        {activeDocument ? (
          <div className="app-immersive">
            <header className="app-pdf-bar">
              <button type="button" className="app-back" onClick={() => { setActiveDocument(null); void refreshStatus() }}>
                <ArrowLeft size={15} /> 资料库
              </button>
              <div className="app-pdf-title">
                <small>PDF · {activeDocument.page_count || '—'} 页</small>
                <strong>{activeDocument.title}</strong>
              </div>
              <span className="app-pdf-badge"><CloudOff size={12} /> 本地副本</span>
            </header>
            <div className="app-pdf-canvas">
              <Suspense fallback={<ViewLoading label="正在加载 PDF 引擎…" />}>
                <PdfWorkspace
                  document={activeDocument}
                  onPageCount={(count) => void handlePageCount(count)}
                  onCardsChanged={() => void refreshStatus()}
                />
              </Suspense>
            </div>
          </div>
        ) : (
          <>
            <header className="app-topbar">
              <div className="app-breadcrumb">
                <span>PDFNote</span><b>/</b><strong>{viewMeta[view].title}</strong>
              </div>
              <div className="app-topbar-right">
                <span className={`app-runtime ${desktop ? 'is-online' : ''}`}>
                  <i /> {desktop ? 'SQLite 已连接' : '浏览器预览'}
                </span>
                <span className="app-schema">SCHEMA v{status?.schema_version ?? 1}</span>
              </div>
            </header>
            {fatalError && (
              <div className="app-fatal" role="alert">
                本地数据访问异常：{fatalError}
                <button type="button" onClick={() => { setFatalError(''); void refreshStatus() }}>重试</button>
              </div>
            )}
            <div className="app-view">
              {view === 'library' && (
                <LibraryWorkspace
                  onOpenDocument={(document) => { setFatalError(''); setActiveDocument(document) }}
                  onChanged={() => void refreshStatus()}
                />
              )}
              {view === 'mindmap' && (
                <Suspense fallback={<ViewLoading label="正在加载脑图…" />}>
                  <MindmapWorkspace onCardsChanged={() => void refreshStatus()} />
                </Suspense>
              )}
              {view === 'review' && (
                <Suspense fallback={<ViewLoading label="正在加载复习队列…" />}>
                  <ReviewWorkspace onCardsChanged={() => void refreshStatus()} />
                </Suspense>
              )}
              {view === 'backup' && (
                <Suspense fallback={<ViewLoading label="正在加载备份模块…" />}>
                  <BackupWorkspace onRestored={() => void refreshStatus()} />
                </Suspense>
              )}
            </div>
          </>
        )}
      </main>

      <nav className="app-mobile-nav" aria-label="移动端导航">
        {navigation.map((item) => {
          const Icon = item.icon
          const active = !activeDocument && view === item.id
          return (
            <button type="button" key={item.id} className={active ? 'is-active' : ''} onClick={() => goTo(item.id)}>
              <Icon size={18} /><span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      {!desktop && (
        <button type="button" className="app-floating-hint" onClick={() => goTo('library')}>
          <Plus size={14} /> 桌面模式下可导入 PDF
        </button>
      )}
    </div>
  )
}

export default App
