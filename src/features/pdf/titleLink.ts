import type { Card, NormalizedBBox } from '../../domain/card'
import type { OcrLine } from '../../services/pdfnote'

/**
 * 标题链接：把卡片标题与别名注册为关键词字典，阅读时反向匹配页面文本。
 * 与 MarginNote 一致，这是纯本地确定性匹配（Aho-Corasick），不依赖 AI。
 */

export interface TitleLinkEntry {
  /** 原始写法，用于展示。 */
  keyword: string
  /** 匹配用写法（拉丁小写，中文不变）。 */
  normalized: string
  /** 同一关键词可对应多张卡（跨文档同题笔记共享条目）。 */
  cardIds: string[]
}

interface AcNode {
  next: Map<string, number>
  fail: number
  outputs: number[]
}

export interface TitleLinkIndex {
  nodes: AcNode[]
  entries: TitleLinkEntry[]
}

export interface TitleLinkHit {
  keyword: string
  cardIds: string[]
  lineIndex: number
  bbox: NormalizedBBox
}

const MAX_KEYWORD_CHARS = 24
const MAX_HITS_PER_PAGE = 80

/** 标题/别名是否适合注册为关键词：单行、2–24 字符、含文字。 */
export function normalizeKeyword(raw: string): string | null {
  const value = raw.trim()
  if (!value || /[\r\n]/.test(value)) return null
  const chars = Array.from(value)
  if (chars.length < 2 || chars.length > MAX_KEYWORD_CHARS) return null
  // 至少包含一个文字或字母数字，避免纯标点关键词。
  if (!/[\p{L}\p{N}]/u.test(value)) return null
  return value
}

/** 从卡片提取全部关键词：标题（question）+ 分号分隔的别名。 */
export function cardKeywords(card: Pick<Card, 'question' | 'link_aliases'>): string[] {
  const keywords: string[] = []
  const title = normalizeKeyword(card.question)
  if (title) keywords.push(title)
  for (const alias of (card.link_aliases ?? '').split(/[;；]/)) {
    const value = normalizeKeyword(alias)
    if (value && !keywords.includes(value)) keywords.push(value)
  }
  return keywords
}

export function buildTitleLinkIndex(
  cards: Array<Pick<Card, 'id' | 'question' | 'link_aliases'>>,
): TitleLinkIndex {
  const byNormalized = new Map<string, TitleLinkEntry>()
  for (const card of cards) {
    for (const keyword of cardKeywords(card)) {
      const normalized = keyword.toLowerCase()
      const existing = byNormalized.get(normalized)
      if (existing) {
        if (!existing.cardIds.includes(card.id)) existing.cardIds.push(card.id)
      } else {
        byNormalized.set(normalized, { keyword, normalized, cardIds: [card.id] })
      }
    }
  }

  const entries = [...byNormalized.values()]
  const nodes: AcNode[] = [{ next: new Map(), fail: 0, outputs: [] }]
  entries.forEach((entry, entryIndex) => {
    let current = 0
    for (const char of entry.normalized) {
      let next = nodes[current].next.get(char)
      if (next === undefined) {
        next = nodes.length
        nodes.push({ next: new Map(), fail: 0, outputs: [] })
        nodes[current].next.set(char, next)
      }
      current = next
    }
    nodes[current].outputs.push(entryIndex)
  })

  // BFS 构建 fail 指针。
  const queue: number[] = []
  for (const next of nodes[0].next.values()) queue.push(next)
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const [char, next] of nodes[current].next) {
      queue.push(next)
      let fail = nodes[current].fail
      while (fail !== 0 && !nodes[fail].next.has(char)) fail = nodes[fail].fail
      nodes[next].fail = nodes[fail].next.get(char) ?? 0
      if (nodes[next].fail === next) nodes[next].fail = 0
      nodes[next].outputs.push(...nodes[nodes[next].fail].outputs)
    }
  }
  return { nodes, entries }
}

export function isTitleLinkIndexEmpty(index: TitleLinkIndex): boolean {
  return index.entries.length === 0
}

interface RawMatch {
  start: number
  end: number
  entryIndex: number
}

const isLatinWordChar = (char: string | undefined) => !!char && /[a-z0-9]/i.test(char)

/** 拉丁关键词要求词边界，避免 "MI" 命中 "SMITH" 内部；中文直接子串匹配。 */
function boundaryOk(text: string, match: RawMatch, normalized: string): boolean {
  const first = normalized[0]
  const last = normalized[normalized.length - 1]
  if (isLatinWordChar(first) && isLatinWordChar(text[match.start - 1])) return false
  if (isLatinWordChar(last) && isLatinWordChar(text[match.end])) return false
  return true
}

function matchLine(index: TitleLinkIndex, rawText: string): RawMatch[] {
  const text = rawText.toLowerCase()
  const matches: RawMatch[] = []
  let current = 0
  let position = 0
  for (const char of text) {
    while (current !== 0 && !index.nodes[current].next.has(char)) {
      current = index.nodes[current].fail
    }
    current = index.nodes[current].next.get(char) ?? 0
    const charLength = char.length
    const end = position + charLength
    for (const entryIndex of index.nodes[current].outputs) {
      const normalized = index.entries[entryIndex].normalized
      const start = end - normalized.length
      if (start < 0) continue
      const match = { start, end, entryIndex }
      if (boundaryOk(text, match, normalized)) matches.push(match)
    }
    position = end
  }
  // 同行内重叠命中保留更长者（如"心肌梗死"优先于"心梗"的误嵌套）。
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const accepted: RawMatch[] = []
  for (const match of matches) {
    if (accepted.some((other) => match.start < other.end && other.start < match.end)) continue
    accepted.push(match)
  }
  return accepted
}

let measureContext: CanvasRenderingContext2D | null | undefined

/** 与文字层同字体测量，求行内前缀宽度比例；Node 测试环境退化为字符比例。 */
function measureRatio(text: string, prefix: string, hit: string): { start: number; width: number } {
  if (measureContext === undefined) {
    measureContext = typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null
  }
  if (!measureContext) {
    const total = Math.max(1, Array.from(text).length)
    return {
      start: Array.from(prefix).length / total,
      width: Math.max(1, Array.from(hit).length) / total,
    }
  }
  measureContext.font = '100px -apple-system, "PingFang SC", "Heiti SC", sans-serif'
  const total = Math.max(1, measureContext.measureText(text).width)
  return {
    start: measureContext.measureText(prefix).width / total,
    width: Math.max(0.001, measureContext.measureText(hit).width / total),
  }
}

/** 计算命中词在页面上的归一化子矩形（与文字层同一套行框定位）。 */
export function hitBBox(line: OcrLine, start: number, end: number): NormalizedBBox {
  const prefix = line.text.slice(0, start)
  const hit = line.text.slice(start, end)
  const ratio = measureRatio(line.text, prefix, hit)
  const x = Math.min(1, Math.max(0, line.x + line.width * ratio.start))
  return {
    x,
    y: line.y,
    width: Math.min(1 - x, Math.max(0.001, line.width * ratio.width)),
    height: line.height,
  }
}

/** 对一页的行级文本做反向匹配，返回可渲染的高亮命中。 */
export function searchTitleLinks(index: TitleLinkIndex, lines: OcrLine[]): TitleLinkHit[] {
  const hits: TitleLinkHit[] = []
  lines.forEach((line, lineIndex) => {
    if (!line.text.trim()) return
    for (const match of matchLine(index, line.text)) {
      if (hits.length >= MAX_HITS_PER_PAGE) return
      const entry = index.entries[match.entryIndex]
      hits.push({
        keyword: entry.keyword,
        cardIds: entry.cardIds,
        lineIndex,
        bbox: hitBBox(line, match.start, match.end),
      })
    }
  })
  return hits
}
