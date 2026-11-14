import { describe, expect, it } from 'vitest'
import { placeSkeletonNode, SKELETON_CHILD_DX, SKELETON_SIBLING_GAP } from './tocLayout'

describe('新增骨架节点落点', () => {
  it('第一个子节点落在父节点右下方', () => {
    expect(placeSkeletonNode({ parent: { x: 100, y: 200 }, siblingYs: [], rootYs: [] }))
      .toEqual({ x: 100 + SKELETON_CHILD_DX, y: 280 })
  })

  it('排在已有兄弟下面，不压住它们', () => {
    const point = placeSkeletonNode({ parent: { x: 0, y: 100 }, siblingYs: [120, 260], rootYs: [] })
    expect(point.x).toBe(SKELETON_CHILD_DX)
    expect(point.y).toBe(260 + SKELETON_SIBLING_GAP)
  })

  it('没有父节点时当作新的根，排在已有根下面', () => {
    expect(placeSkeletonNode({ parent: null, siblingYs: [], rootYs: [80, 400] }))
      .toEqual({ x: 80, y: 400 + 160 })
  })

  it('空画布从默认起点开始', () => {
    expect(placeSkeletonNode({ parent: null, siblingYs: [], rootYs: [] })).toEqual({ x: 80, y: 80 })
  })

  it('父节点有坐标但还没有子节点时不会和父节点重叠', () => {
    const point = placeSkeletonNode({ parent: { x: 500, y: 500 }, siblingYs: [], rootYs: [] })
    expect(point.x).toBeGreaterThan(500)
    expect(point.y).toBeGreaterThan(500)
  })
})
