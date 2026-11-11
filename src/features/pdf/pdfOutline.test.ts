import { describe, expect, it } from 'vitest'
import { assignSkeletonParents, nearestTocEntry, parentIdForPage, readPdfOutline, type TocEntry } from './pdfOutline'

const entries: TocEntry[] = [
  { title: '第一章 绪论', page: 1, level: 0 },
  { title: '1.1 研究背景', page: 3, level: 1 },
  { title: '1.2 研究问题', page: 6, level: 1 },
  { title: '第二章 方法', page: 20, level: 0 },
  { title: '2.1 数据', page: 22, level: 1 },
]

describe('找最近小节', () => {
  it('取最后一个起始页不大于当前页的条目', () => {
    expect(nearestTocEntry(entries, 1)?.title).toBe('第一章 绪论')
    expect(nearestTocEntry(entries, 5)?.title).toBe('1.1 研究背景')
    expect(nearestTocEntry(entries, 6)?.title).toBe('1.2 研究问题')
    expect(nearestTocEntry(entries, 19)?.title).toBe('1.2 研究问题')
    expect(nearestTocEntry(entries, 40)?.title).toBe('2.1 数据')
  })

  it('还没有进入目录范围时返回 null，不硬挂到第一章', () => {
    expect(nearestTocEntry(entries, 0)).toBeNull()
    expect(nearestTocEntry([], 5)).toBeNull()
  })
})

describe('新卡挂到最近小节', () => {
  const skeleton = [
    { cardId: 'ch1', page: 1, level: 0 },
    { cardId: 's11', page: 3, level: 1 },
    { cardId: 'ch2', page: 20, level: 0 },
  ]

  it('第 5 页的新卡挂到 1.1，第 25 页挂到第二章', () => {
    expect(parentIdForPage(skeleton, 5)).toBe('s11')
    expect(parentIdForPage(skeleton, 25)).toBe('ch2')
  })

  it('没有骨架或还没进正文时返回 undefined，不瞎挂', () => {
    expect(parentIdForPage([], 5)).toBeUndefined()
    expect(parentIdForPage(skeleton, 0)).toBeUndefined()
  })
})

describe('目录接树', () => {
  it('二级条目挂到最近的一级条目下', () => {
    const nodes = assignSkeletonParents(entries)
    expect(nodes.map((node) => node.parentIndex)).toEqual([null, 0, 0, null, 3])
  })

  it('回到一级后，更深层不会继续挂到上一章的节下', () => {
    const nodes = assignSkeletonParents([
      { title: '第一章', page: 1, level: 0 },
      { title: '1.1', page: 3, level: 1 },
      { title: '第二章', page: 9, level: 0 },
      { title: '2.1', page: 10, level: 1 },
    ])
    expect(nodes[3].parentIndex).toBe(2)
  })

  it('缺少父级时退化为根节点，断掉的目录也能建', () => {
    const nodes = assignSkeletonParents([{ title: '孤立小节', page: 5, level: 1 }])
    expect(nodes[0].parentIndex).toBeNull()
  })
})

describe('读取 PDF 目录', () => {
  function fakePdf(outline: unknown, pageIndex: Record<string, number> = {}) {
    return {
      getOutline: async () => outline,
      getDestination: async (name: string) => (pageIndex[name] === undefined ? null : [{ num: pageIndex[name] }, { name: 'Fit' }]),
      getPageIndex: async (ref: { num: number }) => ref.num,
    } as never
  }

  it('命名目标解析成页码，只保留前两层', async () => {
    const pdf = fakePdf([
      {
        title: '第一章',
        dest: [{ num: 0 }, { name: 'Fit' }],
        items: [
          { title: '1.1 背景', dest: [{ num: 2 }, { name: 'Fit' }], items: [{ title: '太深的一节', dest: [{ num: 3 }, { name: 'Fit' }] }] },
        ],
      },
      { title: '第二章', dest: 'chapter-2' },
    ], { 'chapter-2': 19 })

    const result = await readPdfOutline(pdf, { maxDepth: 2 })
    expect(result).toEqual([
      { title: '第一章', page: 1, level: 0 },
      { title: '1.1 背景', page: 3, level: 1 },
      { title: '第二章', page: 20, level: 0 },
    ])
  })

  it('解析不出页码的条目直接丢弃，不造假骨架', async () => {
    const pdf = fakePdf([
      { title: '没有目标', dest: null },
      { title: '未知命名', dest: 'missing' },
      { title: '正常', dest: [{ num: 4 }, { name: 'Fit' }] },
    ])
    const result = await readPdfOutline(pdf)
    expect(result.map((entry) => entry.title)).toEqual(['正常'])
  })

  it('没有目录时返回空数组', async () => {
    expect(await readPdfOutline(fakePdf(null))).toEqual([])
  })

  it('条目数量受上限约束', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ title: `第 ${index} 节`, dest: [{ num: index }, { name: 'Fit' }] }))
    const result = await readPdfOutline(fakePdf(many), { maxEntries: 5 })
    expect(result).toHaveLength(5)
  })
})
