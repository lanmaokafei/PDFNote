import { describe, expect, it } from 'vitest'
import type { NormalizedBBox } from '../../domain/card'
import {
  clampRect,
  mergeOverlappingRects,
  pageViewBox,
  rectsOverlap,
  unionRects,
} from './geometry'

const rect = (x: number, y: number, width: number, height: number): NormalizedBBox => ({
  x,
  y,
  width,
  height,
})

function expectRect(actual: NormalizedBBox, expected: NormalizedBBox) {
  expect(actual.x).toBeCloseTo(expected.x, 8)
  expect(actual.y).toBeCloseTo(expected.y, 8)
  expect(actual.width).toBeCloseTo(expected.width, 8)
  expect(actual.height).toBeCloseTo(expected.height, 8)
}

describe('normalized annotation geometry', () => {
  it('clamps a rectangle to page bounds', () => {
    expectRect(clampRect(rect(-0.1, 0.9, 0.6, 0.4)), {
      x: 0,
      y: 0.9,
      width: 0.6,
      height: 0.1,
    })
  })

  it('uses the PDF view box regardless of origin order', () => {
    expect(pageViewBox([0, 0, 612, 792])).toEqual({ x: 0, y: 0, width: 612, height: 792 })
    expect(pageViewBox([612, 792, 0, 0])).toEqual({ x: 612, y: 792, width: 612, height: 792 })
  })

  it('unions disjoint annotations into the card source bbox', () => {
    expectRect(unionRects([rect(0.1, 0.2, 0.2, 0.1), rect(0.5, 0.6, 0.3, 0.2)]), {
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.6,
    })
  })

  it('detects touching and overlapping rectangles', () => {
    expect(rectsOverlap(rect(0.1, 0.1, 0.2, 0.2), rect(0.2, 0.2, 0.2, 0.2))).toBe(true)
    expect(rectsOverlap(rect(0.1, 0.1, 0.1, 0.1), rect(0.5, 0.5, 0.1, 0.1))).toBe(false)
  })

  it('merges overlapping masks for recall mode', () => {
    const merged = mergeOverlappingRects([
      rect(0.1, 0.1, 0.2, 0.2),
      rect(0.25, 0.2, 0.2, 0.2),
      rect(0.7, 0.7, 0.1, 0.1),
    ])
    expect(merged).toHaveLength(2)
    expectRect(merged[0]!, { x: 0.1, y: 0.1, width: 0.35, height: 0.3 })
  })
})
