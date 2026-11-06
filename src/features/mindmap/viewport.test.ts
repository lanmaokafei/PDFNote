import { beforeEach, describe, expect, it } from 'vitest'
import {
  nextMindmapInsertPoint,
  readMindmapViewportCenter,
  resetMindmapInsertSequence,
  setMindmapViewportCenter,
} from './viewport'

describe('mindmap viewport insert point', () => {
  beforeEach(() => {
    setMindmapViewportCenter(null)
    resetMindmapInsertSequence()
  })

  it('没有视口中心时不给坐标，交给数据库默认值', () => {
    expect(readMindmapViewportCenter()).toBeNull()
    expect(nextMindmapInsertPoint()).toBeUndefined()
  })

  it('第一张卡落在视口正中心（按卡片尺寸换算左上角）', () => {
    setMindmapViewportCenter({ x: 1000, y: 600 })
    expect(nextMindmapInsertPoint()).toEqual({ x: 873, y: 505 })
  })

  it('连续建卡在中心附近错开，避免完全重叠', () => {
    setMindmapViewportCenter({ x: 0, y: 0 })
    const first = nextMindmapInsertPoint()
    const second = nextMindmapInsertPoint()
    const third = nextMindmapInsertPoint()
    expect(second).not.toEqual(first)
    expect(third).not.toEqual(second)
    // 3×3 环填满后回到第一格。
    for (let slot = 3; slot < 9; slot += 1) nextMindmapInsertPoint()
    expect(nextMindmapInsertPoint()).toEqual(first)
  })

  it('重置序号后重新从正中心开始', () => {
    setMindmapViewportCenter({ x: 100, y: 100 })
    nextMindmapInsertPoint()
    nextMindmapInsertPoint()
    resetMindmapInsertSequence()
    expect(nextMindmapInsertPoint()).toEqual({ x: -27, y: 5 })
  })

  it('非法中心点不会污染共享状态', () => {
    setMindmapViewportCenter({ x: 10, y: 20 })
    setMindmapViewportCenter({ x: Number.NaN, y: 0 })
    expect(readMindmapViewportCenter()).toBeNull()
  })
})
