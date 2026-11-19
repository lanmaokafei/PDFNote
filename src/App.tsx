import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  BookOpenCheck,
  Copy,
  FileText,
  LayoutGrid,
  Network,
  NotebookPen,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import './App.css'
import { ContextMenu } from './ui/ContextMenu'
import { useContextMenu } from './ui/contextMenuCore'
import type { BootstrapStatus, Document } from './domain/card'
import { listDocuments, restoreCard } from './services/pdfnote'
import { CARD_TRASHED_EVENT } from './features/card/trash'
import { redoLast, undoLast } from './features/undo/undoStack'
import { LibraryWorkspace } from './features/library/LibraryWorkspace'
import { StudyWorkspace } from './features/study/StudyWorkspace'
import { SettingsDialog } from './features/settings/SettingsDialog'

const MindmapWorkspace = lazy(() =>
  import('./features/mindmap/MindmapWorkspace').then((module) => ({ default: module.MindmapWorkspace })),
)
const ReviewWorkspace = lazy(() =>
  import('./features/review/ReviewWorkspace').then((module) => ({ default: module.ReviewWorkspace })),
)
const CloseReadingWorkspace = lazy(() =>
  import('./features/closereading/CloseReadingWorkspace').then((module) => ({ default: module.CloseReadingWorkspace })),
)
const BoardWorkspace = lazy(() =>
  import('./features/board/BoardWorkspace').then((module) => ({ default: module.BoardWorkspace })),
)
const NotebookWorkspace = lazy(() =>
  import('./features/notebook/NotebookWorkspace').then((module) => ({ default: module.NotebookWorkspace })),
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

type View = 'library' | 'board' | 'notebook' | 'mindmap' | 'review' | 'closereading' | 'backup'

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
  // 粗读精读里点页码不能跳回资料库工作区（那会连带把画布换成普通画布）。
  const [closeJump, setCloseJump] = useState<{ documentId: string; page: number; token: number } | null>(null)
  // 学习报告「开始复习这些卡」：把卡片集合交给复习工作区，进入时只看这一组。
  const [reviewCardIds, setReviewCardIds] = useState<string[] | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // 刚被移入回收站的卡片：用于底部「撤销」条与 ⌘Z。
  const [trashed, setTrashed] = useState<string[]>([])
  const [undoBusy, setUndoBusy] = useState(false)
  // 撤销/重做后的轻提示（「已撤销：大纲缩进」）。
  const [actionNotice, setActionNotice] = useState('')
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
      // 在粗读精读工作区里点页码：留在本工作区、保持专属画布，只换 PDF 的页。
      if (view === 'closereading') {
        setCloseJump({ ...detail, token: Date.now() })
        return
      }
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
  }, [activeDocument?.id, view])

  // goTo 每次渲染都是新函数，用 ref 拿最新版本，避免事件监听反复重绑。
  const goToRef = useRef(goTo)
  useEffect(() => {
    goToRef.current = goTo
  })
  // 删除卡片后弹「撤销」：删除是软删除，恢复即从回收站取回。
  useEffect(() => {
    const handler = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids ?? []
      if (ids.length === 0) return
      setTrashed(ids)
      window.setTimeout(() => setTrashed((current) => (current === ids ? [] : current)), 10000)
    }
    window.addEventListener(CARD_TRASHED_EVENT, handler)
    return () => window.removeEventListener(CARD_TRASHED_EVENT, handler)
  }, [])

  const showActionNotice = useCallback((text: string) => {
    setActionNotice(text)
    window.setTimeout(() => setActionNotice((current) => (current === text ? '' : current)), 2400)
  }, [])

  /** ⌘Z：优先撤销栈（大纲 / 笔迹），没有可撤销的就回退到「恢复刚删的卡片」。 */
  const runUndo = useCallback(async () => {
    if (undoBusy) return
    setUndoBusy(true)
    try {
      const label = await undoLast()
      if (label) {
        showActionNotice(`已撤销：${label}`)
        return
      }
      if (trashed.length > 0) {
        const ids = trashed
        setTrashed([])
        for (const id of ids) await restoreCard(id)
        await useCardStore.getState().loadCards()
        await refreshStatus()
        showActionNotice('已从回收站恢复')
        return
      }
      showActionNotice('没有可撤销的操作')
    } catch (reason) {
      showActionNotice(`撤销失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setUndoBusy(false)
    }
  }, [refreshStatus, showActionNotice, trashed, undoBusy])

  const runRedo = useCallback(async () => {
    if (undoBusy) return
    setUndoBusy(true)
    try {
      const label = await redoLast()
      showActionNotice(label ? `已重做：${label}` : '没有可重做的操作')
    } catch (reason) {
      showActionNotice(`重做失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setUndoBusy(false)
    }
  }, [showActionNotice, undoBusy])

  const undoTrash = useCallback(async () => {
    if (trashed.length === 0 || undoBusy) return
    setUndoBusy(true)
    const ids = trashed
    setTrashed([])
    try {
      for (const id of ids) await restoreCard(id)
      await useCardStore.getState().loadCards()
      await refreshStatus()
      window.dispatchEvent(new CustomEvent('pdfnote:cards-restored', { detail: { ids } }))
    } catch {
      // 卡片可能已被彻底删除或已恢复：静默失败，列表刷新会给出真实状态。
    } finally {
      setUndoBusy(false)
    }
  }, [trashed, undoBusy, refreshStatus])

  // 全局快捷键：⌘1–6 切视图、⌘K 聚焦搜索、? 看键位表。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.metaKey || event.ctrlKey) {
        if (event.altKey) return
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault()
          if (event.shiftKey) void runRedo()
          else void runUndo()
          return
        }
        if (event.shiftKey) return
        const views: View[] = ['library', 'mindmap', 'board', 'notebook', 'review', 'closereading']
        const index = Number(event.key)
        if (Number.isInteger(index) && index >= 1 && index <= views.length) {
          event.preventDefault()
          goToRef.current(views[index - 1])
          return
        }
        if (event.key.toLowerCase() === 'k') {
          event.preventDefault()
          window.dispatchEvent(new Event('pdfnote:focus-search'))
          return
        }
      }
      if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }
      if (event.key === 'Escape') setShortcutsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runRedo, runUndo])

  // 学习报告里点「开始复习这些卡」：切到复习视图并只看这一组到期卡片。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ cardIds?: string[] }>).detail
      if (!detail?.cardIds?.length) return
      setReviewCardIds(detail.cardIds)
      goToRef.current('review')
    }
    window.addEventListener('pdfnote:review-cards', handler)
    return () => window.removeEventListener('pdfnote:review-cards', handler)
  }, [])

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
      key: 'board' as const,
      icon: LayoutGrid,
      label: '卡片盒',
      hint: `${cardCount} 张卡片`,
      active: !documentOpen && view === 'board',
      onClick: () => goTo('board'),
    },
    {
      key: 'notebook' as const,
      icon: NotebookPen,
      label: '笔记本',
      hint: '无限纸张',
      active: !documentOpen && view === 'notebook',
      onClick: () => goTo('notebook'),
    },
    {
      key: 'review' as const,
      icon: Sparkles,
      label: '复习',
      hint: `${status?.card_count ?? cardCount} 张卡片`,
      active: !documentOpen && view === 'review',
      onClick: () => { setReviewCardIds(null); goTo('review') },
    },
    {
      key: 'closereading' as const,
      icon: BookOpenCheck,
      label: '粗读精读',
      hint: '建地图 → 挖重点',
      active: !documentOpen && view === 'closereading',
      onClick: () => goTo('closereading'),
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
          { id: 'board', label: '卡片盒', icon: LayoutGrid, checked: !documentOpen && view === 'board', onSelect: () => goTo('board') },
          { id: 'notebook', label: '笔记本', icon: NotebookPen, checked: !documentOpen && view === 'notebook', onSelect: () => goTo('notebook') },
          { id: 'mindmap', label: '知识脑图', icon: Network, checked: !documentOpen && view === 'mindmap', onSelect: () => goTo('mindmap') },
          { id: 'review', label: '复习', icon: Sparkles, checked: !documentOpen && view === 'review', onSelect: () => { setReviewCardIds(null); goTo('review') } },
          { id: 'closereading', label: '粗读精读', icon: BookOpenCheck, checked: !documentOpen && view === 'closereading', onSelect: () => goTo('closereading') },
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
            <div className={`app-view${view === 'library' ? ' is-library' : ''}${view === 'mindmap' || view === 'board' || view === 'notebook' || view === 'closereading' ? ' is-full' : ''}`}>
              {view === 'library' && (
                <LibraryWorkspace
                  onOpenDocument={(document) => { setFatalError(''); setActiveDocument(document) }}
                  onChanged={() => void refreshStatus()}
                  focusSearchToken={searchToken}
                />
              )}
              {view === 'notebook' && (
                <Suspense fallback={<ViewLoading label="正在打开笔记本…" />}>
                  <NotebookWorkspace />
                </Suspense>
              )}
              {view === 'board' && (
                <Suspense fallback={<ViewLoading label="正在整理卡片盒…" />}>
                  <BoardWorkspace
                    onOpenMindmap={() => goTo('mindmap')}
                    onCardsChanged={() => void refreshStatus()}
                  />
                </Suspense>
              )}
              {view === 'mindmap' && (
                <Suspense fallback={<ViewLoading label="正在加载脑图…" />}>
                  <MindmapWorkspace onCardsChanged={() => void refreshStatus()} />
                </Suspense>
              )}
              {view === 'review' && (
                <Suspense fallback={<ViewLoading label="正在加载复习队列…" />}>
                  <ReviewWorkspace
                    onCardsChanged={() => void refreshStatus()}
                    cardIds={reviewCardIds}
                    onClearFilter={() => setReviewCardIds(null)}
                  />
                </Suspense>
              )}
              {view === 'closereading' && (
                <Suspense fallback={<ViewLoading label="正在准备粗读精读…" />}>
                  <CloseReadingWorkspace
                    jumpTarget={closeJump}
                    onJumpHandled={() => setCloseJump(null)}
                    onCardsChanged={() => void refreshStatus()}
                  />
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
      {actionNotice && (
        <div className="app-undo-toast is-action" role="status" data-testid="action-toast">
          <span>{actionNotice}</span>
        </div>
      )}
      {trashed.length > 0 && (
        <div className="app-undo-toast" role="status" data-testid="undo-toast">
          <span>已移入回收站{trashed.length > 1 ? `（${trashed.length} 张）` : ''}</span>
          <button type="button" onClick={() => void undoTrash()} disabled={undoBusy}>
            {undoBusy ? '恢复中…' : '撤销'}
          </button>
          <button type="button" className="app-undo-close" aria-label="关闭提示" onClick={() => setTrashed([])}>×</button>
        </div>
      )}
      <ContextMenu state={menu} onClose={close} />
      {shortcutsOpen && (
        <div className="app-shortcuts-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShortcutsOpen(false)
        }}>
          <div className="app-shortcuts" role="dialog" aria-modal="true" aria-label="键盘快捷键" data-testid="shortcuts-modal">
            <h2>键盘快捷键</h2>
            <dl>
              <dt>⌘1 / ⌘2 / ⌘3</dt><dd>资料库 / 脑图 / 卡片盒</dd>
              <dt>⌘4 / ⌘5 / ⌘6</dt><dd>笔记本 / 复习 / 粗读精读</dd>
              <dt>⌘K</dt><dd>聚焦当前视图的搜索框</dd>
              <dt>⇧⌘F</dt><dd>在 PDF 里全书搜索（⌘F 仍是系统查找）</dd>
              <dt>? </dt><dd>显示或关闭这张键位表</dd>
              <dt>⌘Z</dt><dd>撤销：大纲改动 / 笔迹 / 删除卡片（删除会从回收站取回）</dd>
              <dt>⇧⌘Z</dt><dd>重做</dd>
              <dt>← / →</dt><dd>PDF 上一页 / 下一页</dd>
              <dt>空格</dt><dd>复习页揭示答案</dd>
              <dt>1 – 4</dt><dd>复习页评分：重来 / 困难 / 良好 / 简单</dd>
              <dt>Enter / Shift+Enter</dt><dd>脑图搜索：下一个 / 上一个命中</dd>
            </dl>
            <p>输入框聚焦时快捷键不生效，避免和打字冲突。</p>
            <button type="button" onClick={() => setShortcutsOpen(false)}>知道了</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
