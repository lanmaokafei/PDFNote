import type { OcrLine } from '../../services/pdfnote'
import type { PDFDocumentProxy } from './pdfjs'

/**
 * 把 PDF 的某一页渲染成 JPEG data URL，交给 Apple Vision 做整页识别。
 *
 * 目录页通常字号小、点线密，宽度给到 1800px 才能把页码认出来；
 * 再大对识别率提升有限，只会拖慢传输。渲染始终按「整页」来，
 * 不依赖当前视口，所以用户翻到哪一页都能识别目录。
 */
export async function renderPageImage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  maxWidth = 1800,
): Promise<string> {
  const page = await pdf.getPage(pageNumber)
  try {
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(3, Math.max(1, maxWidth / Math.max(1, base.width)))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布上下文')
    // 白底：扫描页本身可能是透明背景，直接编码会得到黑底图，Vision 认不出来。
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.92)
  } finally {
    page.cleanup()
  }
}

/**
 * OCR 行 → 目录文本。Vision 会把同一行的标题与页码拆成多个框，
 * 所以先按 y 聚成行（阈值取一行高），再按 x 排序拼空格。
 */
export function ocrLinesToText(lines: readonly OcrLine[]): string {
  const usable = lines
    .filter((line) => line.text.trim() !== '')
    .map((line) => ({ ...line, text: line.text.trim() }))
  if (usable.length === 0) return ''
  usable.sort((a, b) => a.y - b.y || a.x - b.x)

  const rows: Array<{ y: number; height: number; items: OcrLine[] }> = []
  for (const line of usable) {
    const row = rows[rows.length - 1]
    // 同一行的标题与页码常有几像素基线差，阈值给到一行高；再大就会把相邻两行串起来。
    const tolerance = Math.max(line.height, row?.height ?? 0)
    if (row && Math.abs(line.y - row.y) <= tolerance) {
      row.items.push(line)
      row.height = Math.max(row.height, line.height)
      continue
    }
    rows.push({ y: line.y, height: line.height, items: [line] })
  }

  return rows
    .map((row) => row.items
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim())
    .filter(Boolean)
    .join('\n')
}
