import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { Annotation, AnnotationGeometry, NormalizedBBox, PageInk } from '../../domain/card'
import {
  clampRect,
  displayPointToNormalized,
  extractTextInRect,
  fromDisplayPoints,
  mergeOverlappingRects,
  moveRects,
  pageViewBox,
  rectsOverlap,
  toDisplayRect,
  unionRects,
} from './geometry'

export type PdfTool = 'select' | 'highlight' | 'rectangle' | 'ink'
export interface PageSize {
  width: number
  height: number
}

type Point = { x: number; y: number }
type Interaction =
  | { type: 'create'; pointerId: number; start: Point; rect: NormalizedBBox }
  | { type: 'move'; pointerId: number; annotation: Annotation; start: Point; startNormalized: Point; rects: NormalizedBBox[] }

interface PdfPageProps {
  pageNumber: number
  shouldRender: boolean
  scale: number
  size: PageSize
  annotations: Annotation[]
  inks: PageInk[]
  inkColor: string
  inkWidth: number
  inkErase: boolean
  excerpts: Record<string, string>
  tool: PdfTool
  recallMode: boolean
  revealedCardIds: ReadonlySet<string>
  selectedAnnotationId: string | null
  getPage: (pageNumber: number) => Promise<PDFPageProxy>
  registerPage: (pageNumber: number, element: HTMLElement | null) => void
  onSize: (pageNumber: number, size: PageSize) => void
  onSelect: (annotation: Annotation) => void
  onCreate: (page: PDFPageProxy, rect: NormalizedBBox, excerpt: string, ocrImage?: string) => Promise<void>
  onMove: (annotation: Annotation, geometry: AnnotationGeometry, bbox: NormalizedBBox) => void
  onReveal: (annotationIds: string[]) => void
  onInk: (bbox: NormalizedBBox, points: Array<[number, number]>) => void
  onEraseInk: (id: string) => void
}

export function PdfPage({
  pageNumber,
  shouldRender,
  scale,
  size,
  annotations,
  inks,
  inkColor,
  inkWidth,
  inkErase,
  excerpts,
  tool,
  recallMode,
  revealedCardIds,
  selectedAnnotationId,
  getPage,
  registerPage,
  onSize,
  onSelect,
  onCreate,
  onMove,
  onReveal,
  onInk,
  onEraseInk,
}: PdfPageProps) {
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [pageError, setPageError] = useState('')
  const [rendering, setRendering] = useState(false)
  const [retry, setRetry] = useState(0)
  const [interaction, setInteraction] = useState<Interaction | null>(null)
  const [stroke, setStroke] = useState<Array<[number, number]> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const pageRef = useCallback((element: HTMLElement | null) => {
    registerPage(pageNumber, element)
  }, [pageNumber, registerPage])

  useEffect(() => {
    if (!shouldRender) return
    let active = true
    setPageError('')
    getPage(pageNumber)
      .then((loadedPage) => {
        if (!active) return
        setPage(loadedPage)
        const viewport = loadedPage.getViewport({ scale: 1 })
        onSize(pageNumber, { width: viewport.width, height: viewport.height })
      })
      .catch((reason: unknown) => {
        if (active) setPageError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      active = false
    }
  }, [getPage, onSize, pageNumber, retry, shouldRender])

  const viewport = useMemo(() => page?.getViewport({ scale: 1 }) ?? null, [page])
  const view = useMemo(() => (page ? pageViewBox(page.view) : null), [page])
  const cssWidth = (viewport?.width ?? size.width) * scale
  const cssHeight = (viewport?.height ?? size.height) * scale

  useEffect(() => {
    const canvas = canvasRef.current
    if (!page || !viewport || !shouldRender || !canvas) return
    let active = true
    let task: RenderTask | null = null
    setRendering(true)
    setPageError('')

    const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
    const renderViewport = page.getViewport({ scale: scale * pixelRatio })
    canvas.width = Math.max(1, Math.floor(renderViewport.width))
    canvas.height = Math.max(1, Math.floor(renderViewport.height))
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    try {
      task = page.render({ canvas, viewport: renderViewport })
      void task.promise
        .then(() => {
          if (active) setRendering(false)
        })
        .catch((reason: unknown) => {
          if (!active) return
          setRendering(false)
          setPageError(reason instanceof Error ? reason.message : String(reason))
        })
    } catch (reason) {
      setRendering(false)
      setPageError(reason instanceof Error ? reason.message : String(reason))
    }

    return () => {
      active = false
      task?.cancel()
      canvas.width = 0
      canvas.height = 0
    }
  }, [cssHeight, cssWidth, page, retry, scale, shouldRender, viewport])

  useEffect(() => {
    setInteraction(null)
  }, [recallMode, scale, tool])

  const pointFromEvent = useCallback((event: React.PointerEvent): Point => {
    const svg = svgRef.current
    if (!svg || !viewport) return { x: 0, y: 0 }
    const bounds = svg.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) * (viewport.width / bounds.width),
      y: (event.clientY - bounds.top) * (viewport.height / bounds.height),
    }
  }, [viewport])

  const displayedAnnotations = useMemo(() => {
    if (interaction?.type !== 'move') return annotations
    return annotations.map((annotation) => annotation.id === interaction.annotation.id
      ? { ...annotation, geometry: { rects: interaction.rects } }
      : annotation)
  }, [annotations, interaction])

  const recallMasks = useMemo(() => {
    if (!recallMode) return []
    return mergeOverlappingRects(annotations.flatMap((annotation) => annotation.geometry.rects))
  }, [annotations, recallMode])

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (recallMode || event.button !== 0 || !viewport || !view) return
    if (tool === 'ink') {
      if (inkErase) return
      event.preventDefault()
      const point = displayPointToNormalized(pointFromEvent(event), viewport, view)
      event.currentTarget.setPointerCapture(event.pointerId)
      setStroke([[point.x, point.y]])
      return
    }
    if (tool === 'select') return
    event.preventDefault()
    const start = pointFromEvent(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setInteraction({ type: 'create', pointerId: event.pointerId, start, rect: fromDisplayPoints(start, start, viewport, view) })
  }

  const handleMoveStart = (event: React.PointerEvent<SVGGElement>, annotation: Annotation) => {
    onSelect(annotation)
    if (recallMode || tool !== 'select' || event.button !== 0 || !viewport || !view) return
    event.preventDefault()
    event.stopPropagation()
    const start = pointFromEvent(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setInteraction({
      type: 'move',
      pointerId: event.pointerId,
      annotation,
      start,
      startNormalized: displayPointToNormalized(start, viewport, view),
      rects: annotation.geometry.rects.map(clampRect),
    })
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (stroke) {
      if (!viewport || !view) return
      const point = displayPointToNormalized(pointFromEvent(event), viewport, view)
      setStroke((current) => {
        if (!current) return current
        const last = current[current.length - 1]
        if (last && Math.hypot(point.x - last[0], point.y - last[1]) < 0.0015) return current
        return [...current, [point.x, point.y]]
      })
      return
    }
    if (!interaction || interaction.pointerId !== event.pointerId || !viewport || !view) return
    const point = pointFromEvent(event)
    if (interaction.type === 'create') {
      setInteraction({ ...interaction, rect: fromDisplayPoints(interaction.start, point, viewport, view) })
      return
    }
    const normalized = displayPointToNormalized(point, viewport, view)
    setInteraction({
      ...interaction,
      rects: moveRects(
        interaction.annotation.geometry.rects,
        normalized.x - interaction.startNormalized.x,
        normalized.y - interaction.startNormalized.y,
      ),
    })
  }

  const cropSelection = (rect: NormalizedBBox): string | undefined => {
    const canvas = canvasRef.current
    if (!canvas || !viewport || !view) return undefined
    const display = toDisplayRect(rect, viewport, view)
    const ratioX = canvas.width / Math.max(viewport.width, 1)
    const ratioY = canvas.height / Math.max(viewport.height, 1)
    const padding = 4
    const sourceX = Math.max(0, Math.floor((display.left - padding) * ratioX))
    const sourceY = Math.max(0, Math.floor((display.top - padding) * ratioY))
    const sourceWidth = Math.min(canvas.width - sourceX, Math.ceil((display.width + padding * 2) * ratioX))
    const sourceHeight = Math.min(canvas.height - sourceY, Math.ceil((display.height + padding * 2) * ratioY))
    if (sourceWidth <= 0 || sourceHeight <= 0) return undefined

    const upscale = Math.min(3, Math.max(1, 90 / Math.max(sourceHeight, 1)))
    let outputWidth = Math.max(1, Math.round(sourceWidth * upscale))
    let outputHeight = Math.max(1, Math.round(sourceHeight * upscale))
    const maxDimension = 2400
    if (outputWidth > maxDimension || outputHeight > maxDimension) {
      const shrink = maxDimension / Math.max(outputWidth, outputHeight)
      outputWidth = Math.max(1, Math.round(outputWidth * shrink))
      outputHeight = Math.max(1, Math.round(outputHeight * shrink))
    }
    const output = window.document.createElement('canvas')
    output.width = outputWidth
    output.height = outputHeight
    const context = output.getContext('2d')
    if (!context) return undefined
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      canvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      output.width,
      output.height,
    )
    // JPEG 足以支撑文字识别，且能显著降低 IPC 传输体积。
    return output.toDataURL('image/jpeg', 0.92)
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (stroke) {
      if (stroke.length >= 2) {
        const xs = stroke.map((point) => point[0])
        const ys = stroke.map((point) => point[1])
        const minX = Math.max(0, Math.min(...xs))
        const minY = Math.max(0, Math.min(...ys))
        const maxX = Math.min(1, Math.max(...xs))
        const maxY = Math.min(1, Math.max(...ys))
        const width = Math.max(0.004, Math.min(1 - minX, maxX - minX))
        const height = Math.max(0.004, Math.min(1 - minY, maxY - minY))
        const bbox: NormalizedBBox = {
          x: Math.min(minX, 1 - width),
          y: Math.min(minY, 1 - height),
          width,
          height,
        }
        onInk(bbox, stroke)
      }
      setStroke(null)
      return
    }
    if (!interaction || interaction.pointerId !== event.pointerId || !page || !view) return
    if (interaction.type === 'create') {
      const rect = interaction.rect
      if (rect.width * view.width >= 3 && rect.height * view.height >= 3) {
        void page.getTextContent()
          .then((content) => {
            const excerpt = extractTextInRect(content, rect, view)
            onCreate(page, rect, excerpt, excerpt ? undefined : cropSelection(rect))
          })
          .catch(() => onCreate(page, rect, '', cropSelection(rect)))
      }
    } else {
      onMove(interaction.annotation, { rects: interaction.rects }, unionRects(interaction.rects))
    }
    setInteraction(null)
  }

  const revealMask = (mask: NormalizedBBox) => {
    const ids = annotations
      .filter((annotation) => annotation.geometry.rects.some((rect) => rectsOverlap(mask, rect)))
      .map((annotation) => annotation.id)
    onReveal(ids)
  }

  const showSurface = shouldRender && page && viewport && view
  return (
    <section
      ref={pageRef}
      className={`pdf-page ${tool !== 'select' && !recallMode ? 'is-drawing' : ''}`}
      style={{ width: cssWidth, height: cssHeight }}
      data-page={pageNumber}
      aria-label={`第 ${pageNumber} 页`}
    >
      {!showSurface && (
        <div className="pdf-page-placeholder">
          <span>第 {pageNumber} 页</span>
          {shouldRender && !pageError && <small>正在载入页面…</small>}
          {pageError && (
            <div className="pdf-page-error">
              <small>页面载入失败</small>
              <button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button>
            </div>
          )}
        </div>
      )}

      {showSurface && (
        <>
          <canvas ref={canvasRef} className="pdf-canvas" aria-hidden="true" />
          <svg
            ref={svgRef}
            className={`pdf-annotation-layer ${recallMode ? 'is-recall' : ''}`}
            viewBox={`0 0 ${viewport.width} ${viewport.height}`}
            width={cssWidth}
            height={cssHeight}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setInteraction(null)}
          >
            <g className="pdf-ink-layer">
              {inks.map((ink) => {
                const points = ink.style.points ?? []
                const path = points
                  .map((point, index) => {
                    const display = toDisplayRect(
                      { x: point[0], y: point[1], width: 0.0001, height: 0.0001 },
                      viewport,
                      view,
                    )
                    return `${index === 0 ? 'M' : 'L'}${display.left} ${display.top}`
                  })
                  .join(' ')
                if (!path) return null
                return (
                  <path
                    key={ink.id}
                    d={path}
                    fill="none"
                    stroke={ink.style.color ?? '#d94f3d'}
                    strokeWidth={Math.max(1, (ink.style.width ?? 0.0025) * viewport.width)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`pdf-ink${inkErase ? ' is-erasing' : ''}`}
                    onPointerDown={(event) => {
                      if (!inkErase) return
                      event.stopPropagation()
                      onEraseInk(ink.id)
                    }}
                  />
                )
              })}
              {stroke && stroke.length > 1 && (
                <path
                  className="pdf-ink-draft"
                  d={stroke
                    .map((point, index) => {
                      const display = toDisplayRect(
                        { x: point[0], y: point[1], width: 0.0001, height: 0.0001 },
                        viewport,
                        view,
                      )
                      return `${index === 0 ? 'M' : 'L'}${display.left} ${display.top}`
                    })
                    .join(' ')}
                  fill="none"
                  stroke={inkColor}
                  strokeWidth={Math.max(1, inkWidth * viewport.width)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </g>

            {displayedAnnotations.map((annotation) => (
              <g
                key={annotation.id}
                className={`pdf-annotation is-${annotation.kind} ${selectedAnnotationId === annotation.id ? 'is-selected' : ''}`}
                onPointerDown={(event) => handleMoveStart(event, annotation)}
              >
                <title>{excerpts[annotation.card_id] || '无文字摘录'}</title>
                {annotation.geometry.rects.map((sourceRect, index) => {
                  const rect = toDisplayRect(clampRect(sourceRect), viewport, view)
                  return (
                    <rect
                      key={`${annotation.id}-${index}`}
                      x={rect.left}
                      y={rect.top}
                      width={rect.width}
                      height={rect.height}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </g>
            ))}

            {interaction?.type === 'create' && (() => {
              const rect = toDisplayRect(interaction.rect, viewport, view)
              return <rect className={`pdf-draft is-${tool}`} x={rect.left} y={rect.top} width={rect.width} height={rect.height} vectorEffect="non-scaling-stroke" />
            })()}

            {recallMasks.map((mask, index) => {
              const rect = toDisplayRect(mask, viewport, view)
              const maskAnnotations = annotations.filter((annotation) => annotation.geometry.rects.some((item) => rectsOverlap(mask, item)))
              const allRevealed = maskAnnotations.every((annotation) => revealedCardIds.has(annotation.card_id))
              if (allRevealed) return null
              return (
                <g
                  key={`mask-${index}`}
                  className="pdf-recall-mask"
                  role="button"
                  tabIndex={0}
                  aria-label="点击揭示标注"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => revealMask(mask)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') revealMask(mask)
                  }}
                >
                  <rect x={rect.left} y={rect.top} width={rect.width} height={rect.height} />
                  {rect.width > 70 && rect.height > 24 && (
                    <text x={rect.left + rect.width / 2} y={rect.top + rect.height / 2} textAnchor="middle" dominantBaseline="central">
                      点击回忆
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {rendering && <div className="pdf-render-status">正在渲染…</div>}
          {pageError && <div className="pdf-render-error">渲染失败：{pageError}</div>}
        </>
      )}
      <span className="pdf-page-number">{pageNumber}</span>
    </section>
  )
}
