import type { PDFDocumentProxy } from './pdfjs'

/** 一条目录条目：标题、起始页（1 起）、层级（0 = 一级标题）。 */
export interface TocEntry {
  title: string
  page: number
  level: number
}

interface OutlineItemLike {
  title?: string
  dest?: unknown
  items?: OutlineItemLike[]
}

export interface OutlineReadOptions {
  /** 只取前几层；默认 2 层（章 / 节），太深会把整本书的条目都建出来。 */
  maxDepth?: number
  /** 节点上限，防止目录特别细的书一次建上千张卡。 */
  maxEntries?: number
}

async function resolvePage(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    let resolved = dest
    if (typeof resolved === 'string') resolved = await pdf.getDestination(resolved)
    if (!Array.isArray(resolved) || resolved.length === 0) return null
    const target = resolved[0]
    // 少数 PDF 直接给页索引，多数给命名的 Ref，需要再查一次。
    if (typeof target === 'number') return target + 1
    const index = await pdf.getPageIndex(target as never)
    return Number.isFinite(index) ? index + 1 : null
  } catch {
    return null
  }
}

/**
 * 读取 PDF 内置目录（书签）并解析成页码。
 *
 * 解析不出页码的条目直接丢弃——宁可少建几个节点，也不要造一堆「第 1 页」的假骨架。
 */
export async function readPdfOutline(
  pdf: PDFDocumentProxy,
  options: OutlineReadOptions = {},
): Promise<TocEntry[]> {
  const maxDepth = Math.max(1, Math.min(4, options.maxDepth ?? 2))
  const maxEntries = Math.max(1, Math.min(500, options.maxEntries ?? 120))
  let outline: OutlineItemLike[] | null = null
  try {
    outline = (await pdf.getOutline()) as OutlineItemLike[] | null
  } catch {
    return []
  }
  if (!outline?.length) return []

  const entries: TocEntry[] = []
  const walk = async (nodes: OutlineItemLike[], level: number) => {
    for (const node of nodes) {
      if (entries.length >= maxEntries) return
      const title = (node.title ?? '').replace(/\s+/g, ' ').trim()
      if (title) {
        const page = await resolvePage(pdf, node.dest)
        if (page) entries.push({ title: title.slice(0, 120), page, level })
      }
      if (level + 1 < maxDepth && node.items?.length) await walk(node.items, level + 1)
    }
  }
  await walk(outline, 0)
  return entries
}

/** 按页码找「最近的小节」：取最后一个起始页不大于当前页的条目，同级取更深的一条。 */
export function nearestTocEntry<T extends { page: number; level: number }>(entries: readonly T[], page: number): T | null {
  let best: T | null = null
  for (const entry of entries) {
    if (entry.page > page) continue
    if (
      !best
      || entry.page > best.page
      || (entry.page === best.page && entry.level >= best.level)
    ) {
      best = entry
    }
  }
  return best
}

/** 新卡应该挂到哪个骨架节点：按页码找最近小节，没有就返回 undefined（挂到根）。 */
export function parentIdForPage(
  entries: readonly { cardId: string; page: number; level: number }[],
  page: number,
): string | undefined {
  return nearestTocEntry(entries, page)?.cardId
}

export interface SkeletonNode extends TocEntry {
  /** 父节点在这一批条目里的下标；null = 根。 */
  parentIndex: number | null
}

/**
 * 把平铺的目录条目接成树：每个条目挂到「上一个层级比它浅」的最近条目下。
 * 纯函数，方便单测；实际建卡时按下标顺序创建即可保证父节点先存在。
 */
export function assignSkeletonParents(entries: readonly TocEntry[]): SkeletonNode[] {
  const lastByLevel: Array<number | null> = []
  return entries.map((entry, index) => {
    const parentIndex = entry.level > 0 ? lastByLevel[entry.level - 1] ?? null : null
    lastByLevel[entry.level] = index
    // 回到浅层时，清掉更深的记录，避免下一节错挂到上一节的子项下。
    for (let level = entry.level + 1; level < lastByLevel.length; level += 1) {
      lastByLevel[level] = null
    }
    return { ...entry, parentIndex }
  })
}
