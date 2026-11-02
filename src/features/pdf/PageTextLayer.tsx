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
          <span style={{ transform: `scaleX(${item.scaleX})` }}>{item.text}</span>
        </div>
      ))}
    </div>
  )
}
