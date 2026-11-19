import { getPageOcr } from '../../services/pdfnote'
import type { PDFDocumentProxy } from './pdfjs'
import { linesFromOcr, linesFromTextContent, type SearchLine, type SearchProgress } from './pageSearch'

function parseOcrLines(raw: string): SearchLine[] {
  try {
    const parsed = JSON.parse(raw) as Array<{ text?: string; x?: number; y?: number; width?: number; height?: number }>
    return linesFromOcr(parsed.map((row) => ({
      text: row.text ?? '',
      x: row.x ?? 0,
      y: row.y ?? 0,
      width: row.width ?? 0,
      height: row.height ?? 0,
    })))
  } catch {
    return []
  }
}

/**
 * 单页文本：优先 PDF 文字层，空页（扫描件）再退回 `page_ocr` 缓存。
 * 扫描页每页一次 IPC，只在真的没有文字层时发生。
 */
export async function extractPageLines(
  pdf: PDFDocumentProxy,
  documentId: string,
  pageNumber: number,
): Promise<SearchLine[]> {
  const page = await pdf.getPage(pageNumber)
  try {
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const lines = linesFromTextContent(
      content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>,
      viewport,
    )
    if (lines.length > 0) return lines
  } catch {
    // 文字层损坏时也走 OCR 兜底。
  } finally {
    page.cleanup()
  }
  const ocr = await getPageOcr(documentId, pageNumber).catch(() => null)
  return ocr ? parseOcrLines(ocr.linesJson) : []
}

/**
 * 逐页建立索引，边建边回调。
 *
 * 顺序执行而不是并发：pdf.js 的 worker 与页面渲染共用通道，
 * 并发抽取会让正在滚动的页面明显卡顿；顺序抽取单页通常只需几毫秒。
 */
export async function indexDocument(
  pdf: PDFDocumentProxy,
  documentId: string,
  options: {
    maxPages?: number
    signal?: { cancelled: boolean }
    onPage?: (page: number, lines: SearchLine[]) => void
    onProgress?: (progress: SearchProgress) => void
  } = {},
): Promise<Map<number, SearchLine[]>> {
  const total = Math.min(pdf.numPages, options.maxPages ?? 1200)
  const index = new Map<number, SearchLine[]>()
  for (let page = 1; page <= total; page += 1) {
    if (options.signal?.cancelled) break
    const lines = await extractPageLines(pdf, documentId, page)
    index.set(page, lines)
    options.onPage?.(page, lines)
    options.onProgress?.({ indexed: page, total, done: page === total })
    // 让出一帧，别把滚动/缩放的输入事件堵死。
    if (page % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  options.onProgress?.({ indexed: index.size, total, done: true })
  return index
}
