import type { PDFDocumentProxy } from 'pdfjs-dist'
import { listPageIndexPages, savePageIndex } from '../../services/pdfnote'

/** 与 PDF 全页搜索保持一致：最多索引 1200 页，单页 4000 字。 */
const MAX_PAGES = 1200
const BATCH = 20
const MAX_CHARS = 4000

/**
 * 首次打开文档时在后台抽取每页文本，供跨库搜索使用。
 *
 * - 已索引的页在数据库里有记录，跳过；所以第二次打开几乎不做事。
 * - 每 20 页提交一次并让出主线程，避免翻页 / 滚动被抽取卡住。
 * - 调用方传 AbortSignal：切文档即中止，不会把旧书的页写进新书。
 */
export async function ensurePageIndex(
  pdf: PDFDocumentProxy,
  documentId: string,
  signal: AbortSignal,
): Promise<void> {
  const indexed = new Set(await listPageIndexPages(documentId))
  const total = Math.min(pdf.numPages, MAX_PAGES)
  const pending: number[] = []
  for (let page = 1; page <= total; page += 1) {
    if (!indexed.has(page)) pending.push(page)
  }
  if (pending.length === 0) return

  for (let offset = 0; offset < pending.length; offset += BATCH) {
    if (signal.aborted) return
    const batch = pending.slice(offset, offset + BATCH)
    const pages = await Promise.all(batch.map(async (page) => {
      const pdfPage = await pdf.getPage(page)
      const content = await pdfPage.getTextContent()
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .slice(0, MAX_CHARS)
      return { page, text }
    }))
    if (signal.aborted) return
    await savePageIndex(documentId, pages)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
}
