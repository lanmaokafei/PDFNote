import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type OnNodeDrag,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { explainCardQuestion } from '../../services/ai'
import {
  ChevronRight,
  Copy,
  Sparkles,
  Download,
  FileText,
  Focus,
  LayoutGrid,
  Link2,
  ListTree,
  Maximize,
  Merge,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
} from 'lucide-react'
import type { Card, CardLink, MindmapCanvas, MindmapLayoutInput, Rating } from '../../domain/card'
import { ContextMenu } from '../../ui/ContextMenu'
import { useContextMenu, type ContextMenuSection } from '../../ui/contextMenuCore'
import {
  applyCardOrder,
  clearMindmapCards,
  createMindmapCanvas,
  exportMarkdownFile,
  isTauriRuntime,
  listCardLinks,
  listMindmapCanvases,
  listMindmapLayout,
  moveCard,
  saveMindmapLayout,
  setCardCollapsed,
  updateCardContent,
} from '../../services/pdfnote'
import { useCardStore } from '../../store/cardStore'
import { reviewCard } from '../review/scheduler'
import {
  CardEditor,
  ClearCardsDialog,
  ConfirmationDialog,
  type CardDraft,
  type ClearCardsMode,
  type ConfirmationKind,
} from './CardEditor'
import { LinkDialog, MergeDialog, TagDialog } from '../card/CardDialogs'
import { MindmapNodeContext } from './MindmapContext'
import { MindmapNode, type MindmapFlowNode } from './MindmapNode'
import { InkEdge } from './MindmapEdge'
import { buildOutlineForest, flattenOutline, outlineTitle, outlineToMarkdown } from './outline'
import {
  buildChildMap,
  collectDescendants,
  dropPlan,
  indentPlan,
  insertAfterPlan,
  insertChildPlan,
  outdentPlan,
  outlineEditField,
  type DropPosition,
} from './outlineEdit'
import { ExpandableField } from './ExpandableField'
import { useCanvasInk } from './CanvasInkLayer'
import { CanvasSwitcher } from './CanvasSwitcher'
import { AnkiImportDialog } from '../book/AnkiImportDialog'
import type { AnkiImportResult } from '../../services/anki'
import {
  DEFAULT_CANVAS_ID,
  MINDMAP_CHANGED_EVENT,
  documentCanvasName,
  readCanvasId,
  readCanvasPreference,
  saveCanvasId,
} from './canvas'
import {
  nextMindmapInsertPoint,
  readMindmapViewportCenter,
  resetMindmapInsertSequence,
  setMindmapViewportCenter,
} from './viewport'
import {
  TREE_X_GAP,
  TREE_Y_GAP,
  buildTreeLayout,
  getOrderedMindmapCards,
  nextSortOrder,
  type MindmapSortMode,
  type Point,
} from './layout'
import { clearToneOverride, saveToneOverride, toneAt, toneIndexMap, toneOverrides } from './tone'
import { MindmapStylePanel } from './MindmapStylePanel'
import {
  type MindmapCardStyle,
  MINDMAP_THEMES,
  readCardStyle,
  resolveCardStyle,
  saveCardStyle,
} from './style'
import './mindmap.css'

const nodeTypes = { mindmapCard: MindmapNode }
// 缺失布局时复用同一对象，避免每次渲染生成新 position 引用。
const DEFAULT_NODE_POSITION = { x: 80, y: 80 }
// 视口外的节点不会挂载，也就永远测不到尺寸。给一个估算尺寸，让边线端点、命中测试与
// 「适应视图」在第一次测量之前也有合理值；节点挂载后 measured 会覆盖它。
const NODE_WIDTH = 254
const COMPACT_NODE_WIDTH = 228
const NODE_ESTIMATED_HEIGHT = 172
// 超过这个规模就关掉 MiniMap：它每次节点变化都要为全部节点算一遍缩略矩形。
const MINIMAP_NODE_LIMIT = 400
// 微缩导航图的色块跟随卡片的节气色调（data.tone）：主色填充、深色同族描边，
// 整幅缩略图才能看出簇群分布。模块级纯函数保证引用稳定（React #185）。
const minimapNodeColor = (node: { data?: unknown }) =>
  toneAt(((node.data ?? {}) as { tone?: number }).tone ?? 0).bar
const minimapNodeStrokeColor = (node: { data?: unknown }) =>
  toneAt(((node.data ?? {}) as { tone?: number }).tone ?? 0).ink
// 超过这个规模不再自动 fitView：1483 个节点铺满屏幕时缩放会被压到下限，什么也看不清。
const AUTO_FIT_NODE_LIMIT = 400
// 大图的「适应视图」只框住前若干个节点，保证缩放后文字仍然可读。
const READABLE_FIT_NODES = 40
// 低缩放时不渲染边：338 个节点能带出 1000+ 条 smoothstep 路径，拖拽时每帧都要重算，
// 而那个比例下边只是一层灰线，反而盖住标题条。
const NO_EDGES: Edge[] = []
// 大纲首屏只渲染这么多行，其余按需追加（上千行全量挂载会卡住切换）。
const OUTLINE_PAGE = 200
// 传给 React Flow 的对象/数组必须保持引用稳定：StoreUpdater 会逐字段比较，
// 每次渲染新建会让它在 effect 里重复写入 store，放大成 #185。
const FIT_VIEW_OPTIONS = { padding: 0.18, maxZoom: 1 }
// 0=左键、1=中键、2=右键。左键拖空白即可平移；框选改为按住 Shift。
const PAN_ON_DRAG: number[] = [0, 1, 2]
const MULTI_SELECTION_KEYS = ['Meta', 'Control', 'Shift']
const COMPACT_VIEWPORT = { x: 30, y: 96, zoom: 0.9 }
// 边线样式对象提到模块级：1483 条边每次重算都新建 style/marker 对象的话，
// React Flow 的 memo 比较会全部失效，整层边线都会重渲染。
const HIERARCHY_MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#a8b2aa' }
const HIERARCHY_EDGE_STYLE = { stroke: '#a8b2aa', strokeWidth: 1.4 }
// 深墨连线：深灰、无箭头、圆角折线，目标端由 InkEdge 画小圆点。
const INK_EDGE_STYLE = { stroke: '#2f3a33', strokeWidth: 1.6 }
const LINK_MARKER = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#7d9dab' }
const LINK_EDGE_STYLE = { stroke: '#7d9dab', strokeWidth: 1.2, strokeDasharray: '5 4' }
const LINK_LABEL_STYLE = { fill: '#6d8794', fontSize: 8 }
const LINK_LABEL_BG_STYLE = { fill: '#f4f7f4', fillOpacity: 0.9 }
// 自定义边类型表必须模块级常量：每次渲染新建会让 React Flow 认为边类型变了。
const EDGE_TYPES = { ink: InkEdge }
// 超过这个规模就不用自定义边（每条边一个组件，上千条会拖慢缩放/拖拽），退回内置折线。
const CUSTOM_EDGE_LIMIT = 400

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function titleOf(card: Card | undefined): string {
  return card?.question.trim() || card?.excerpt.trim() || card?.user_note.trim() || '未命名卡片'
}

interface MindmapWorkspaceProps {
  onCardsChanged: () => void
  /** 嵌入分栏工作区：隐藏页头与完整工具栏，改用画布内悬浮操作。 */
  compact?: boolean
  /** 文档工作台传入：加载全局画布 + 这本书的专属画布，并把选择偏好按文档记住。 */
  documentId?: string | null
  /** 文档标题：新导入 / 升级前导入的书缺少专属画布时，用它给画布命名。 */
  documentTitle?: string | null
}

interface ConfirmationState {
  kind: ConfirmationKind
  id: string
}

function MindmapCanvas({ onCardsChanged, compact = false, documentId = null, documentTitle = null }: MindmapWorkspaceProps) {
  const cardsById = useCardStore((state) => state.cardsById)
  const loadCards = useCardStore((state) => state.loadCards)
  const createCardInStore = useCardStore((state) => state.createCard)
  const removeFromMindmap = useCardStore((state) => state.removeFromMindmap)
  const deleteCard = useCardStore((state) => state.deleteCard)
  const {
    getIntersectingNodes,
    fitView: fitViewInstance,
    getViewport,
  } = useReactFlow<MindmapFlowNode, Edge>()

  // 当前画布：全局独立视图只用 main，文档工作台会按 documentId 单独记住上次选的画布。
  const [canvasId, setCanvasId] = useState(() => readCanvasId(documentId))
  const [canvases, setCanvases] = useState<MindmapCanvas[]>([])
  /**
   * 画布归属解析完成前不加载成员：否则新导入的书会先用 main 拉一遍，
   * 短暂闪出全局画布（例如上一本书的 AI 拆书内容）。
   */
  const [canvasResolved, setCanvasResolved] = useState(() => !documentId)
  const canvasResolvedRef = useRef(!documentId)
  /** 当前画布的 mindmap_layout 成员；surface_mindmap 只是「在任意画布出现」的派生开关。 */
  const [layoutCardIds, setLayoutCardIds] = useState<ReadonlySet<string>>(new Set())
  /** 这批成员属于哪张画布；切换过程中旧成员仍渲染，避免 React Flow 被卸载。 */
  const [layoutScope, setLayoutScope] = useState('')
  const [ankiOpen, setAnkiOpen] = useState(false)
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [measuredSizes, setMeasuredSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  /** 画布涂鸦 / 图层：世界坐标墨迹 + 卡片分层显隐（schema v11）。 */
  const ink = useCanvasInk(canvasId, selectedIds)

  // 尺寸回写熔断：极端情况下（容器 0 宽、图片抖动）测量会连续变化，
  // 超过阈值后本秒内停止回写，直接断开 StoreUpdater ↔ onNodesChange 的回路。
  const measuredBurstRef = useRef({ windowStart: 0, count: 0 })
  /**
   * 平移 / 缩放 / 拖拽期间先不把尺寸写回 state。
   * 每次写回都会重建整张 nodes 数组（1483 个对象）并让 React Flow 重新 adopt 一遍，
   * 而低缩放下视口里同时挂着一千多个节点，写一次就是几百毫秒的卡顿。
   * 交互结束后一次性 flush，期间只记在 ref 里。
   */
  const interactingRef = useRef(false)
  const pendingMeasureRef = useRef<Record<string, { width: number; height: number }>>({})
  const flushMeasures = useCallback(() => {
    const pending = pendingMeasureRef.current
    if (!Object.keys(pending).length) return
    pendingMeasureRef.current = {}
    setMeasuredSizes((current) => ({ ...current, ...pending }))
  }, [])
  const beginInteraction = useCallback(() => { interactingRef.current = true }, [])
  /**
   * 把当前视口中心换算成世界坐标存进共享模块：
   * PDF 建卡发生在左栏，需要知道右栏画布此刻「看的是哪一块」。
   */
  const publishViewportCenter = useCallback(() => {
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    const viewport = getViewport()
    setMindmapViewportCenter({
      x: (rect.width / 2 - viewport.x) / viewport.zoom,
      y: (rect.height / 2 - viewport.y) / viewport.zoom,
    })
  }, [getViewport])
  const endInteraction = useCallback(() => {
    interactingRef.current = false
    flushMeasures()
    publishViewportCenter()
  }, [flushMeasures, publishViewportCenter])
  const arrangeTimerRef = useRef<number | null>(null)
  /** 画布容器：用它的尺寸把「视口中心」换算成世界坐标，供建卡落点使用。 */
  const hostRef = useRef<HTMLDivElement>(null)
  /** 首次加载只自动适配一次视图；切换画布时不要反复抢用户的视口。 */
  const initialFitRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<'new' | string | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)
  const [viewMode, setViewMode] = useState<'canvas' | 'outline'>('canvas')
  /** 卡片样式（卡面/边框/圆角/密度），按画布保存在本地，不写数据库。 */
  const [cardStyle, setCardStyle] = useState<MindmapCardStyle>(() => readCardStyle(readCanvasId(documentId)))
  const [styleOpen, setStyleOpen] = useState(false)
  /** 面板是从哪张卡打开的：配色只作用于这张卡，样式仍是整张画布。 */
  const [styleTarget, setStyleTarget] = useState<string | null>(null)
  /**
   * 大纲一次只挂载前 OUTLINE_PAGE 行。1483 行 × 两个可展开字段 + KaTeX 会直接把
   * 切换动作卡住几秒；其余行按需追加，成本随用户实际翻到的位置增长。
   */
  const [outlineLimit, setOutlineLimit] = useState(OUTLINE_PAGE)
  /** 大纲行内编辑：同一时刻只有一行在改；ref 与 state 同步，防止 blur 与回车重复提交。 */
  const [outlineEditing, setOutlineEditing] = useState<string | null>(null)
  const [outlineDraft, setOutlineDraft] = useState('')
  const [outlineDrag, setOutlineDrag] = useState<string | null>(null)
  const [outlineDrop, setOutlineDrop] = useState<{ id: string; position: DropPosition } | null>(null)
  const [outlineFocusTick, setOutlineFocusTick] = useState(0)
  const outlineEditingRef = useRef<string | null>(null)
  const outlineDragRef = useRef<string | null>(null)
  const outlineDragDescendants = useRef<Set<string>>(new Set())
  const outlineInputRef = useRef<HTMLInputElement | null>(null)
  /**
   * 低缩放（<0.45）时节点只画标题条。用滞后阈值（退出要回到 0.55）避免
   * 用户停在临界点附近时反复切换，反而更卡。
   */
  const [lite, setLite] = useState(false)
  const liteRef = useRef(false)
  const handleViewportMove = useCallback((_event: unknown, viewport: Viewport) => {
    const next = viewport.zoom < (liteRef.current ? 0.55 : 0.45)
    if (next === liteRef.current) return
    liteRef.current = next
    setLite(next)
  }, [])
  const [exporting, setExporting] = useState(false)
  const [links, setLinks] = useState<CardLink[]>([])
  const [tagTarget, setTagTarget] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const { menu, show, close } = useContextMenu()

  const [recallActive, setRecallActive] = useState(false)
  const [recallSort, setRecallSort] = useState<MindmapSortMode>('order')
  const [recallExpandedIds, setRecallExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(new Set())
  const [ratedIds, setRatedIds] = useState<ReadonlySet<string>>(new Set())
  const [ratingPendingIds, setRatingPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [recallErrors, setRecallErrors] = useState<Readonly<Record<string, string>>>({})
  const sessionId = useRef('')

  const switching = loading && hasLoaded && layoutScope !== canvasId
  const currentCanvas = useMemo(
    () => canvases.find((canvas) => canvas.id === canvasId),
    [canvases, canvasId],
  )
  const canvasName = currentCanvas?.name ?? canvasId
  const cards = useMemo(
    () => Object.values(cardsById).filter(
      (card) => card.surface_mindmap
        && layoutCardIds.has(card.id)
        && !ink.hiddenCardIds.has(card.id),
    ),
    [cardsById, layoutCardIds, ink.hiddenCardIds],
  )
  const parentIds = useMemo(() => {
    const ids = new Set(cards.map((card) => card.id))
    return new Set(
      cards
        .map((card) => card.parent_id)
        .filter((id): id is string => Boolean(id && ids.has(id))),
    )
  }, [cards])

  /**
   * 卡片配色：每棵子树按「根节点 id」稳定分配一个二十四节气色，
   * 同一簇同色 → 上千张卡也不会糊成一片灰绿。手动换色写在 localStorage。
   */
  // 手动改过的颜色放进 state：既让 useMemo 有明确依赖，也让换色立刻反映到画布。
  const [tonePrefs, setTonePrefs] = useState(toneOverrides)
  const toneByCard = useMemo(() => {
    const parentOf = new Map<string, string | null>()
    for (const card of cards) parentOf.set(card.id, card.parent_id)
    return toneIndexMap(parentOf, tonePrefs)
  }, [cards, tonePrefs])

  /** 点徽标换色：在这张卡当前色调上 +1，立即重算节点 data。 */
  const cycleTone = useCallback((cardId: string) => {
    setTonePrefs(saveToneOverride(cardId, (toneByCard.get(cardId) ?? 0) + 1))
  }, [toneByCard])

  // 每张画布一套样式：切画布时重新读，不把上一本的风格带过去。
  useEffect(() => {
    setCardStyle(readCardStyle(canvasId))
  }, [canvasId])

  const resolvedStyle = useMemo(() => resolveCardStyle(cardStyle), [cardStyle])
  const currentTheme = MINDMAP_THEMES.find((theme) => theme.id === cardStyle.theme) ?? MINDMAP_THEMES[0]

  /** 面板里改一项就立即落盘，不需要“保存”按钮。 */
  const updateCardStyle = useCallback((next: MindmapCardStyle) => {
    setCardStyle(saveCardStyle(canvasId, next))
  }, [canvasId])
  const collapsedIds = useMemo(() => {
    if (recallActive) {
      return new Set([...parentIds].filter((id) => !recallExpandedIds.has(id)))
    }
    return new Set(cards.filter((card) => card.collapsed).map((card) => card.id))
  }, [cards, parentIds, recallActive, recallExpandedIds])
  const orderedVisibleCards = useMemo(
    () => getOrderedMindmapCards(cards, collapsedIds, recallActive ? recallSort : 'order'),
    [cards, collapsedIds, recallActive, recallSort],
  )
  const visibleIds = useMemo(() => new Set(orderedVisibleCards.map((card) => card.id)), [orderedVisibleCards])

  /**
   * 大图上「适应视图」只框住前几十个节点：1483 个节点全部塞进 700px 宽的分栏时，
   * 缩放会被压到 0.15 的下限，卡片变成一片看不清的色块，等于没适配。
   *
   * 这里用 ref 读最新的可见卡片，保证函数身份稳定 —— 否则 refresh 的依赖每次
   * 都会变化，effect → refresh → setState → effect 会形成无限加载回环。
   */
  const visibleCardsRef = useRef(orderedVisibleCards)
  useEffect(() => {
    visibleCardsRef.current = orderedVisibleCards
  }, [orderedVisibleCards])
  const fitReadable = useCallback((duration = 0) => {
    const current = visibleCardsRef.current
    const options = current.length > AUTO_FIT_NODE_LIMIT
      ? {
        ...FIT_VIEW_OPTIONS,
        duration,
        nodes: current.slice(0, READABLE_FIT_NODES).map((card) => ({ id: card.id })),
      }
      : { ...FIT_VIEW_OPTIONS, duration }
    void fitViewInstance(options)
  }, [fitViewInstance])
  /** 点击页码标签：切到该文档并跳到对应页。 */
  const openSource = useCallback((cardId: string) => {
    const card = cardsById[cardId]
    const source = card?.source_ref
    if (!source) return
    window.dispatchEvent(new CustomEvent('pdfnote:open-source', {
      detail: { documentId: source.document_id, page: source.page },
    }))
  }, [cardsById])

  /** 让模型解析卡片问题，结果追加到笔记。 */
  const explainCard = useCallback(async (cardId: string) => {
    const card = cardsById[cardId]
    if (!card || busy) return
    // 与后端一致：问题 / 摘录 / 笔记任一非空就能解析。PDF 划重点的卡没有 question，
    // 之前这里直接拒绝，等于把大部分卡片挡在 AI 之外。
    if (!card.question.trim() && !card.excerpt.trim() && !card.user_note.trim()) {
      setError('这张卡片还没有内容，先填写问题或摘录再让 AI 解析。')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const explanation = (await explainCardQuestion(cardId)).trim()
      const merged = [card.user_note.trim(), `【AI 解析】\n${explanation}`]
        .filter(Boolean)
        .join('\n\n')
      await updateCardContent({
        id: cardId,
        question: card.question,
        excerpt: card.excerpt,
        user_note: merged,
      })
      await loadCards()
      setNotice('AI 解析已写入卡片笔记。')
      onCardsChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [busy, cardsById, loadCards, onCardsChanged])

  // 画布常驻（大纲只是覆盖层），切换视图不会卸载 React Flow，因此 viewport、节点测量
  // 与交互状态都保留，切回画布不会出现空白。仅在独立视图切回时延迟重新适配一次，
  // 兜住用户在大纲期间调整窗口尺寸的情况；嵌入视图保留固定的 defaultViewport。
  const previousViewModeRef = useRef(viewMode)
  useEffect(() => {
    const previous = previousViewModeRef.current
    previousViewModeRef.current = viewMode
    if (viewMode !== 'canvas' || previous !== 'outline' || compact) return
    const timer = window.setTimeout(() => {
      fitReadable(0)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [compact, fitReadable, viewMode])

  // 大纲数据只在切到大纲时构建：画布视图下对着 1483 张卡建森林 + 展开行是纯浪费。
  const outlineForest = useMemo(
    () => buildOutlineForest(viewMode === 'outline' ? cards : []),
    [cards, viewMode],
  )
  const outlineCollapsedIds = useMemo(
    () => new Set(
      viewMode === 'outline' ? cards.filter((card) => card.collapsed).map((card) => card.id) : [],
    ),
    [cards, viewMode],
  )
  const outlineRows = useMemo(
    () => flattenOutline(outlineForest, (id) => outlineCollapsedIds.has(id)),
    [outlineCollapsedIds, outlineForest],
  )
  useEffect(() => {
    if (viewMode === 'outline') setOutlineLimit(OUTLINE_PAGE)
  }, [viewMode])
  const parentCardIds = useMemo(() => new Set(parentIds), [parentIds])
  /** 父 → 直接子节点数。节点组件据此 O(1) 决定是否显示折叠按钮，不再各自扫全表。 */
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const card of cards) {
      if (!card.parent_id || !parentIds.has(card.parent_id)) continue
      counts.set(card.parent_id, (counts.get(card.parent_id) ?? 0) + 1)
    }
    return counts
  }, [cards, parentIds])

  // 节点 data 与卡片列表同生命周期：位置/选中变化重建 nodes 时复用同一对象，
  // React Flow 才不会把“位置更新”误判成“节点内容更新”。
  const nodeData = useMemo(() => {
    const map = new Map<string, { card_id: string; tone: number }>()
    for (const card of orderedVisibleCards) {
      map.set(card.id, { card_id: card.id, tone: toneByCard.get(card.id) ?? 0 })
    }
    return map
  }, [orderedVisibleCards, toneByCard])

  /**
   * 复用没变化的节点对象：React Flow 的 `adoptUserNodes` 对「引用未变」的节点走快路径，
   * 否则每次选中 / 尺寸回写都要为上千个节点重建对象并重算 handleBounds。
   */
  const nodeCache = useMemo(() => new Map<string, MindmapFlowNode>(), [])
  const nodes = useMemo<MindmapFlowNode[]>(() => {
    const cache = nodeCache
    const next: MindmapFlowNode[] = []
    const seen = new Set<string>()
    for (const card of orderedVisibleCards) {
      seen.add(card.id)
      const size = measuredSizes[card.id]
      const position = positions[card.id] ?? DEFAULT_NODE_POSITION
      const data = nodeData.get(card.id)
      const selected = selectedIds.has(card.id)
      const width = size?.width ?? (compact ? COMPACT_NODE_WIDTH : NODE_WIDTH)
      const height = size?.height ?? NODE_ESTIMATED_HEIGHT
      const previous = cache.get(card.id)
      if (previous
        && previous.position === position
        && previous.data === data
        && previous.selected === selected
        && previous.width === width
        && previous.height === height
        && previous.measured === size) {
        next.push(previous)
        continue
      }
      const node: MindmapFlowNode = {
        id: card.id,
        type: 'mindmapCard',
        position,
        // data 必须保持稳定引用，否则 StoreUpdater 与 onNodesChange 会形成更新回环（React #185）。
        data: data ?? { card_id: card.id },
        selected,
        // 未挂载（视口外）的节点没有 measured，用估算值兜住 fitView / 边线计算。
        width,
        height,
        // 保留 React Flow 的实测尺寸，否则拖拽时会提示节点未初始化。
        ...(size ? { measured: size } : {}),
      }
      // 这里的 Map 只作为「上一帧节点对象」的缓存，写入发生在同一次 useMemo 内、
      // 且完全由输入决定，不会产生渲染副作用之外的可见变化。
      // oxlint-disable-next-line react/immutability
      cache.set(card.id, node)
      next.push(node)
    }
    for (const id of cache.keys()) {
      // oxlint-disable-next-line react/immutability
      if (!seen.has(id)) cache.delete(id)
    }
    return next
  }, [compact, measuredSizes, nodeCache, nodeData, orderedVisibleCards, positions, selectedIds])
  const edges = useMemo<Edge[]>(() => {
    const edgeStyle = resolvedStyle.edge
    // 自定义边（圆点）只为小画布启用；大图退回内置折线，避免上千个边组件。
    const dotted = edgeStyle !== 'hairline' && orderedVisibleCards.length <= CUSTOM_EDGE_LIMIT
    const hierarchy = orderedVisibleCards.flatMap((card) => {
      if (!card.parent_id || !visibleIds.has(card.parent_id)) return []
      const base = {
        id: `${card.parent_id}->${card.id}`,
        source: card.parent_id,
        target: card.id,
      }
      if (edgeStyle === 'hairline') {
        return [{
          ...base,
          type: 'smoothstep' as const,
          markerEnd: HIERARCHY_MARKER,
          style: HIERARCHY_EDGE_STYLE,
        }]
      }
      // 深墨 / 跟随子树：带圆点、无箭头；跟随子树取子卡片的主色。
      const tone = toneByCard.get(card.id) ?? 0
      return [{
        ...base,
        type: (dotted ? 'ink' : 'smoothstep') as 'ink' | 'smoothstep',
        style: edgeStyle === 'tone'
          ? { stroke: toneAt(tone).bar, strokeWidth: 1.5 }
          : INK_EDGE_STYLE,
      }]
    })
    const references = links
      .filter((link) => visibleIds.has(link.source_card_id) && visibleIds.has(link.target_card_id))
      .map((link) => {
        const edge: Edge = {
          id: `link-${link.id}`,
          source: link.source_card_id,
          target: link.target_card_id,
          type: 'straight' as const,
          markerEnd: LINK_MARKER,
          style: resolvedStyle.link === 'tone'
            ? {
                stroke: toneAt(toneByCard.get(link.source_card_id) ?? 0).bar,
                strokeWidth: 1.2,
                strokeDasharray: '5 4',
              }
            : LINK_EDGE_STYLE,
        }
        // 标签默认跟随主题：「色块」主题不画「链接」小字，参考图里也不标。
        if (resolvedStyle.linkLabels) {
          edge.label = '链接'
          edge.labelStyle = LINK_LABEL_STYLE
          edge.labelBgStyle = LINK_LABEL_BG_STYLE
        }
        return edge
      })
    return [...hierarchy, ...references]
  }, [
    links,
    orderedVisibleCards,
    resolvedStyle.edge,
    resolvedStyle.link,
    resolvedStyle.linkLabels,
    toneByCard,
    visibleIds,
  ])

  const refresh = useCallback(async (): Promise<string[]> => {
    const perfStart = performance.now()
    const timings: Record<string, number> = {}
    setLoading(true)
    setError('')
    try {
      // 画布列表与布局 / 卡片 / 链接并行取，少一次串行 IPC 往返。
      const [savedLayouts, , allLinks, list] = await Promise.all([
        listMindmapLayout(canvasId),
        loadCards(),
        listCardLinks(),
        listMindmapCanvases(documentId ?? null),
      ])
      timings.ipc = Math.round(performance.now() - perfStart)
      setLinks(allLinks)
      setCanvases(list)
      // 卡片归属 = 这张画布里是否有 mindmap_layout 行；绝不把别的画布卡片顺手补进来。
      const scopedIds = new Set(savedLayouts.map((layout) => layout.card_id))
      const latestCards = Object.values(useCardStore.getState().cardsById).filter(
        (card) => card.surface_mindmap && scopedIds.has(card.id),
      )
      const savedById = new Map(savedLayouts.map((layout) => [layout.card_id, layout]))
      const nextPositions: Record<string, Point> = {}
      const stranded: Card[] = []

      for (const card of latestCards) {
        const saved = savedById.get(card.id)
        // (0,0) 是建卡时的占位坐标（layout 列默认值），不是用户摆的位置：
        // 把它当成「未定位」，下一张新卡的落点由当前视口中心决定。
        const placed = saved
          && Number.isFinite(saved.x)
          && Number.isFinite(saved.y)
          && (saved.x !== 0 || saved.y !== 0)
        if (placed) {
          nextPositions[card.id] = { x: saved.x, y: saved.y }
        } else {
          stranded.push(card)
        }
      }

      // 只有真的缺坐标才跑布局：已经排好版的画布（哪怕 1483 张）打开时不再做一次 O(n) 重排。
      const missing: MindmapLayoutInput[] = []
      if (stranded.length) {
        const insert = readMindmapViewportCenter() ? nextMindmapInsertPoint() : undefined
        if (insert) {
          // 已知视口中心：新卡落在用户正在看的位置，而不是画布原点。
          stranded.forEach((card, index) => {
            const point = index === 0 ? insert : { x: insert.x, y: insert.y + index * 210 }
            nextPositions[card.id] = point
            missing.push({ card_id: card.id, canvas_id: canvasId, ...point })
          })
        } else {
          const generated = buildTreeLayout(latestCards)
          for (const card of stranded) {
            const point = generated[card.id] ?? DEFAULT_NODE_POSITION
            nextPositions[card.id] = point
            missing.push({ card_id: card.id, canvas_id: canvasId, ...point })
          }
        }
      }

      setPositions(nextPositions)
      setLayoutCardIds(scopedIds)
      setLayoutScope(canvasId)
      setSelectedIds(new Set())
      setHasLoaded(true)
      // 让 PDF 建卡侧立刻能读到当前视口中心（首屏 fitView 之后也要更新）。
      window.requestAnimationFrame(() => publishViewportCenter())
      timings.compute = Math.round(performance.now() - perfStart)
      // 只在内存里留一份加载耗时，供性能回归读取；不打印，避免生产环境刷控制台。
      window.requestAnimationFrame(() => {
        ;(window as unknown as { __mindmapPerf?: unknown }).__mindmapPerf = {
          ...timings,
          paint: Math.round(performance.now() - perfStart),
          cards: latestCards.length,
        }
      })

      // 首屏只在小图上自动适配；几千张卡铺满屏幕会把缩放压到下限，什么都看不清，
      // 因此大图停在左上角（分组根节点所在处），由用户自己决定看哪里。
      if (!compact && !initialFitRef.current) {
        initialFitRef.current = true
        if (latestCards.length > AUTO_FIT_NODE_LIMIT) {
          setNotice(`这个画布有 ${latestCards.length} 个节点，已停在左上角；拖动画布或点「适应视图」查看全图。`)
        } else {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            fitReadable(0)
          }))
        }
      }

      if (missing.length) await saveMindmapLayout(missing)
      return [...scopedIds]
    } catch (reason) {
      setError(`脑图加载失败：${errorMessage(reason)}`)
      return []
    } finally {
      setLoading(false)
    }
  }, [canvasId, compact, documentId, fitReadable, loadCards, publishViewportCenter])

  /**
   * 打开文档时先确定画布归属（在加载卡片之前）：
   * 1. 用户选过的画布优先 —— 下次打开自动关联同一张；
   * 2. 否则用这本书最新的专属画布；
   * 3. 升级前导入的书没有专属画布、且从未选过 → 补建一张，名字用文档标题。
   *
   * 之前这里默认回落到 main（全局画布），而 main 里往往是上一本书的 AI 拆书内容，
   * 于是新导入的 PDF 打开看到的是别人的脑图。
   */
  useEffect(() => {
    let cancelled = false
    canvasResolvedRef.current = !documentId
    setCanvasResolved(!documentId)
    if (!documentId) {
      void listMindmapCanvases(null).then((list) => {
        if (cancelled) return
        setCanvases(list)
        const preferred = readCanvasPreference(null)
        const fallback = list.some((canvas) => canvas.id === DEFAULT_CANVAS_ID)
          ? DEFAULT_CANVAS_ID
          : list[0]?.id ?? DEFAULT_CANVAS_ID
        const next = preferred && list.some((canvas) => canvas.id === preferred) ? preferred : fallback
        saveCanvasId(null, next)
        setCanvasId(next)
        canvasResolvedRef.current = true
        setCanvasResolved(true)
      }).catch((reason) => {
        if (cancelled) return
        setError(`画布列表加载失败：${errorMessage(reason)}`)
        canvasResolvedRef.current = true
        setCanvasResolved(true)
      })
      return () => { cancelled = true }
    }

    void (async () => {
      try {
        let list = await listMindmapCanvases(documentId)
        if (cancelled) return
        const own = list.filter((canvas) => canvas.document_id === documentId)
        const preferred = readCanvasPreference(documentId)

        // 只要这本书还没有专属画布就补一张：老版本导入的文档也一样，
        // 否则它们会继续停留在全局 main（上一本书的拆书内容）。
        if (!own.length) {
          const created = await createMindmapCanvas({
            name: documentCanvasName(documentTitle),
            document_id: documentId,
          })
          if (cancelled) return
          list = await listMindmapCanvases(documentId)
          if (cancelled) return
          setCanvases(list)
          saveCanvasId(documentId, created.id)
          setCanvasId(created.id)
          canvasResolvedRef.current = true
          setCanvasResolved(true)
          return
        }

        setCanvases(list)
        const latestOwn = own
          .slice()
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
        const next = (preferred && list.some((canvas) => canvas.id === preferred) ? preferred : null)
          ?? latestOwn?.id
          ?? list.find((canvas) => canvas.id === DEFAULT_CANVAS_ID)?.id
          ?? list[0]?.id
          ?? DEFAULT_CANVAS_ID
        saveCanvasId(documentId, next)
        setCanvasId(next)
        canvasResolvedRef.current = true
        setCanvasResolved(true)
      } catch (reason) {
        if (cancelled) return
        setError(`画布列表加载失败：${errorMessage(reason)}`)
        canvasResolvedRef.current = true
        setCanvasResolved(true)
      }
    })()
    return () => { cancelled = true }
  }, [documentId, documentTitle])

  useEffect(() => {
    if (!canvasResolved) return
    void refresh()
  }, [canvasResolved, refresh])

  /** PDF 建卡、AI 拆书、Anki 导入等外部写入后重新读取当前画布成员。 */
  useEffect(() => {
    const reload = () => { void refresh() }
    window.addEventListener(MINDMAP_CHANGED_EVENT, reload)
    return () => window.removeEventListener(MINDMAP_CHANGED_EVENT, reload)
  }, [refresh])

  useEffect(() => {
    const reloadLinks = () => {
      void listCardLinks().then(setLinks).catch(() => undefined)
    }
    window.addEventListener('pdfnote:links-changed', reloadLinks)
    return () => window.removeEventListener('pdfnote:links-changed', reloadLinks)
  }, [])

  // 分栏模式下新建的卡片不会重新挂载脑图，这里为缺少坐标的卡片补一次树形布局。
  // 切换画布期间 layoutScope 还没跟上，必须跳过，否则会把旧画布的卡片写进新画布。
  useEffect(() => {
    if (!hasLoaded || layoutScope !== canvasId) return
    const missing = cards.filter((card) => !positions[card.id])
    if (!missing.length) return

    // 新卡优先落在当前视口中心；没有视口信息时才退回「贴父节点 / 排到下方」。
    let points: Record<string, Point>
    const insert = readMindmapViewportCenter() ? nextMindmapInsertPoint() : undefined
    if (insert) {
      points = {}
      missing.forEach((card, index) => {
        points[card.id] = index === 0 ? insert : { x: insert.x, y: insert.y + index * 210 }
      })
    } else if (cards.length > AUTO_FIT_NODE_LIMIT) {
      let maxY = 0
      for (const point of Object.values(positions)) maxY = Math.max(maxY, point.y)
      points = {}
      missing.forEach((card, index) => {
        const parent = card.parent_id ? positions[card.parent_id] : undefined
        points[card.id] = parent
          ? { x: parent.x + TREE_X_GAP, y: parent.y + (index + 1) * 80 }
          : { x: 80, y: maxY + TREE_Y_GAP * (index + 1) }
      })
    } else {
      points = buildTreeLayout(cards)
    }

    const fallback = { x: 80, y: 80 }
    setPositions((current) => {
      const next = { ...current }
      missing.forEach((card) => {
        next[card.id] = points[card.id] ?? fallback
      })
      return next
    })
    void saveMindmapLayout(missing.map((card) => ({
      card_id: card.id,
      canvas_id: canvasId,
      ...(points[card.id] ?? fallback),
    }))).catch(() => undefined)
  }, [canvasId, cards, hasLoaded, layoutScope, positions])

  const selectCanvas = useCallback((id: string) => {
    if (id === canvasId) return
    // 换画布相当于换了一块桌面：新卡重新从视口正中心开始。
    resetMindmapInsertSequence()
    saveCanvasId(documentId, id)
    setCanvasId(id)
    setNotice(`已切换到「${canvases.find((canvas) => canvas.id === id)?.name ?? id}」。`)
  }, [canvasId, canvases, documentId])

  const handleCanvasesChanged = useCallback((list: MindmapCanvas[], activeId?: string) => {
    setCanvases(list)
    const target = activeId ?? canvasId
    const resolved = list.some((canvas) => canvas.id === target)
      ? target
      : list.find((canvas) => canvas.id === DEFAULT_CANVAS_ID)?.id ?? DEFAULT_CANVAS_ID
    saveCanvasId(documentId, resolved)
    setCanvasId(resolved)
  }, [canvasId, documentId])

  /** Anki 导入在后端单事务建树；小图刷新后整理并对齐视口，上千张时不再全量重排。 */
  const handleAnkiImported = useCallback((result: AnkiImportResult) => {
    setAnkiOpen(false)
    void refresh().then((scopedIds) => {
      const scoped = new Set(scopedIds)
      const latest = Object.values(useCardStore.getState().cardsById)
        .filter((card) => card.surface_mindmap && scoped.has(card.id))
      const summary = `已导入 ${result.imported} 张卡片、${result.groups} 个分组，跳过 ${result.skipped} 张重复题目。`
      // 上千张卡时后端已经按牌组层级给了坐标；再全量重排 + 写回 1400 多行布局既慢，
      // fitView 之后缩放也会被压到下限，不如停在左上角让用户自己逛。
      if (latest.length > AUTO_FIT_NODE_LIMIT) {
        setNotice(`${summary} 画布节点较多，已停在左上角，拖动画布或用「适应视图」查看。`)
        return
      }
      setNotice(summary)
      const arranged = buildTreeLayout(latest)
      void saveMindmapLayout(Object.entries(arranged).map(([cardId, point]) => ({
        card_id: cardId,
        canvas_id: canvasId,
        ...point,
      }))).then(() => {
        setPositions((current) => ({ ...current, ...arranged }))
        if (arrangeTimerRef.current !== null) window.clearTimeout(arrangeTimerRef.current)
        arrangeTimerRef.current = window.setTimeout(() => {
          arrangeTimerRef.current = null
          fitReadable(320)
        }, 160)
      }).catch((reason) => setError(`导入成功但布局整理失败：${errorMessage(reason)}`))
    })
    onCardsChanged()
  }, [canvasId, fitReadable, onCardsChanged, refresh])

  const syncCards = useCallback(async () => {
    await loadCards()
    onCardsChanged()
  }, [loadCards, onCardsChanged])

  const runTask = useCallback(async (task: () => Promise<void>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await task()
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    } finally {
      setBusy(false)
    }
  }, [busy])

  const persistPositions = useCallback(async (items: Array<{ id: string; position: Point }>) => {
    if (!items.length || layoutScope !== canvasId) return
    await saveMindmapLayout(items.map((item) => ({
      card_id: item.id,
      canvas_id: canvasId,
      x: item.position.x,
      y: item.position.y,
    })))
    setPositions((current) => {
      const next = { ...current }
      for (const item of items) next[item.id] = item.position
      return next
    })
  }, [canvasId, layoutScope])

  const selectionFrameRef = useRef<number | null>(null)
  const pendingSelectRef = useRef<Array<{ id: string; selected: boolean }>>([])

  /**
   * 受控 nodes 模式下，选中必须由父组件应用 select change，React Flow 不会自己改。
   * 但它们不能在 React Flow 的更新阶段同步 setState（切换视图时会形成 #185），
   * 因此合并到下一帧，并保持内容比较。
   */
  const queueSelection = useCallback((items: Array<{ id: string; selected: boolean }>) => {
    pendingSelectRef.current.push(...items)
    if (selectionFrameRef.current !== null) return
    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = null
      const batch = pendingSelectRef.current
      pendingSelectRef.current = []
      setSelectedIds((current) => {
        let next: Set<string> | null = null
        for (const item of batch) {
          if (current.has(item.id) === item.selected) continue
          if (!next) next = new Set(current)
          if (item.selected) next.add(item.id)
          else next.delete(item.id)
        }
        return next ?? current
      })
    })
  }, [])

  useEffect(() => () => {
    if (selectionFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = null
    }
  }, [queueSelection])

  const handleNodesChange = useCallback((changes: NodeChange<MindmapFlowNode>[]) => {
    const selectChanges = changes.filter(
      (change): change is NodeChange<MindmapFlowNode> & { type: 'select'; id: string; selected: boolean } =>
        change.type === 'select',
    )
    if (selectChanges.length) {
      queueSelection(selectChanges.map((change) => ({ id: change.id, selected: change.selected })))
    }

    // 拖拽过程中 React Flow 自己维护节点位置。若同时把位置回写到 props，
    // StoreUpdater 会与拖拽状态互相触发，形成 React #185；松手后统一落盘。
    setPositions((current) => {
      let next = current
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue
        if (change.dragging) continue
        const previous = next[change.id]
        if (previous
          && Math.abs(previous.x - change.position.x) < 0.01
          && Math.abs(previous.y - change.position.y) < 0.01) {
          continue
        }
        if (next === current) next = { ...current }
        next[change.id] = change.position
      }
      // 返回同一引用，避免“测量 → 位置回写 → 重新测量”的无意义循环。
      return next
    })

    // 交互期间（平移 / 缩放 / 拖拽）只缓冲尺寸，不 setState：
    // 每次回写都会重建整张 nodes 并让 React Flow 重新 adopt 1483 个节点。
    const dimensionChanges = changes.filter(
      (change): change is NodeChange<MindmapFlowNode> & {
        type: 'dimensions'
        id: string
        dimensions: { width: number; height: number }
      } => change.type === 'dimensions' && Boolean(change.dimensions),
    )
    if (interactingRef.current || liteRef.current) {
      // 交互期间先不写；低缩放（lite）下节点只剩标题条，尺寸变化没有意义，
      // 直接丢弃 —— 否则缩放结束时一次 flush 会让 React Flow 重新 adopt 上千个节点。
      if (!liteRef.current) {
        for (const change of dimensionChanges) {
          const dimensions = change.dimensions
          if (dimensions.width < 2 || dimensions.height < 2) continue
          pendingMeasureRef.current[change.id] = {
            width: dimensions.width,
            height: dimensions.height,
          }
        }
      }
    } else if (dimensionChanges.length) {
      setMeasuredSizes((current) => {
        const now = Date.now()
        if (now - measuredBurstRef.current.windowStart > 1000) {
          measuredBurstRef.current = { windowStart: now, count: 0 }
        }
        let next = current
        for (const change of changes) {
          if (change.type !== 'dimensions' || !change.dimensions) continue
          const { width, height } = change.dimensions
          // 容器尚未布局时测量值是 0，回写后 React Flow 会立刻重新测量，容易成环。
          if (width < 2 || height < 2) continue
          if (measuredBurstRef.current.count > 60) break
          const previous = next[change.id]
          // 只同步首次测量与明显布局变化（折叠展开等）。几像素的抖动一律忽略：
          // 每次回写都会重建整个 nodes 数组并触发 React Flow 重新测量。
          if (previous
            && Math.abs(previous.width - width) <= 24
            && Math.abs(previous.height - height) <= 24) {
            continue
          }
          if (next === current) next = { ...current }
          next[change.id] = { width, height }
          measuredBurstRef.current.count += 1
        }
        return next
      })
    }
  }, [queueSelection])


  const changeParent = useCallback(async (cardId: string, parentId: string | null) => {
    const latest = useCardStore.getState().cardsById[cardId]
    if (!latest || latest.parent_id === parentId || cardId === parentId) return
    await runTask(async () => {
      const sortOrder = nextSortOrder(
        Object.values(useCardStore.getState().cardsById).filter((card) => card.surface_mindmap && card.id !== cardId),
        parentId,
      )
      // Cycle rejection is deliberately owned by the backend moveCard transaction.
      await moveCard(cardId, parentId, sortOrder)
      await syncCards()
      setNotice(parentId ? '已建立新的父子关系。' : '已移动为独立节点。')
    })
  }, [runTask, syncCards])

  const handleConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return
    void changeParent(connection.target, connection.source)
  }, [changeParent])

  const handleNodeDragStop: OnNodeDrag<MindmapFlowNode> = useCallback((_event, draggedNode, draggedNodes) => {
    // 拖拽期间尺寸只进了缓冲，松手这里统一写回一次。
    endInteraction()
    const batch = draggedNodes.length
      ? draggedNodes
      : nodes.filter((node) => node.id === draggedNode.id || node.selected)
    const dropTarget = getIntersectingNodes(draggedNode).find((node) => node.id !== draggedNode.id)

    // 只是挪了位置：直接落盘，不占「忙碌」锁。
    // 占锁会把 `busy` 写进 context 与 `nodesDraggable`，一次拖拽触发两轮全画布重渲染。
    if (!dropTarget) {
      void persistPositions(batch)
        .then(() => setNotice(`已保存 ${batch.length} 个节点坐标。`))
        .catch((reason) => setError(errorMessage(reason)))
      return
    }

    void runTask(async () => {
      await persistPositions(batch)
      const latest = useCardStore.getState().cardsById[draggedNode.id]
      if (latest && latest.parent_id !== dropTarget.id) {
        const latestCards = Object.values(useCardStore.getState().cardsById).filter(
          (card) => card.surface_mindmap && card.id !== draggedNode.id,
        )
        await moveCard(draggedNode.id, dropTarget.id, nextSortOrder(latestCards, dropTarget.id))
        await syncCards()
        setNotice(`已保存 ${batch.length} 个节点坐标，并更新父级。`)
        return
      }
      setNotice(`已保存 ${batch.length} 个节点坐标。`)
    })
  }, [endInteraction, getIntersectingNodes, nodes, persistPositions, runTask, syncCards])

  // 整理后要等 React Flow 应用新坐标，再对齐视口；否则用户仍停在旧的缩放/平移上，
  // 看起来像「卡片没有聚拢」。卸载时清掉定时器，避免对已销毁实例调用 fitView。
  useEffect(() => () => {
    if (arrangeTimerRef.current !== null) window.clearTimeout(arrangeTimerRef.current)
  }, [])

  const autoArrange = useCallback(() => {
    if (!cards.length || layoutScope !== canvasId) return
    const arranged = buildTreeLayout(cards)
    void runTask(async () => {
      await saveMindmapLayout(cards.map((card) => ({
        card_id: card.id,
        canvas_id: canvasId,
        ...arranged[card.id],
      })))
      setPositions((current) => ({ ...current, ...arranged }))
      if (arrangeTimerRef.current !== null) window.clearTimeout(arrangeTimerRef.current)
      arrangeTimerRef.current = window.setTimeout(() => {
        arrangeTimerRef.current = null
        fitReadable(320)
      }, 120)
      setNotice(`已整理并保存 ${cards.length} 个节点，视图已对齐。`)
    })
  }, [canvasId, cards, fitReadable, layoutScope, runTask])

  const saveSelected = useCallback(() => {
    const selected = nodes.filter((node) => selectedIds.has(node.id))
    if (!selected.length) {
      setNotice('请先选择一个或多个节点。拖动空白处可框选。')
      return
    }
    void runTask(async () => {
      await persistPositions(selected)
      setNotice(`已批量保存 ${selected.length} 个节点坐标。`)
    })
  }, [nodes, persistPositions, runTask, selectedIds])

  const saveEditor = useCallback(async (draft: CardDraft) => runTask(async () => {
    if (editor === 'new') {
      const latestCards = cards
      const card = await createCardInStore({
        ...draft,
        canvas_id: canvasId,
        sort_order: nextSortOrder(latestCards, null),
      })
      // 新卡落在当前视口中心（而不是画布左下角），连续建卡按 3×3 环错开。
      const point = nextMindmapInsertPoint() ?? {
        x: 80,
        y: Math.max(80, ...Object.values(positions).map((value) => value.y + TREE_Y_GAP)),
      }
      setPositions((current) => ({ ...current, [card.id]: point }))
      setEditor(null)
      try {
        await saveMindmapLayout([{ card_id: card.id, canvas_id: canvasId, ...point }])
      } catch (reason) {
        await syncCards()
        throw new Error(`卡片已创建，但坐标保存失败：${errorMessage(reason)}`)
      }
      setLayoutCardIds((current) => new Set(current).add(card.id))
      await syncCards()
      setNotice('独立卡片已创建。')
      return
    }

    if (!editor) return
    await updateCardContent({ id: editor, ...draft })
    await syncCards()
    setEditor(null)
    setNotice('卡片内容已同步到三个视图。')
  }), [canvasId, cards, createCardInStore, editor, positions, runTask, syncCards])

  const toggleCard = useCallback(async (id: string) => {
    const card = useCardStore.getState().cardsById[id]
    if (!card || busy) return
    const nextCollapsed = recallActive ? recallExpandedIds.has(id) : !card.collapsed

    if (recallActive) {
      setRecallExpandedIds((current) => {
        const next = new Set(current)
        if (nextCollapsed) next.delete(id)
        else next.add(id)
        return next
      })
    }

    await runTask(async () => {
      try {
        await setCardCollapsed(id, nextCollapsed)
        await syncCards()
      } catch (reason) {
        if (recallActive) {
          setRecallExpandedIds((current) => {
            const next = new Set(current)
            if (nextCollapsed) next.add(id)
            else next.delete(id)
            return next
          })
        }
        throw reason
      }
    })
  }, [busy, recallActive, recallExpandedIds, runTask, syncCards])

  const startRecall = useCallback(() => {
    sessionId.current = crypto.randomUUID()
    setRecallExpandedIds(new Set())
    setRevealedIds(new Set())
    setRatedIds(new Set())
    setRatingPendingIds(new Set())
    setRecallErrors({})
    setSelectedIds(new Set())
    setRecallActive(true)
    setNotice('主动回忆已开始：先回忆问题，再显示答案并评分。')
    setError('')
  }, [])

  const stopRecall = useCallback(() => {
    setRecallActive(false)
    setRecallErrors({})
    setRatingPendingIds(new Set())
    setNotice('已退出主动回忆；评分结果仍保留在卡片中。')
  }, [])

  const revealAnswer = useCallback((id: string) => {
    setRevealedIds((current) => new Set(current).add(id))
  }, [])

  const revealNext = useCallback(() => {
    const nextAnswer = orderedVisibleCards.find((card) => !revealedIds.has(card.id))
    if (nextAnswer) {
      revealAnswer(nextAnswer.id)
      return
    }
    const nextLevel = orderedVisibleCards.find((card) => parentIds.has(card.id) && collapsedIds.has(card.id))
    if (nextLevel) {
      void toggleCard(nextLevel.id)
      return
    }
    setNotice('当前可见分支已全部揭示。可展开其他分支继续。')
  }, [collapsedIds, orderedVisibleCards, parentIds, revealAnswer, revealedIds, toggleCard])

  const rateCard = useCallback(async (id: string, rating: Rating) => {
    if (ratedIds.has(id) || ratingPendingIds.has(id) || !revealedIds.has(id)) return
    setRatingPendingIds((current) => new Set(current).add(id))
    setRecallErrors((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })

    try {
      const latest = useCardStore.getState().cardsById[id]
      if (!latest) throw new Error('卡片已不存在，无法评分。')
      await reviewCard(latest, rating, 'mindmap_recall', sessionId.current)
      // Mark first: even if refreshing fails, this session will not double-review the card.
      setRatedIds((current) => new Set(current).add(id))
      try {
        await syncCards()
      } catch (reason) {
        setRecallErrors((current) => ({
          ...current,
          [id]: `评分已保存，但视图同步失败：${errorMessage(reason)}`,
        }))
      }
    } catch (reason) {
      // Errors stay on this card; siblings and descendants are never changed.
      setRecallErrors((current) => ({ ...current, [id]: `评分失败：${errorMessage(reason)}` }))
    } finally {
      setRatingPendingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }, [ratedIds, ratingPendingIds, revealedIds, syncCards])

  const toggleOutlineCollapse = useCallback((id: string) => {
    const card = useCardStore.getState().cardsById[id]
    if (!card || busy) return
    void runTask(async () => {
      await setCardCollapsed(id, !card.collapsed)
      await syncCards()
    })
  }, [busy, runTask, syncCards])

  const beginOutlineEdit = useCallback((card: Card) => {
    if (busy) return
    outlineEditingRef.current = card.id
    setOutlineEditing(card.id)
    // 行里显示的是「问题 → 摘录 → 笔记」第一个非空字段，编辑也改同一处。
    setOutlineDraft(card[outlineEditField(card)])
    setOutlineFocusTick((value) => value + 1)
  }, [busy])

  const cancelOutlineEdit = useCallback(() => {
    outlineEditingRef.current = null
    setOutlineEditing(null)
    setOutlineDraft('')
  }, [])

  /**
   * 提交行内编辑。`discardEmpty` 只给 blur 用：新建的空行没填内容就离开时删掉，
   * 避免留下一堆「未命名卡片」。回车/缩进主动提交时不删，防止刚建的行被顺手带走。
   */
  const saveOutlineEdit = useCallback(async (discardEmpty: boolean) => {
    const id = outlineEditingRef.current
    if (!id) return
    outlineEditingRef.current = null
    setOutlineEditing(null)
    // 直接读 DOM 值：快速输入后立刻按 Tab/回车时，state 可能还没提交到这次回调。
    const draft = (outlineInputRef.current?.value ?? outlineDraft).trim()
    setOutlineDraft('')
    const card = useCardStore.getState().cardsById[id]
    if (!card) return
    const field = outlineEditField(card)
    const current = card[field].trim()
    if (draft === current) return
    try {
      if (!draft && discardEmpty && !card.question.trim() && !card.excerpt.trim() && !card.user_note.trim()) {
        await deleteCard(id)
        await syncCards()
        setNotice('已移除空行。')
        return
      }
      const content = {
        id,
        question: card.question,
        excerpt: card.excerpt,
        user_note: card.user_note,
      }
      content[field] = draft
      await updateCardContent({
        ...content,
        link_aliases: card.link_aliases,
      })
      await syncCards()
    } catch (reason) {
      setError(`标题保存失败：${errorMessage(reason)}`)
    }
  }, [deleteCard, outlineDraft, syncCards])

  /** 回车新建：同级插到当前行后面，⌘/Ctrl+回车挂到当前行下面。 */
  const createOutlineCard = useCallback(async (baseId: string, mode: 'sibling' | 'child') => {
    if (busy) return
    const base = useCardStore.getState().cardsById[baseId]
    if (!base) return
    const parentId = mode === 'child' ? base.id : base.parent_id
    const anchor = (parentId ? positions[parentId] : undefined)
      ?? positions[base.id]
      ?? readMindmapViewportCenter()
    const point = anchor ? { x: anchor.x + TREE_X_GAP, y: anchor.y + TREE_Y_GAP } : undefined
    try {
      const created = await createCardInStore({
        question: '',
        parent_id: parentId ?? undefined,
        sort_order: 0,
        canvas_id: canvasId,
        x: point?.x,
        y: point?.y,
      })
      const plan = mode === 'child'
        ? insertChildPlan(cards, base.id, created.id)
        : insertAfterPlan(cards, base.id, created.id)
      if (plan) await applyCardOrder(plan)
      setLayoutCardIds((current) => new Set(current).add(created.id))
      if (point) setPositions((current) => ({ ...current, [created.id]: point }))
      await syncCards()
      outlineEditingRef.current = created.id
      setOutlineEditing(created.id)
      setOutlineDraft('')
      setOutlineFocusTick((value) => value + 1)
      setNotice(mode === 'child' ? '已新建子级，继续输入标题。' : '已新建同级卡片，继续输入标题。')
    } catch (reason) {
      setError(`新建卡片失败：${errorMessage(reason)}`)
    }
  }, [busy, canvasId, cards, createCardInStore, positions, syncCards])

  const moveOutlineCard = useCallback(async (id: string, kind: 'indent' | 'outdent') => {
    const plan = kind === 'indent' ? indentPlan(cards, id) : outdentPlan(cards, id)
    if (!plan) {
      setNotice(kind === 'indent' ? '已经是第一个子节点，无法再缩进。' : '已经是顶层，无法再提升。')
      return
    }
    await runTask(async () => {
      await applyCardOrder(plan)
      await syncCards()
      setNotice(kind === 'indent' ? '已缩进为上一项的子级。' : '已提升一级。')
    })
  }, [cards, runTask, syncCards])

  const handleOutlineKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法用回车确认候选词时不能建行。
    if (event.nativeEvent.isComposing) return
    const id = outlineEditingRef.current
    if (!id) return

    if (event.key === 'Enter') {
      event.preventDefault()
      const mode = event.metaKey || event.ctrlKey ? 'child' : 'sibling'
      const card = useCardStore.getState().cardsById[id]
      const draft = (outlineInputRef.current?.value ?? outlineDraft).trim()
      // 空行再回车没有意义：留在原地，避免连出空卡片。
      if (!draft && card && !card.question.trim() && !card.excerpt.trim() && !card.user_note.trim()) return
      void (async () => {
        await saveOutlineEdit(false)
        await createOutlineCard(id, mode)
      })()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelOutlineEdit()
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      const direction = event.shiftKey ? 'outdent' : 'indent'
      const draft = outlineInputRef.current?.value ?? outlineDraft
      void (async () => {
        await saveOutlineEdit(false)
        await moveOutlineCard(id, direction)
        // 缩进后行会换位置，重新挂载输入框并把文本带回去。
        outlineEditingRef.current = id
        setOutlineDraft(draft)
        setOutlineEditing(id)
        setOutlineFocusTick((value) => value + 1)
      })()
    }
  }, [cancelOutlineEdit, createOutlineCard, moveOutlineCard, outlineDraft, saveOutlineEdit])

  const handleOutlineDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, card: Card) => {
    if (busy || outlineEditing) return
    outlineDragRef.current = card.id
    // 后代集合只在开始拖时算一次；dragover 高频触发，不能每次扫全表。
    outlineDragDescendants.current = collectDescendants(buildChildMap(cards), card.id)
    setOutlineDrag(card.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', card.id)
  }, [busy, cards, outlineEditing])

  const handleOutlineDragOver = useCallback((event: React.DragEvent<HTMLDivElement>, card: Card) => {
    const dragId = outlineDragRef.current
    if (!dragId || dragId === card.id || outlineDragDescendants.current.has(card.id)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    const position: DropPosition = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside'
    if (outlineDrop?.id !== card.id || outlineDrop.position !== position) {
      setOutlineDrop({ id: card.id, position })
    }
  }, [outlineDrop])

  const handleOutlineDrop = useCallback((event: React.DragEvent<HTMLDivElement>, card: Card) => {
    event.preventDefault()
    const dragId = outlineDragRef.current
    const position = outlineDrop?.id === card.id ? outlineDrop.position : 'after'
    outlineDragRef.current = null
    setOutlineDrag(null)
    setOutlineDrop(null)
    if (!dragId || dragId === card.id) return
    const plan = dropPlan(cards, dragId, card.id, position)
    if (!plan) {
      setNotice('不能把卡片移动到它自己的子级下面。')
      return
    }
    void runTask(async () => {
      await applyCardOrder(plan)
      await syncCards()
      setNotice('已调整大纲结构。')
    })
  }, [cards, outlineDrop, runTask, syncCards])

  const endOutlineDrag = useCallback(() => {
    outlineDragRef.current = null
    setOutlineDrag(null)
    setOutlineDrop(null)
  }, [])

  // 新建 / 缩进后重新聚焦输入框（行在列表里换了位置，DOM 会被移动）。
  useEffect(() => {
    if (!outlineEditing) return
    const frame = window.requestAnimationFrame(() => {
      const input = outlineInputRef.current
      if (!input) return
      input.focus()
      input.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [outlineEditing, outlineFocusTick])

  const handleExportMarkdown = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const forest = buildOutlineForest(cards)
      if (!forest.length) throw new Error('当前脑图没有可导出的卡片')
      const markdown = outlineToMarkdown(forest)
      const filename = `知识脑图-${new Date().toISOString().slice(0, 10)}.md`
      if (isTauriRuntime()) {
        const target = await saveDialog({
          defaultPath: filename,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        })
        if (!target) return
        await exportMarkdownFile(target, markdown)
        setNotice(`已导出 Markdown：${target}`)
      } else {
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        URL.revokeObjectURL(url)
        setNotice('已下载 Markdown 文件。')
      }
    } catch (reason) {
      setError(`导出失败：${errorMessage(reason)}`)
    } finally {
      setExporting(false)
    }
  }, [cards, exporting])

  const confirmOperation = useCallback(() => {
    if (!confirmation) return
    const { id, kind } = confirmation
    void runTask(async () => {
      if (kind === 'remove') await removeFromMindmap(id, canvasId)
      else await deleteCard(id)

      setPositions((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setLayoutCardIds((current) => {
        if (!current.has(id)) return current
        const next = new Set(current)
        next.delete(id)
        return next
      })
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      setConfirmation(null)
      if (editor === id) setEditor(null)
      await syncCards()
      void listMindmapCanvases(documentId ?? null).then(setCanvases).catch(() => undefined)
      setNotice(kind === 'remove'
        ? `已从「${canvasName}」移除，其他画布与 PDF / 复习投影保持不变。`
        : '卡片已彻底删除（所有画布上的布局一并移除）。')
    })
  }, [canvasId, canvasName, confirmation, deleteCard, documentId, editor, removeFromMindmap, runTask, syncCards])

  /** 批量清空：后端单事务完成后，本地把当前画布的投影、坐标、选中与弹窗一次性复位。 */
  const clearAllCards = useCallback((mode: ClearCardsMode) => {
    void runTask(async () => {
      const count = await clearMindmapCards(mode, canvasId)
      setPositions({})
      setMeasuredSizes({})
      setLayoutCardIds(new Set())
      setSelectedIds(new Set())
      setLinks([])
      setConfirmation(null)
      setEditor(null)
      setClearOpen(false)
      setViewMode('canvas')
      await syncCards()
      void listMindmapCanvases(documentId ?? null).then(setCanvases).catch(() => undefined)
      setNotice(mode === 'remove'
        ? `已清空当前画布的 ${count} 张卡片，其他画布与 PDF / 复习投影仍保留。`
        : `已彻底删除当前画布的 ${count} 张卡片及其标注、复习记录。`)
    })
  }, [canvasId, documentId, runTask, syncCards])

  const copyToClipboard = (text: string) => {
    if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  /** 节点与大纲行共用一套卡片操作，仅折叠行为与视图项不同。 */
  const cardMenuSections = (
    cardId: string,
    options: { toggleLabel: string; onToggle: () => void; canToggle: boolean; includeWorkspace: boolean },
  ): ContextMenuSection[] => {
    const title = titleOf(cardsById[cardId])
    const sections: ContextMenuSection[] = [
      { id: 'card', items: [
        { id: 'edit', label: '编辑卡片', icon: Pencil, disabled: busy, onSelect: () => setEditor(cardId) },
        { id: 'copy', label: '复制卡片标题', icon: Copy, onSelect: () => copyToClipboard(title) },
        { id: 'toggle', label: options.toggleLabel, icon: ChevronRight, disabled: !options.canToggle || busy, onSelect: options.onToggle },
        { id: 'explain', label: 'AI 解析这个问题', icon: Sparkles, disabled: busy || !cardsById[cardId]?.question.trim(), onSelect: () => void explainCard(cardId) },
      ] },
      { id: 'relations', title: '卡片关系', items: [
        { id: 'tags', label: '编辑标签…', icon: Tag, onSelect: () => setTagTarget(cardId) },
        { id: 'link', label: '关联其他卡片…', icon: Link2, onSelect: () => setLinkTarget(cardId) },
        { id: 'merge', label: '合并所选卡片…', icon: Merge, disabled: selectedIds.size < 2 || busy, onSelect: () => setMergeOpen(true) },
      ] },
      { id: 'appearance', title: '外观', items: [
        // 样式是画布级的（一本书一套风格），不属于单张卡片，所以只留一个入口。
        { id: 'style', label: '卡片样式…', icon: Palette, hint: currentTheme.name, onSelect: () => { setEditor(null); setStyleTarget(cardId); setStyleOpen(true) } },
      ] },
      { id: 'danger', items: [
        { id: 'remove', label: '从脑图移除', icon: LayoutGrid, disabled: busy, onSelect: () => setConfirmation({ kind: 'remove', id: cardId }) },
        { id: 'delete', label: '彻底删除卡片', icon: Trash2, danger: true, disabled: busy, onSelect: () => setConfirmation({ kind: 'delete', id: cardId }) },
      ] },
    ]
    if (options.includeWorkspace) {
      sections.push({ id: 'workspace', title: '工作区', items: [
        { id: 'outline', label: '切换到大纲', icon: ListTree, onSelect: () => setViewMode('outline') },
        { id: 'export', label: '导出 Markdown', icon: Download, onSelect: () => void handleExportMarkdown() },
      ] })
    }
    return sections
  }

  const handleNodeContextMenu = (event: React.MouseEvent, node: MindmapFlowNode) => {
    const card = cardsById[node.id]
    if (!card) return
    const collapsed = collapsedIds.has(card.id)
    show(event, {
      title: titleOf(card),
      sections: cardMenuSections(card.id, {
        toggleLabel: collapsed ? '展开子节点' : '折叠子节点',
        onToggle: () => void toggleCard(card.id),
        canToggle: parentCardIds.has(card.id),
        includeWorkspace: true,
      }),
    })
  }

  const handleOutlineContextMenu = (event: React.MouseEvent, card: Card) => {
    const collapsed = outlineCollapsedIds.has(card.id)
    show(event, {
      title: outlineTitle(card),
      sections: [
        ...cardMenuSections(card.id, {
          toggleLabel: collapsed ? '展开子节点' : '折叠子节点',
          onToggle: () => toggleOutlineCollapse(card.id),
          canToggle: parentCardIds.has(card.id),
          includeWorkspace: false,
        }),
        { id: 'outline-view', title: '视图', items: [
          { id: 'canvas', label: '返回画布', icon: LayoutGrid, onSelect: () => setViewMode('canvas') },
          { id: 'export', label: '导出 Markdown', icon: Download, onSelect: () => void handleExportMarkdown() },
        ] },
      ],
    })
  }

  const handlePaneContextMenu = (event: React.MouseEvent | MouseEvent) => {
    show(event, {
      title: '脑图画布',
      sections: [
        { id: 'canvas', items: [
          { id: 'new', label: '新建独立卡片', icon: Plus, disabled: busy, onSelect: () => setEditor('new') },
          { id: 'anki', label: '导入 Anki 牌组…', icon: FileText, disabled: busy, onSelect: () => setAnkiOpen(true) },
          { id: 'refresh', label: '刷新脑图', icon: RefreshCw, onSelect: () => void refresh() },
          { id: 'arrange', label: '自动整理节点', icon: Focus, disabled: busy || !cards.length, onSelect: autoArrange },
          { id: 'fit', label: '适应视图', icon: Maximize, disabled: !cards.length, onSelect: () => fitReadable(320) },
          { id: 'save', label: '保存所选布局', icon: LayoutGrid, disabled: busy || selectedIds.size === 0, onSelect: saveSelected },
          { id: 'clear', label: '清空脑图卡片…', icon: Trash2, danger: true, disabled: busy || !cards.length, onSelect: () => setClearOpen(true) },
        ] },
        { id: 'view', title: '视图', items: [
          { id: 'outline', label: '切换到大纲', icon: ListTree, onSelect: () => setViewMode('outline') },
          { id: 'export', label: '导出 Markdown', icon: Download, onSelect: () => void handleExportMarkdown() },
          { id: 'recall', label: recallActive ? '结束主动回忆' : '开始主动回忆', icon: Sparkles, checked: recallActive, disabled: !recallActive && !cards.length, onSelect: recallActive ? stopRecall : startRecall },
        ] },
      ],
    })
  }

  const handleOutlinePaneContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    show(event, {
      title: '大纲视图',
      sections: [{ id: 'outline', items: [
        { id: 'canvas', label: '返回画布', icon: LayoutGrid, onSelect: () => setViewMode('canvas') },
        { id: 'new', label: '新建独立卡片', icon: Plus, disabled: busy, onSelect: () => setEditor('new') },
        { id: 'export', label: '导出 Markdown', icon: Download, onSelect: () => void handleExportMarkdown() },
      ] }],
    })
  }

  const editingCard = editor && editor !== 'new' ? cardsById[editor] : null
  const confirmationCard = confirmation ? cardsById[confirmation.id] : undefined

  /**
   * 节点 context 必须 memo：以前每次渲染都新建对象和内联回调，父组件任何状态
   * （提示条、busy、选中）变化都会让上千个挂载节点全部重渲染。
   */
  const nodeContext = useMemo(() => ({
    busy,
    collapsedIds,
    childCounts,
    lite,
    recallActive,
    revealedIds,
    ratedIds,
    ratingPendingIds,
    recallErrors,
    onEdit: (id: string) => setEditor(id),
    onTag: (id: string) => setTagTarget(id),
    onLink: (id: string) => setLinkTarget(id),
    onToggle: (id: string) => void toggleCard(id),
    onReveal: revealAnswer,
    onRate: (id: string, rating: Rating) => void rateCard(id, rating),
    onRemove: (id: string) => setConfirmation({ kind: 'remove', id }),
    onDelete: (id: string) => setConfirmation({ kind: 'delete', id }),
    onOpenSource: openSource,
    onExplain: (id: string) => void explainCard(id),
    onCycleTone: cycleTone,
  }), [
    busy, childCounts, collapsedIds, cycleTone, explainCard, lite, openSource, rateCard,
    ratedIds, ratingPendingIds, recallActive, recallErrors, revealedIds, revealAnswer, toggleCard,
  ])

  return (
    <MindmapNodeContext.Provider value={nodeContext}>
    <section
      className={`mindmap-workspace${compact ? ' is-embedded' : ''}`}
      data-mm-theme={cardStyle.theme}
      data-mm-surface={resolvedStyle.surface}
      data-mm-radius={resolvedStyle.radius}
      data-mm-density={resolvedStyle.density}
      // 只有偏离主题预设时才写这四个属性，老主题的 CSS 保持原样、观感不变。
      data-mm-header={resolvedStyle.header === currentTheme.header ? undefined : resolvedStyle.header}
      data-mm-edge={resolvedStyle.edge === currentTheme.edge ? undefined : resolvedStyle.edge}
      data-mm-border={resolvedStyle.border === currentTheme.border ? undefined : resolvedStyle.border}
      data-mm-link={resolvedStyle.link === currentTheme.link ? undefined : resolvedStyle.link}
      aria-label="知识脑图工作区"
    >
      {!compact && (
      <header className="mindmap-header">
        <div>
          <span className="mindmap-eyebrow">CARD-CENTRIC KNOWLEDGE MAP</span>
          <h1>知识脑图</h1>
          <p>节点仅引用 Card，让结构、内容与复习状态始终同源。</p>
        </div>
        <div className="mindmap-header-stat">
          <strong>{cards.length}</strong>
          <span>脑图卡片</span>
        </div>
      </header>
      )}

      {!compact && (
      <div className="mindmap-canvas-bar">
        <CanvasSwitcher
          documentId={documentId}
          canvasId={canvasId}
          canvases={canvases}
          busy={busy || switching}
          onSelect={selectCanvas}
          onCanvasesChanged={handleCanvasesChanged}
          onError={setError}
        />
        <button type="button" className="mindmap-import-button" data-testid="anki-open" onClick={() => setAnkiOpen(true)} disabled={busy || switching}>
          导入 Anki 牌组…
        </button>
      </div>
      )}

      {compact && (
        <div className="mindmap-float-canvas">
          <CanvasSwitcher
            compact
            documentId={documentId}
            canvasId={canvasId}
            canvases={canvases}
            busy={busy || switching}
            onSelect={selectCanvas}
            onCanvasesChanged={handleCanvasesChanged}
            onError={setError}
          />
          <button type="button" className="mindmap-import-button" data-testid="anki-open" onClick={() => setAnkiOpen(true)} disabled={busy || switching}>
            导入 Anki
          </button>
        </div>
      )}

      {!compact && (
      <div className="mindmap-toolbar">
        <div className="mindmap-mode-switch" aria-label="工作区模式">
          <button type="button" className={!recallActive ? 'active' : ''} onClick={stopRecall} disabled={!recallActive}>结构编辑</button>
          <button type="button" className={recallActive ? 'active' : ''} onClick={startRecall} disabled={recallActive || !cards.length}>主动回忆</button>
        </div>
        <div className="mindmap-view-switch" aria-label="视图模式">
          <button type="button" className={viewMode === 'canvas' ? 'active' : ''} onClick={() => setViewMode('canvas')} aria-pressed={viewMode === 'canvas'}>画布</button>
          <button type="button" className={viewMode === 'outline' ? 'active' : ''} onClick={() => setViewMode('outline')} aria-pressed={viewMode === 'outline'}>大纲</button>
        </div>
        <div className="mindmap-toolbar-actions">
          {ink.toolbar()}
          <button type="button" onClick={() => void refresh()} disabled={loading || busy}>刷新</button>
          <button type="button" onClick={autoArrange} disabled={busy || !cards.length || viewMode === 'outline'}>自动整理</button>
          <button type="button" onClick={() => fitReadable(320)} disabled={!cards.length || viewMode === 'outline'} title="把视图对准内容；节点很多时只对准前几十个，保证文字可读">适应视图</button>
          <button type="button" onClick={saveSelected} disabled={busy || !cards.length || viewMode === 'outline'}>保存所选布局</button>
          <button type="button" onClick={() => setMergeOpen(true)} disabled={busy || selectedIds.size < 2} title="先多选两张以上卡片">合并所选</button>
          <button type="button" onClick={() => void handleExportMarkdown()} disabled={exporting || !cards.length}>{exporting ? '导出中…' : '导出 MD'}</button>
          <button type="button" className="is-danger" onClick={() => setClearOpen(true)} disabled={busy || !cards.length} title="批量清空脑图卡片">清空卡片</button>
          <button type="button" className="primary" onClick={() => setEditor('new')} disabled={busy}>＋ 新建卡片</button>
        </div>
      </div>
      )}

      {compact && viewMode === 'canvas' && (
        <div className="mindmap-float-actions">
          {ink.toolbar(true)}
          <button type="button" onClick={() => void refresh()} disabled={loading || busy}>刷新</button>
          <button type="button" onClick={() => setViewMode('outline')}>大纲</button>
          <button type="button" onClick={autoArrange} disabled={busy || !cards.length}>整理</button>
          <button type="button" onClick={() => setEditor('new')} disabled={busy}>新建</button>
          <button
            type="button"
            className={recallActive ? 'is-active' : ''}
            onClick={recallActive ? stopRecall : startRecall}
            disabled={!recallActive && !cards.length}
          >
            {recallActive ? '结束回忆' : '主动回忆'}
          </button>
          <button type="button" onClick={() => setMergeOpen(true)} disabled={busy || selectedIds.size < 2}>合并</button>
          <button type="button" onClick={() => void handleExportMarkdown()} disabled={exporting || !cards.length}>{exporting ? '导出中…' : '导出'}</button>
          <button type="button" className="is-danger" onClick={() => setClearOpen(true)} disabled={busy || !cards.length}>清空</button>
        </div>
      )}

      {!compact && recallActive && (
        <div className="mindmap-recall-toolbar">
          <div className="mindmap-recall-status">
            <span className="mindmap-live-dot" />
            <strong>主动回忆会话</strong>
            <span>{ratedIds.size} / {cards.length} 已评分</span>
          </div>
          <label>
            揭示顺序
            <select value={recallSort} onChange={(event) => setRecallSort(event.target.value as MindmapSortMode)}>
              <option value="order">卡片顺序</option>
              <option value="urgency">到期紧迫度</option>
            </select>
          </label>
          <button type="button" onClick={revealNext} disabled={busy}>揭示下一项</button>
          <button type="button" onClick={stopRecall}>结束会话</button>
        </div>
      )}

      {compact && recallActive && (
        <div className="mindmap-float-recall">
          <span>{ratedIds.size} / {cards.length} 已评分</span>
          <button type="button" onClick={revealNext} disabled={busy}>揭示下一项</button>
        </div>
      )}

      {error && hasLoaded && <div className="mindmap-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')}>关闭</button></div>}
      {notice && <div className="mindmap-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice('')}>关闭</button></div>}

      <div className="mindmap-canvas">
        {switching && <div className="mindmap-switching" role="status">正在切换画布…</div>}
        {loading && !hasLoaded ? (
          <div className="mindmap-state"><span className="mindmap-spinner" /><h2>正在读取脑图</h2><p>加载最新卡片与已保存的布局…</p></div>
        ) : !hasLoaded ? (
          <div className="mindmap-state"><span className="mindmap-state-mark">!</span><h2>暂时无法打开脑图</h2><p>{error}</p><button type="button" className="mindmap-button primary" onClick={() => void refresh()}>重试</button></div>
        ) : cards.length === 0 && ink.inkMode === 'off' ? (
          <div className="mindmap-state"><span className="mindmap-state-mark">◇</span><h2>「{canvasName}」还是空的</h2><p>新建独立卡片、从 PDF 划重点，或导入 AnkiDroid 导出的 txt；每张画布的卡片与坐标互相独立。</p><div className="mindmap-state-actions"><button type="button" className="mindmap-button primary" onClick={() => setEditor('new')}>新建独立卡片</button><button type="button" className="mindmap-button" onClick={() => setAnkiOpen(true)}>导入 Anki 牌组</button></div></div>
        ) : (
          <>
            <div className={`mindmap-flow-host${viewMode === 'outline' ? ' is-hidden' : ''}`} ref={hostRef}>
              <ReactFlow<MindmapFlowNode, Edge>
            nodes={nodes}
            edges={lite ? NO_EDGES : edges}
            nodeTypes={nodeTypes}
            edgeTypes={EDGE_TYPES}
            onNodesChange={handleNodesChange}
            onNodeDragStart={beginInteraction}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            onMove={handleViewportMove}
            onMoveStart={beginInteraction}
            onMoveEnd={endInteraction}
            onNodeContextMenu={handleNodeContextMenu}
            onPaneContextMenu={handlePaneContextMenu}
            fitViewOptions={FIT_VIEW_OPTIONS}
            // 视口外节点不挂载：1483 张卡时 DOM 从 3.3 万降到几百，
            // 首次可见与拖动画布的帧率都靠它。小图仍全量渲染，行为与以前一致。
            onlyRenderVisibleElements={nodes.length > 60}
            defaultViewport={compact ? COMPACT_VIEWPORT : undefined}
            minZoom={0.15}
            maxZoom={1.8}
            // 低缩放（lite）下把拖动让给画布平移：这个比例下看不清卡片，
            // 而 React Flow 会为每个可见节点逐帧重建（338 个节点一次拖拽近 8000 次渲染）。
            nodesDraggable={!busy && !lite && ink.inkMode === 'off'}
            nodesConnectable={!busy && !lite && ink.inkMode === 'off'}
            deleteKeyCode={null}
            selectionKeyCode={ink.inkMode === 'off' ? 'Shift' : null}
            panOnDrag={ink.inkMode === 'off' ? PAN_ON_DRAG : false}
            panOnScroll={ink.inkMode === 'off'}
            zoomOnScroll={false}
            zoomActivationKeyCode="Meta"
            zoomOnDoubleClick={false}
            multiSelectionKeyCode={MULTI_SELECTION_KEYS}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d7ded9" />
            {ink.portal}
            {ink.overlay}
            {!compact && (
              <Panel position="top-left" className="mindmap-canvas-hint">
                拖拽空白或双指滑动平移 · ⌘+滚轮 / 捏合缩放 · Shift 拖拽框选
              </Panel>
            )}
            <Controls position="bottom-left" showInteractive={false} />
            {!compact && nodes.length <= MINIMAP_NODE_LIMIT && (
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={minimapNodeColor}
                nodeStrokeColor={minimapNodeStrokeColor}
                maskColor="rgba(244, 247, 244, .78)"
              />
            )}
              </ReactFlow>
            </div>
            {ink.panel}
            {viewMode === 'outline' && (
            <div className="mindmap-outline" onContextMenu={handleOutlinePaneContextMenu}>
              <div className="mindmap-outline-head">
                  <div>
                    <strong>大纲视图</strong>
                    <span>{cards.length} 张卡片 · 点击标题直接改；回车建同级、⌘↩ 建子级、Tab 缩进、拖拽调层级</span>
                  </div>
                <div className="mindmap-outline-actions">
                  {compact && (
                    <button type="button" onClick={() => setViewMode('canvas')}>返回画布</button>
                  )}
                  <button type="button" className="is-primary" onClick={() => void handleExportMarkdown()} disabled={exporting || !cards.length}>
                    {exporting ? '导出中…' : '导出 Markdown'}
                  </button>
                </div>
              </div>
              <div className="mindmap-outline-list">
                {outlineRows.slice(0, outlineLimit).map(({ card, depth }) => {
                  const hasChildren = parentCardIds.has(card.id)
                  const collapsed = outlineCollapsedIds.has(card.id)
                  return (
                    <div
                      className={`mindmap-outline-row mindmap-tone-${toneByCard.get(card.id) ?? 0}${outlineDrag === card.id ? ' is-dragging' : ''}${outlineDrop?.id === card.id ? ` is-drop-${outlineDrop.position}` : ''}`}
                      key={card.id}
                      data-card-id={card.id}
                      data-depth={depth}
                      draggable={!busy && outlineEditing !== card.id}
                      style={{ paddingLeft: `${12 + depth * 22}px` }}
                      onDragStart={(event) => handleOutlineDragStart(event, card)}
                      onDragOver={(event) => handleOutlineDragOver(event, card)}
                      onDrop={(event) => handleOutlineDrop(event, card)}
                      onDragEnd={endOutlineDrag}
                      onContextMenu={(event) => handleOutlineContextMenu(event, card)}
                    >
                      <button
                        type="button"
                        className="mindmap-outline-toggle"
                        onClick={() => toggleOutlineCollapse(card.id)}
                        disabled={!hasChildren || busy}
                        aria-label={hasChildren ? (collapsed ? '展开子节点' : '折叠子节点') : '没有子节点'}
                      >
                        {hasChildren ? (collapsed ? '▸' : '▾') : '·'}
                      </button>
                      <span className="mindmap-outline-badge" aria-hidden="true">Q</span>
                      <div className="mindmap-outline-body">
                        {outlineEditing === card.id ? (
                          <input
                            ref={outlineInputRef}
                            className="mindmap-outline-input"
                            data-testid="outline-input"
                            defaultValue={outlineDraft}
                            autoFocus
                            spellCheck={false}
                            placeholder="输入标题；回车建下一行，⌘↩ 建子级"
                            onBlur={() => void saveOutlineEdit(true)}
                            onKeyDown={handleOutlineKeyDown}
                          />
                        ) : (
                          <button
                            type="button"
                            className="mindmap-outline-title"
                            title="点击直接改标题"
                            onClick={() => beginOutlineEdit(card)}
                          >
                            {outlineTitle(card)}
                          </button>
                        )}
                        {card.excerpt.trim() && (
                          <ExpandableField
                            field="excerpt"
                            label="摘录"
                            text={card.excerpt.trim()}
                            variant="outline"
                          />
                        )}
                        {card.user_note.trim() && (
                          <ExpandableField
                            field="note"
                            label="笔记"
                            text={card.user_note.trim()}
                            variant="outline"
                          />
                        )}
                        {card.tags.length > 0 && (
                          <div className="mindmap-outline-tags">
                            {card.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                          </div>
                        )}
                      </div>
                      <span className="mindmap-outline-level">L{depth + 1}</span>
                    </div>
                  )
                })}
                {outlineRows.length > outlineLimit && (
                  <div className="mindmap-outline-more">
                    <button type="button" onClick={() => setOutlineLimit((value) => value + OUTLINE_PAGE)}>
                      继续显示（还有 {outlineRows.length - outlineLimit} 行）
                    </button>
                  </div>
                )}
              </div>
            </div>
            )}
          </>
        )}

        {editor && (
          <CardEditor
            key={editor}
            card={editor === 'new' ? null : editingCard ?? null}
            busy={busy}
            onClose={() => setEditor(null)}
            onSave={saveEditor}
          />
        )}
        {styleOpen && !editor && (
          <MindmapStylePanel
            style={cardStyle}
            onChange={updateCardStyle}
            onClose={() => setStyleOpen(false)}
            cardId={styleTarget}
            toneIndex={styleTarget ? (toneByCard.get(styleTarget) ?? 0) : 0}
            toneIsManual={Boolean(styleTarget && tonePrefs[styleTarget] !== undefined)}
            onPickTone={(index) => {
              if (!styleTarget) return
              setTonePrefs(index === null
                ? clearToneOverride(styleTarget)
                : saveToneOverride(styleTarget, index))
            }}
          />
        )}
        {confirmation && (
          <ConfirmationDialog
            kind={confirmation.kind}
            cardTitle={titleOf(confirmationCard)}
            busy={busy}
            onCancel={() => setConfirmation(null)}
            onConfirm={confirmOperation}
          />
        )}
        {clearOpen && (
          <ClearCardsDialog
            count={cards.length}
            busy={busy}
            onCancel={() => setClearOpen(false)}
            onConfirm={clearAllCards}
          />
        )}
      </div>

      {ankiOpen && (
        <AnkiImportDialog
          canvasId={canvasId}
          canvasName={canvasName}
          busy={busy || switching}
          onClose={() => setAnkiOpen(false)}
          onImported={handleAnkiImported}
        />
      )}

      {tagTarget && cardsById[tagTarget] && (
        <TagDialog
          card={cardsById[tagTarget]}
          onClose={() => setTagTarget(null)}
          onSaved={() => { void syncCards() }}
        />
      )}

      {linkTarget && cardsById[linkTarget] && (
        <LinkDialog
          card={cardsById[linkTarget]}
          cards={cards}
          onClose={() => setLinkTarget(null)}
          onChanged={() => undefined}
        />
      )}

      {mergeOpen && (
        <MergeDialog
          cards={cards}
          initialSelection={[...selectedIds]}
          onClose={() => setMergeOpen(false)}
          onMerged={() => { void syncCards() }}
        />
      )}

      {!compact && (
      <footer className="mindmap-footer">
        {recallActive
          ? '默认仅显示当前层级。显示答案后可评分；每张卡片在本会话最多评分一次。'
          : '连线或在节点重叠处释放可修改父级；拖动空白处框选，Shift / ⌘ / Ctrl 可多选。'}
      </footer>
      )}

      <ContextMenu state={menu} onClose={close} />
    </section>
    </MindmapNodeContext.Provider>
  )
}

export function MindmapWorkspace(props: MindmapWorkspaceProps) {
  return <ReactFlowProvider><MindmapCanvas {...props} /></ReactFlowProvider>
}
