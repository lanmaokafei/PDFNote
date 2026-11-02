import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  BookOpen,
  FileText,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import './App.css'
import type { BootstrapStatus, Document } from './domain/card'
import { LibraryWorkspace } from './features/library/LibraryWorkspace'
import { StudyWorkspace } from './features/study/StudyWorkspace'

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

function App() {
  const [view, setView] = useState<View>('library')
  const [activeDocument, setActiveDocument] = useState<Document | null>(null)
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [fatalError, setFatalError] = useState('')
  const [showMindmap, setShowMindmap] = useState(true)
  const [searchToken, setSearchToken] = useState(0)
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

  function openSearch() {
    setActiveDocument(null)
    setView('library')
    setSearchToken((token) => token + 1)
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
  const documentOpen = activeDocument !== null
  const segments = [
    {
      key: 'library' as const,
      icon: BookOpen,
      label: '资料库',
      hint: `${status?.document_count ?? 0} 份文档`,
      active: !documentOpen && view === 'library',
      onClick: () => goTo('library'),
    },
    {
      key: 'review' as const,
      icon: Sparkles,
      label: '复习',
      hint: `${status?.card_count ?? cardCount} 张卡片`,
      active: !documentOpen && view === 'review',
      onClick: () => goTo('review'),
    },
    {
      key: 'document' as const,
      icon: FileText,
      label: activeDocument?.title ?? '未打开文档',
      hint: activeDocument ? `${activeDocument.page_count || '—'} 页 · 本地副本` : '从资料库选择 PDF',
      active: documentOpen,
      onClick: () => {
        if (activeDocument) {
          setShowMindmap(true)
        } else {
          goTo('library')
        }
      },
    },
    {
      key: 'mindmap' as const,
      icon: Network,
      label: '脑图',
      hint: documentOpen ? (showMindmap ? '已展开' : '已收起') : `${cardCount} 个节点`,
      active: documentOpen ? showMindmap : view === 'mindmap',
      onClick: () => {
        if (documentOpen) setShowMindmap((value) => !value)
        else goTo('mindmap')
      },
    },
  ]

  return (
    <div className="app-shell">
      <header className="app-top">
        <div className="app-segments" role="tablist" aria-label="工作区切换">
          {segments.map((segment) => {
            const Icon = segment.icon
            return (
              <button
                type="button"
                key={segment.key}
                role="tab"
                aria-selected={segment.active}
                className={`app-segment${segment.active ? ' is-active' : ''}${segment.key === 'document' ? ' is-document' : ''}`}
                onClick={segment.onClick}
                title={`${segment.label} · ${segment.hint}`}
              >
                <Icon size={17} strokeWidth={1.7} />
                <span>
                  <strong>{segment.label}</strong>
                  <small>{segment.hint}</small>
                </span>
              </button>
            )
          })}
          <span className="app-segment-divider" aria-hidden="true" />
          <button type="button" className="app-segment-action" onClick={openSearch} title="搜索文档" aria-label="搜索文档">
            <Search size={17} strokeWidth={1.8} />
          </button>
          <button type="button" className="app-segment-action" onClick={() => goTo('backup')} title="备份与恢复" aria-label="备份与恢复">
            <ShieldCheck size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <main className="app-main">
        {documentOpen ? (
          <StudyWorkspace
            document={activeDocument}
            showMindmap={showMindmap}
            onPageCount={(count) => void handlePageCount(count)}
            onCardsChanged={() => void refreshStatus()}
          />
        ) : (
          <>
            {fatalError && (
              <div className="app-fatal" role="alert">
                本地数据访问异常：{fatalError}
                <button type="button" onClick={() => { setFatalError(''); void refreshStatus() }}>重试</button>
              </div>
            )}
            <div className={`app-view${view === 'library' ? ' is-library' : ''}${view === 'mindmap' ? ' is-full' : ''}`}>
              {view === 'library' && (
                <LibraryWorkspace
                  onOpenDocument={(document) => { setFatalError(''); setActiveDocument(document) }}
                  onChanged={() => void refreshStatus()}
                  focusSearchToken={searchToken}
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
    </div>
  )
}

export default App
