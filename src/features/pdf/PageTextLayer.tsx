import { useMemo, useRef, type CSSProperties } from 'react'
import type { OcrLine } from '../../services/pdfnote'
import { readTextSelection, type TextSelectionInfo } from './textSelection'

export type { TextSelectionInfo } from './textSelection'

interface PageTextLayerProps {
  lines: OcrLine[]
  width: number
  height: number
  active: boolean
  onSelection: (info: TextSelectionInfo | null) => void
}

const FONT_STACK = '-apple-system, "PingFang SC", "Heiti SC", sans-serif'

let measureContext: CanvasRenderingContext2D | null = null
const ascentCache = new Map<number, number>()

function context(): CanvasRenderingContext2D | null {
  if (!measureContext) {
    measureContext = window.document.createElement('canvas').getContext('2d')
  }
  return measureContext
}

/** 按实际字体测量文本宽度，用来把每个 run 横向贴合到 PDF 的字宽。 */
function measureWidth(text: string, fontSize: number): number {
  const ctx = context()
  if (!ctx) return Math.max(1, text.length * fontSize)
  ctx.font = `${fontSize}px ${FONT_STACK}`
  return Math.max(1, ctx.measureText(text).width)
}

/**
 * 字体基线到 em 框顶部的距离。
 * 不同系统字体的 ascent 不一样，用 canvas 的字体度量算出来，
 * 比写死 0.8 更能贴合真实字形（这决定了选区色块是否压住文字）。
 */
function measureAscent(fontSize: number): number {
  const key = Math.round(fontSize * 4) / 4
  const cached = ascentCache.get(key)
  if (cached !== undefined) return cached
  const ctx = context()
  let ascent = fontSize * 0.8
  if (ctx) {
    ctx.font = `${key}px ${FONT_STACK}`
    const metrics = ctx.measureText('中')
    const measured = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent
    if (Number.isFinite(measured) && measured > 0) ascent = measured
  }
  ascentCache.set(key, ascent)
  return ascent
}

/** 把 run 变成一条贴合 PDF 字宽的透明文字。 */
function runLayout(
  lineLeft: number,
  previousRight: number,
  text: string,
  x: number,
  width: number,
  fontSize: number,
  pageWidth: number,
  pageHeight: number,
) {
  const fontSizePx = Math.max(1, fontSize * pageHeight)
  const targetWidth = Math.max(1, width * pageWidth)
  const natural = measureWidth(text, fontSizePx)
  return {
    gapPx: Math.max(0, (x - Math.max(lineLeft, previousRight)) * pageWidth),
    style: {
      width: `${targetWidth}px`,
      fontSize: `${fontSizePx}px`,
    } as CSSProperties,
    scaleX: Math.min(8, Math.max(0.1, targetWidth / natural)),
  }
}

/**
 * An invisible, selectable DOM layer placed over the rendered page.
 *
 * 有 PDF 文字层的页面按 run 渲染：字号来自 PDF 的 transform，基线来自
 * 文字项的 y，横向按 run 的真实字宽做 scaleX —— 不依赖「行高 × 系数」估算，
 * 因此大字号、行内混排、字距被调整过的 PDF 都能对齐。
 * 扫描页仍然按 Vision 返回的行包围盒估算。
 */
export function PageTextLayer({ lines, width, height, active, onSelection }: PageTextLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  const rendered = useMemo(() => lines.map((line, index) => {
    const key = `${index}-${line.x.toFixed(4)}-${line.y.toFixed(4)}`
    if (line.runs && line.runs.length > 0) {
      const tallest = line.runs.reduce(
        (best, run) => (run.fontSize > best.fontSize ? run : best),
        line.runs[0],
      )
      const lineFontPx = Math.max(1, tallest.fontSize * height)
      const topPx = tallest.baselineTop * height - measureAscent(lineFontPx)
      let previousRight = -Infinity
      const runs = line.runs.map((run, runIndex) => {
        const layout = runLayout(
          line.x,
          runIndex === 0 ? -Infinity : previousRight,
          run.text,
          run.x,
          run.width,
          run.fontSize,
          width,
          height,
        )
        previousRight = run.x + run.width
        return {
          key: `${key}-run-${runIndex}`,
          text: run.text,
          style: {
            ...layout.style,
            marginLeft: `${layout.gapPx}px`,
          },
          scaleX: layout.scaleX,
        }
      })
      return {
        key,
        style: {
          left: `${line.x * 100}%`,
          top: `${topPx}px`,
          width: `${line.width * 100}%`,
          height: `${lineFontPx}px`,
          fontSize: `${lineFontPx}px`,
        } as CSSProperties,
        runs,
        scaleX: 1,
        text: line.text,
      }
    }

    // 扫描页：Vision 给的是墨迹包围盒，按行高估算字号并整行拉伸。
    const lineHeight = line.height * height
    const fontSize = Math.max(9, Math.min(96, lineHeight * 0.86))
    const natural = measureWidth(line.text, fontSize)
    const scaleX = Math.min(6, Math.max(0.15, (line.width * width) / natural))
    return {
      key,
      style: {
        left: `${line.x * 100}%`,
        top: `${line.y * 100}%`,
        width: `${line.width * 100}%`,
        height: `${line.height * 100}%`,
        fontSize: `${fontSize}px`,
      } as CSSProperties,
      runs: null,
      scaleX,
      text: line.text,
    }
  }), [lines, width, height])

  const handleSelection = () => {
    if (!active) return
    const root = rootRef.current
    onSelection(root ? readTextSelection(root) : null)
  }

  return (
    <div
      ref={rootRef}
      className={`pdf-text-layer${active ? ' is-active' : ''}`}
      onMouseUp={handleSelection}
      onKeyUp={handleSelection}
      aria-hidden={!active}
    >
      {rendered.map((item) => (
        <div key={item.key} className="pdf-text-line" style={item.style}>
          {item.runs ? item.runs.map((run) => (
            <span key={run.key} className="pdf-text-run" style={run.style}>
              <span style={{ transform: `scaleX(${run.scaleX})` }}>{run.text}</span>
            </span>
          )) : (
            <span style={{ transform: `scaleX(${item.scaleX})` }}>{item.text}</span>
          )}
        </div>
      ))}
    </div>
  )
}
