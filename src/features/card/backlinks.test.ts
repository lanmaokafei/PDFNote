import { describe, expect, it } from 'vitest'
import type { CardLink } from '../../domain/card'
import { buildLinkIndex, inboundBadgeLabel, neighborsOf } from './backlinks'

function link(id: string, source: string, target: string): CardLink {
  return { id, source_card_id: source, target_card_id: target, label: '', created_at: '2026-01-01T00:00:00.000Z' }
}

describe('反向链接索引', () => {
  const index = buildLinkIndex([
    link('l1', 'a', 'b'),
    link('l2', 'c', 'b'),
    link('l3', 'b', 'd'),
  ])

  it('入链与出链分开统计', () => {
    const neighbors = neighborsOf(index, 'b')
    expect(neighbors.inbound.map((item) => item.source_card_id)).toEqual(['a', 'c'])
    expect(neighbors.outbound.map((item) => item.target_card_id)).toEqual(['d'])
  })

  it('角标数只算入链', () => {
    expect(index.inboundCounts.get('b')).toBe(2)
    expect(index.inboundCounts.get('a')).toBeUndefined()
  })

  it('没有链接的卡片返回空数组而不是 undefined', () => {
    expect(neighborsOf(index, 'zzz')).toEqual({ inbound: [], outbound: [] })
  })

  it('角标文字为空、正常与超限', () => {
    expect(inboundBadgeLabel(0)).toBe('')
    expect(inboundBadgeLabel(3)).toBe('3')
    expect(inboundBadgeLabel(150)).toBe('99+')
  })
})
