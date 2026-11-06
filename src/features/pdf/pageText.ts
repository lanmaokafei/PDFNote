import type { PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedBBox } from '../../domain/card'
import {
  getPageOcr,
  recognizePageLines,
  savePageOcr,
  type OcrLine,
  type OcrRun,
} from '../../services/pdfnote'
import type { PageViewBox } from './geometry'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

const CACHE_LIMIT = 64
// Vision 整页识别约 2–3 秒，快速翻页时限制并发，避免堆积请求拖慢界面。
const MAX_CONCURRENT_OCR = 2
const memory = new Map<string, OcrLine[]>()
const inFlight = new Map<string, Promise<OcrLine[]>>()
let activeOcr = 0
const ocrQueue: Array<() => void> = []

const keyOf = (documentId: string, page: number) => `${documentId}:${page}`

function acquireOcrSlot(): Promise<void> {
  if (activeOcr < MAX_CONCURRENT_OCR) {
    activeOcr += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => ocrQueue.push(resolve))
}

function releaseOcrSlot() {
  const next = ocrQueue.shift()
  if (next) next()
  else activeOcr = Math.max(0, activeOcr - 1)
}

function remember(key: string, lines: OcrLine[]) {
  memory.delete(key)
  memory.set(key, lines)
  while (memory.size > CACHE_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function getCachedLines(documentId: string, page: number): OcrLine[] | undefined {
  return memory.get(keyOf(documentId, page))
}

/** Cache lines built from a PDF text layer too, so zooming is instant. */
export function cachePageLines(documentId: string, page: number, lines: OcrLine[]) {
  remember(keyOf(documentId, page), lines)
}

export function clearPageTextCache(documentId?: string) {
  if (!documentId) {
    memory.clear()
    return
  }
  for (const key of [...memory.keys()]) {
    if (key.startsWith(`${documentId}:`)) memory.delete(key)
  }
}

/** Drop unusable lines and clamp Vision's slightly overscanned boxes. */
export function normalizeLines(lines: OcrLine[]): OcrLine[] {
  return lines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => {
      const x = Math.min(1, Math.max(0, line.x))
      const y = Math.min(1, Math.max(0, line.y))
      return {
        ...line,
        x,
        y,
        width: Math.min(1 - x, Math.max(0.0001, line.width)),
        height: Math.min(1 - y, Math.max(0.0001, line.height)),
      }
    })
    .filter((line) => line.width > 0 && line.height > 0)
}

function parseStoredLines(json: string): OcrLine[] | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    const lines = parsed.filter((item): item is OcrLine =>
      typeof item === 'object'
      && item !== null
      && typeof (item as OcrLine).text === 'string'
      && typeof (item as OcrLine).x === 'number'
      && typeof (item as OcrLine).y === 'number'
      && typeof (item as OcrLine).width === 'number'
      && typeof (item as OcrLine).height === 'number',
    )
    return normalizeLines(lines.map((line) => ({ ...line, confidence: line.confidence ?? 0 })))
  } catch {
    return null
  }
}

/**
 * Get whole-page line geometry, recognizing only once per page.
 *
 * Order: in-memory cache → SQLite cache → Apple Vision. Concurrent calls for
 * the same page share one promise, so scrolling back and forth cannot trigger
 * duplicate recognition.
 */
export async function ensurePageLines(
  documentId: string,
  page: number,
  imageDataUrl: string,
): Promise<OcrLine[]> {
  const key = keyOf(documentId, page)
  const cached = memory.get(key)
  if (cached) return cached
  const running = inFlight.get(key)
  if (running) return running

  const task = (async () => {
    const stored = await getPageOcr(documentId, page)
    if (stored) {
      const lines = parseStoredLines(stored.linesJson)
      if (lines) {
        remember(key, lines)
        return lines
      }
    }
    await acquireOcrSlot()
    let recognized: OcrLine[]
    try {
      recognized = await recognizePageLines(imageDataUrl)
    } finally {
      releaseOcrSlot()
    }
    const lines = normalizeLines(recognized)
    remember(key, lines)
    // A cache write failure must never break text selection.
    try {
      await savePageOcr(documentId, page, JSON.stringify(lines), 'apple-vision')
    } catch {
      // ignore
    }
    return lines
  })()

  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Turn PDF.js text items into the same line geometry used by the OCR layer.
 * Pages with a real text layer never need Vision; the DOM text layer is built
 * from exact PDF glyph positions instead.
 */
export function linesFromTextContent(content: TextContent, view: PageViewBox): OcrLine[] {
  type Run = OcrRun & { right: number }
  const runs: Run[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const [, , c, d, e, f] = item.transform
    // PDF 的真实字号在 transform 的 c/d 里；item.height 在部分文档里会被放大/缩小，
    // 不能当作字号用，否则大字号的书整层都会偏。
    const fontSize = Math.max(Math.hypot(c, d), 1)
    const width = Math.max(Math.abs(item.width), 1)
    runs.push({
      text: item.str,
      x: (e - view.x) / view.width,
      width: width / view.width,
      baselineTop: 1 - (f - view.y) / view.height,
      fontSize: fontSize / view.height,
      right: (e - view.x + width) / view.width,
    })
  }
  if (runs.length === 0) return []

  runs.sort((a, b) => a.baselineTop - b.baselineTop || a.x - b.x)
  const rows: Run[][] = []
  for (const run of runs) {
    const row = rows[rows.length - 1]
    // 用基线而不是包围盒顶部聚类：同一行的不同字号（内联加粗、上标）基线一致。
    const tolerance = row ? Math.max(...row.map((entry) => entry.fontSize)) * 0.6 : 0
    if (row && Math.abs(row[0].baselineTop - run.baselineTop) <= tolerance) row.push(run)
    else rows.push([run])
  }

  return normalizeLines(rows.map((row) => {
    row.sort((a, b) => a.x - b.x)
    let text = ''
    let previousRight = 0
    for (const run of row) {
      // CJK glyph spacing must not become a space; only insert one between
      // latin words when PDF.js reports a real gap.
      const latinBoundary = /[A-Za-z0-9]/.test(text.slice(-1)) && /^[A-Za-z0-9]/.test(run.text)
      if (text && latinBoundary && run.x - previousRight > run.fontSize * 0.35) text += ' '
      text += run.text
      previousRight = run.x + run.width
    }
    const fontSize = Math.max(...row.map((run) => run.fontSize))
    const baselineTop = row.reduce(
      (best, run) => (run.fontSize > best.fontSize ? run : best),
      row[0],
    ).baselineTop
    const x = Math.min(...row.map((run) => run.x))
    const right = Math.max(...row.map((run) => run.right))
    return {
      text,
      x,
      // 顶部按「基线 − 0.8 倍字号」折算成包围盒，供不认 runs 的旧逻辑使用。
      y: baselineTop - fontSize * 0.8,
      width: right - x,
      height: fontSize,
      confidence: 1,
      runs: row.map(({ right: _right, ...run }) => run),
    }
  })).filter((line) => line.text.trim().length > 0)
}

/**
 * 一页的「文字覆盖面积」：把每行包围盒面积加起来（不重叠时近似）。
 * 正常正文页约 0.2–0.5；只有页码/图注的页接近 0。
 */
export function textLayerCoverage(lines: OcrLine[]): number {
  return lines.reduce(
    (total, line) => total + Math.min(1, Math.max(0, line.width)) * Math.min(1, Math.max(0, line.height)),
    0,
  )
}

/**
 * 文字层太稀疏时改用整页 OCR：
 * 只有页码、或扫描页只带一行隐藏文字的文档，纯 PDF 文字层会让整页无法选择。
 */
export function isSparseTextLayer(lines: OcrLine[]): boolean {
  if (!lines.length) return true
  const chars = lines.reduce((total, line) => total + line.text.replace(/\s/g, '').length, 0)
  if (chars < 40) return true
  return textLayerCoverage(lines) < 0.04
}

/** Build an excerpt from cached lines instead of running OCR for every drag. */
export function extractTextFromLines(lines: OcrLine[], rect: NormalizedBBox): string {
  const hits = lines.filter((line) =>
    line.x <= rect.x + rect.width
    && line.x + line.width >= rect.x
    && line.y <= rect.y + rect.height
    && line.y + line.height >= rect.y,
  )
  hits.sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: OcrLine[][] = []
  for (const line of hits) {
    const row = rows[rows.length - 1]
    const tolerance = row ? Math.max(row[0].height, line.height) * 0.6 : 0
    if (row && Math.abs(row[0].y - line.y) <= tolerance) row.push(line)
    else rows.push([line])
  }
  return rows
    .map((row) => row.sort((a, b) => a.x - b.x).map((line) => line.text.trim()).join(' '))
    .join('\n')
    .replace(/[\t ]+/g, ' ')
    .trim()
}
