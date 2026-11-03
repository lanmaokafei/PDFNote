import { useState } from 'react'
import { ArrowUpRight, FileText, X } from 'lucide-react'
import type { Card } from '../../domain/card'

interface TitleLinkPopoverProps {
  keyword: string
  cards: Card[]
  currentDocumentId: string
  onJump: (page: number) => void
  onClose: () => void
}

/**
 * 标题链接命中后的卡片预览：展示当年那张卡的摘录、笔记与来源，
 * 同文档可一键跳回原文页码。这是「旧笔记在新文档里浮现」的落点。
 */
export function TitleLinkPopover({ keyword, cards, currentDocumentId, onJump, onClose }: TitleLinkPopoverProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const card = cards[Math.min(activeIndex, cards.length - 1)]
  if (!card) return null
  const source = card.source_ref
  const sameDocument = source?.document_id === currentDocumentId

  return (
    <div className="pdf-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="pdf-modal pdf-titlelink-modal" role="dialog" aria-modal="true" aria-labelledby="pdf-titlelink-title">
        <header className="pdf-titlelink-head">
          <div>
            <small>标题链接 · 过去的知识浮现</small>
            <h2 id="pdf-titlelink-title">{card.question.trim() || card.excerpt.slice(0, 24) || '未命名卡片'}</h2>
          </div>
          <button type="button" className="pdf-titlelink-close" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        <p className="pdf-titlelink-keyword">命中关键词：<strong>{keyword}</strong>
          {cards.length > 1 && <span> · 共 {cards.length} 张相关卡片</span>}
        </p>

        {cards.length > 1 && (
          <div className="pdf-titlelink-tabs" role="tablist" aria-label="相关卡片">
            {cards.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'is-active' : ''}
                onClick={() => setActiveIndex(index)}
              >
                {item.question.trim() || item.excerpt.slice(0, 16) || `卡片 ${index + 1}`}
              </button>
            ))}
          </div>
        )}

        {card.excerpt_image && (
          <img className="pdf-titlelink-image" src={card.excerpt_image} alt="卡片摘录截图" />
        )}
        {card.excerpt && <blockquote className="pdf-titlelink-excerpt">{card.excerpt}</blockquote>}
        {card.user_note && <p className="pdf-titlelink-note">{card.user_note}</p>}
        {card.tags.length > 0 && (
          <div className="pdf-titlelink-tags">
            {card.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          </div>
        )}

        <footer className="pdf-titlelink-actions">
          <span className="pdf-titlelink-source">
            <FileText size={13} />
            {source ? `来源 · 第 ${source.page} 页${sameDocument ? '' : '（其他文档）'}` : '独立卡片，没有 PDF 来源'}
          </span>
          {source && sameDocument && (
            <button type="button" className="pdf-titlelink-jump" onClick={() => { onJump(source.page); onClose() }}>
              跳回原文 <ArrowUpRight size={14} />
            </button>
          )}
          <button type="button" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
