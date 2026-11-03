import { describe, expect, it } from 'vitest'
import type { Annotation } from '../../domain/card'
import { pruneCardAnnotations } from './annotationCache'

const annotation = (id: string, cardId: string, page: number): Annotation => ({
  id,
  card_id: cardId,
  kind: 'highlight',
  page,
  geometry: { rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

describe('pruneCardAnnotations', () => {
  it('跨页移除指定卡片的全部标注', () => {
    const pages = {
      1: [annotation('a1', 'card-1', 1), annotation('a2', 'card-2', 1)],
      3: [annotation('a3', 'card-1', 3)],
    }
    const result = pruneCardAnnotations(pages, 'card-1')
    expect(result).not.toBeNull()
    expect(result?.removedIds.sort()).toEqual(['a1', 'a3'])
    expect(result?.affectedPages.sort()).toEqual([1, 3])
    expect(result?.pages[1].map((item) => item.id)).toEqual(['a2'])
    expect(result?.pages[3]).toEqual([])
  })

  it('没有匹配卡片时返回 null，避免无谓渲染', () => {
    const pages = { 1: [annotation('a1', 'card-1', 1)] }
    expect(pruneCardAnnotations(pages, 'missing')).toBeNull()
  })

  it('保留其他页面的原有数组引用', () => {
    const untouched = [annotation('b1', 'card-9', 2)]
    const pages = { 1: [annotation('a1', 'card-1', 1)], 2: untouched }
    const result = pruneCardAnnotations(pages, 'card-1')
    expect(result?.pages[2]).toBe(untouched)
  })

  it('空缓存不报错', () => {
    expect(pruneCardAnnotations({}, 'card-1')).toBeNull()
  })
})
