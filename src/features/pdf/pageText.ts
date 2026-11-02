import type { PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedBBox } from '../../domain/card'
import {
  getPageOcr,
  recognizePageLines,
  savePageOcr,
  type OcrLine,
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
  type Item = { text: string; x: number; y: number; width: number; height: number }
  const items: Item[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const tx = item.transform[4] ?? 0
    const ty = item.transform[5] ?? 0
    const width = Math.max(Math.abs(item.width), 1)
    const height = Math.max(
      Math.abs(item.height),
      Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0),
      1,
    )
    const bottomPdf = ty - view.y
    const topPdf = bottomPdf + height
    items.push({
      text: item.str,
      x: (tx - view.x) / view.width,
      y: 1 - topPdf / view.height,
      width: width / view.width,
      height: height / view.height,
    })
  }
  if (items.length === 0) return []

  items.sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: Item[][] = []
  for (const item of items) {
    const row = rows[rows.length - 1]
    const tolerance = row ? Math.max(row[0].height, item.height) * 0.6 : 0
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item)
    else rows.push([item])
  }

  return normalizeLines(rows.map((row) => {
    row.sort((a, b) => a.x - b.x)
    let text = ''
    let previousRight = 0
    for (const item of row) {
      // CJK glyph spacing must not become a space; only insert one between
      // latin words when PDF.js reports a real gap.
      const latinBoundary = /[A-Za-z0-9]/.test(text.slice(-1)) && /^[A-Za-z0-9]/.test(item.text)
      if (text && latinBoundary && item.x - previousRight > item.height * 0.35) text += ' '
      text += item.text
      previousRight = item.x + item.width
    }
    const x = Math.min(...row.map((item) => item.x))
    const y = Math.min(...row.map((item) => item.y))
    const right = Math.max(...row.map((item) => item.x + item.width))
    const bottom = Math.max(...row.map((item) => item.y + item.height))
    return {
      text,
      x,
      y,
      width: right - x,
      height: bottom - y,
      confidence: 1,
    }
  })).filter((line) => line.text.trim().length > 0)
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
