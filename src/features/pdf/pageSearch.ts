import type { NormalizedBBox } from '../../domain/card'

/** 一行可搜索文本：文字 + 若干矩形（同一次匹配可能跨多个 run）。 */
export interface SearchLine {
  text: string
  rects: NormalizedBBox[]
}

export interface SearchHit {
  page: number
  /** 命中在行内的起始下标。 */
  index: number
  length: number
  snippet: string
  rects: NormalizedBBox[]
}

export interface SearchProgress {
  indexed: number
  total: number
  /** 命中是否已覆盖全部已索引页。 */
  done: boolean
}

const SNIPPET_PAD = 26

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * pdf.js 的文本项 → 归一化行。
 *
 * 每个 item 自带 transform（文本空间 → PDF 空间），乘上 viewport 的变换就是
 * 页面上的像素位置；再除以页面宽高得到与标注一致的 0–1 坐标。
 */
/** 2×3 仿射矩阵相乘：m = a × b（pdf.js 的 Util.transform 同款语义）。 */
function multiplyTransform(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function linesFromTextContent(
  items: ReadonlyArray<{ str?: string; transform?: number[]; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
): SearchLine[] {
  const lines: SearchLine[] = []
  for (const item of items) {
    const raw = item.str ?? ''
    const text = raw.trim()
    if (!text || !item.transform || !item.width || !item.height) continue
    const tx = multiplyTransform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    if (!Number.isFinite(fontHeight) || fontHeight <= 0) continue
    const x = tx[4]
    const y = tx[5] - fontHeight
    // PDF 文本项常带尾部填充空格：按有效字符占比缩短高亮宽度，避免横贯整行。
    const width = Math.abs(item.width) * (raw.length > 0 ? text.length / raw.length : 1)
    const rect = {
      x: clamp01(x / viewport.width),
      y: clamp01(y / viewport.height),
      width: clamp01(width / viewport.width),
      height: clamp01(fontHeight / viewport.height),
    }
    if (rect.width <= 0 || rect.height <= 0) continue
    lines.push({ text: text.replace(/\s+/gu, ' '), rects: [rect] })
  }
  return lines
}

/** OCR 行（已带归一化 bbox）→ 可搜索行。 */
export function linesFromOcr(rows: ReadonlyArray<{ text: string; x: number; y: number; width: number; height: number }>): SearchLine[] {
  return rows
    .map((row) => ({
      text: row.text.trim().replace(/\s+/gu, ' '),
      rects: [{ x: row.x, y: row.y, width: row.width, height: row.height }],
    }))
    .filter((line) => line.text.length > 0)
}

/** 大小写不敏感地查找全部命中；中文按子串、英文也按子串（够用且可预期）。 */
export function findHits(lines: readonly SearchLine[], query: string, page: number, limit = 500): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits: SearchHit[] = []
  for (const line of lines) {
    const haystack = line.text.toLowerCase()
    let from = 0
    while (hits.length < limit) {
      const index = haystack.indexOf(needle, from)
      if (index < 0) break
      hits.push({
        page,
        index,
        length: needle.length,
        snippet: buildSnippet(line.text, index, needle.length),
        rects: line.rects,
      })
      from = index + needle.length
    }
    if (hits.length >= limit) break
  }
  return hits
}

/** 截取命中附近的一段文字，两端加省略号。 */
export function buildSnippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_PAD)
  const end = Math.min(text.length, index + length + SNIPPET_PAD)
  const body = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
