import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
} from './pdfjs'
import { listPageIndexPages, readPdfChunk, recognizePageLines, savePageIndex } from '../../services/pdfnote'

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.legacy.min.mjs'

/** 与 PDF 全页搜索保持一致：最多索引 1200 页，单页 4000 字。 */
const MAX_PAGES = 1200
const BATCH = 10
const MAX_CHARS = 4000
/** OCR 用的渲染尺寸：字够清楚，又不会让 Vision 太慢。 */
const OCR_MAX_WIDTH = 1400

export interface IndexProgress {
  /** 当前文档已处理页 / 待处理页 */
  done: number
  total: number
  phase: 'text' | 'ocr'
}

export interface IndexResult {
  textPages: number
  ocrPages: number
  skipped: number
}

/**
 * 给一份已加载的 PDF 建页索引。
 *
 * - 文本层有字的页直接存 `source=text`；
 * - `ocr=true` 时，文本层为空的页渲染成图交给 Apple Vision，存 `source=ocr`；
 * - 已有索引的页跳过，所以重复运行是廉价的。
 */
export async function indexDocument(
  pdf: PDFDocumentProxy,
  documentId: string,
  options: { ocr?: boolean; signal: AbortSignal; onProgress?: (progress: IndexProgress) => void },
): Promise<IndexResult> {
  const { ocr = false, signal, onProgress } = options

  const indexed = new Set(await listPageIndexPages(documentId))
  const total = Math.min(pdf.numPages, MAX_PAGES)
  const pending: number[] = []
  for (let page = 1; page <= total; page += 1) {
    if (!indexed.has(page)) pending.push(page)
  }
  const result: IndexResult = { textPages: 0, ocrPages: 0, skipped: 0 }
  if (pending.length === 0) return result

  let batch: { page: number; text: string; source: 'text' | 'ocr' }[] = []
  const flush = async () => {
    if (batch.length === 0) return
    const pages = batch
    batch = []
    await savePageIndex(documentId, pages)
  }

  for (let index = 0; index < pending.length; index += 1) {
    if (signal.aborted) break
    const pageNumber = pending[index]
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .trim()
      .slice(0, MAX_CHARS)

    if (text) {
      batch.push({ page: pageNumber, text, source: 'text' })
      result.textPages += 1
    } else if (ocr) {
      // 扫描页：按需渲染再识别，识别失败就当这一页没索引，不阻断整本。
      try {
        const ocrText = await ocrPage(page)
        if (ocrText) {
          batch.push({ page: pageNumber, text: ocrText, source: 'ocr' })
          result.ocrPages += 1
        } else {
          result.skipped += 1
        }
      } catch {
        // 单页识别失败就当这页没索引，不阻断整本。
        result.skipped += 1
      }
    } else {
      result.skipped += 1
    }

    if (batch.length >= BATCH) await flush()
    onProgress?.({ done: index + 1, total: pending.length, phase: 'text' })
    // 让出主线程：抽取 / OCR 都在主线程排队，翻页和滚动不能被整本卡死。
    if (index % BATCH === BATCH - 1) await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  await flush()
  return result
}

async function ocrPage(page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>): Promise<string> {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(1.6, OCR_MAX_WIDTH / base.width)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建 OCR 画布')
  await page.render({ canvas, viewport }).promise
  const dataUrl = canvas.toDataURL('image/png')
  const lines = await recognizePageLines(dataUrl)
  return lines.map((line) => line.text).join('\n').trim()
}

/** 打开一个文档的 pdf.js 句柄：复用 Range 传输，避免整本读进内存。 */
export async function openDocumentPdf(documentId: string, fileSize: number): Promise<{
  pdf: PDFDocumentProxy
  destroy: () => Promise<void>
}> {
  const transport = new PDFDataRangeTransport(fileSize, null)
  transport.requestDataRange = (begin, end) => {
    void readPdfChunk(documentId, begin, end)
      .then((buffer) => transport.onDataRange(begin, new Uint8Array(buffer)))
      .catch(() => undefined)
  }
  const task = getDocument({
    range: transport,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    disableStream: true,
    disableAutoFetch: true,
    rangeChunkSize: 256 * 1024,
  })
  const pdf = await task.promise
  return { pdf, destroy: () => task.destroy() }
}

/** 文档首次打开时的轻量索引：只抽文本层，不做 OCR。 */
export async function ensurePageIndex(
  pdf: PDFDocumentProxy,
  documentId: string,
  signal: AbortSignal,
): Promise<void> {
  await indexDocument(pdf, documentId, { ocr: false, signal })
}
