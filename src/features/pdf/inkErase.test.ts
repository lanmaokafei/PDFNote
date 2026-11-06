import { describe, expect, it } from 'vitest'
import { findInkHits, type InkHitCandidate } from './inkErase'

const line: InkHitCandidate = {
  id: 'a',
  width: 2,
  points: [[0, 0], [100, 0], [100, 100]],
}

describe('橡皮命中判定', () => {
  it('落在线上时命中，距离为 0', () => {
    const hits = findInkHits({ x: 50, y: 0 }, [line], 8)
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('a')
    expect(hits[0].distance).toBeCloseTo(0, 5)
  })

  it('橡皮圈够大才能擦到旁边的线（这是大小调节的意义）', () => {
    // 点在 (50, 12)，距水平线段 12px
    expect(findInkHits({ x: 50, y: 12 }, [line], 8)).toHaveLength(0)
    expect(findInkHits({ x: 50, y: 12 }, [line], 12)).toHaveLength(1)
    expect(findInkHits({ x: 50, y: 12 }, [line], 20)).toHaveLength(1)
  })

  it('细笔画不需要正好点在线上：半径加上线宽一半', () => {
    const thin: InkHitCandidate = { id: 'thin', width: 1, points: [[0, 0], [50, 0]] }
    // 距离 8.2：小橡皮（半径 8）也能擦到，因为再加半个线宽
    const hits = findInkHits({ x: 10, y: 8.2 }, [thin], 8)
    expect(hits).toHaveLength(1)
  })

  it('同时命中多条时按距离排序', () => {
    const near: InkHitCandidate = { id: 'near', width: 1, points: [[0, 0], [100, 0]] }
    const far: InkHitCandidate = { id: 'far', width: 1, points: [[0, 40], [100, 40]] }
    const hits = findInkHits({ x: 50, y: 10 }, [far, near], 50)
    expect(hits.map((hit) => hit.id)).toEqual(['near', 'far'])
  })

  it('橡皮圈外不命中', () => {
    const hits = findInkHits({ x: 500, y: 500 }, [line], 20)
    expect(hits).toHaveLength(0)
  })

  it('单点笔迹（点一下）也能命中', () => {
    const dot: InkHitCandidate = { id: 'dot', width: 3, points: [[10, 10]] }
    expect(findInkHits({ x: 12, y: 12 }, [dot], 3)).toHaveLength(1)
    expect(findInkHits({ x: 30, y: 30 }, [dot], 3)).toHaveLength(0)
  })

  it('空折线与零半径都不误伤', () => {
    const empty: InkHitCandidate = { id: 'empty', width: 1, points: [] }
    expect(findInkHits({ x: 0, y: 0 }, [empty], 10)).toHaveLength(0)
    expect(findInkHits({ x: 0, y: 0 }, [line], 0)).toHaveLength(1) // 线宽一半仍算命中
    expect(findInkHits({ x: 50, y: 3 }, [{ ...line, width: 0 }], 0)).toHaveLength(0)
  })
})
