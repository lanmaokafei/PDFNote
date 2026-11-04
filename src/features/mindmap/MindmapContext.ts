import { createContext } from 'react'
import type { Rating } from '../../domain/card'

export interface MindmapNodeContextValue {
  busy: boolean
  collapsedIds: ReadonlySet<string>
  recallActive: boolean
  revealedIds: ReadonlySet<string>
  ratedIds: ReadonlySet<string>
  ratingPendingIds: ReadonlySet<string>
  recallErrors: Readonly<Record<string, string>>
  onEdit: (id: string) => void
  onTag: (id: string) => void
  onLink: (id: string) => void
  onToggle: (id: string) => void
  onReveal: (id: string) => void
  onRate: (id: string, rating: Rating) => void
  onRemove: (id: string) => void
  onDelete: (id: string) => void
  /** 点击页码标签：切到文档并跳到对应页。 */
  onOpenSource: (id: string) => void
  /** 用模型解析卡片问题，写回笔记。 */
  onExplain: (id: string) => void
}

export const MindmapNodeContext = createContext<MindmapNodeContextValue | null>(null)
