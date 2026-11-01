import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedBBox } from '../../domain/card'

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

export interface PageViewBox {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayRect {
  left: number
  top: number
  width: number
  height: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function clampRect(rect: NormalizedBBox): NormalizedBBox {
  const x = clamp(rect.x, 0, 1)
  const y = clamp(rect.y, 0, 1)
  return {
    x,
    y,
    width: clamp(rect.width, 0, 1 - x),
    height: clamp(rect.height, 0, 1 - y),
  }
}

export function pageViewBox(view: number[]): PageViewBox {
  const [x = 0, y = 0, xMax = 612, yMax = 792] = view
  return { x, y, width: Math.abs(xMax - x), height: Math.abs(yMax - y) }
}

/** Convert an unrotated, top-left-origin normalized rectangle to viewport CSS units. */
export function toDisplayRect(
  rect: NormalizedBBox,
  viewport: PageViewport,
  view: PageViewBox,
): DisplayRect {
  const left = view.x + rect.x * view.width
  const right = view.x + (rect.x + rect.width) * view.width
  const top = view.y + (1 - rect.y) * view.height
  const bottom = view.y + (1 - rect.y - rect.height) * view.height
  const first = viewport.convertToViewportPoint(left, top)
  const second = viewport.convertToViewportPoint(right, bottom)
  const x1 = Number(first[0])
  const y1 = Number(first[1])
  const x2 = Number(second[0])
  const y2 = Number(second[1])
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

/** Convert two viewport points to an unrotated, top-left-origin normalized rectangle. */
export function fromDisplayPoints(
  first: { x: number; y: number },
  second: { x: number; y: number },
  viewport: PageViewport,
  view: PageViewBox,
): NormalizedBBox {
  const a = viewport.convertToPdfPoint(first.x, first.y)
  const b = viewport.convertToPdfPoint(second.x, second.y)
  const ax = Number(a[0])
  const ay = Number(a[1])
  const bx = Number(b[0])
  const by = Number(b[1])
  const left = clamp((Math.min(ax, bx) - view.x) / view.width, 0, 1)
  const right = clamp((Math.max(ax, bx) - view.x) / view.width, 0, 1)
  const bottom = clamp((Math.min(ay, by) - view.y) / view.height, 0, 1)
  const top = clamp((Math.max(ay, by) - view.y) / view.height, 0, 1)
  return { x: left, y: 1 - top, width: right - left, height: top - bottom }
}

export function displayPointToNormalized(
  point: { x: number; y: number },
  viewport: PageViewport,
  view: PageViewBox,
): { x: number; y: number } {
  const pdfPoint = viewport.convertToPdfPoint(point.x, point.y)
  return {
    x: clamp((Number(pdfPoint[0]) - view.x) / view.width, 0, 1),
    y: clamp(1 - (Number(pdfPoint[1]) - view.y) / view.height, 0, 1),
  }
}

export function unionRects(rects: NormalizedBBox[]): NormalizedBBox {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function moveRects(
  rects: NormalizedBBox[],
  deltaX: number,
  deltaY: number,
): NormalizedBBox[] {
  if (rects.length === 0) return rects
  const bounds = unionRects(rects)
  const dx = clamp(deltaX, -bounds.x, 1 - bounds.x - bounds.width)
  const dy = clamp(deltaY, -bounds.y, 1 - bounds.y - bounds.height)
  return rects.map((rect) => ({ ...rect, x: rect.x + dx, y: rect.y + dy }))
}

export function rectsOverlap(a: NormalizedBBox, b: NormalizedBBox): boolean {
  return a.x <= b.x + b.width
    && a.x + a.width >= b.x
    && a.y <= b.y + b.height
    && a.y + a.height >= b.y
}

/** Merge transitively overlapping rectangles so adjacent recall masks cannot leak excerpts. */
export function mergeOverlappingRects(rects: NormalizedBBox[]): NormalizedBBox[] {
  const pending = rects.map(clampRect)
  const merged: NormalizedBBox[] = []
  while (pending.length > 0) {
    let current = pending.shift()
    if (!current) break
    let changed = true
    while (changed) {
      changed = false
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const candidate = pending[index]
        if (candidate && rectsOverlap(current, candidate)) {
          current = unionRects([current, candidate])
          pending.splice(index, 1)
          changed = true
        }
      }
    }
    merged.push(current)
  }
  return merged
}

/** Approximate text extraction using text-item positions in unrotated PDF coordinates. */
export function extractTextInRect(
  content: TextContent,
  rect: NormalizedBBox,
  view: PageViewBox,
): string {
  const left = view.x + rect.x * view.width
  const right = view.x + (rect.x + rect.width) * view.width
  const top = view.y + (1 - rect.y) * view.height
  const bottom = view.y + (1 - rect.y - rect.height) * view.height
  let excerpt = ''

  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const x = item.transform[4] ?? 0
    const y = item.transform[5] ?? 0
    const width = Math.max(Math.abs(item.width), 1)
    const height = Math.max(Math.abs(item.height), Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0), 1)
    const intersects = x <= right && x + width >= left && y <= top && y + height >= bottom
    if (!intersects) continue
    excerpt += item.str
    excerpt += item.hasEOL ? '\n' : ' '
  }

  return excerpt
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}
