import type { NotebookInk, PaperStyle } from '../../domain/card'

/** 与画布渲染共用同一套页面尺寸（viewBox 单位）。 */
export const PAGE_W = 1000
export const PAGE_H = 1414

export interface ExportableInk {
  points: Array<[number, number]>
  color: string
  width: number
}

/** 只保留落在本页、且图层可见的笔迹，并转成绘制用的最小结构。 */
export function collectPageInks(
  inks: readonly NotebookInk[],
  page: number,
  visibleLayerIds?: ReadonlySet<string>,
): ExportableInk[] {
  return inks
    .filter((ink) => ink.page === page)
    .filter((ink) => !visibleLayerIds || visibleLayerIds.has(ink.layer_id))
    .map((ink) => ({
      points: ink.style.points ?? [],
      color: ink.style.color ?? '#2f3330',
      width: ink.style.width ?? 0.0035,
    }))
    .filter((ink) => ink.points.length > 1)
}

function drawPaper(ctx: CanvasRenderingContext2D, paper: PaperStyle): void {
  ctx.fillStyle = paper === 'blank' ? '#ffffff' : '#fdfdfb'
  ctx.fillRect(0, 0, PAGE_W, PAGE_H)
  ctx.strokeStyle = '#e6ecf1'
  ctx.fillStyle = '#e6ecf1'
  ctx.lineWidth = 1
  if (paper === 'lined') {
    for (let y = 96; y < PAGE_H - 40; y += 44) {
      ctx.beginPath()
      ctx.moveTo(56, y)
      ctx.lineTo(PAGE_W - 56, y)
      ctx.stroke()
    }
  } else if (paper === 'grid') {
    for (let x = 56; x < PAGE_W - 40; x += 44) {
      ctx.beginPath()
      ctx.moveTo(x, 56)
      ctx.lineTo(x, PAGE_H - 56)
      ctx.stroke()
    }
    for (let y = 56; y < PAGE_H - 40; y += 44) {
      ctx.beginPath()
      ctx.moveTo(56, y)
      ctx.lineTo(PAGE_W - 56, y)
      ctx.stroke()
    }
  } else if (paper === 'dot') {
    for (let x = 56; x < PAGE_W - 40; x += 44) {
      for (let y = 56; y < PAGE_H - 40; y += 44) {
        ctx.beginPath()
        ctx.arc(x, y, 1.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

function drawStrokes(ctx: CanvasRenderingContext2D, inks: readonly ExportableInk[]): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const ink of inks) {
    ctx.beginPath()
    ink.points.forEach((point, index) => {
      const x = point[0] * PAGE_W
      const y = point[1] * PAGE_H
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = ink.color
    ctx.lineWidth = Math.max(1.5, ink.width * PAGE_W)
    ctx.stroke()
  }
}

/**
 * 把一页画到 canvas 并返回 base64 PNG。
 *
 * 不走 DOM 截图：手写页的笔迹本来就是矢量点，直接重绘更清晰，
 * 也不受滚动位置、缩放比例与元素可见性影响。
 */
export function renderNotebookPage(
  page: number,
  inks: readonly NotebookInk[],
  paper: PaperStyle,
  options: { scale?: number; visibleLayerIds?: ReadonlySet<string> } = {},
): string {
  const scale = options.scale ?? 2
  const canvas = document.createElement('canvas')
  canvas.width = PAGE_W * scale
  canvas.height = PAGE_H * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建导出画布')
  ctx.scale(scale, scale)
  drawPaper(ctx, paper)
  drawStrokes(ctx, collectPageInks(inks, page, options.visibleLayerIds))
  return canvas.toDataURL('image/png').split(',')[1] ?? ''
}

/** 整本导出：每页一张 PNG，文件名补零方便排序。 */
export function renderNotebookPages(
  pages: number,
  inks: readonly NotebookInk[],
  paper: PaperStyle,
  options: { scale?: number; visibleLayerIds?: ReadonlySet<string> } = {},
): Array<{ name: string; base64: string }> {
  const width = String(pages).length
  return Array.from({ length: pages }, (_, index) => {
    const page = index + 1
    return {
      name: `第 ${String(page).padStart(width, '0')} 页.png`,
      base64: renderNotebookPage(page, inks, paper, options),
    }
  })
}
