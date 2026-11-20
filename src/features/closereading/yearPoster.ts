import { formatReadingClock } from '../reading/readingStats'

export interface YearPosterBook {
  title: string
  seconds: number
}

export interface YearPosterData {
  year: number
  totalSeconds: number
  activeDays: number
  longestStreak: number
  currentStreak: number
  cardsWritten: number
  reviews: number
  reviewedCards: number
  averageSeconds: number
  /** 12 个月的总秒数。 */
  months: number[]
  books: YearPosterBook[]
}

export const POSTER_W = 1080
export const POSTER_H = 1350

/**
 * 柱状图高度：按当年最高月归一，零值给 0（画一条基线即可）。
 * 抽成纯函数方便单测，避免只能靠截图判断。
 */
export function barHeights(months: readonly number[], maxHeight: number): number[] {
  const peak = Math.max(0, ...months)
  if (peak <= 0 || maxHeight <= 0) return months.map(() => 0)
  return months.map((value) => {
    if (value <= 0) return 0
    return Math.max(6, Math.round((value / peak) * maxHeight))
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function metricCard(ctx: CanvasRenderingContext2D, x: number, y: number, value: string, label: string): void {
  ctx.fillStyle = 'rgba(255,255,255,.72)'
  roundRect(ctx, x, y, 420, 140, 20)
  ctx.fill()
  ctx.strokeStyle = 'rgba(116, 145, 118, .18)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = '#2f4a37'
  ctx.font = '600 46px "PingFang SC", "Helvetica Neue", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(value, x + 210, y + 68)
  ctx.fillStyle = '#8a978c'
  ctx.font = '400 22px "PingFang SC", "Helvetica Neue", sans-serif'
  ctx.fillText(label, x + 210, y + 108)
}

/**
 * 年度回顾分享图：一张竖版 PNG，包含四宫格、月柱、书单。
 *
 * 不走 DOM 截图——分享卡片的排版与页面无关，单独绘制才能保证
 * 在不同窗口尺寸、缩放下导出的图完全一致。
 */
export function renderYearPoster(data: YearPosterData): string {
  const canvas = document.createElement('canvas')
  canvas.width = POSTER_W
  canvas.height = POSTER_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建导出画布')

  // 背景：米色纸面 + 顶部淡绿弧
  const gradient = ctx.createLinearGradient(0, 0, 0, POSTER_H)
  gradient.addColorStop(0, '#fbfaf2')
  gradient.addColorStop(1, '#f4f6ee')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, POSTER_W, POSTER_H)
  ctx.fillStyle = 'rgba(154, 191, 154, .22)'
  ctx.beginPath()
  ctx.ellipse(POSTER_W / 2, -60, POSTER_W * 0.7, 260, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.textAlign = 'left'
  ctx.fillStyle = '#93a08f'
  ctx.font = '500 20px "PingFang SC", "Helvetica Neue", sans-serif'
  ctx.fillText('PDFNOTE · YEAR IN REVIEW', 72, 116)
  ctx.fillStyle = '#2c4234'
  ctx.font = '600 62px "PingFang SC", "Helvetica Neue", sans-serif'
  ctx.fillText(`${data.year} 年度回顾`, 72, 194)
  ctx.fillStyle = '#7d8b7f'
  ctx.font = '400 24px "PingFang SC", "Helvetica Neue", sans-serif'
  ctx.fillText(
    `读了 ${data.books.length} 本书 · ${formatReadingClock(data.totalSeconds)} · ${data.activeDays} 个阅读日`,
    74,
    238,
  )

  metricCard(ctx, 72, 286, formatReadingClock(data.totalSeconds), '阅读时长')
  metricCard(ctx, 588, 286, `${data.activeDays}`, '阅读天数')
  metricCard(ctx, 72, 446, `${data.longestStreak}`, '最长连续（天）')
  metricCard(ctx, 588, 446, `${data.cardsWritten}`, '写卡（张）')

  // 月柱
  const chartX = 72
  const chartY = 640
  const chartW = POSTER_W - 144
  const chartH = 210
  ctx.fillStyle = 'rgba(255,255,255,.6)'
  roundRect(ctx, chartX - 16, chartY - 34, chartW + 32, chartH + 76, 22)
  ctx.fill()
  const heights = barHeights(data.months, chartH)
  const slot = chartW / 12
  heights.forEach((height, index) => {
    const barW = Math.min(44, slot - 18)
    const x = chartX + slot * index + (slot - barW) / 2
    const y = chartY + chartH - height
    ctx.fillStyle = height > 0 ? '#7ba983' : '#e6ece2'
    roundRect(ctx, x, y, barW, Math.max(6, height), 8)
    ctx.fill()
    ctx.fillStyle = '#9aa496'
    ctx.font = '400 18px "PingFang SC", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${index + 1}`, chartX + slot * index + slot / 2, chartY + chartH + 30)
  })
  ctx.textAlign = 'left'

  // 小结
  ctx.fillStyle = '#5c6a5d'
  ctx.font = '400 22px "PingFang SC", "Helvetica Neue", sans-serif'
  const summary = `复习 ${data.reviews} 次 · 复习过 ${data.reviewedCards} 张卡 · 平均每个阅读日 ${formatReadingClock(data.averageSeconds)}`
  ctx.fillText(summary, 72, chartY + chartH + 84)
  if (data.currentStreak > 0) {
    ctx.fillStyle = '#7ba983'
    ctx.fillText(`当前连续 ${data.currentStreak} 天`, 72, chartY + chartH + 118)
  }

  // 书单
  ctx.fillStyle = '#93a08f'
  ctx.font = '500 20px "PingFang SC", sans-serif'
  ctx.fillText('读过的书', 72, 1046)
  const books = data.books.slice(0, 5)
  if (books.length === 0) {
    ctx.fillStyle = '#a5aea2'
    ctx.font = '400 22px "PingFang SC", sans-serif'
    ctx.fillText('今年还没有阅读记录', 72, 1092)
  } else {
    books.forEach((book, index) => {
      const y = 1092 + index * 46
      ctx.fillStyle = '#3f4f42'
      ctx.font = '400 24px "PingFang SC", sans-serif'
      const title = book.title.length > 18 ? `${book.title.slice(0, 18)}…` : book.title
      ctx.fillText(title, 72, y)
      ctx.fillStyle = '#8a978c'
      ctx.font = '400 22px "PingFang SC", sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(formatReadingClock(book.seconds), POSTER_W - 72, y)
      ctx.textAlign = 'left'
    })
  }

  ctx.fillStyle = '#a9b3a6'
  ctx.font = '400 18px "PingFang SC", sans-serif'
  ctx.fillText('PDFNote · 全部数据保存在本机', 72, POSTER_H - 54)

  return canvas.toDataURL('image/png').split(',')[1] ?? ''
}
