import { describe, expect, it } from 'vitest'
import { barHeights } from './yearPoster'

describe('年度回顾分享图', () => {
  it('柱高按当年最高月归一', () => {
    const heights = barHeights([0, 100, 200, 50], 200)
    expect(heights[0]).toBe(0)
    expect(heights[2]).toBe(200)
    expect(heights[1]).toBe(100)
    expect(heights[3]).toBe(50)
  })

  it('零值月不画柱，非零月至少 6px', () => {
    const heights = barHeights([0, 1, 1000], 200)
    expect(heights[0]).toBe(0)
    expect(heights[1]).toBe(6)
  })

  it('全年没读时不产生高度', () => {
    expect(barHeights(new Array(12).fill(0), 200)).toEqual(new Array(12).fill(0))
  })

  it('月份不足或超出 12 个时按实际长度返回', () => {
    expect(barHeights([10, 20], 100)).toHaveLength(2)
  })
})
