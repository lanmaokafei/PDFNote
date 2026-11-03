import type { Annotation } from '../../domain/card'

export interface AnnotationPruneResult {
  /** 清理后的按页标注映射。 */
  pages: Record<number, Annotation[]>
  /** 被移除的标注 id，用于同步清空选中态。 */
  removedIds: string[]
  /** 受影响的页码，需要重新从数据库同步。 */
  affectedPages: number[]
}

/**
 * 卡片被彻底删除后，立即从 PDF 标注缓存里剔除它的标注。
 *
 * 后端是 `ON DELETE CASCADE`，但 PDF 工作区的 `annotationsByPage` 是独立缓存，
 * 不会因为卡片列表变化而刷新——不清理就会出现“幽灵标注”，点删除时后端返回
 * `annotation not found`。返回 null 表示没有变化，调用方无需触发渲染。
 */
export function pruneCardAnnotations(
  pages: Record<number, Annotation[]>,
  cardId: string,
): AnnotationPruneResult | null {
  const removedIds: string[] = []
  const affectedPages: number[] = []
  const next: Record<number, Annotation[]> = {}

  for (const [page, list] of Object.entries(pages)) {
    const kept = list.filter((annotation) => annotation.card_id !== cardId)
    // 没有命中的页面复用原数组，避免整页标注白白重渲染。
    if (kept.length === list.length) {
      next[Number(page)] = list
      continue
    }
    removedIds.push(...list.filter((annotation) => annotation.card_id === cardId).map((annotation) => annotation.id))
    affectedPages.push(Number(page))
    next[Number(page)] = kept
  }

  if (removedIds.length === 0) return null
  return { pages: next, removedIds, affectedPages }
}
