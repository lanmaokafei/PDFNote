import { useMemo, useRef, type CSSProperties } from 'react'
import type { NormalizedBBox } from '../../domain/card'
import type { OcrLine } from '../../services/pdfnote'

export interface TextSelectionInfo {
  text: string
  bbox: NormalizedBBox
  left: number
  top: number
}

interface PageTextLayerProps {
  lines: OcrLine[]
  width: number
  height: number
  active: boolean
  onSelection: (info: TextSelectionInfo | null) => void
}

let measureContext: CanvasRenderingContext2D | null = null

/** Measure rendered text so each line can be stretched to its OCR box. */
function measureText(text: string, fontSize: number): number {
  if (!measureContext) {
    measureContext = window.document.createElement('canvas').getContext('2d')
  }
  if (!measureContext) return Math.max(1, text.length * fontSize)
  measureContext.font = `${fontSize}px -apple-system, "PingFang SC", "Heiti SC", sans-serif`
  return Math.max(1, measureContext.measureText(text).width)
}

/**
 * An invisible, selectable DOM layer placed over the rendered page.
 *
 * This is exactly how PDF.js and Word make text selectable: the glyphs are real
 * DOM text (transparent), positioned by the line bounding box that Apple Vision
 * already returns, and stretched horizontally so a click maps to the right
 * character. Selection is therefore native and instant — no OCR per click.
 */
export function PageTextLayer({ lines, width, height, active, onSelection }: PageTextLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  const rendered = useMemo(() => lines.map((line, index) => {
    const lineHeight = line.height * height
    const fontSize = Math.max(9, Math.min(96, lineHeight * 0.86))
    const natural = measureText(line.text, fontSize)
    const scaleX = Math.min(6, Math.max(0.15, (line.width * width) / natural))
    const style: CSSProperties = {
      left: `${line.x * 100}%`,
      top: `${line.y * 100}%`,
      width: `${line.width * 100}%`,
      height: `${line.height * 100}%`,
      fontSize: `${fontSize}px`,
    }
    return {
      key: `${index}-${line.x.toFixed(4)}-${line.y.toFixed(4)}`,
      style,
      scaleX,
      text: line.text,
    }
  }), [lines, width, height])

  const readSelection = () => {
    if (!active) return
    const selection = window.getSelection()
    const text = selection?.toString().trim() ?? ''
    const root = rootRef.current
    if (!text || !selection || selection.rangeCount === 0 || !root) {
      onSelection(null)
      return
    }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const pageRect = root.getBoundingClientRect()
    if (pageRect.width <= 0 || pageRect.height <= 0) return
    const x = Math.min(1, Math.max(0, (rect.left - pageRect.left) / pageRect.width))
    const y = Math.min(1, Math.max(0, (rect.top - pageRect.top) / pageRect.height))
    const right = Math.min(1, Math.max(0, (rect.right - pageRect.left) / pageRect.width))
    const bottom = Math.min(1, Math.max(0, (rect.bottom - pageRect.top) / pageRect.height))
    onSelection({
      text,
      bbox: {
        x,
        y,
        width: Math.max(0.002, right - x),
        height: Math.max(0.002, bottom - y),
      },
      left: Math.max(8, Math.min(pageRect.width - 180, rect.left - pageRect.left)),
      top: Math.min(pageRect.height - 44, rect.bottom - pageRect.top + 8),
    })
  }

  return (
    <div
      ref={rootRef}
      className={`pdf-text-layer${active ? ' is-active' : ''}`}
      onMouseUp={readSelection}
      onKeyUp={readSelection}
      aria-hidden={!active}
    >
      {rendered.map((item) => (
        <div key={item.key} className="pdf-text-line" style={item.style}>
          <span style={{ transform: `scaleX(${item.scaleX})` }}>{item.text}</span>
        </div>
      ))}
    </div>
  )
}
