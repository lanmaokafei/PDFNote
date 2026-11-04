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
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { explainCardQuestion } from '../../services/ai'
import {
  ChevronRight,
  Copy,
  Sparkles,
  Download,
  Focus,
  LayoutGrid,
  Link2,
  ListTree,
  Merge,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
} from 'lucide-react'
import type { Card, CardLink, MindmapLayoutInput, Rating } from '../../domain/card'
import { ContextMenu } from '../../ui/ContextMenu'
import { useContextMenu, type ContextMenuSection } from '../../ui/contextMenuCore'
import {
  clearMindmapCards,
  exportMarkdownFile,
  isTauriRuntime,
  listCardLinks,
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
import { MathText } from '../../ui/MathText'
import { buildOutlineForest, flattenOutline, outlineTitle, outlineToMarkdown } from './outline'
import {
  TREE_Y_GAP,
  buildTreeLayout,
  getOrderedMindmapCards,
  nextSortOrder,
  type MindmapSortMode,
  type Point,
} from './layout'
import './mindmap.css'

const CANVAS_ID = 'main'
const nodeTypes = { mindmapCard: MindmapNode }
// 缺失布局时复用同一对象，避免每次渲染生成新 position 引用。
const DEFAULT_NODE_POSITION = { x: 80, y: 80 }
// 传给 React Flow 的对象/数组必须保持引用稳定：StoreUpdater 会逐字段比较，
// 每次渲染新建会让它在 effect 里重复写入 store，放大成 #185。
const FIT_VIEW_OPTIONS = { padding: 0.18, maxZoom: 1 }
// 0=左键、1=中键、2=右键。左键拖空白即可平移；框选改为按住 Shift。
const PAN_ON_DRAG: number[] = [0, 1, 2]
const MULTI_SELECTION_KEYS = ['Meta', 'Control', 'Shift']
const COMPACT_VIEWPORT = { x: 30, y: 96, zoom: 0.9 }

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
}

interface ConfirmationState {
  kind: ConfirmationKind
  id: string
}

function MindmapCanvas({ onCardsChanged, compact = false }: MindmapWorkspaceProps) {
  const cardsById = useCardStore((state) => state.cardsById)
  const loadCards = useCardStore((state) => state.loadCards)
  const createCardInStore = useCardStore((state) => state.createCard)
  const removeFromMindmap = useCardStore((state) => state.removeFromMindmap)
  const deleteCard = useCardStore((state) => state.deleteCard)
  const { getIntersectingNodes, fitView: fitViewInstance } = useReactFlow<MindmapFlowNode, Edge>()

  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [measuredSizes, setMeasuredSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())

  // 尺寸回写熔断：极端情况下（容器 0 宽、图片抖动）测量会连续变化，
  // 超过阈值后本秒内停止回写，直接断开 StoreUpdater ↔ onNodesChange 的回路。
  const measuredBurstRef = useRef({ windowStart: 0, count: 0 })
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<'new' | string | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)
  const [viewMode, setViewMode] = useState<'canvas' | 'outline'>('canvas')
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

  const cards = useMemo(
    () => Object.values(cardsById).filter((card) => card.surface_mindmap),
    [cardsById],
  )
  const parentIds = useMemo(() => {
    const ids = new Set(cards.map((card) => card.id))
    return new Set(
      cards
        .map((card) => card.parent_id)
        .filter((id): id is string => Boolean(id && ids.has(id))),
    )
  }, [cards])
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
    if (!card.question.trim()) {
      setError('这张卡片没有填写问题，先补一个 Q 再让 AI 解析。')
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
      fitViewInstance({ ...FIT_VIEW_OPTIONS, duration: 0 })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [compact, fitViewInstance, viewMode])

  const outlineForest = useMemo(() => buildOutlineForest(cards), [cards])
  const outlineCollapsedIds = useMemo(
    () => new Set(cards.filter((card) => card.collapsed).map((card) => card.id)),
    [cards],
  )
  const outlineRows = useMemo(
    () => flattenOutline(outlineForest, (id) => outlineCollapsedIds.has(id)),
    [outlineCollapsedIds, outlineForest],
  )
  const parentCardIds = useMemo(() => new Set(parentIds), [parentIds])

  // 节点 data 与卡片列表同生命周期：位置/选中变化重建 nodes 时复用同一对象，
  // React Flow 才不会把“位置更新”误判成“节点内容更新”。
  const nodeData = useMemo(() => {
    const map = new Map<string, { card_id: string }>()
    for (const card of orderedVisibleCards) map.set(card.id, { card_id: card.id })
    return map
  }, [orderedVisibleCards])

  const nodes = useMemo<MindmapFlowNode[]>(
    () => orderedVisibleCards.map((card) => {
      const size = measuredSizes[card.id]
      return {
        id: card.id,
        type: 'mindmapCard',
        position: positions[card.id] ?? DEFAULT_NODE_POSITION,
        // data 必须保持稳定引用，否则 StoreUpdater 与 onNodesChange 会形成更新回环（React #185）。
        data: nodeData.get(card.id) ?? { card_id: card.id },
        selected: selectedIds.has(card.id),
        // 保留 React Flow 的实测尺寸，否则拖拽时会提示节点未初始化。
        ...(size ? { measured: size } : {}),
      }
    }),
    [measuredSizes, nodeData, orderedVisibleCards, positions, selectedIds],
  )
  const edges = useMemo<Edge[]>(() => {
    const hierarchy = orderedVisibleCards.flatMap((card) => {
      if (!card.parent_id || !visibleIds.has(card.parent_id)) return []
      return [{
        id: `${card.parent_id}->${card.id}`,
        source: card.parent_id,
        target: card.id,
        type: 'smoothstep' as const,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#a8b2aa' },
        style: { stroke: '#a8b2aa', strokeWidth: 1.4 },
      }]
    })
    const references = links
      .filter((link) => visibleIds.has(link.source_card_id) && visibleIds.has(link.target_card_id))
      .map((link) => ({
        id: `link-${link.id}`,
        source: link.source_card_id,
        target: link.target_card_id,
        type: 'straight' as const,
        label: '链接',
        labelStyle: { fill: '#6d8794', fontSize: 8 },
        labelBgStyle: { fill: '#f4f7f4', fillOpacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#7d9dab' },
        style: { stroke: '#7d9dab', strokeWidth: 1.2, strokeDasharray: '5 4' },
      }))
    return [...hierarchy, ...references]
  }, [links, orderedVisibleCards, visibleIds])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [savedLayouts, , allLinks] = await Promise.all([
        listMindmapLayout(CANVAS_ID),
        loadCards(),
        listCardLinks(),
      ])
      setLinks(allLinks)
      const latestCards = Object.values(useCardStore.getState().cardsById).filter((card) => card.surface_mindmap)
      const generated = buildTreeLayout(latestCards)
      const savedById = new Map(savedLayouts.map((layout) => [layout.card_id, layout]))
      const nextPositions: Record<string, Point> = {}
      const missing: MindmapLayoutInput[] = []

      for (const card of latestCards) {
        const saved = savedById.get(card.id)
        const hasSavedPosition = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        const point = hasSavedPosition ? { x: saved.x, y: saved.y } : generated[card.id]
        nextPositions[card.id] = point
        if (!hasSavedPosition) missing.push({ card_id: card.id, canvas_id: CANVAS_ID, ...point })
      }

      setPositions(nextPositions)
      setSelectedIds(new Set())
      setHasLoaded(true)
      if (missing.length) await saveMindmapLayout(missing)
    } catch (reason) {
      setError(`脑图加载失败：${errorMessage(reason)}`)
    } finally {
      setLoading(false)
    }
  }, [loadCards])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const reloadLinks = () => {
      void listCardLinks().then(setLinks).catch(() => undefined)
    }
    window.addEventListener('pdfnote:links-changed', reloadLinks)
    return () => window.removeEventListener('pdfnote:links-changed', reloadLinks)
  }, [])

  // 分栏模式下新建的卡片不会重新挂载脑图，这里为缺少坐标的卡片补一次树形布局。
  useEffect(() => {
    if (!hasLoaded) return
    const missing = cards.filter((card) => !positions[card.id])
    if (!missing.length) return
    const generated = buildTreeLayout(cards)
    const fallback = { x: 80, y: 80 }
    setPositions((current) => {
      const next = { ...current }
      missing.forEach((card) => {
        next[card.id] = generated[card.id] ?? fallback
      })
      return next
    })
    void saveMindmapLayout(missing.map((card) => ({
      card_id: card.id,
      canvas_id: CANVAS_ID,
      ...(generated[card.id] ?? fallback),
    }))).catch(() => undefined)
  }, [cards, hasLoaded, positions])

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
    if (!items.length) return
    await saveMindmapLayout(items.map((item) => ({
      card_id: item.id,
      canvas_id: CANVAS_ID,
      x: item.position.x,
      y: item.position.y,
    })))
    setPositions((current) => {
      const next = { ...current }
      for (const item of items) next[item.id] = item.position
      return next
    })
  }, [])

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
    const batch = draggedNodes.length
      ? draggedNodes
      : nodes.filter((node) => node.id === draggedNode.id || node.selected)
    const dropTarget = getIntersectingNodes(draggedNode).find((node) => node.id !== draggedNode.id)

    void runTask(async () => {
      await persistPositions(batch)
      if (dropTarget) {
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
      }
      setNotice(`已保存 ${batch.length} 个节点坐标。`)
    })
  }, [getIntersectingNodes, nodes, persistPositions, runTask, syncCards])

  // 整理后要等 React Flow 应用新坐标，再对齐视口；否则用户仍停在旧的缩放/平移上，
  // 看起来像「卡片没有聚拢」。卸载时清掉定时器，避免对已销毁实例调用 fitView。
  const arrangeTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (arrangeTimerRef.current !== null) window.clearTimeout(arrangeTimerRef.current)
  }, [])

  const autoArrange = useCallback(() => {
    if (!cards.length) return
    const arranged = buildTreeLayout(cards)
    void runTask(async () => {
      await saveMindmapLayout(cards.map((card) => ({
        card_id: card.id,
        canvas_id: CANVAS_ID,
        ...arranged[card.id],
      })))
      setPositions((current) => ({ ...current, ...arranged }))
      if (arrangeTimerRef.current !== null) window.clearTimeout(arrangeTimerRef.current)
      arrangeTimerRef.current = window.setTimeout(() => {
        arrangeTimerRef.current = null
        fitViewInstance({ ...FIT_VIEW_OPTIONS, duration: 320 })
      }, 120)
      setNotice(`已整理并保存 ${cards.length} 个节点，视图已对齐。`)
    })
  }, [cards, fitViewInstance, runTask])

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
      const latestCards = Object.values(useCardStore.getState().cardsById).filter((card) => card.surface_mindmap)
      const card = await createCardInStore({
        ...draft,
        sort_order: nextSortOrder(latestCards, null),
      })
      const nextY = Math.max(80, ...Object.values(positions).map((point) => point.y + TREE_Y_GAP))
      const point = { x: 80, y: nextY }
      setPositions((current) => ({ ...current, [card.id]: point }))
      setEditor(null)
      try {
        await saveMindmapLayout([{ card_id: card.id, canvas_id: CANVAS_ID, ...point }])
      } catch (reason) {
        await syncCards()
        throw new Error(`卡片已创建，但坐标保存失败：${errorMessage(reason)}`)
      }
      await syncCards()
      setNotice('独立卡片已创建。')
      return
    }

    if (!editor) return
    await updateCardContent({ id: editor, ...draft })
    await syncCards()
    setEditor(null)
    setNotice('卡片内容已同步到三个视图。')
  }), [createCardInStore, editor, positions, runTask, syncCards])

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

  const handleExportMarkdown = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const forest = buildOutlineForest(Object.values(useCardStore.getState().cardsById))
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
  }, [exporting])

  const confirmOperation = useCallback(() => {
    if (!confirmation) return
    const { id, kind } = confirmation
    void runTask(async () => {
      if (kind === 'remove') await removeFromMindmap(id)
      else await deleteCard(id)

      setPositions((current) => {
        const next = { ...current }
        delete next[id]
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
      setNotice(kind === 'remove' ? '已移出脑图，PDF 与复习投影保持不变。' : '卡片已彻底删除。')
    })
  }, [confirmation, deleteCard, editor, removeFromMindmap, runTask, syncCards])

  /** 批量清空：后端单事务完成后，本地把投影、坐标、选中与弹窗一次性复位。 */
  const clearAllCards = useCallback((mode: ClearCardsMode) => {
    void runTask(async () => {
      const count = await clearMindmapCards(mode)
      setPositions({})
      setMeasuredSizes({})
      setSelectedIds(new Set())
      setLinks([])
      setConfirmation(null)
      setEditor(null)
      setClearOpen(false)
      setViewMode('canvas')
      await syncCards()
      setNotice(mode === 'remove'
        ? `已清空 ${count} 张脑图卡片，PDF 标注与复习记录仍保留。`
        : `已彻底删除 ${count} 张卡片及其标注、复习记录。`)
    })
  }, [runTask, syncCards])

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
          { id: 'refresh', label: '刷新脑图', icon: RefreshCw, onSelect: () => void refresh() },
          { id: 'arrange', label: '自动整理节点', icon: Focus, disabled: busy || !cards.length, onSelect: autoArrange },
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

  return (
    <MindmapNodeContext.Provider value={{
      busy,
      collapsedIds,
      recallActive,
      revealedIds,
      ratedIds,
      ratingPendingIds,
      recallErrors,
      onEdit: (id) => setEditor(id),
      onTag: (id) => setTagTarget(id),
      onLink: (id) => setLinkTarget(id),
      onToggle: (id) => void toggleCard(id),
      onReveal: revealAnswer,
      onRate: (id, rating) => void rateCard(id, rating),
      onRemove: (id) => setConfirmation({ kind: 'remove', id }),
      onDelete: (id) => setConfirmation({ kind: 'delete', id }),
      onOpenSource: openSource,
      onExplain: (id) => void explainCard(id),
    }}>
    <section className={`mindmap-workspace${compact ? ' is-embedded' : ''}`} aria-label="知识脑图工作区">
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
          <button type="button" onClick={() => void refresh()} disabled={loading || busy}>刷新</button>
          <button type="button" onClick={autoArrange} disabled={busy || !cards.length || viewMode === 'outline'}>自动整理</button>
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
        {loading && !hasLoaded ? (
          <div className="mindmap-state"><span className="mindmap-spinner" /><h2>正在读取脑图</h2><p>加载最新卡片与已保存的布局…</p></div>
        ) : !hasLoaded ? (
          <div className="mindmap-state"><span className="mindmap-state-mark">!</span><h2>暂时无法打开脑图</h2><p>{error}</p><button type="button" className="mindmap-button primary" onClick={() => void refresh()}>重试</button></div>
        ) : cards.length === 0 ? (
          <div className="mindmap-state"><span className="mindmap-state-mark">◇</span><h2>从第一张知识卡片开始</h2><p>创建一张不依赖 PDF 的独立卡片，之后可连线或拖拽建立层级。</p><button type="button" className="mindmap-button primary" onClick={() => setEditor('new')}>新建独立卡片</button></div>
        ) : (
          <>
            <div className={`mindmap-flow-host${viewMode === 'outline' ? ' is-hidden' : ''}`}>
              <ReactFlow<MindmapFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            onNodeContextMenu={handleNodeContextMenu}
            onPaneContextMenu={handlePaneContextMenu}
            fitView={!compact}
            fitViewOptions={FIT_VIEW_OPTIONS}
            defaultViewport={compact ? COMPACT_VIEWPORT : undefined}
            minZoom={0.15}
            maxZoom={1.8}
            nodesDraggable={!busy}
            nodesConnectable={!busy}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            panOnDrag={PAN_ON_DRAG}
            panOnScroll
            zoomOnScroll={false}
            zoomActivationKeyCode="Meta"
            zoomOnDoubleClick={false}
            multiSelectionKeyCode={MULTI_SELECTION_KEYS}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d7ded9" />
            {!compact && (
              <Panel position="top-left" className="mindmap-canvas-hint">
                拖拽空白或双指滑动平移 · ⌘+滚轮 / 捏合缩放 · Shift 拖拽框选
              </Panel>
            )}
            <Controls position="bottom-left" showInteractive={false} />
            {!compact && (
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor="#c8d5cc"
                nodeStrokeColor="#8da092"
                maskColor="rgba(244, 247, 244, .78)"
              />
            )}
              </ReactFlow>
            </div>
            {viewMode === 'outline' && (
            <div className="mindmap-outline" onContextMenu={handleOutlinePaneContextMenu}>
              <div className="mindmap-outline-head">
                <div>
                  <strong>大纲视图</strong>
                  <span>{cards.length} 张卡片 · 点击标题可编辑，折叠状态与脑图同步</span>
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
                {outlineRows.map(({ card, depth }) => {
                  const hasChildren = parentCardIds.has(card.id)
                  const collapsed = outlineCollapsedIds.has(card.id)
                  return (
                    <div
                      className="mindmap-outline-row"
                      key={card.id}
                      style={{ paddingLeft: `${12 + depth * 22}px` }}
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
                        <button type="button" className="mindmap-outline-title" onClick={() => setEditor(card.id)}>
                          {outlineTitle(card)}
                        </button>
                        {card.excerpt.trim() && (
                          <p><MathText text={card.excerpt.trim()} /></p>
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
