import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Eraser,
  Eye,
  EyeOff,
  Layers,
  Lock,
  LockOpen,
  NotebookPen,
  PenLine,
  Plus,
  Trash2,
} from 'lucide-react'
import type {
  CreateNotebookInkInput,
  Layer,
  Notebook,
  NotebookInk,
  NormalizedBBox,
  PaperStyle,
} from '../../domain/card'
import {
  createLayer,
  createNotebook,
  createNotebookInk,
  deleteLayer,
  deleteNotebook,
  deleteNotebookInk,
  isTauriRuntime,
  listLayers,
  listNotebookInks,
  listNotebooks,
  updateLayer,
  updateNotebook,
} from '../../services/pdfnote'
import { findInkHits, type InkHitCandidate } from '../pdf/inkErase'
import { SizeControl } from '../ink/SizeControl'
import { readSizePreference, saveSizePreference } from '../ink/size'
import './NotebookWorkspace.css'

/** 固定虚拟画布：墨迹坐标按 0–1 存，渲染时换算到这套尺寸，换窗口大小不会变形。 */
const PAGE_W = 1000
const PAGE_H = 1414
const INITIAL_PAGES = 4
const MAX_PAGES = 60

const PAPER_OPTIONS: Array<{ value: PaperStyle; label: string }> = [
  { value: 'lined', label: '横线' },
  { value: 'grid', label: '网格' },
  { value: 'dot', label: '点阵' },
  { value: 'blank', label: '空白' },
]

const INK_COLORS = ['#2f3330', '#d94f3d', '#2f6f8f', '#3f7a4c', '#8a5cab']
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
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

export function NotebookWorkspace() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [active, setActive] = useState<Notebook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [paper, setPaper] = useState<PaperStyle>('lined')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmNotebookDelete, setConfirmNotebookDelete] = useState<string | null>(null)

  const desktop = isTauriRuntime()

  const refresh = useCallback(async () => {
    if (!desktop) {
      setLoading(false)
      setError('笔记本需要在桌面应用中运行')
      return
    }
    try {
      setNotebooks(await listNotebooks())
      setError('')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [desktop])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function submitCreate() {
    const value = title.trim()
    if (!value) {
      setError('给笔记本起个名字')
      return
    }
    try {
      const created = await createNotebook(value, paper)
      setNotebooks((current) => [created, ...current])
      setCreating(false)
      setTitle('')
      setActive(created)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function submitRename(notebook: Notebook) {
    const value = renameDraft.trim()
    setRenaming(null)
    if (!value || value === notebook.title) return
    try {
      const updated = await updateNotebook(notebook.id, value, notebook.paper)
      setNotebooks((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      if (active?.id === updated.id) setActive(updated)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function removeNotebook(notebook: Notebook) {
    try {
      await deleteNotebook(notebook.id)
      setNotebooks((current) => current.filter((item) => item.id !== notebook.id))
      if (active?.id === notebook.id) setActive(null)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  if (active) {
    return (
      <NotebookEditor
        notebook={active}
        onBack={() => { setActive(null); void refresh() }}
        onNotebookUpdated={(updated) => {
          setActive(updated)
          setNotebooks((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        }}
      />
    )
  }

  return (
    <div className="notebook-shelf">
      <header className="notebook-heading">
        <div>
          <p className="notebook-eyebrow">NOTEBOOKS</p>
          <h1>书写笔记本</h1>
          <p>独立于任何书页的无限纸张。多种纸样、多图层演草，反复研读、多轮刷题都写在同一本里。</p>
        </div>
        <button type="button" className="notebook-primary" onClick={() => setCreating(true)}>
          <Plus size={16} strokeWidth={1.9} />
          新建笔记本
        </button>
      </header>

      {error && <p className="notebook-banner is-error" role="alert">{error}</p>}
      {!desktop && <p className="notebook-banner">浏览器预览无法保存墨迹，请在桌面应用中使用。</p>}

      {creating && (
        <div className="notebook-create">
          <label>
            <span>书名</span>
            <input
              autoFocus
              value={title}
              placeholder="例如：内科学刷题本"
              data-testid="notebook-title"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitCreate()
                if (event.key === 'Escape') setCreating(false)
              }}
            />
          </label>
          <label>
            <span>纸样</span>
            <select value={paper} onChange={(event) => setPaper(event.target.value as PaperStyle)}>
              {PAPER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="notebook-create-actions">
            <button type="button" onClick={() => setCreating(false)}>取消</button>
            <button type="button" className="is-primary" data-testid="notebook-create" onClick={() => void submitCreate()}>
              创建并打开
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="notebook-loading"><span /><strong>正在打开笔记本…</strong></div>
      ) : notebooks.length === 0 ? (
        <div className="notebook-empty">
          <NotebookPen size={30} strokeWidth={1.4} />
          <h2>还没有笔记本</h2>
          <p>新建一本，选好纸样就能直接落笔。每本默认带一个「图层 1」，可以继续加图层分轮演草。</p>
        </div>
      ) : (
        <div className="notebook-grid">
          {notebooks.map((notebook) => (
            <article key={notebook.id} className="notebook-card" data-notebook-id={notebook.id}>
              <button type="button" className="notebook-cover" onClick={() => setActive(notebook)}>
                <span className={`notebook-cover-paper is-${notebook.paper}`} aria-hidden="true" />
                <strong>{notebook.title}</strong>
                <small>
                  {PAPER_OPTIONS.find((option) => option.value === notebook.paper)?.label ?? notebook.paper}
                  {' · '}
                  {formatDate(notebook.updated_at)}
                </small>
              </button>
              <div className="notebook-actions">
                {renaming === notebook.id ? (
                  <input
                    autoFocus
                    className="notebook-rename"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={() => void submitRename(notebook)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitRename(notebook)
                      if (event.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => { setRenaming(notebook.id); setRenameDraft(notebook.title) }}
                  >
                    重命名
                  </button>
                )}
                {confirmNotebookDelete === notebook.id ? (
                  <>
                    <span className="notebook-confirm-text">删除整本（含全部墨迹）？</span>
                    <button
                      type="button"
                      className="is-danger"
                      data-testid="notebook-delete-confirm"
                      onClick={() => void removeNotebook(notebook)}
                    >
                      确认删除
                    </button>
                    <button type="button" onClick={() => setConfirmNotebookDelete(null)}>取消</button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => setConfirmNotebookDelete(notebook.id)}
                  >
                    删除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

interface NotebookEditorProps {
  notebook: Notebook
  onBack: () => void
  onNotebookUpdated: (notebook: Notebook) => void
}

function NotebookEditor({ notebook, onBack, onNotebookUpdated }: NotebookEditorProps) {
  const [layers, setLayers] = useState<Layer[]>([])
  const [inks, setInks] = useState<NotebookInk[]>([])
  const [activeLayerId, setActiveLayerId] = useState('')
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [color, setColor] = useState(INK_COLORS[0])
  const [width, setWidth] = useState(() => readSizePreference('pen'))
  const [eraserSize, setEraserSize] = useState(() => readSizePreference('eraser'))

  const changeWidth = (value: number) => {
    setWidth(value)
    saveSizePreference('pen', value)
  }
  const changeEraserSize = (value: number) => {
    setEraserSize(value)
    saveSizePreference('eraser', value)
  }
  const [pages, setPages] = useState(INITIAL_PAGES)
  const [layersOpen, setLayersOpen] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null)
  const [layerDraft, setLayerDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const activeLayer = layers.find((layer) => layer.id === activeLayerId) ?? null
  const visibleLayerIds = useMemo(
    () => new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id)),
    [layers],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [nextLayers, nextInks] = await Promise.all([
          listLayers('notebook', notebook.id),
          listNotebookInks(notebook.id),
        ])
        if (cancelled) return
        setLayers(nextLayers)
        setActiveLayerId((current) => current || nextLayers[0]?.id || '')
        setInks(nextInks)
        const maxPage = nextInks.reduce((max, ink) => Math.max(max, ink.page), 0)
        setPages(Math.min(MAX_PAGES, Math.max(INITIAL_PAGES, maxPage + 2)))
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [notebook.id])

  // 滚动到接近底部时再加两页：表现上就是「用不完的纸」，但 DOM 不会无限增长。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || pages >= MAX_PAGES) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setPages((current) => Math.min(MAX_PAGES, current + 2))
      }
    }, { rootMargin: '400px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [pages])

  async function changePaper(next: PaperStyle) {
    try {
      const updated = await updateNotebook(notebook.id, notebook.title, next)
      onNotebookUpdated(updated)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function addLayer() {
    try {
      const created = await createLayer('notebook', notebook.id)
      setLayers((current) => [...current, created])
      setActiveLayerId(created.id)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function patchLayer(layer: Layer, changes: { name?: string; visible?: boolean; locked?: boolean }) {
    try {
      const updated = await updateLayer(layer.id, changes)
      setLayers((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  async function removeLayer(layer: Layer) {
    try {
      await deleteLayer(layer.id)
      setLayers((current) => current.filter((item) => item.id !== layer.id))
      setInks((current) => current.filter((ink) => ink.layer_id !== layer.id))
      if (activeLayerId === layer.id) {
        const next = layers.find((item) => item.id !== layer.id)
        setActiveLayerId(next?.id ?? '')
      }      setConfirmDelete(null)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const saveStroke = useCallback(async (
    page: number,
    bbox: NormalizedBBox,
    style: { color: string; width: number; points: Array<[number, number]> },
  ) => {
    if (!activeLayerId) return
    const input: CreateNotebookInkInput = {
      notebook_id: notebook.id,
      page,
      layer_id: activeLayerId,
      bbox,
      style,
    }
    try {
      const created = await createNotebookInk(input)
      setInks((current) => [...current, created])
    } catch (reason) {
      setError(`墨迹保存失败：${errorMessage(reason)}`)
    }
  }, [activeLayerId, notebook.id])

  const eraseStrokes = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    const unique = [...new Set(ids)]
    try {
      // 串行删除：一次擦掉几十笔时，并发 invoke 只会互相等 SQLite 锁。
      for (const id of unique) await deleteNotebookInk(id)
      const removed = new Set(unique)
      setInks((current) => current.filter((ink) => !removed.has(ink.id)))
    } catch (reason) {
      setError(`擦除失败：${errorMessage(reason)}`)
    }
  }, [])

  const canDraw = Boolean(activeLayer && activeLayer.visible && !activeLayer.locked)

  return (
    <div className="notebook-editor">
      <header className="notebook-editor-head">
        <button type="button" className="notebook-back" onClick={onBack} aria-label="返回笔记本列表">
          <ArrowLeft size={16} strokeWidth={1.9} />
        </button>
        <div className="notebook-editor-title">
          <strong>{notebook.title}</strong>
          <span>{inks.length} 笔 · {layers.length} 个图层</span>
        </div>
        <label className="notebook-paper">
          <span>纸样</span>
          <select value={notebook.paper} onChange={(event) => void changePaper(event.target.value as PaperStyle)}>
            {PAPER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`notebook-layer-toggle${layersOpen ? ' is-active' : ''}`}
          onClick={() => setLayersOpen((value) => !value)}
          aria-pressed={layersOpen}
        >
          <Layers size={15} strokeWidth={1.8} />
          图层
        </button>
      </header>

      {error && <p className="notebook-banner is-error" role="alert">{error}</p>}

      <div className="notebook-canvas-area">
        <div className="notebook-scroll">
          {loading && <div className="notebook-loading"><span /><strong>正在载入墨迹…</strong></div>}
          {Array.from({ length: pages }, (_, index) => {
            const page = index + 1
            return (
              <InkPage
                key={page}
                page={page}
                paper={notebook.paper}
                inks={inks.filter((ink) => ink.page === page)}
                visibleLayerIds={visibleLayerIds}
                activeLayer={activeLayer}
                tool={tool}
                color={color}
                width={width}
                eraserSize={eraserSize}
                onStroke={saveStroke}
                onErase={eraseStrokes}
              />
            )
          })}
          <div ref={sentinelRef} className="notebook-sentinel">
            {pages >= MAX_PAGES ? '已到本子上限（60 页）' : '继续向下滚动会加纸…'}
          </div>
        </div>

        {layersOpen && (
          <aside className="notebook-layers" aria-label="图层">
            <header>
              <strong>图层</strong>
              <button type="button" onClick={() => void addLayer()} title="新建图层">
                <Plus size={14} strokeWidth={2} />
              </button>
            </header>
            <div className="notebook-layer-list">
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  className={`notebook-layer${layer.id === activeLayerId ? ' is-active' : ''}`}
                  data-layer-id={layer.id}
                >
                  {renamingLayer === layer.id ? (
                    <input
                      autoFocus
                      className="notebook-layer-rename"
                      value={layerDraft}
                      onChange={(event) => setLayerDraft(event.target.value)}
                      onBlur={() => {
                        void patchLayer(layer, { name: layerDraft })
                        setRenamingLayer(null)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void patchLayer(layer, { name: layerDraft })
                          setRenamingLayer(null)
                        }
                        if (event.key === 'Escape') setRenamingLayer(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="notebook-layer-name"
                      onClick={() => setActiveLayerId(layer.id)}
                      onDoubleClick={() => { setRenamingLayer(layer.id); setLayerDraft(layer.name) }}
                    >
                      <span>{layer.name}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    title={layer.visible ? '隐藏图层' : '显示图层'}
                    aria-pressed={layer.visible}
                    onClick={() => void patchLayer(layer, { visible: !layer.visible })}
                  >
                    {layer.visible ? <Eye size={13} strokeWidth={1.8} /> : <EyeOff size={13} strokeWidth={1.8} />}
                  </button>
                  <button
                    type="button"
                    title={layer.locked ? '解锁图层' : '锁定图层'}
                    aria-pressed={layer.locked}
                    onClick={() => void patchLayer(layer, { locked: !layer.locked })}
                  >
                    {layer.locked ? <Lock size={13} strokeWidth={1.8} /> : <LockOpen size={13} strokeWidth={1.8} />}
                  </button>
                  <button
                    type="button"
                    title="删除图层"
                    onClick={() => setConfirmDelete(layer.id)}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                  {confirmDelete === layer.id && (
                    <div className="notebook-layer-confirm">
                      <span>
                        删除「{layer.name}」及其
                        {inks.filter((ink) => ink.layer_id === layer.id).length} 笔？
                      </span>
                      <button type="button" className="is-danger" onClick={() => void removeLayer(layer)}>删除</button>
                      <button type="button" onClick={() => setConfirmDelete(null)}>取消</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="notebook-layer-hint">双击图层名可改名；隐藏的图层不参与橡皮，锁定的图层不能落笔。</p>
          </aside>
        )}
      </div>

      <div className="notebook-dock">
        <div className="notebook-tool-group">
          <button
            type="button"
            className={tool === 'pen' ? 'is-active' : ''}
            onClick={() => setTool('pen')}
            title="画笔"
            aria-pressed={tool === 'pen'}
          >
            <PenLine size={16} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={tool === 'eraser' ? 'is-active' : ''}
            onClick={() => setTool('eraser')}
            title="橡皮"
            aria-pressed={tool === 'eraser'}
          >
            <Eraser size={16} strokeWidth={1.8} />
          </button>
        </div>

        {tool === 'pen' ? (
          <>
            <div className="notebook-tool-group">
              {INK_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`notebook-color${color === value ? ' is-active' : ''}`}
                  style={{ background: value }}
                  aria-label={`颜色 ${value}`}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
            <SizeControl kind="pen" label="笔宽" value={width} onChange={changeWidth} />
          </>
        ) : (
          <SizeControl kind="eraser" label="橡皮半径" value={eraserSize} onChange={changeEraserSize} />
        )}

        <span className={`notebook-status${canDraw ? '' : ' is-locked'}`}>
          {activeLayer
            ? `${activeLayer.name}${activeLayer.locked ? ' · 已锁定' : ''}${activeLayer.visible ? '' : ' · 已隐藏'}`
            : '没有可用图层'}
        </span>
      </div>
    </div>
  )
}

interface InkPageProps {
  page: number
  paper: PaperStyle
  inks: NotebookInk[]
  visibleLayerIds: Set<string>
  activeLayer: Layer | null
  tool: 'pen' | 'eraser'
  color: string
  width: number
  eraserSize: number
  onStroke: (
    page: number,
    bbox: NormalizedBBox,
    style: { color: string; width: number; points: Array<[number, number]> },
  ) => Promise<void>
  onErase: (ids: string[]) => Promise<void>
}

function InkPage({
  page,
  paper,
  inks,
  visibleLayerIds,
  activeLayer,
  tool,
  color,
  width,
  eraserSize,
  onStroke,
  onErase,
}: InkPageProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [draft, setDraft] = useState<Array<[number, number]>>([])
  const [cursor, setCursor] = useState<{ x: number; y: number; scale: number } | null>(null)
  const [hoverIds, setHoverIds] = useState<ReadonlySet<string>>(new Set())
  const [erased, setErased] = useState<ReadonlySet<string>>(new Set())
  const erasingRef = useRef(false)
  const strokeRef = useRef<Array<[number, number]>>([])
  const erasedRef = useRef<Set<string>>(new Set())

  const canDraw = Boolean(activeLayer && activeLayer.visible && !activeLayer.locked)
  const shown = inks.filter((ink) => visibleLayerIds.has(ink.layer_id) && !erased.has(ink.id))

  const candidates = useMemo<InkHitCandidate[]>(() => shown.map((ink) => ({
    id: ink.id,
    width: Math.max(2, (ink.style.width ?? 0.003) * PAGE_W),
    points: (ink.style.points ?? []).map((point) => [point[0] * PAGE_W, point[1] * PAGE_H] as [number, number]),
  })), [shown])

  function toLocal(event: React.PointerEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return {
      x: (event.clientX - rect.left) / rect.width * PAGE_W,
      y: (event.clientY - rect.top) / rect.height * PAGE_H,
      scale: PAGE_W / rect.width,
    }
  }

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!canDraw) return
    const local = toLocal(event)
    if (!local) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'pen') {
      strokeRef.current = [[local.x, local.y]]
      setDraft(strokeRef.current)
      return
    }
    erasingRef.current = true
    erasedRef.current = new Set()
    applyErase(local.x, local.y, local.scale)
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!canDraw) return
    const local = toLocal(event)
    if (!local) return
    if (tool === 'eraser') {
      setCursor({ x: local.x, y: local.y, scale: local.scale })
      const hits = findInkHits(
        { x: local.x, y: local.y },
        candidates.filter((candidate) => !erasedRef.current.has(candidate.id)),
        eraserSize * local.scale,
      )
      setHoverIds(new Set(hits.map((hit) => hit.id)))
      if (erasingRef.current) applyErase(local.x, local.y, local.scale)
      return
    }
    if (!strokeRef.current.length) return
    const last = strokeRef.current[strokeRef.current.length - 1]
    if (Math.hypot(local.x - last[0], local.y - last[1]) < PAGE_W * 0.002) return
    strokeRef.current = [...strokeRef.current, [local.x, local.y]]
    setDraft(strokeRef.current)
  }

  function applyErase(x: number, y: number, scale: number) {
    const hits = findInkHits(
      { x, y },
      candidates.filter((candidate) => !erasedRef.current.has(candidate.id)),
      eraserSize * scale,
    )
    if (!hits.length) return
    for (const hit of hits) erasedRef.current.add(hit.id)
    setErased(new Set(erasedRef.current))
  }

  async function handlePointerUp() {
    if (erasingRef.current) {
      erasingRef.current = false
      const ids = [...erasedRef.current]
      erasedRef.current = new Set()
      if (ids.length) await onErase(ids)
      return
    }
    const points = strokeRef.current
    strokeRef.current = []
    setDraft([])
    if (points.length < 2) return
    const normalized = points.map(([x, y]) => [x / PAGE_W, y / PAGE_H] as [number, number])
    const xs = normalized.map((point) => point[0])
    const ys = normalized.map((point) => point[1])
    const pad = width
    const x = Math.max(0, Math.min(...xs) - pad)
    const y = Math.max(0, Math.min(...ys) - pad)
    const w = Math.min(1 - x, Math.max(...xs) - x + pad)
    const h = Math.min(1 - y, Math.max(...ys) - y + pad)
    if (w <= 0 || h <= 0) return
    await onStroke(
      page,
      { x, y, width: Math.max(0.0005, w), height: Math.max(0.0005, h) },
      { color, width, points: normalized },
    )
  }

  const pathOf = (points: Array<[number, number]>) => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0] * PAGE_W} ${point[1] * PAGE_H}`)
    .join(' ')

  return (
    <section className={`notebook-page is-${paper}`} data-page={page}>
      <svg
        ref={svgRef}
        className={`notebook-ink-surface${tool === 'eraser' ? ' is-erasing' : ''}`}
        viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={() => void handlePointerUp()}
        onPointerCancel={() => void handlePointerUp()}
        onPointerLeave={() => { setCursor(null); setHoverIds(new Set()) }}
      >
        {shown.map((ink) => (
          <path
            key={ink.id}
            d={pathOf(ink.style.points ?? [])}
            fill="none"
            stroke={ink.style.color ?? '#2f3330'}
            strokeWidth={Math.max(1.5, (ink.style.width ?? 0.0035) * PAGE_W)}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={hoverIds.has(ink.id) ? 'is-hover' : ''}
          />
        ))}
        {draft.length > 1 && (
          <path
            d={pathOf(draft)}
            fill="none"
            stroke={color}
            strokeWidth={Math.max(1.5, width * PAGE_W)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
          />
        )}
        {tool === 'eraser' && cursor && (
          <circle
            className="notebook-eraser-cursor"
            cx={cursor.x}
            cy={cursor.y}
            r={eraserSize * cursor.scale}
          />
        )}
      </svg>
      <span className="notebook-page-no">{page}</span>
    </section>
  )
}
