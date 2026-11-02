import type { Card } from '../../domain/card'

export interface OutlineNode {
  card: Card
  depth: number
  children: OutlineNode[]
}

export function outlineTitle(card: Card): string {
  return card.question.trim() || card.excerpt.trim() || card.user_note.trim() || '未命名卡片'
}

/** 按 parent_id + sort_order 生成脑图森林；父节点缺失的卡片提升为根，避免丢内容。 */
export function buildOutlineForest(cards: Card[]): OutlineNode[] {
  const visible = cards.filter((card) => card.surface_mindmap)
  const byId = new Map(visible.map((card) => [card.id, card]))
  const childrenByParent = new Map<string | null, Card[]>()

  for (const card of visible) {
    const parent = card.parent_id && byId.has(card.parent_id) ? card.parent_id : null
    const list = childrenByParent.get(parent) ?? []
    list.push(card)
    childrenByParent.set(parent, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id))
  }

  const build = (parent: string | null, depth: number): OutlineNode[] =>
    (childrenByParent.get(parent) ?? []).map((card) => ({
      card,
      depth,
      children: build(card.id, depth + 1),
    }))

  return build(null, 0)
}

/** 展平为带层级的行，折叠节点的后代不出现。 */
export function flattenOutline(
  forest: OutlineNode[],
  isCollapsed: (cardId: string) => boolean,
): OutlineNode[] {
  const rows: OutlineNode[] = []
  const walk = (nodes: OutlineNode[]) => {
    for (const node of nodes) {
      rows.push(node)
      if (!isCollapsed(node.card.id)) walk(node.children)
    }
  }
  walk(forest)
  return rows
}

function singleLine(value: string): string {
  return value.replace(/\s*\n+\s*/g, ' ').trim()
}

/**
 * 将脑图导出为 Markdown 嵌套列表：
 * - 节点标题优先取问题，其次摘录、笔记；
 * - 摘录与笔记以引用块附在节点下，避免与子节点混淆。
 */
export function outlineToMarkdown(forest: OutlineNode[], title = '知识脑图'): string {
  const lines: string[] = [`# ${title}`, '']

  const walk = (nodes: OutlineNode[], depth: number) => {
    for (const node of nodes) {
      const card = node.card
      const heading = singleLine(outlineTitle(card))
      const indent = '  '.repeat(depth)
      lines.push(`${indent}- ${heading}`)

      const details: string[] = []
      const excerpt = singleLine(card.excerpt)
      const note = singleLine(card.user_note)
      if (excerpt && excerpt !== heading) {
        const page = card.source_ref ? `第 ${card.source_ref.page} 页 · ` : ''
        details.push(`摘录：${page}${excerpt}`)
      }
      if (note && note !== heading) details.push(`笔记：${note}`)
      for (const detail of details) {
        lines.push(`${indent}  > ${detail}`)
      }

      walk(node.children, depth + 1)
    }
  }

  walk(forest, 0)
  return `${lines.join('\n').trimEnd()}\n`
}
