import {
  listNotebookInks,
  listNotebookPageIndex,
  recognizePageLines,
  saveNotebookPageIndex,
} from '../../services/pdfnote'
import type { Notebook, NotebookInk } from '../../domain/card'
import { renderNotebookPageJpeg } from './notebookExport'

export interface NotebookIndexProgress {
  notebookIndex: number
  notebookTotal: number
  title: string
  done: number
  total: number
}

export interface NotebookIndexSummary {
  notebooks: number
  pages: number
  skipped: number
  failed: string[]
  cancelled: boolean
}

/** 笔迹指纹：笔数 + 最后更新时间。笔迹只增删、不原地改，足够判断是否需要重识别。 */
function pageSignature(inks: NotebookInk[]): string {
  if (inks.length === 0) return '0:'
  let latest = ''
  for (const ink of inks) if (ink.updated_at > latest) latest = ink.updated_at
  return `${inks.length}:${latest}`
}

/**
 * 手写本建索引：按页渲染 → Apple Vision 识别 → 存 notebook_page_index。
 *
 * 只有**有笔迹的页**才识别（空白页没有可搜内容）；
 * 指纹没变的页直接跳过，所以重复运行只处理新写的页。
 */
export async function indexNotebooks(
  notebooks: Notebook[],
  options: { signal: AbortSignal; onProgress?: (progress: NotebookIndexProgress) => void },
): Promise<NotebookIndexSummary> {
  const { signal, onProgress } = options
  const summary: NotebookIndexSummary = {
    notebooks: 0,
    pages: 0,
    skipped: 0,
    failed: [],
    cancelled: false,
  }

  for (let index = 0; index < notebooks.length; index += 1) {
    if (signal.aborted) {
      summary.cancelled = true
      break
    }
    const notebook = notebooks[index]
    try {
      const inks = await listNotebookInks(notebook.id)
      const byPage = new Map<number, NotebookInk[]>()
      for (const ink of inks) {
        const list = byPage.get(ink.page) ?? []
        list.push(ink)
        byPage.set(ink.page, list)
      }
      const existing = new Map(
        (await listNotebookPageIndex(notebook.id)).map((item) => [item.page, item.signature]),
      )
      const pages = [...byPage.keys()].sort((a, b) => a - b)
      let batch: { page: number; text: string; signature: string }[] = []
      let processed = 0

      for (const page of pages) {
        if (signal.aborted) {
          summary.cancelled = true
          break
        }
        const pageInks = byPage.get(page) ?? []
        const signature = pageSignature(pageInks)
        processed += 1
        onProgress?.({
          notebookIndex: index,
          notebookTotal: notebooks.length,
          title: notebook.title,
          done: processed,
          total: pages.length,
        })
        if (existing.get(page) === signature) {
          summary.skipped += 1
          continue
        }
        const image = renderNotebookPageJpeg(page, inks, notebook.paper, {
          scale: 1.4,
          visibleLayerIds: undefined,
        })
        const dataUrl = `data:image/jpeg;base64,${image.base64}`
        const lines = await recognizePageLines(dataUrl)
        const text = lines.map((line) => line.text).join('\n').trim()
        if (!text) {
          summary.skipped += 1
          continue
        }
        batch.push({ page, text, signature })
        if (batch.length >= 5) {
          await saveNotebookPageIndex(notebook.id, batch)
          summary.pages += batch.length
          batch = []
          await new Promise((resolve) => window.setTimeout(resolve, 0))
        }
      }
      if (batch.length > 0) {
        await saveNotebookPageIndex(notebook.id, batch)
        summary.pages += batch.length
      }
      summary.notebooks += 1
    } catch (reason) {
      summary.failed.push(`${notebook.title}：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }
  if (signal.aborted) summary.cancelled = true
  return summary
}
