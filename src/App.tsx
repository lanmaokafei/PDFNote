import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  BookOpen,
  Copy,
  FileText,
  Network,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import './App.css'
import { ContextMenu } from './ui/ContextMenu'
import { useContextMenu } from './ui/contextMenuCore'
import type { BootstrapStatus, Document } from './domain/card'
import { listDocuments } from './services/pdfnote'
import { LibraryWorkspace } from './features/library/LibraryWorkspace'
import { StudyWorkspace } from './features/study/StudyWorkspace'
import { SettingsDialog } from './features/settings/SettingsDialog'

const MindmapWorkspace = lazy(() =>
  import('./features/mindmap/MindmapWorkspace').then((module) => ({ default: module.MindmapWorkspace })),
)
const ReviewWorkspace = lazy(() =>
  import('./features/review/ReviewWorkspace').then((module) => ({ default: module.ReviewWorkspace })),
)
const BackupWorkspace = lazy(() =>
  import('./features/backup/BackupWorkspace').then((module) => ({ default: module.BackupWorkspace })),
)
const UpdatePrompt = lazy(() =>
  import('./features/update/UpdatePrompt').then((module) => ({ default: module.UpdatePrompt })),
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
import { autoCheckUpdate } from './services/update'
import type { UpdateInfo } from './services/update'
import { useCardStore } from './store/cardStore'

type View = 'library' | 'mindmap' | 'review' | 'backup'

function App() {
  const [view, setView] = useState<View>('library')
  const [activeDocument, setActiveDocument] = useState<Document | null>(null)
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [fatalError, setFatalError] = useState('')
  const [showMindmap, setShowMindmap] = useState(true)
  const [searchToken, setSearchToken] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false)
  const [updatePromptInfo, setUpdatePromptInfo] = useState<UpdateInfo | null>(null)
  const [jumpTarget, setJumpTarget] = useState<{ documentId: string; page: number; token: number } | null>(null)
  const { menu, show, close } = useContextMenu()
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

  // 脑图卡片点击页码：切到对应文档并跳到该页。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string; page: number }>).detail
      if (!detail?.documentId || !detail.page) return
      void (async () => {
        if (activeDocument?.id !== detail.documentId) {
          try {
            const documents = await listDocuments()
            const target = documents.find((item) => item.id === detail.documentId)
            if (!target) return
            setActiveDocument(target)
          } catch {
            return
          }
        }
        setJumpTarget({ ...detail, token: Date.now() })
      })()
    }
    window.addEventListener('pdfnote:open-source', handler)
    return () => window.removeEventListener('pdfnote:open-source', handler)
  }, [activeDocument?.id])

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

  useEffect(() => {
    if (!desktop) return
    // 启动约 8 秒后后台检查 GitHub Releases；有新版且用户没点过「稍后」才弹升级提示。
    let cancelled = false
    const timer = window.setTimeout(() => {
      void autoCheckUpdate().then((info) => {
        if (!info || cancelled) return
        setUpdatePromptInfo(info)
        setUpdatePromptOpen(true)
      })
    }, 8_000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
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

  /** 没有元素菜单的区域也提供一层通用菜单，替代 WebView 自带的 Reload。 */
  function handleShellContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const selected = window.getSelection()?.toString().trim() ?? ''
    const copyText = (text: string) => {
      if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined)
    }
    show(event, {
      title: 'PDFNote',
      sections: [
        { id: 'clipboard', items: [
          {
            id: 'copy-selection',
            label: '复制选中文字',
            icon: Copy,
            disabled: !selected,
            hint: selected ? `${selected.length} 字` : undefined,
            onSelect: () => copyText(selected),
          },
        ] },
        { id: 'navigate', title: '切换工作区', items: [
          { id: 'library', label: '资料库', icon: BookOpen, checked: !documentOpen && view === 'library', onSelect: () => goTo('library') },
          { id: 'mindmap', label: '知识脑图', icon: Network, checked: !documentOpen && view === 'mindmap', onSelect: () => goTo('mindmap') },
          { id: 'review', label: '复习', icon: Sparkles, checked: !documentOpen && view === 'review', onSelect: () => goTo('review') },
          { id: 'backup', label: '备份与恢复', icon: ShieldCheck, checked: !documentOpen && view === 'backup', onSelect: () => goTo('backup') },
        ] },
      ],
    })
  }

  return (
    <div className="app-shell" onContextMenu={handleShellContextMenu}>
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
          <button type="button" className="app-segment-action" onClick={() => setSettingsOpen(true)} title="设置：可选的 AI 识别模型" aria-label="设置">
            <Settings size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <main className="app-main">
        {documentOpen ? (
          <StudyWorkspace
            document={activeDocument}
            showMindmap={showMindmap}
            jumpTarget={jumpTarget}
            onJumpHandled={() => setJumpTarget(null)}
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
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onCheckUpdate={() => {
            // 手动检查：不带缓存信息，对话框挂载后自行检查。
            setUpdatePromptInfo(null)
            setUpdatePromptOpen(true)
          }}
        />
      )}
      {updatePromptOpen && (
        <Suspense fallback={null}>
          <UpdatePrompt
            initialInfo={updatePromptInfo}
            onClose={() => setUpdatePromptOpen(false)}
          />
        </Suspense>
      )}
      <ContextMenu state={menu} onClose={close} />
    </div>
  )
}

export default App
