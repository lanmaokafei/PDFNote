import type { Document } from '../../domain/card'
import { indexDocument, openDocumentPdf } from '../pdf/pageTextIndex'

export interface LibraryIndexProgress {
  documentIndex: number
  documentTotal: number
  title: string
  done: number
  total: number
  phase: 'text' | 'ocr'
}

export interface LibraryIndexSummary {
  documents: number
  textPages: number
  ocrPages: number
  skipped: number
  failed: string[]
  cancelled: boolean
}

/**
 * 全库建索引：逐本打开 PDF，补文本层页；勾了 OCR 还会识别没有文本的扫描页。
 *
 * 串行执行（一次只开一本）：pdf.js 每本都要占内存与 worker，
 * 并发反而更容易把大教材的 Range 读取挤爆。随时可通过 signal 取消。
 */
export async function buildLibraryIndex(
  documents: Document[],
  options: {
    ocr: boolean
    signal: AbortSignal
    onProgress?: (progress: LibraryIndexProgress) => void
  },
): Promise<LibraryIndexSummary> {
  const { ocr, signal, onProgress } = options
  const summary: LibraryIndexSummary = {
    documents: 0,
    textPages: 0,
    ocrPages: 0,
    skipped: 0,
    failed: [],
    cancelled: false,
  }
  const targets = documents.filter((document) => document.file_status === 'ready')

  for (let index = 0; index < targets.length; index += 1) {
    if (signal.aborted) {
      summary.cancelled = true
      break
    }
    const document = targets[index]
    onProgress?.({
      documentIndex: index,
      documentTotal: targets.length,
      title: document.title,
      done: 0,
      total: document.page_count,
      phase: 'text',
    })
    let handle: Awaited<ReturnType<typeof openDocumentPdf>> | null = null
    try {
      handle = await openDocumentPdf(document.id, document.file_size)
      const result = await indexDocument(handle.pdf, document.id, {
        ocr,
        signal,
        onProgress: (progress) => onProgress?.({
          documentIndex: index,
          documentTotal: targets.length,
          title: document.title,
          done: progress.done,
          total: progress.total,
          phase: progress.phase,
        }),
      })
      summary.documents += 1
      summary.textPages += result.textPages
      summary.ocrPages += result.ocrPages
      summary.skipped += result.skipped
    } catch (reason) {
      summary.failed.push(`${document.title}：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      await handle?.destroy().catch(() => undefined)
    }
  }
  if (signal.aborted) summary.cancelled = true
  return summary
}
