import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ViewportPortal, useReactFlow } from '@xyflow/react'
import { Eraser, Eye, EyeOff, Layers, Lock, LockOpen, PenLine, Plus, Trash2 } from 'lucide-react'
import type { CanvasInk, Layer, LayerMember } from '../../domain/card'
import {
  createCanvasInk,
  createLayer,
  deleteCanvasInk,
  deleteLayer,
  listCanvasInks,
  listLayerMembers,
  listLayers,
  setCardLayer,
  updateLayer,
} from '../../services/pdfnote'
import { SizeControl } from '../ink/SizeControl'
import { readSizePreference, saveSizePreference } from '../ink/size'
import { findInkHits, type InkHitCandidate } from '../pdf/inkErase'
import './CanvasInkLayer.css'

export type InkMode = 'off' | 'pen' | 'eraser'

const INK_COLORS = ['#2f3330', '#d94f3d', '#2f6f8f', '#3f7a4c']
/** 世界坐标下的笔宽：与 PDF / 笔记本共用归一化值，乘 1000 变成 flow 单位。 */
const WORLD_SCALE = 1000

export interface CanvasInkApi {
  hiddenCardIds: ReadonlySet<string>
  inkMode: InkMode
  setInkMode: (mode: InkMode) => void
  layerPanelOpen: boolean
  setLayerPanelOpen: (open: boolean) => void
  toolbar: (compact?: boolean) => ReactNode
  portal: ReactNode
  overlay: ReactNode
  panel: ReactNode
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function pathOf(points: Array<[number, number]>): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0]} ${point[1]}`)
    .join(' ')
}

/**
 * 画布涂鸦 + 脑图分层。墨迹用 React Flow 世界坐标存在 canvas_inks，
 * 通过 ViewportPortal 跟着画布平移缩放；卡片归属存在 mindmap_layer_members，
 * 隐藏图层时同时隐藏该层的墨迹与卡片。
 */
export function useCanvasInk(canvasId: string, selectedCardIds: ReadonlySet<string>): CanvasInkApi {
  const { screenToFlowPosition, getViewport } = useReactFlow()
  const [layers, setLayers] = useState<Layer[]>([])
  const [inks, setInks] = useState<CanvasInk[]>([])
  const [members, setMembers] = useState<LayerMember[]>([])
  const [activeLayerId, setActiveLayerId] = useState('')
  const [inkMode, setInkMode] = useState<InkMode>('off')
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [color, setColor] = useState(INK_COLORS[0])
  const [width, setWidth] = useState(() => readSizePreference('pen'))
  const [eraserRadius, setEraserRadius] = useState(() => readSizePreference('eraser'))
  const [draft, setDraft] = useState<Array<[number, number]>>([])
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  const [hoverIds, setHoverIds] = useState<ReadonlySet<string>>(new Set())
  const [erased, setErased] = useState<ReadonlySet<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState('')

  const strokeRef = useRef<Array<[number, number]>>([])
  const erasingRef = useRef(false)
  const erasedRef = useRef<Set<string>>(new Set())

  const hiddenLayerIds = useMemo(
    () => new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.id)),
    [layers],
  )
  const hiddenCardIds = useMemo(
    () => new Set(members.filter((member) => hiddenLayerIds.has(member.layer_id)).map((member) => member.card_id)),
    [hiddenLayerIds, members],
  )
  const activeLayer = layers.find((layer) => layer.id === activeLayerId) ?? null
  const canDraw = Boolean(activeLayer && activeLayer.visible && !activeLayer.locked)

  const reload = useCallback(async () => {
    try {
      const [nextLayers, nextInks, nextMembers] = await Promise.all([
        listLayers('canvas', canvasId),
        listCanvasInks(canvasId),
        listLayerMembers(canvasId),
      ])
      let resolved = nextLayers
      if (!resolved.length) {
        resolved = [await createLayer('canvas', canvasId, '主层')]
      }
      setLayers(resolved)
      setActiveLayerId((current) => resolved.some((layer) => layer.id === current) ? current : resolved[0].id)
      setInks(nextInks)
      setMembers(nextMembers)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [canvasId])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    // 切画布时退出落笔状态，避免把笔迹写到另一张画布上。
    setInkMode('off')
    setDraft([])
    setLayerPanelOpen(false)
  }, [canvasId])

  const changeWidth = (value: number) => {
    setWidth(value)
    saveSizePreference('pen', value)
  }
  const changeEraserRadius = (value: number) => {
    setEraserRadius(value)
    saveSizePreference('eraser', value)
  }

  async function addLayer() {
    try {
      const created = await createLayer('canvas', canvasId)
      setLayers((current) => [...current, created])
      setActiveLayerId(created.id)
    } catch (reason) { setError(errorMessage(reason)) }
  }

  async function patchLayer(layer: Layer, changes: { name?: string; visible?: boolean; locked?: boolean }) {
    try {
      const updated = await updateLayer(layer.id, changes)
      setLayers((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (reason) { setError(errorMessage(reason)) }
  }

  async function removeLayer(layer: Layer) {
    try {
      await deleteLayer(layer.id)
      setLayers((current) => current.filter((item) => item.id !== layer.id))
      setInks((current) => current.filter((ink) => ink.layer_id !== layer.id))
      setMembers((current) => current.filter((member) => member.layer_id !== layer.id))
      if (activeLayerId === layer.id) {
        setActiveLayerId(layers.find((item) => item.id !== layer.id)?.id ?? '')
      }
      setConfirmDelete(null)
    } catch (reason) { setError(errorMessage(reason)) }
  }

  async function assignSelected(layerId: string | null) {
    try {
      for (const cardId of selectedCardIds) {
        await setCardLayer(canvasId, cardId, layerId)
      }
      setMembers(await listLayerMembers(canvasId))
    } catch (reason) { setError(errorMessage(reason)) }
  }

  const shownInks = inks.filter((ink) => !hiddenLayerIds.has(ink.layer_id) && !erased.has(ink.id))
  const candidates = useMemo<InkHitCandidate[]>(() => shownInks.map((ink) => ({
    id: ink.id,
    width: Math.max(2, ink.style.width * WORLD_SCALE),
    points: ink.points,
  })), [shownInks])

  const toWorld = (event: React.PointerEvent<HTMLDivElement>): [number, number] => {
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    return [point.x, point.y]
  }

  const hitRadius = () => eraserRadius / Math.max(0.15, getViewport().zoom)

  function applyErase(point: [number, number]) {
    const hits = findInkHits(
      { x: point[0], y: point[1] },
      candidates.filter((candidate) => !erasedRef.current.has(candidate.id)),
      hitRadius(),
    )
    if (!hits.length) return
    for (const hit of hits) erasedRef.current.add(hit.id)
    setErased(new Set(erasedRef.current))
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!canDraw || inkMode === 'off') return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = toWorld(event)
    if (inkMode === 'pen') {
      strokeRef.current = [point]
      setDraft([point])
      return
    }
    erasingRef.current = true
    erasedRef.current = new Set()
    setCursor(point)
    applyErase(point)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!canDraw || inkMode === 'off') return
    const point = toWorld(event)
    if (inkMode === 'eraser') {
      setCursor(point)
      const hits = findInkHits(
        { x: point[0], y: point[1] },
        candidates.filter((candidate) => !erasedRef.current.has(candidate.id)),
        hitRadius(),
      )
      setHoverIds(new Set(hits.map((hit) => hit.id)))
      if (erasingRef.current) applyErase(point)
      return
    }
    const points = strokeRef.current
    if (!points.length) return
    const last = points[points.length - 1]
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 2 / Math.max(0.15, getViewport().zoom)) return
    strokeRef.current = [...points, point]
    setDraft(strokeRef.current)
  }

  async function handlePointerUp() {
    if (erasingRef.current) {
      erasingRef.current = false
      const ids = [...erasedRef.current]
      erasedRef.current = new Set()
      if (ids.length) {
        try {
          for (const id of ids) await deleteCanvasInk(id)
          const removed = new Set(ids)
          setInks((current) => current.filter((ink) => !removed.has(ink.id)))
        } catch (reason) { setError(errorMessage(reason)) }
      }
      setErased(new Set())
      return
    }
    const points = strokeRef.current
    strokeRef.current = []
    setDraft([])
    if (points.length < 2 || !activeLayerId) return
    try {
      const created = await createCanvasInk({
        canvas_id: canvasId,
        layer_id: activeLayerId,
        points,
        style: { color, width },
      })
      setInks((current) => [...current, created])
    } catch (reason) { setError(`笔迹保存失败：${errorMessage(reason)}`) }
  }

  const toolbar = (compact = false): ReactNode => (
    <>
      <button
        type="button"
        data-testid="mindmap-ink-toggle"
        className={inkMode !== 'off' ? 'is-active' : ''}
        title="画布涂鸦"
        aria-pressed={inkMode !== 'off'}
        onClick={() => setInkMode((mode) => mode === 'off' ? 'pen' : 'off')}
      >
        {compact ? '涂鸦' : '涂鸦'}
      </button>
      <button
        type="button"
        data-testid="mindmap-layer-toggle"
        className={layerPanelOpen ? 'is-active' : ''}
        title="图层"
        aria-pressed={layerPanelOpen}
        onClick={() => setLayerPanelOpen((open) => !open)}
      >
        {compact ? '图层' : '图层'}
      </button>
      {!compact && inkMode !== 'off' && (
        <>
          <button
            type="button"
            data-testid="mindmap-ink-pen"
            className={inkMode === 'pen' ? 'is-active' : ''}
            aria-pressed={inkMode === 'pen'}
            onClick={() => setInkMode('pen')}
            title="画笔"
          ><PenLine size={13} /></button>
          <button
            type="button"
            data-testid="mindmap-ink-eraser"
            className={inkMode === 'eraser' ? 'is-active' : ''}
            aria-pressed={inkMode === 'eraser'}
            onClick={() => setInkMode('eraser')}
            title="橡皮"
          ><Eraser size={13} /></button>
          {INK_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              className={`mindmap-ink-color${color === value ? ' is-active' : ''}`}
              style={{ background: value }}
              aria-label={`墨迹颜色 ${value}`}
              onClick={() => { setColor(value); setInkMode('pen') }}
            />
          ))}
        </>
      )}
      {inkMode === 'pen' && <SizeControl kind="pen" label="笔宽" value={width} onChange={changeWidth} />}
      {inkMode === 'eraser' && <SizeControl kind="eraser" label="橡皮半径" value={eraserRadius} onChange={changeEraserRadius} />}
    </>
  )

  const portal: ReactNode = (
    <ViewportPortal>
      <svg className="mindmap-ink-svg" data-testid="mindmap-ink-svg">
        {shownInks.map((ink) => (
          <path
            key={ink.id}
            d={pathOf(ink.points)}
            fill="none"
            stroke={ink.style.color}
            strokeWidth={Math.max(1.5, ink.style.width * WORLD_SCALE)}
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
            strokeWidth={Math.max(1.5, width * WORLD_SCALE)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
          />
        )}
        {inkMode === 'eraser' && cursor && (
          <circle className="mindmap-ink-eraser-cursor" cx={cursor[0]} cy={cursor[1]} r={hitRadius()} />
        )}
      </svg>
    </ViewportPortal>
  )

  const overlay: ReactNode = inkMode !== 'off' ? (
    <div
      className="mindmap-ink-overlay"
      data-testid="mindmap-ink-overlay"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => void handlePointerUp()}
      onPointerCancel={() => void handlePointerUp()}
      onPointerLeave={() => { setCursor(null); setHoverIds(new Set()) }}
    />
  ) : null

  const panel: ReactNode = layerPanelOpen ? (
    <aside className="mindmap-layer-panel" data-testid="mindmap-layer-panel">
      <header>
        <Layers size={14} strokeWidth={1.8} />
        <strong>画布图层</strong>
        <button type="button" title="新建图层" data-testid="mindmap-layer-add" onClick={() => void addLayer()}>
          <Plus size={14} />
        </button>
      </header>
      <div className="mindmap-layer-list">
        {layers.map((layer) => (
          <div
            key={layer.id}
            className={`mindmap-layer-row${layer.id === activeLayerId ? ' is-active' : ''}`}
            data-layer-id={layer.id}
          >
            {renaming === layer.id ? (
              <input
                autoFocus
                className="mindmap-layer-rename"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => { void patchLayer(layer, { name: renameDraft }); setRenaming(null) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { void patchLayer(layer, { name: renameDraft }); setRenaming(null) }
                  if (event.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <button
                type="button"
                className="mindmap-layer-name"
                onClick={() => setActiveLayerId(layer.id)}
                onDoubleClick={() => { setRenaming(layer.id); setRenameDraft(layer.name) }}
              >
                <span>{layer.name}</span>
                <small>
                  {inks.filter((ink) => ink.layer_id === layer.id).length} 笔 ·{' '}
                  {members.filter((member) => member.layer_id === layer.id).length} 卡
                </small>
              </button>
            )}
            <button
              type="button"
              title={layer.visible ? '隐藏图层' : '显示图层'}
              className={layer.visible ? '' : 'is-off'}
              onClick={() => void patchLayer(layer, { visible: !layer.visible })}
            >
              {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button
              type="button"
              title={layer.locked ? '解锁图层' : '锁定图层'}
              className={layer.locked ? 'is-off' : ''}
              onClick={() => void patchLayer(layer, { locked: !layer.locked })}
            >
              {layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
            <button type="button" title="删除图层" onClick={() => setConfirmDelete(layer.id)}>
              <Trash2 size={13} />
            </button>
            {confirmDelete === layer.id && (
              <div className="mindmap-layer-confirm">
                <span>删除「{layer.name}」及其墨迹 / 卡片归属？</span>
                <button type="button" className="is-danger" onClick={() => void removeLayer(layer)}>删除</button>
                <button type="button" onClick={() => setConfirmDelete(null)}>取消</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mindmap-layer-actions">
        <button
          type="button"
          data-testid="mindmap-layer-assign"
          disabled={!selectedCardIds.size || !activeLayerId}
          onClick={() => void assignSelected(activeLayerId)}
        >
          把选中卡片归入当前层
        </button>
        <button type="button" disabled={!selectedCardIds.size} onClick={() => void assignSelected(null)}>
          移出分层
        </button>
      </div>
      <p>隐藏图层会同时隐藏该层的墨迹与卡片；没有归入任何层的卡片始终可见。双击层名可改名。</p>
      {error && <p className="is-error">{error}</p>}
    </aside>
  ) : null

  return {
    hiddenCardIds,
    inkMode,
    setInkMode,
    layerPanelOpen,
    setLayerPanelOpen,
    toolbar,
    portal,
    overlay,
    panel,
  }
}
