import { createContext } from 'react'
import type { Rating } from '../../domain/card'

export interface MindmapNodeContextValue {
  busy: boolean
  /**
   * 缩得很小（zoom < 0.45）时只画标题条：此时文字本来就不可读，却仍要挂上百个
   * KaTeX / 图片 / 按钮。lite 模式让低缩放下的平移与拖拽保持流畅。
   */
  lite: boolean
  collapsedIds: ReadonlySet<string>
  /**
   * 当前画布的「父 → 直接子节点数」。
   *
   * 之前每个节点用 store selector 扫全表统计子节点，复杂度 O(节点数²)：
   * 1483 张卡时会做 220 万次过滤，而且任何一次 store 更新都会重跑一遍。
   * 现在由工作区一次性算好传下来，节点只做 O(1) 查表。
   */
  childCounts: ReadonlyMap<string, number>
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
  /** 点卡片徽标：在二十四节气色板里换下一个颜色（写入本地偏好）。 */
  onCycleTone: (id: string) => void
}

export const MindmapNodeContext = createContext<MindmapNodeContextValue | null>(null)
