import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Card, MindmapLayoutInput, Rating } from '../../domain/card'
import {
  listMindmapLayout,
  moveCard,
  saveMindmapLayout,
  setCardCollapsed,
  updateCardContent,
} from '../../services/pdfnote'
import { useCardStore } from '../../store/cardStore'
import { reviewCard } from '../review/scheduler'
import { CardEditor, ConfirmationDialog, type CardDraft, type ConfirmationKind } from './CardEditor'
import { MindmapNodeContext } from './MindmapContext'
import { MindmapNode, type MindmapFlowNode } from './MindmapNode'
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
  const { getIntersectingNodes } = useReactFlow<MindmapFlowNode, Edge>()

  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [measuredSizes, setMeasuredSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<'new' | string | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)

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

  const nodes = useMemo<MindmapFlowNode[]>(
    () => orderedVisibleCards.map((card) => {
      const size = measuredSizes[card.id]
      return {
        id: card.id,
        type: 'mindmapCard',
        position: positions[card.id] ?? { x: 80, y: 80 },
        data: { card_id: card.id },
        selected: selectedIds.has(card.id),
        // 保留 React Flow 的实测尺寸，否则拖拽时会提示节点未初始化。
        ...(size ? { measured: size } : {}),
      }
    }),
    [measuredSizes, orderedVisibleCards, positions, selectedIds],
  )
  const edges = useMemo<Edge[]>(
    () => orderedVisibleCards.flatMap((card) => {
      if (!card.parent_id || !visibleIds.has(card.parent_id)) return []
      return [{
        id: `${card.parent_id}->${card.id}`,
        source: card.parent_id,
        target: card.id,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#a8b2aa' },
        style: { stroke: '#a8b2aa', strokeWidth: 1.4 },
      }]
    }),
    [orderedVisibleCards, visibleIds],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [savedLayouts] = await Promise.all([listMindmapLayout(CANVAS_ID), loadCards()])
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

  const handleNodesChange = useCallback((changes: NodeChange<MindmapFlowNode>[]) => {
    setPositions((current) => {
      let next = current
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue
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
      let next = current
      for (const change of changes) {
        if (change.type !== 'dimensions' || !change.dimensions) continue
        const { width, height } = change.dimensions
        const previous = next[change.id]
        if (previous && Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5) continue
        if (next === current) next = { ...current }
        next[change.id] = { width, height }
      }
      return next
    })
  }, [])

  /**
   * React Flow 会在每次内部节点变化时回调选择集。这里必须做内容比较：
   * 直接 setSelectedIds(new Set(...)) 会让 nodes 数组每次重建，StoreUpdater
   * 再次 setNodes，形成 Maximum update depth exceeded（React #185）。
   */
  const handleSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: Array<{ id: string }> }) => {
    const nextIds = selectedNodes.map((node) => node.id)
    setSelectedIds((current) => {
      if (current.size === nextIds.length && nextIds.every((id) => current.has(id))) return current
      return new Set(nextIds)
    })
  }, [])

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
      setNotice(`已整理并保存 ${cards.length} 个节点。`)
    })
  }, [cards, runTask])

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
      onToggle: (id) => void toggleCard(id),
      onReveal: revealAnswer,
      onRate: (id, rating) => void rateCard(id, rating),
      onRemove: (id) => setConfirmation({ kind: 'remove', id }),
      onDelete: (id) => setConfirmation({ kind: 'delete', id }),
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
        <div className="mindmap-toolbar-actions">
          <button type="button" onClick={() => void refresh()} disabled={loading || busy}>刷新</button>
          <button type="button" onClick={autoArrange} disabled={busy || !cards.length}>自动整理</button>
          <button type="button" onClick={saveSelected} disabled={busy || !cards.length}>保存所选布局</button>
          <button type="button" className="primary" onClick={() => setEditor('new')} disabled={busy}>＋ 新建卡片</button>
        </div>
      </div>
      )}

      {compact && (
        <div className="mindmap-float-actions">
          <button type="button" onClick={() => void refresh()} disabled={loading || busy}>刷新</button>
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
          <ReactFlow<MindmapFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onNodeDragStop={handleNodeDragStop}
            onConnect={handleConnect}
            onSelectionChange={handleSelectionChange}
            fitView={!compact}
            fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
            defaultViewport={compact ? { x: 30, y: 96, zoom: 0.9 } : undefined}
            minZoom={0.15}
            maxZoom={1.8}
            nodesDraggable={!busy}
            nodesConnectable={!busy}
            deleteKeyCode={null}
            selectionOnDrag
            panOnDrag={[1, 2]}
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d7ded9" />
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
      </div>

      {!compact && (
      <footer className="mindmap-footer">
        {recallActive
          ? '默认仅显示当前层级。显示答案后可评分；每张卡片在本会话最多评分一次。'
          : '连线或在节点重叠处释放可修改父级；拖动空白处框选，Shift / ⌘ / Ctrl 可多选。'}
      </footer>
      )}

    </section>
    </MindmapNodeContext.Provider>
  )
}

export function MindmapWorkspace(props: MindmapWorkspaceProps) {
  return <ReactFlowProvider><MindmapCanvas {...props} /></ReactFlowProvider>
}
