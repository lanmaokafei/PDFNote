import { memo, useContext } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Card, Rating } from '../../domain/card'
import { useCardStore } from '../../store/cardStore'

export type MindmapFlowNode = Node<{ card_id: string; tone?: number }, 'mindmapCard'>

import { MindmapNodeContext } from './MindmapContext'
import { hasMathContent } from '../../ui/latex'
import { ExpandableField } from './ExpandableField'
import { toneAt } from './tone'

const ratings: Array<{ value: Rating; label: string }> = [
  { value: 1, label: '重来' },
  { value: 2, label: '困难' },
  { value: 3, label: '良好' },
  { value: 4, label: '简单' },
]

function cardTitle(card: Card): string {
  return card.question.trim() || card.excerpt.trim() || card.user_note.trim() || '未命名卡片'
}

function sameNodeProps(previous: NodeProps<MindmapFlowNode>, next: NodeProps<MindmapFlowNode>): boolean {
  // React Flow 在拖拽每一帧都会把 dragging / positionAbsolute 等字段换新。
  // 卡片内容只取决于 id / data / selected，其余变化一律不重渲染，
  // 否则低缩放下 338 个节点会在一次拖拽里重渲染近万次。
  return previous.id === next.id
    && previous.data === next.data
    && previous.selected === next.selected
}

export const MindmapNode = memo(function MindmapNode({ data, selected }: NodeProps<MindmapFlowNode>) {
  const card = useCardStore((state) => state.cardsById[data.card_id])
  const context = useContext(MindmapNodeContext)
  if (!context) throw new Error('MindmapNode must be rendered inside MindmapWorkspace')
  if (!card) return <div className="mindmap-node mindmap-node-missing">卡片已不可用</div>

  // 色调由工作区按「子树根」预算好：同一棵树同色，整张画布才有色彩层次。
  const tone = data.tone ?? 0
  const palette = toneAt(tone)

  // 低缩放下文字本来就看不清：只画一条标题，省掉 KaTeX、图片、标签和全部按钮。
  // 节点仍可点选、拖拽，交互行为不变，只是 DOM 与渲染成本降到十分之一。
  if (context.lite) {
    return (
      <article className={`mindmap-node is-lite mindmap-tone-${tone}${selected ? ' is-selected' : ''}`}>
        <Handle className="mindmap-handle" type="target" position={Position.Left} />
        <h3 title={cardTitle(card)}>{cardTitle(card)}</h3>
        <Handle className="mindmap-handle" type="source" position={Position.Right} />
      </article>
    )
  }

  // 子节点数由工作区预算好：节点内部不再扫全表（否则 1000+ 卡时是 O(n²)）。
  const childCount = context.childCounts.get(card.id) ?? 0
  // 与后端 build_explain_prompt 同一判定顺序：问题 → 摘录 → 笔记，任一非空即可解析。
  const hasContent = Boolean(
    card.question.trim() || card.excerpt.trim() || card.user_note.trim(),
  )

  // 摘录能排版成公式时不再显示选区截图：两者内容重复，图片还会把公式挤出卡片。
  const excerptHasMath = hasMathContent(card.excerpt)
  const showExcerptImage = Boolean(card.excerpt_image) && !excerptHasMath
  const collapsed = context.collapsedIds.has(card.id)
  const revealed = !context.recallActive || context.revealedIds.has(card.id)
  const rated = context.ratedIds.has(card.id)
  const ratingPending = context.ratingPendingIds.has(card.id)
  const recallError = context.recallErrors[card.id]

  return (
    <article className={`mindmap-node mindmap-tone-${tone}${selected ? ' is-selected' : ''}${context.recallActive ? ' is-recall' : ''}`}>
      <Handle className="mindmap-handle" type="target" position={Position.Left} />
      <header className="mindmap-node-header">
        <button
          type="button"
          className="mindmap-node-index nodrag"
          title={`${palette.term}·${palette.color}｜点击换个颜色`}
          aria-label={`卡片配色：${palette.term}·${palette.color}，点击切换`}
          onClick={(event) => {
            event.stopPropagation()
            context.onCycleTone(card.id)
          }}
        >Q</button>
        <h3 title={cardTitle(card)}>{cardTitle(card)}</h3>
        {card.source_ref && (
          <button
            type="button"
            className="mindmap-node-page nodrag"
            title={`跳到第 ${card.source_ref.page} 页`}
            aria-label={`跳到第 ${card.source_ref.page} 页`}
            onClick={(event) => {
              event.stopPropagation()
              context.onOpenSource(card.id)
            }}
          >
            P{card.source_ref.page}
          </button>
        )}
        {childCount > 0 && (
          <button
            className="mindmap-collapse nodrag"
            type="button"
            disabled={context.busy}
            onClick={() => context.onToggle(card.id)}
            aria-label={collapsed ? `展开 ${childCount} 个子节点` : `折叠 ${childCount} 个子节点`}
            title={collapsed ? '展开子节点' : '折叠子节点'}
          >
            <span aria-hidden="true">{collapsed ? '＋' : '−'}</span>{childCount}
          </button>
        )}
      </header>

      {card.tags.length > 0 && (
        <div className="mindmap-node-tags">
          {card.tags.slice(0, 4).map((tag) => <span key={tag}>#{tag}</span>)}
        </div>
      )}

      {!revealed ? (
        <button className="mindmap-reveal-answer nodrag" type="button" onClick={() => context.onReveal(card.id)}>
          显示答案
        </button>
      ) : (
        <div className="mindmap-node-content">
          <ExpandableField
            field="excerpt"
            label="摘录"
            text={card.excerpt}
            variant="node"
            emptyLabel="未填写摘录"
          >
            {showExcerptImage && (
              <img
                className="mindmap-node-image nodrag"
                src={card.excerpt_image ?? undefined}
                alt="摘录图像"
                draggable={false}
                loading="lazy"
              />
            )}
          </ExpandableField>
          <ExpandableField
            field="note"
            label="笔记"
            text={card.user_note}
            variant="node"
            emptyLabel="未填写笔记"
          />
        </div>
      )}

      {context.recallActive && revealed && (
        <div className="mindmap-recall-rating">
          {rated ? (
            <span className="mindmap-rated">本会话已评分</span>
          ) : (
            <div className="mindmap-rating-buttons" aria-label="回忆评分">
              {ratings.map((rating) => (
                <button
                  className="nodrag"
                  key={rating.value}
                  type="button"
                  disabled={ratingPending || context.busy}
                  onClick={() => context.onRate(card.id, rating.value)}
                >
                  {ratingPending ? '…' : rating.label}
                </button>
              ))}
            </div>
          )}
          {recallError && <p className="mindmap-recall-error" role="alert">{recallError}</p>}
        </div>
      )}

      <footer className="mindmap-node-actions">
        {/**
         * AI 解析对所有有内容的卡片开放：PDF 划重点建的卡没有 question、只有摘录，
         * 以前这里用 `card.question.trim() &&` 把它整条入口滤掉了。
         * 只有纯结构节点（Anki 牌组、空卡片）三者皆空时才禁用。
         */}
        <button
          className="nodrag mindmap-explain-action"
          type="button"
          disabled={context.busy || !hasContent}
          title={hasContent
            ? (card.question.trim()
              ? '让 AI 解析这个问题，结果写入卡片笔记'
              : '让 AI 解析这段摘录，结果写入卡片笔记')
            : '这张卡片还没有内容，先填写问题或摘录'}
          onClick={() => context.onExplain(card.id)}
        >AI 解析</button>
        <button className="nodrag" type="button" disabled={context.busy} onClick={() => context.onEdit(card.id)}>编辑</button>
        <button className="nodrag" type="button" disabled={context.busy} onClick={() => context.onRemove(card.id)}>从脑图移除</button>
        <button className="mindmap-delete-action nodrag" type="button" disabled={context.busy} onClick={() => context.onDelete(card.id)}>彻底删除</button>
      </footer>
      <Handle className="mindmap-handle" type="source" position={Position.Right} />
    </article>
  )
}, sameNodeProps)
