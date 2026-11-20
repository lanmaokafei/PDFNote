import type { CardLink } from '../../domain/card'

export interface LinkNeighbors {
  /** 指向这张卡的链接（谁引用我）。 */
  inbound: CardLink[]
  /** 这张卡指向别人的链接（我引用谁）。 */
  outbound: CardLink[]
}

export interface LinkIndex {
  bySource: Map<string, CardLink[]>
  byTarget: Map<string, CardLink[]>
  /** 每张卡的入链数，节点角标用。 */
  inboundCounts: Map<string, number>
}

/** 一次遍历建好正反两张表：卡片上千时也不在渲染里反复过滤。 */
export function buildLinkIndex(links: readonly CardLink[]): LinkIndex {
  const bySource = new Map<string, CardLink[]>()
  const byTarget = new Map<string, CardLink[]>()
  const inboundCounts = new Map<string, number>()
  for (const link of links) {
    const outgoing = bySource.get(link.source_card_id)
    if (outgoing) outgoing.push(link)
    else bySource.set(link.source_card_id, [link])

    const incoming = byTarget.get(link.target_card_id)
    if (incoming) incoming.push(link)
    else byTarget.set(link.target_card_id, [link])
    inboundCounts.set(link.target_card_id, (inboundCounts.get(link.target_card_id) ?? 0) + 1)
  }
  return { bySource, byTarget, inboundCounts }
}

export function neighborsOf(index: LinkIndex, cardId: string): LinkNeighbors {
  return {
    inbound: index.byTarget.get(cardId) ?? [],
    outbound: index.bySource.get(cardId) ?? [],
  }
}

/** 节点角标文字：没有入链就不显示。 */
export function inboundBadgeLabel(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}
