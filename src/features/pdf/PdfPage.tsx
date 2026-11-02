import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { Annotation, AnnotationGeometry, NormalizedBBox, PageInk } from '../../domain/card'
import type { OcrLine } from '../../services/pdfnote'
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
import {
  cachePageLines,
  ensurePageLines,
  extractTextFromLines,
  getCachedLines,
  linesFromTextContent,
} from './pageText'
import { PageTextLayer, type TextSelectionInfo } from './PageTextLayer'

export type PdfTool = 'select' | 'highlight' | 'rectangle' | 'ink' | 'text'
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
  documentId: string
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
  onCreate: (page: PDFPageProxy, rect: NormalizedBBox, excerpt: string, ocrImage?: string, archiveImage?: string) => Promise<void>
  onMove: (annotation: Annotation, geometry: AnnotationGeometry, bbox: NormalizedBBox) => void
  onReveal: (annotationIds: string[]) => void
  onInk: (bbox: NormalizedBBox, points: Array<[number, number]>) => void
  onEraseInk: (id: string) => void
}

export function PdfPage({
  pageNumber,
  documentId,
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
  const [lines, setLines] = useState<OcrLine[]>([])
  const [textStatus, setTextStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [textError, setTextError] = useState('')
  const [selection, setSelection] = useState<TextSelectionInfo | null>(null)
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

  /** 导出整页图给 Vision 做一次性行级识别；上限 1600px 与原生库内部降采样一致。 */
  const renderPageImage = useCallback((): string | undefined => {
    const canvas = canvasRef.current
    if (!canvas || canvas.width === 0 || canvas.height === 0) return undefined
    const ratio = Math.min(1, 1600 / Math.max(canvas.width, canvas.height))
    const output = window.document.createElement('canvas')
    output.width = Math.max(1, Math.round(canvas.width * ratio))
    output.height = Math.max(1, Math.round(canvas.height * ratio))
    const context = output.getContext('2d')
    if (!context) return undefined
    // JPEG 没有 alpha 通道，先铺白底，避免透明区域变黑影响识别。
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, output.width, output.height)
    context.drawImage(canvas, 0, 0, output.width, output.height)
    return output.toDataURL('image/jpeg', 0.9)
  }, [])

  /**
   * 页面渲染完成后建立可选文字层：有 PDF 文字层时直接用精确字形坐标，
   * 扫描页则整页识别一次并缓存。之后所有点选 / 框选都不再触发 OCR。
   */
  useEffect(() => {
    if (!page || !viewport || !view || !shouldRender || rendering) return
    const cached = getCachedLines(documentId, pageNumber)
    if (cached) {
      setLines(cached)
      setTextStatus('ready')
      return
    }
    let active = true
    const run = async () => {
      let content: Awaited<ReturnType<PDFPageProxy['getTextContent']>> | null = null
      try {
        content = await page.getTextContent()
      } catch {
        content = null
      }
      if (!active) return
      if (content) {
        const fromPdf = linesFromTextContent(content, view)
        if (fromPdf.length > 0) {
          cachePageLines(documentId, pageNumber, fromPdf)
          setLines(fromPdf)
          setTextStatus('ready')
          return
        }
      }
      const image = renderPageImage()
      if (!image) {
        if (active) setTextStatus('error')
        return
      }
      if (active) {
        setTextStatus('loading')
        setTextError('')
      }
      try {
        const recognized = await ensurePageLines(documentId, pageNumber, image)
        if (!active) return
        setLines(recognized)
        setTextStatus(recognized.length > 0 ? 'ready' : 'error')
        if (recognized.length === 0) setTextError('此页未识别到文字')
      } catch (reason) {
        if (!active) return
        setTextStatus('error')
        setTextError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void run()
    return () => { active = false }
  }, [documentId, page, pageNumber, renderPageImage, rendering, shouldRender, view, viewport])

  useEffect(() => {
    if (tool === 'text') return
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [tool])

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
    if (tool === 'select' || tool === 'text') return
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

  /**
   * 裁剪选区。ocrImage 供 OCR 引擎使用（尽量大以保证识别率），
   * archiveImage 是随卡片存档的较小版本，避免数据库被大图撑爆。
   */
  const cropSelection = (rect: NormalizedBBox, withOcr = true): { ocr?: string; archive?: string } => {
    const canvas = canvasRef.current
    if (!canvas || !viewport || !view) return {}
    const display = toDisplayRect(rect, viewport, view)
    const ratioX = canvas.width / Math.max(viewport.width, 1)
    const ratioY = canvas.height / Math.max(viewport.height, 1)
    const padding = 4
    const sourceX = Math.max(0, Math.floor((display.left - padding) * ratioX))
    const sourceY = Math.max(0, Math.floor((display.top - padding) * ratioY))
    const sourceWidth = Math.min(canvas.width - sourceX, Math.ceil((display.width + padding * 2) * ratioX))
    const sourceHeight = Math.min(canvas.height - sourceY, Math.ceil((display.height + padding * 2) * ratioY))
    if (sourceWidth <= 0 || sourceHeight <= 0) return {}

    const drawCropped = (output: HTMLCanvasElement, maxDimension: number) => {
      const upscale = Math.min(3, Math.max(1, 90 / Math.max(sourceHeight, 1)))
      let outputWidth = Math.max(1, Math.round(sourceWidth * upscale))
      let outputHeight = Math.max(1, Math.round(sourceHeight * upscale))
      if (outputWidth > maxDimension || outputHeight > maxDimension) {
        const shrink = maxDimension / Math.max(outputWidth, outputHeight)
        outputWidth = Math.max(1, Math.round(outputWidth * shrink))
        outputHeight = Math.max(1, Math.round(outputHeight * shrink))
      }
      output.width = outputWidth
      output.height = outputHeight
      const context = output.getContext('2d')
      if (!context) return
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
    }

    // OCR 用大图保证识别率；JPEG 足以支撑文字识别，且能显著降低 IPC 传输体积。
    // 有文字层时不需要 OCR，只生成存档图，避免无谓地渲染 2400px 画布。
    let ocrImage: string | undefined
    if (withOcr) {
      const ocr = window.document.createElement('canvas')
      drawCropped(ocr, 2400)
      ocrImage = ocr.width > 0 ? ocr.toDataURL('image/jpeg', 0.92) : undefined
    }
    // 存档图上限 1000px，公式/图表在复习视图中仍清晰可读。
    const archive = window.document.createElement('canvas')
    drawCropped(archive, 1000)
    return {
      ocr: ocrImage,
      archive: archive.width > 0 ? archive.toDataURL('image/jpeg', 0.82) : undefined,
    }
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
        const fromLayer = extractTextFromLines(lines, rect)
        if (fromLayer) {
          // 文字层已就绪：直接取文字，零延迟建卡，不再调用 OCR。
          const crops = cropSelection(rect, false)
          onCreate(page, rect, fromLayer, undefined, crops.archive)
        } else {
          void page.getTextContent()
            .then((content) => {
              const excerpt = extractTextInRect(content, rect, view)
              // 文字层文本也可能来自公式版式，始终生成存档图；只有无文字层才需要 OCR 大图。
              const crops = cropSelection(rect, !excerpt)
              onCreate(page, rect, excerpt, crops.ocr, crops.archive)
            })
            .catch(() => {
              const crops = cropSelection(rect)
              onCreate(page, rect, '', crops.ocr, crops.archive)
            })
        }
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

  const clearTextSelection = () => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const copySelectedText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 剪贴板不可用时保留原生选区，用户仍可用系统快捷键复制。
    }
    clearTextSelection()
  }

  const createCardFromSelection = (info: TextSelectionInfo) => {
    if (!page) return
    const crops = cropSelection(info.bbox, false)
    onCreate(page, info.bbox, info.text, undefined, crops.archive)
    clearTextSelection()
  }

  const showSurface = shouldRender && page && viewport && view
  const textMode = tool === 'text' && !recallMode
  return (
    <section
      ref={pageRef}
      className={`pdf-page ${tool !== 'select' && tool !== 'text' && !recallMode ? 'is-drawing' : ''} ${textMode ? 'is-text-mode' : ''}`}
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
          <PageTextLayer
            lines={lines}
            width={cssWidth}
            height={cssHeight}
            active={textMode}
            onSelection={setSelection}
          />
          {textMode && textStatus === 'loading' && (
            <div className="pdf-text-status" role="status">正在生成可选文字层…</div>
          )}
          {textMode && textStatus === 'error' && (
            <div className="pdf-text-status is-error" role="alert">{textError || '文字层生成失败'}</div>
          )}
          {textMode && selection && (
            <div className="pdf-text-action" style={{ left: selection.left, top: selection.top }}>
              <span className="pdf-text-preview" title={selection.text}>{selection.text}</span>
              <button type="button" className="is-secondary" onClick={() => void copySelectedText(selection.text)}>复制</button>
              <button type="button" onClick={() => createCardFromSelection(selection)}>建卡</button>
            </div>
          )}
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
