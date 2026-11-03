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
import {
  ArrowLeft,
  ArrowRight,
  ClipboardCopy,
  Copy,
  Eye,
  FilePlus2,
  Focus,
  Highlighter,
  Link2,
  Merge,
  MessageSquare,
  MousePointer2,
  PenLine,
  Quote,
  Square,
  Tag,
  Trash2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { ContextMenu } from '../../ui/ContextMenu'
import { useContextMenu, type ContextMenuItem, type ContextMenuSection } from '../../ui/contextMenuCore'
import { PageTextLayer, type TextSelectionInfo } from './PageTextLayer'
import { readTextSelection } from './textSelection'
import { searchTitleLinks, type TitleLinkHit, type TitleLinkIndex } from './titleLink'

export type PdfTool = 'select' | 'highlight' | 'rectangle' | 'ink' | 'text'

/** 右键菜单里需要在工作区层执行的动作（工具、缩放、对话框、回忆会话）。 */
export type PdfContextAction =
  | { type: 'tool'; tool: PdfTool }
  | { type: 'zoom'; delta: number }
  | { type: 'zoom-reset' }
  | { type: 'page'; delta: number }
  | { type: 'recall-toggle' }
  | { type: 'tags'; cardId: string }
  | { type: 'links'; cardId: string }
  | { type: 'merge' }
  | { type: 'delete-annotation'; annotation: Annotation }
  | { type: 'reveal'; annotationIds: string[] }
  | { type: 'title-link-toggle' }
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
  onCreate: (
    page: PDFPageProxy,
    rect: NormalizedBBox,
    excerpt: string,
    ocrImage?: string,
    archiveImage?: string,
    annotationKind?: 'highlight' | 'rectangle',
  ) => Promise<void>
  onMove: (annotation: Annotation, geometry: AnnotationGeometry, bbox: NormalizedBBox) => void
  onReveal: (annotationIds: string[]) => void
  onInk: (bbox: NormalizedBBox, points: Array<[number, number]>) => void
  onEraseInk: (id: string) => void
  onContextAction: (action: PdfContextAction) => void
  /** 标题链接字典；null 表示功能关闭。 */
  titleLinkIndex: TitleLinkIndex | null
  onTitleLink: (hit: TitleLinkHit) => void
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
  onContextAction,
  titleLinkIndex,
  onTitleLink,
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
  const { menu, show, close } = useContextMenu()
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

  // 标题链接命中：页面文本就绪后做一次本地字典匹配，回忆模式下不干扰遮挡。
  const titleLinkHits = useMemo(() => {
    if (!titleLinkIndex || recallMode || lines.length === 0) return []
    return searchTitleLinks(titleLinkIndex, lines)
  }, [lines, recallMode, titleLinkIndex])

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

  const copyText = async (text: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 剪贴板不可用时保留原生选区，用户仍可用系统快捷键复制。
    }
  }

  const copySelectedText = async (text: string) => {
    await copyText(text)
    clearTextSelection()
  }

  const createCardFromSelection = (info: TextSelectionInfo) => {
    if (!page) return
    const crops = cropSelection(info.bbox, false)
    // 文字选区建卡不受当前工具限制，默认生成高亮标注。
    onCreate(page, info.bbox, info.text, undefined, crops.archive, 'highlight')
    clearTextSelection()
  }

  /**
   * 右键命中元素由 DOM 结构判断：遮挡块 > 标注 > 墨迹 > 文字选区 > 页面空白。
   * 每页各自持有菜单状态，但通用组件保证全局只显示一个菜单。
   */
  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null
    const layer = event.currentTarget.querySelector<HTMLElement>('.pdf-text-layer')
    const selectionInfo = layer ? readTextSelection(layer) : null
    const maskElement = target?.closest<SVGGElement>('[data-mask-index]')
    const annotationElement = target?.closest<SVGGElement>('[data-annotation-id]')
    const inkElement = target?.closest<SVGPathElement>('[data-ink-id]')
    const titleLinkElement = target?.closest<HTMLElement>('[data-titlelink-index]')
    const open = (title: string, sections: ContextMenuSection[]) => show(event, { title, sections })

    if (titleLinkElement) {
      const hit = titleLinkHits[Number(titleLinkElement.dataset.titlelinkIndex)]
      if (hit) {
        open(`标题链接「${hit.keyword}」`, [
          { id: 'titlelink', items: [
            { id: 'open', label: hit.cardIds.length > 1 ? `查看 ${hit.cardIds.length} 张相关卡片` : '查看过去的卡片', icon: Link2, onSelect: () => onTitleLink(hit) },
            { id: 'copy', label: '复制关键词', icon: Copy, onSelect: () => void copyText(hit.keyword) },
          ] },
          { id: 'titlelink-more', items: [
            { id: 'toggle', label: '关闭标题链接', icon: Link2, onSelect: () => onContextAction({ type: 'title-link-toggle' }) },
          ] },
        ])
        return
      }
    }

    if (maskElement) {
      const mask = recallMasks[Number(maskElement.dataset.maskIndex)]
      if (mask) {
        const ids = annotations
          .filter((annotation) => annotation.geometry.rects.some((rect) => rectsOverlap(mask, rect)))
          .map((annotation) => annotation.id)
        open(`回忆遮挡 · 第 ${pageNumber} 页`, [{ id: 'mask', items: [
          { id: 'reveal', label: '揭示此处的摘录', icon: Eye, onSelect: () => onReveal(ids) },
          { id: 'exit', label: '退出文档回忆', icon: MessageSquare, onSelect: () => onContextAction({ type: 'recall-toggle' }) },
        ] }])
        return
      }
    }

    if (annotationElement) {
      const annotation = annotations.find((item) => item.id === annotationElement.dataset.annotationId)
      if (annotation) {
        const excerpt = excerpts[annotation.card_id] ?? ''
        open(`${annotation.kind === 'rectangle' ? '矩形标注' : '高亮标注'} · 第 ${pageNumber} 页`, [
          { id: 'annotation', items: [
            { id: 'copy', label: '复制摘录文字', icon: Copy, disabled: !excerpt, onSelect: () => void copyText(excerpt) },
            { id: 'inspect', label: '在检查器中查看', icon: MousePointer2, onSelect: () => onSelect(annotation) },
          ] },
          { id: 'card', title: '关联卡片', items: [
            { id: 'tags', label: '编辑标签…', icon: Tag, onSelect: () => onContextAction({ type: 'tags', cardId: annotation.card_id }) },
            { id: 'links', label: '关联其他卡片…', icon: Link2, onSelect: () => onContextAction({ type: 'links', cardId: annotation.card_id }) },
            { id: 'merge', label: '合并卡片…', icon: Merge, onSelect: () => { onSelect(annotation); onContextAction({ type: 'merge' }) } },
          ] },
          { id: 'danger', items: [
            { id: 'delete', label: '删除标注…', icon: Trash2, danger: true, onSelect: () => onContextAction({ type: 'delete-annotation', annotation }) },
          ] },
        ])
        return
      }
    }

    if (inkElement?.dataset.inkId) {
      const inkId = inkElement.dataset.inkId
      open(`墨迹 · 第 ${pageNumber} 页`, [{ id: 'ink', items: [
        { id: 'erase', label: '删除这条墨迹', icon: Trash2, danger: true, onSelect: () => onEraseInk(inkId) },
        { id: 'ink-tool', label: '继续手写墨迹', icon: PenLine, onSelect: () => onContextAction({ type: 'tool', tool: 'ink' }) },
      ] }])
      return
    }

    if (selectionInfo) {
      open(`已选中 ${selectionInfo.text.length} 字 · 第 ${pageNumber} 页`, [
        { id: 'selection', items: [
          { id: 'copy', label: '复制文字', icon: Copy, hint: '⌘C', onSelect: () => void copySelectedText(selectionInfo.text) },
          { id: 'quote', label: '复制为引用', icon: Quote, onSelect: () => void copySelectedText(`「${selectionInfo.text}」（第 ${pageNumber} 页）`) },
          { id: 'create', label: '用选中文字建卡', icon: FilePlus2, onSelect: () => createCardFromSelection(selectionInfo) },
        ] },
        { id: 'selection-tools', items: [
          { id: 'clear', label: '取消选择', icon: X, onSelect: clearTextSelection },
          { id: 'text-tool', label: '文字选择模式', icon: Type, checked: tool === 'text' && !recallMode, onSelect: () => onContextAction({ type: 'tool', tool: 'text' }) },
        ] },
      ])
      return
    }

    const toolItems: ContextMenuItem[] = [
      { id: 'tool-select', label: '选择 / 移动标注', icon: MousePointer2, checked: tool === 'select', disabled: recallMode, onSelect: () => onContextAction({ type: 'tool', tool: 'select' }) },
      { id: 'tool-text', label: '文字选择', icon: Type, checked: tool === 'text', disabled: recallMode, onSelect: () => onContextAction({ type: 'tool', tool: 'text' }) },
      { id: 'tool-highlight', label: '高亮框选', icon: Highlighter, checked: tool === 'highlight', disabled: recallMode, onSelect: () => onContextAction({ type: 'tool', tool: 'highlight' }) },
      { id: 'tool-rectangle', label: '矩形框选', icon: Square, checked: tool === 'rectangle', disabled: recallMode, onSelect: () => onContextAction({ type: 'tool', tool: 'rectangle' }) },
      { id: 'tool-ink', label: '手写墨迹', icon: PenLine, checked: tool === 'ink', disabled: recallMode, onSelect: () => onContextAction({ type: 'tool', tool: 'ink' }) },
    ]
    const pageText = lines.map((line) => line.text).join('\n')
    open(`第 ${pageNumber} 页`, [
      { id: 'tools', title: '标注工具', items: toolItems },
      { id: 'view', title: '视图与翻页', items: [
        { id: 'zoom-in', label: '放大', icon: ZoomIn, hint: '+10%', onSelect: () => onContextAction({ type: 'zoom', delta: 0.1 }) },
        { id: 'zoom-out', label: '缩小', icon: ZoomOut, hint: '−10%', onSelect: () => onContextAction({ type: 'zoom', delta: -0.1 }) },
        { id: 'zoom-reset', label: '恢复 100%', icon: Focus, hint: '100%', onSelect: () => onContextAction({ type: 'zoom-reset' }) },
        { id: 'prev', label: '上一页', icon: ArrowLeft, onSelect: () => onContextAction({ type: 'page', delta: -1 }) },
        { id: 'next', label: '下一页', icon: ArrowRight, onSelect: () => onContextAction({ type: 'page', delta: 1 }) },
      ] },
      { id: 'page-actions', items: [
        { id: 'copy-page', label: '复制本页文字', icon: ClipboardCopy, disabled: !pageText, hint: pageText ? `${lines.length} 行` : '文字层未就绪', onSelect: () => void copyText(pageText) },
        { id: 'titlelink', label: titleLinkIndex ? '关闭标题链接' : '开启标题链接', icon: Link2, checked: !!titleLinkIndex, onSelect: () => onContextAction({ type: 'title-link-toggle' }) },
        { id: 'recall', label: recallMode ? '退出文档回忆' : '开始文档回忆', icon: MessageSquare, checked: recallMode, onSelect: () => onContextAction({ type: 'recall-toggle' }) },
      ] },
    ])
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
      onContextMenu={handleContextMenu}
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
                    data-ink-id={ink.id}
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
                data-annotation-id={annotation.id}
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
                  data-mask-index={index}
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
          {titleLinkHits.length > 0 && (
            <div className="pdf-titlelink-layer">
              {titleLinkHits.map((hit, index) => (
                <button
                  key={`${hit.lineIndex}-${hit.bbox.x.toFixed(4)}-${index}`}
                  type="button"
                  data-titlelink-index={index}
                  className="pdf-titlelink"
                  style={{
                    left: `${hit.bbox.x * 100}%`,
                    top: `${hit.bbox.y * 100}%`,
                    width: `${hit.bbox.width * 100}%`,
                    height: `${hit.bbox.height * 100}%`,
                  }}
                  title={`${hit.keyword}${hit.cardIds.length > 1 ? ` · ${hit.cardIds.length} 张卡片` : ''}`}
                  aria-label={`标题链接：${hit.keyword}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onTitleLink(hit)
                  }}
                />
              ))}
            </div>
          )}
          {rendering && <div className="pdf-render-status">正在渲染…</div>}
          {pageError && <div className="pdf-render-error">渲染失败：{pageError}</div>}
        </>
      )}
      <span className="pdf-page-number">{pageNumber}</span>
      <ContextMenu state={menu} onClose={close} />
    </section>
  )
}
