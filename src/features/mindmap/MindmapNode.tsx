import { memo, useContext } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Card, Rating } from '../../domain/card'
import { useCardStore } from '../../store/cardStore'

export type MindmapFlowNode = Node<{ card_id: string }, 'mindmapCard'>

import { MindmapNodeContext } from './MindmapContext'
import { MathText } from '../../ui/MathText'

const ratings: Array<{ value: Rating; label: string }> = [
  { value: 1, label: '重来' },
  { value: 2, label: '困难' },
  { value: 3, label: '良好' },
  { value: 4, label: '简单' },
]

function cardTitle(card: Card): string {
  return card.question.trim() || card.excerpt.trim() || card.user_note.trim() || '未命名卡片'
}

export const MindmapNode = memo(function MindmapNode({ data, selected }: NodeProps<MindmapFlowNode>) {
  const card = useCardStore((state) => state.cardsById[data.card_id])
  const childCount = useCardStore(
    (state) => Object.values(state.cardsById).filter(
      (candidate) => candidate.surface_mindmap && candidate.parent_id === data.card_id,
    ).length,
  )
  const context = useContext(MindmapNodeContext)
  if (!context) throw new Error('MindmapNode must be rendered inside MindmapWorkspace')
  if (!card) return <div className="mindmap-node mindmap-node-missing">卡片已不可用</div>

  const collapsed = context.collapsedIds.has(card.id)
  const revealed = !context.recallActive || context.revealedIds.has(card.id)
  const rated = context.ratedIds.has(card.id)
  const ratingPending = context.ratingPendingIds.has(card.id)
  const recallError = context.recallErrors[card.id]

  return (
    <article className={`mindmap-node${selected ? ' is-selected' : ''}${context.recallActive ? ' is-recall' : ''}`}>
      <Handle className="mindmap-handle" type="target" position={Position.Left} />
      <header className="mindmap-node-header">
        <span className="mindmap-node-index" aria-hidden="true">Q</span>
        <h3 title={cardTitle(card)}>{cardTitle(card)}</h3>
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
          <section>
            <span>摘录</span>
            {card.excerpt_image && (
              <img
                className="mindmap-node-image nodrag"
                src={card.excerpt_image}
                alt="摘录图像"
                draggable={false}
                loading="lazy"
              />
            )}
            <p className={!card.excerpt ? 'is-empty' : ''}>
              {card.excerpt ? <MathText text={card.excerpt} /> : '未填写摘录'}
            </p>
          </section>
          <section>
            <span>笔记</span>
            <p className={!card.user_note ? 'is-empty' : ''}>
              {card.user_note ? <MathText text={card.user_note} /> : '未填写笔记'}
            </p>
          </section>
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
        <button className="nodrag" type="button" disabled={context.busy} onClick={() => context.onEdit(card.id)}>编辑</button>
        <button className="nodrag" type="button" disabled={context.busy} onClick={() => context.onRemove(card.id)}>从脑图移除</button>
        <button className="mindmap-delete-action nodrag" type="button" disabled={context.busy} onClick={() => context.onDelete(card.id)}>彻底删除</button>
      </footer>
      <Handle className="mindmap-handle" type="source" position={Position.Right} />
    </article>
  )
})
