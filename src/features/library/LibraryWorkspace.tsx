import { useCallback, useEffect, useRef, useState } from 'react'
import { pushUndo } from '../undo/undoStack'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Copy,
  Database,
  FileText,
  FolderOpen,
  HardDrive,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { BootstrapStatus, Document } from '../../domain/card'
import { ContextMenu } from '../../ui/ContextMenu'
import { SearchIndexDialog } from './SearchIndexDialog'
import { useContextMenu } from '../../ui/contextMenuCore'
import {
  deleteDocument,
  getBootstrapStatus,
  importDocument,
  listTrashedDocuments,
  purgeDocument,
  purgeExpiredDocumentTrash,
  renameDocument,
  restoreDocument,
  trashDocument,
  type TrashedDocument,
  isTauriRuntime,
  listDocuments,
  relocateDocument,
  verifyDocument,
} from '../../services/pdfnote'
import './LibraryWorkspace.css'

interface LibraryWorkspaceProps {
  onOpenDocument: (document: Document) => void
  onChanged: () => void
  /** 顶部搜索按钮递增该值即可让搜索框获得焦点。 */
  focusSearchToken?: number
}

type BusyState = { kind: 'import' | 'verify' | 'relocate' | 'delete' | 'rename'; id?: string } | null

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

const statusLabels: Record<Document['file_status'], string> = {
  ready: '文件正常',
  missing: '文件缺失',
  mismatch: '哈希不一致',
  importing: '导入中',
}

export function LibraryWorkspace({ onOpenDocument, onChanged, focusSearchToken = 0 }: LibraryWorkspaceProps) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyState>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [indexOpen, setIndexOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Document | null>(null)
  // 默认移入回收站；勾「保留卡片」才是永久解除文档（卡片留下）。
  const [keepCards, setKeepCards] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashed, setTrashed] = useState<TrashedDocument[]>([])
  const [trashBusy, setTrashBusy] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Document | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const { menu, show, close } = useContextMenu()
  const desktop = isTauriRuntime()
  const searchRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextDocuments, nextStatus] = await Promise.all([
        listDocuments(),
        getBootstrapStatus(),
      ])
      setDocuments(nextDocuments)
      setStatus(nextStatus)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ⌘K：从任何视图聚焦资料库搜索。
  useEffect(() => {
    const handler = () => {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('pdfnote:focus-search', handler)
    return () => window.removeEventListener('pdfnote:focus-search', handler)
  }, [])

  useEffect(() => {
    if (focusSearchToken > 0) searchRef.current?.focus()
  }, [focusSearchToken])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function handleImport() {
    if (!desktop) {
      setError('PDF 导入需要在桌面应用中运行')
      return
    }
    setError('')
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      })
      if (!selected || Array.isArray(selected)) return
      setBusy({ kind: 'import' })
      const document = await importDocument(selected)
      setNotice(`《${document.title}》已加入本地资料库`)
      await refresh()
      onChanged()
      onOpenDocument(document)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  async function handleOpen(document: Document) {
    setError('')
    setBusy({ kind: 'verify', id: document.id })
    try {
      const verified = await verifyDocument(document.id)
      if (verified.file_status !== 'ready') {
        setDocuments((items) =>
          items.map((item) => (item.id === verified.id ? verified : item)),
        )
        setError(
          verified.file_status === 'missing'
            ? 'PDF 文件已丢失，请重新定位后再打开。'
            : 'PDF 文件内容与导入时不一致，请重新定位正确文件。',
        )
        return
      }
      onOpenDocument(verified)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  async function handleRelocate(document: Document) {
    setError('')
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      })
      if (!selected || Array.isArray(selected)) return
      setBusy({ kind: 'relocate', id: document.id })
      const relocated = await relocateDocument(document.id, selected)
      setDocuments((items) =>
        items.map((item) => (item.id === relocated.id ? relocated : item)),
      )
      setNotice('文件已重新定位，内容哈希一致')
      onChanged()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  const loadTrash = useCallback(async () => {
    setTrashBusy(true)
    try {
      await purgeExpiredDocumentTrash(30).catch(() => 0)
      setTrashed(await listTrashedDocuments(200))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTrashBusy(false)
    }
  }, [])

  function openTrash() {
    setTrashOpen(true)
    void loadTrash()
  }

  async function handleRestore(document: Document) {
    setTrashBusy(true)
    try {
      await restoreDocument(document.id)
      await loadTrash()
      await refresh()
      onChanged()
      setNotice(`《${document.title}》已从回收站恢复`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTrashBusy(false)
    }
  }

  async function handlePurge(document: Document) {
    if (!window.confirm(`彻底删除《${document.title}》？卡片、标注与复习记录都会消失。`)) return
    setTrashBusy(true)
    try {
      await purgeDocument(document.id)
      await loadTrash()
      setNotice(`《${document.title}》已彻底删除`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTrashBusy(false)
    }
  }

  async function handleRename() {
    if (!renameTarget) return
    const title = renameDraft.trim()
    if (!title) {
      setError('书名不能为空')
      return
    }
    setBusy({ kind: 'rename', id: renameTarget.id })
    try {
      await renameDocument(renameTarget.id, title)
      setRenameTarget(null)
      setNotice(`已重命名为《${title}》`)
      await refresh()
      onChanged()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setBusy({ kind: 'delete', id: deleteTarget.id })
    const target = deleteTarget
    try {
      if (keepCards) {
        await deleteDocument(target.id, true)
        setNotice('文档已移出资料库，关联卡片与复习记录已保留')
      } else {
        await trashDocument(target.id)
        // 整本书进回收站也可以撤销：恢复文档即恢复它的全部卡片。
        pushUndo({
          label: `删除文档《${target.title}》`,
          undo: async () => {
            await restoreDocument(target.id)
            await refresh()
            onChanged()
          },
          redo: async () => {
            await trashDocument(target.id)
            await refresh()
            onChanged()
          },
        })
        setNotice(`《${target.title}》已移入回收站（⌘Z 可撤销）`)
      }
      setDeleteTarget(null)
      await refresh()
      onChanged()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(null)
    }
  }

  const filtered = documents.filter((document) =>
    document.title.toLowerCase().includes(query.trim().toLowerCase()),
  )

  function handleDocumentContextMenu(event: React.MouseEvent<HTMLElement>, document: Document) {
    const copyTitle = () => {
      if (navigator.clipboard) void navigator.clipboard.writeText(document.title).catch(() => undefined)
    }
    show(event, {
      title: document.title,
      sections: [
        { id: 'document', items: [
          { id: 'open', label: '打开文档', icon: FileText, disabled: busy !== null || !desktop, onSelect: () => void handleOpen(document) },
          { id: 'copy', label: '复制文档标题', icon: Copy, onSelect: copyTitle },
        ] },
        { id: 'file', title: '文件', items: [
          { id: 'relocate', label: '重新定位 PDF…', icon: FolderOpen, disabled: !desktop, onSelect: () => void handleRelocate(document) },
          { id: 'refresh', label: '刷新资料库', icon: RefreshCw, onSelect: () => void refresh() },
          { id: 'import', label: '导入新 PDF…', icon: Plus, disabled: !desktop, onSelect: () => void handleImport() },
        ] },
        { id: 'danger', items: [
          { id: 'rename', label: '重命名…', icon: Pencil, disabled: busy !== null || !desktop, onSelect: () => { setRenameTarget(document); setRenameDraft(document.title) } },
          { id: 'delete', label: '删除文档…', icon: Trash2, danger: true, onSelect: () => { setKeepCards(false); setDeleteTarget(document) } },
        ] },
      ],
    })
  }

  return (
    <section className="library">
      <header className="library-heading">
        <div>
          <p className="library-eyebrow">LOCAL LIBRARY</p>
          <h1>本地资料库</h1>
          <p>所有 PDF 副本、标注与卡片只保存在这台设备。导入后即可离线阅读与复习。</p>
        </div>
        <button
          type="button"
          className="library-primary"
          onClick={() => void handleImport()}
          disabled={busy?.kind === 'import' || !desktop}
        >
          <Plus size={17} />
          {busy?.kind === 'import' ? '正在导入…' : '导入 PDF'}
        </button>
      </header>

      {!desktop && (
        <div className="library-banner is-info">
          当前为浏览器预览。PDF 导入、SQLite 与备份需要运行 <code>npm run tauri dev</code>。
        </div>
      )}
      {error && (
        <div className="library-banner is-error" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {notice && <div className="library-banner is-success">{notice}</div>}

      <div className="library-stats">
        <div><FileText size={16} /><span>文档</span><strong>{status?.document_count ?? documents.length}</strong></div>
        <div><HardDrive size={16} /><span>知识卡片</span><strong>{status?.card_count ?? '—'}</strong></div>
        <div><ShieldCheck size={16} /><span>存储</span><strong className="library-stat-word">本地 SQLite</strong></div>
        <div><FolderOpen size={16} /><span>已用空间</span><strong>{formatBytes(documents.reduce((total, item) => total + item.file_size, 0))}</strong></div>
      </div>

      <div className="library-toolbar">
        <label className="library-search">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文档标题"
            aria-label="搜索文档标题"
          />
        </label>
        <button type="button" className="library-quiet" onClick={() => setIndexOpen(true)} data-testid="search-index-open">
          <Database size={14} /> 搜索索引
        </button>
        <button type="button" className="library-quiet" onClick={openTrash} data-testid="library-trash">
          <Trash2 size={14} /> 回收站
        </button>
        <button type="button" className="library-quiet" onClick={() => void refresh()}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {loading ? (
        <div className="library-empty">正在读取本地资料库…</div>
      ) : filtered.length === 0 ? (
        <div className="library-empty library-empty-rich">
          <div className="library-empty-mark"><FileText size={30} /></div>
          <h2>{documents.length ? '没有匹配的文档' : '从第一份 PDF 开始'}</h2>
          <p>{documents.length ? '尝试换一个关键词。' : '导入 PDF 后，框选文字区域即可生成卡片，同时进入脑图与复习。'}</p>
          {!documents.length && (
            <button type="button" className="library-primary" onClick={() => void handleImport()} disabled={!desktop}>
              <Plus size={16} /> 导入第一份 PDF
            </button>
          )}
        </div>
      ) : (
        <div className="library-grid">
          {filtered.map((document, index) => (
            <article className="document-card" key={document.id} onContextMenu={(event) => handleDocumentContextMenu(event, document)}>
              <button
                type="button"
                className="document-cover"
                onClick={() => void handleOpen(document)}
                disabled={busy?.kind === 'verify' && busy.id === document.id}
                aria-label={`打开 ${document.title}`}
              >
                <span className="document-cover-spine" />
                <span className="document-cover-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="document-cover-title">{document.title}</span>
                <span className="document-cover-lines"><i /><i /><i /></span>
                <span className={`document-file-status is-${document.file_status}`}>
                  {statusLabels[document.file_status]}
                </span>
                {busy?.kind === 'verify' && busy.id === document.id && (
                  <span className="document-cover-loading">校验文件…</span>
                )}
              </button>
              <div className="document-info">
                <div>
                  <h3 title={document.title}>{document.title}</h3>
                  <p>
                    {document.page_count ? `${document.page_count} 页` : '页数待读取'} · {formatBytes(document.file_size)}
                    {document.last_page > 1 ? ` · 读到第 ${document.last_page} 页` : ''}
                  </p>
                </div>
                <div className="document-actions">
                  {document.file_status !== 'ready' && (
                    <button
                      type="button"
                      onClick={() => void handleRelocate(document)}
                      disabled={busy?.kind === 'relocate' && busy.id === document.id}
                      title="重新定位 PDF"
                    >
                      <FolderOpen size={15} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => {
                      setKeepCards(false)
                      setDeleteTarget(document)
                    }}
                    title="删除文档"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <footer>更新于 {formatDate(document.updated_at)}</footer>
            </article>
          ))}
        </div>
      )}

      {indexOpen && <SearchIndexDialog onClose={() => setIndexOpen(false)} />}

      {trashOpen && (
        <div className="library-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !trashBusy) setTrashOpen(false)
        }}>
          <div className="library-modal library-trash-modal" role="dialog" aria-modal="true" aria-labelledby="doc-trash-title" data-testid="library-trash-modal">
            <small>TRASH</small>
            <h2 id="doc-trash-title">文档回收站</h2>
            <p>删除的文档保留 30 天，PDF 副本与卡片都在这段时间内可恢复；彻底删除不可撤销。</p>
            {trashBusy && <p className="library-trash-empty">正在读取回收站…</p>}
            {!trashBusy && trashed.length === 0 && (
              <p className="library-trash-empty" data-testid="library-trash-empty">回收站是空的。</p>
            )}
            {!trashBusy && trashed.length > 0 && (
              <ul className="library-trash-list" data-testid="library-trash-list">
                {trashed.map((item) => (
                  <li key={item.document.id}>
                    <div className="library-trash-text">
                      <strong>{item.document.title}</strong>
                      <span>
                        删除于 {new Date(item.deletedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {item.document.page_count ? ` · ${item.document.page_count} 页` : ''}
                      </span>
                    </div>
                    <div className="library-trash-actions">
                      <button type="button" data-testid="library-trash-restore" onClick={() => void handleRestore(item.document)} disabled={trashBusy}>
                        恢复
                      </button>
                      <button type="button" className="is-danger" data-testid="library-trash-purge" onClick={() => void handlePurge(item.document)} disabled={trashBusy}>
                        彻底删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="library-modal-actions">
              <button type="button" onClick={() => setTrashOpen(false)} disabled={trashBusy}>关闭</button>
            </div>
          </div>
        </div>
      )}

      <ContextMenu state={menu} onClose={close} />

      {renameTarget && (
        <div className="library-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && busy?.kind !== 'rename') setRenameTarget(null)
        }}>
          <div className="library-modal" role="dialog" aria-modal="true" aria-labelledby="rename-title" data-testid="library-rename-modal">
            <small>RENAME</small>
            <h2 id="rename-title">重命名文档</h2>
            <p>只改书名，页数、阅读进度与卡片都不受影响。</p>
            <input
              className="library-rename-input"
              data-testid="library-rename-input"
              value={renameDraft}
              maxLength={120}
              autoFocus
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleRename()
                }
                if (event.key === 'Escape') setRenameTarget(null)
              }}
            />
            <div className="library-modal-actions">
              <button type="button" onClick={() => setRenameTarget(null)} disabled={busy?.kind === 'rename'}>取消</button>
              <button type="button" className="library-primary" data-testid="library-rename-save" onClick={() => void handleRename()} disabled={busy?.kind === 'rename'}>
                {busy?.kind === 'rename' ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="library-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && busy?.kind !== 'delete') setDeleteTarget(null)
        }}>
          <div className="library-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <small>移除文档</small>
            <h2 id="delete-title">{deleteTarget.title}</h2>
            <p>默认移入回收站，PDF 副本与卡片都会保留；彻底删除请到回收站里操作。</p>
            <label className={`library-option ${!keepCards ? 'is-selected' : ''}`}>
              <input type="radio" checked={!keepCards} onChange={() => setKeepCards(false)} />
              <div>
                <strong>移入回收站（推荐）</strong>
                <span>文档与卡片从列表消失，保留 30 天，可随时恢复；⌘Z 也能撤销。</span>
              </div>
            </label>
            <label className={`library-option ${keepCards ? 'is-selected' : ''}`}>
              <input type="radio" checked={keepCards} onChange={() => setKeepCards(true)} />
              <div>
                <strong>仅移出资料库，保留卡片</strong>
                <span>PDF 副本会立即删除、有卡片解除来源关联但继续留在脑图与复习里；文档本身不可恢复。</span>
              </div>
            </label>
            <div className="library-modal-actions">
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={busy?.kind === 'delete'}>取消</button>
              <button type="button" className="is-danger" onClick={() => void handleDelete()} disabled={busy?.kind === 'delete'}>
                {busy?.kind === 'delete' ? '处理中…' : keepCards ? '确认移出' : '移入回收站'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
