import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist'
import type {
  Annotation,
  AnnotationGeometry,
  Card,
  Document as PdfDocument,
  NormalizedBBox,
  PageInk,
  Rating,
} from '../../domain/card'
import {
  createPageInk,
  deletePageInk,
  listAnnotations,
  listPageInks,
  readPdfChunk,
  removeAnnotation,
  setCardTags,
  updateAnnotationGeometry,
  updateDocumentProgress,
} from '../../services/pdfnote'
import {
  Highlighter,
  Link2,
  Merge,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  PenLine,
  Scissors,
  Square,
  Tag,
  Trash2,
  Type,
} from 'lucide-react'
import { LinkDialog, MergeDialog, TagDialog } from '../card/CardDialogs'
import { useCardStore } from '../../store/cardStore'
import { reviewCard } from '../review/scheduler'
import { PdfPage, type PageSize, type PdfContextAction, type PdfTool } from './PdfPage'
import { looksLikeMathFormula, recognizeText } from './ocr'
import './PdfWorkspace.css'

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs'

const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 }
const PAGE_PROXY_CACHE_LIMIT = 16
const EMPTY_INKS: PageInk[] = []
const INK_COLORS = ['#d94f3d', '#2f6f8f', '#3f7a4c', '#2f3330']
const INK_WIDTHS = [
  { label: '细', value: 0.0018 },
  { label: '中', value: 0.0028 },
  { label: '粗', value: 0.0042 },
]
const MIN_SCALE = 0.5
const MAX_SCALE = 3
const EMPTY_ANNOTATIONS: Annotation[] = []

export interface PdfWorkspaceProps {
  document: PdfDocument
  onPageCount: (count: number) => void
  onCardsChanged: () => void
  /** 嵌入分栏工作区：隐藏独立页头与标注检查器，改用底部悬浮工具坞。 */
  embedded?: boolean
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function updateSet(previous: Set<number>, page: number, included: boolean): Set<number> {
  if (previous.has(page) === included) return previous
  const next = new Set(previous)
  if (included) next.add(page)
  else next.delete(page)
  return next
}

export function PdfWorkspace({ document, onPageCount, onCardsChanged, embedded = false }: PdfWorkspaceProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(document.page_count)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [scale, setScale] = useState(1)
  const [tool, setTool] = useState<PdfTool>('select')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set())
  const [renderPages, setRenderPages] = useState<Set<number>>(new Set())
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({})
  // 用第 1 页的真实尺寸作为未测量占位页的高度，否则数百页后跳转会累计明显偏差。
  const [defaultPageSize, setDefaultPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE)
  const [annotationsByPage, setAnnotationsByPage] = useState<Record<number, Annotation[]>>({})
  const [annotationVersion, setAnnotationVersion] = useState(0)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState('')
  const [ocrMessage, setOcrMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Annotation | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [recallMode, setRecallMode] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [revealedCardIds, setRevealedCardIds] = useState<Set<string>>(new Set())
  const [ratedCardIds, setRatedCardIds] = useState<Set<string>>(new Set())
  const [ratingBusy, setRatingBusy] = useState(false)
  const [reviewedCards, setReviewedCards] = useState<Record<string, Card>>({})
  const [dockMenuOpen, setDockMenuOpen] = useState(false)
  const [tagTarget, setTagTarget] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [inksByPage, setInksByPage] = useState<Record<number, PageInk[]>>({})
  const [inkColor, setInkColor] = useState(INK_COLORS[0])
  const [inkWidth, setInkWidth] = useState(INK_WIDTHS[1].value)
  const [inkErase, setInkErase] = useState(false)

  const cardsById = useCardStore((state) => state.cardsById)
  const createCard = useCardStore((state) => state.createCard)
  const loadCards = useCardStore((state) => state.loadCards)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageElementsRef = useRef<Map<number, HTMLElement>>(new Map())
  const renderObserverRef = useRef<IntersectionObserver | null>(null)
  const visibleObserverRef = useRef<IntersectionObserver | null>(null)
  const pageCacheRef = useRef<Map<number, Promise<PDFPageProxy>>>(new Map())
  const loadedAnnotationPagesRef = useRef<Set<number>>(new Set())
  const pendingAnnotationPagesRef = useRef<Set<number>>(new Set())
  const annotationRequestsRef = useRef<Map<number, number>>(new Map())
  const documentGenerationRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const moveRequestsRef = useRef<Map<string, number>>(new Map())
  const callbacksRef = useRef({ onPageCount, onCardsChanged })
  const restoredDocumentRef = useRef<string | null>(null)
  const userNavigatedRef = useRef(false)
  const progressPageRef = useRef(document.last_page || 1)
  const visiblePagesRef = useRef<Set<number>>(new Set())
  const loadedInkPagesRef = useRef<Set<number>>(new Set())
  // 恢复阅读位置期间，观察器仍持有滚动前的可见页，先暂停页码同步避免把页码改回 1。
  const restoringRef = useRef(false)

  useEffect(() => {
    callbacksRef.current = { onPageCount, onCardsChanged }
  }, [onCardsChanged, onPageCount])

  useEffect(() => {
    const generation = documentGenerationRef.current + 1
    documentGenerationRef.current = generation
    let active = true
    let loadingTask: PDFDocumentLoadingTask | null = null
    let rangeTransport: PDFDataRangeTransport | null = null
    const pageCache = pageCacheRef.current

    setPdf(null)
    setLoading(true)
    setLoadError('')
    setOperationError('')
    setNotice('')
    setPageCount(document.page_count)
    setCurrentPage(1)
    setPageInput('1')
    setVisiblePages(new Set())
    setRenderPages(new Set())
    setPageSizes({})
    setDefaultPageSize(DEFAULT_PAGE_SIZE)
    setAnnotationsByPage({})
    setSelectedAnnotationId(null)
    setDeleteTarget(null)
    setRecallMode(false)
    setSessionId('')
    setRevealedCardIds(new Set())
    setRatedCardIds(new Set())
    setReviewedCards({})
    setInksByPage({})
    setTool('select')
    loadedInkPagesRef.current.clear()
    restoredDocumentRef.current = null
    restoringRef.current = false
    userNavigatedRef.current = false
    progressPageRef.current = document.last_page || 1
    pageCacheRef.current.clear()
    loadedAnnotationPagesRef.current.clear()
    pendingAnnotationPagesRef.current.clear()
    annotationRequestsRef.current.clear()

    if (document.file_status === 'importing') {
      return () => {
        active = false
      }
    }
    if (document.file_status === 'missing' || document.file_status === 'mismatch') {
      setLoading(false)
      setLoadError(document.file_status === 'missing' ? 'PDF 文件缺失，请先在文档库中重新定位文件。' : 'PDF 文件内容已变化，请先完成文件校验。')
      return () => {
        active = false
      }
    }

    const openDocument = async () => {
      try {
        if (!active) return
        rangeTransport = new PDFDataRangeTransport(document.file_size, null)
        rangeTransport.requestDataRange = (begin, end) => {
          void readPdfChunk(document.id, begin, end)
            .then((buffer) => {
              if (!active || documentGenerationRef.current !== generation) return
              rangeTransport?.onDataRange(begin, new Uint8Array(buffer))
            })
            .catch((reason: unknown) => {
              if (!active || documentGenerationRef.current !== generation) return
              setLoading(false)
              setLoadError(`PDF 分块读取失败：${errorMessage(reason)}`)
            })
        }
        loadingTask = getDocument({
          range: rangeTransport,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          // 500MB 级教材不能整本预取；自有 Range 传输确保只读取当前需要的分块。
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: 256 * 1024,
        })
        const loadedPdf = await loadingTask.promise
        if (!active) {
          await loadingTask.destroy()
          return
        }
        const firstPage = await loadedPdf.getPage(1)
        if (!active) return
        const firstViewport = firstPage.getViewport({ scale: 1 })
        setDefaultPageSize({ width: firstViewport.width, height: firstViewport.height })
        setPdf(loadedPdf)
        setPageCount(loadedPdf.numPages)
        callbacksRef.current.onPageCount(loadedPdf.numPages)
        setLoading(false)
      } catch (reason) {
        if (!active) return
        setLoading(false)
        setLoadError(errorMessage(reason))
      }
    }
    void openDocument()

    return () => {
      active = false
      rangeTransport?.abort()
      if (loadingTask) void loadingTask.destroy()
      pageCache.clear()
    }
    // page_count 只是持久化元数据，不应触发 PDF 重新加载。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [document.file_status, document.id, loadAttempt])

  useEffect(() => {
    void loadCards().catch((reason: unknown) => {
      setOperationError(`卡片载入失败：${errorMessage(reason)}`)
    })
  }, [document.id, loadCards])


  const getPage = useCallback((pageNumber: number): Promise<PDFPageProxy> => {
    if (!pdf) return Promise.reject(new Error('PDF 尚未载入'))
    const cached = pageCacheRef.current.get(pageNumber)
    if (cached) return cached
    const request = pdf.getPage(pageNumber).catch((reason: unknown) => {
      pageCacheRef.current.delete(pageNumber)
      throw reason instanceof Error ? reason : new Error(String(reason))
    })
    pageCacheRef.current.set(pageNumber, request)
    // 只保留最近访问的页面代理，避免翻阅数百页后累计解码图像与 PDF 对象。
    while (pageCacheRef.current.size > PAGE_PROXY_CACHE_LIMIT) {
      const oldest = pageCacheRef.current.keys().next().value
      if (oldest === undefined) break
      const evicted = pageCacheRef.current.get(oldest)
      pageCacheRef.current.delete(oldest)
      void evicted?.then((page) => page.cleanup()).catch(() => undefined)
    }
    return request
  }, [pdf])

  const registerPage = useCallback((pageNumber: number, element: HTMLElement | null) => {
    const previous = pageElementsRef.current.get(pageNumber)
    if (previous && previous !== element) {
      renderObserverRef.current?.unobserve(previous)
      visibleObserverRef.current?.unobserve(previous)
    }
    if (!element) {
      pageElementsRef.current.delete(pageNumber)
      return
    }
    pageElementsRef.current.set(pageNumber, element)
    renderObserverRef.current?.observe(element)
    visibleObserverRef.current?.observe(element)
  }, [])

  useEffect(() => {
    const root = scrollRef.current
    if (!root || !pdf) return
    const renderObserver = new IntersectionObserver((entries) => {
      setRenderPages((previous) => entries.reduce((pages, entry) => {
        const page = Number((entry.target as HTMLElement).dataset.page)
        return Number.isFinite(page) ? updateSet(pages, page, entry.isIntersecting) : pages
      }, previous))
    }, { root: null, rootMargin: '100% 0px', threshold: 0 })
    const visibleObserver = new IntersectionObserver((entries) => {
      setVisiblePages((previous) => entries.reduce((pages, entry) => {
        const page = Number((entry.target as HTMLElement).dataset.page)
        return Number.isFinite(page) ? updateSet(pages, page, entry.isIntersecting) : pages
      }, previous))
    }, { root: null, threshold: 0.01 })
    renderObserverRef.current = renderObserver
    visibleObserverRef.current = visibleObserver
    pageElementsRef.current.forEach((element) => {
      renderObserver.observe(element)
      visibleObserver.observe(element)
    })
    return () => {
      renderObserver.disconnect()
      visibleObserver.disconnect()
      renderObserverRef.current = null
      visibleObserverRef.current = null
    }
  }, [pdf])

  useEffect(() => {
    if (!pdf || visiblePages.size === 0) return
    const pages = [...visiblePages]
      .filter((page) => !loadedAnnotationPagesRef.current.has(page) && !pendingAnnotationPagesRef.current.has(page))
      .sort((a, b) => a - b)
    if (pages.length === 0) return
    const generation = documentGenerationRef.current
    const requestIds = new Map<number, number>()
    pages.forEach((page) => {
      const requestId = (annotationRequestsRef.current.get(page) ?? 0) + 1
      annotationRequestsRef.current.set(page, requestId)
      requestIds.set(page, requestId)
      pendingAnnotationPagesRef.current.add(page)
    })

    void listAnnotations(document.id, pages)
      .then((annotations) => {
        if (generation !== documentGenerationRef.current) return
        setAnnotationsByPage((previous) => {
          const next = { ...previous }
          pages.forEach((page) => {
            if (annotationRequestsRef.current.get(page) !== requestIds.get(page)) return
            next[page] = annotations.filter((annotation) => annotation.page === page)
            loadedAnnotationPagesRef.current.add(page)
          })
          return next
        })
      })
      .catch((reason: unknown) => {
        if (generation === documentGenerationRef.current) {
          setOperationError(`标注载入失败：${errorMessage(reason)}`)
        }
      })
      .finally(() => {
        pages.forEach((page) => {
          if (annotationRequestsRef.current.get(page) === requestIds.get(page)) {
            pendingAnnotationPagesRef.current.delete(page)
          }
        })
      })
  }, [annotationVersion, document.id, pdf, visiblePages])

  /**
   * 打开文档后回到上次阅读位置。占位页高度依赖页尺寸，测量会带来轻微位移，
   * 因此在首帧后做几次对齐，用户一旦主动滚动就不再强行拉回。
   */
  useEffect(() => {
    if (!pdf || loading) return
    if (restoredDocumentRef.current === document.id) return
    restoredDocumentRef.current = document.id
    if (userNavigatedRef.current) return
    const target = Math.min(Math.max(document.last_page || 1, 1), pageCount || 1)
    progressPageRef.current = target
    if (target <= 1) return

    setCurrentPage(target)
    setPageInput(String(target))
    restoringRef.current = true
    const jump = () => {
      if (userNavigatedRef.current) return
      const element = pageElementsRef.current.get(target)
      const root = scrollRef.current
      if (!element || !root) return
      root.scrollTop = Math.max(0, element.offsetTop - 12)
    }
    const timers = [60, 400, 1_200].map((delay) => window.setTimeout(jump, delay))
    const release = window.setTimeout(() => {
      restoringRef.current = false
    }, 1_500)
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      window.clearTimeout(release)
    }
  }, [document.id, document.last_page, loading, pageCount, pdf])

  useEffect(() => {
    progressPageRef.current = currentPage
    // 滚动时保持页码输入框与当前页一致；输入框编辑本身不会改变 currentPage。
    setPageInput(String(currentPage))
  }, [currentPage])

  // 翻页后延迟写库，避免连续滚动产生大量 UPDATE。
  useEffect(() => {
    if (!userNavigatedRef.current) return
    if (restoredDocumentRef.current !== document.id) return
    const timer = window.setTimeout(() => {
      void updateDocumentProgress(document.id, currentPage).catch(() => undefined)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [currentPage, document.id])

  // 关闭文档或退出时补一次写入，保证最后停留页不丢失。
  useEffect(() => {
    const id = document.id
    return () => {
      if (!userNavigatedRef.current) return
      void updateDocumentProgress(id, progressPageRef.current).catch(() => undefined)
    }
  }, [document.id])

  useEffect(() => {
    if (!pdf || visiblePages.size === 0) return
    const pages = [...visiblePages].filter((page) => !loadedInkPagesRef.current.has(page))
    if (pages.length === 0) return
    pages.forEach((page) => loadedInkPagesRef.current.add(page))
    void listPageInks(document.id, pages)
      .then((items) => {
        setInksByPage((previous) => {
          const next = { ...previous }
          pages.forEach((page) => {
            next[page] = items.filter((ink) => ink.page === page)
          })
          return next
        })
      })
      .catch((reason: unknown) => {
        pages.forEach((page) => loadedInkPagesRef.current.delete(page))
        setOperationError(`墨迹载入失败：${errorMessage(reason)}`)
      })
  }, [document.id, pdf, visiblePages])

  const invalidateAnnotations = useCallback((page: number) => {
    loadedAnnotationPagesRef.current.delete(page)
    pendingAnnotationPagesRef.current.delete(page)
    annotationRequestsRef.current.set(page, (annotationRequestsRef.current.get(page) ?? 0) + 1)
    setAnnotationVersion((version) => version + 1)
  }, [])

  const handleSize = useCallback((pageNumber: number, size: PageSize) => {
    setPageSizes((previous) => {
      const old = previous[pageNumber]
      if (old && Math.abs(old.width - size.width) < 0.01 && Math.abs(old.height - size.height) < 0.01) return previous
      return { ...previous, [pageNumber]: size }
    })
  }, [])

  // 用 ref 读取最新可见页，避免滚动节流里拿到过期集合导致页码滞后。
  const syncCurrentPage = useCallback(() => {
    if (restoringRef.current) return
    const root = scrollRef.current
    if (!root) return
    const rootBounds = root.getBoundingClientRect()
    const center = rootBounds.top + rootBounds.height / 2
    let nearestPage = 1
    let nearestDistance = Number.POSITIVE_INFINITY
    let matched = false
    visiblePagesRef.current.forEach((page) => {
      const element = pageElementsRef.current.get(page)
      if (!element) return
      const bounds = element.getBoundingClientRect()
      const distance = Math.abs(bounds.top + bounds.height / 2 - center)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestPage = page
        matched = true
      }
    })
    if (matched) setCurrentPage(nearestPage)
  }, [])

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      syncCurrentPage()
    })
  }, [syncCurrentPage])

  useEffect(() => {
    visiblePagesRef.current = visiblePages
    // 可见页集合更新后重新计算当前页，处理“最后一次滚动事件早于观察器回调”的情况。
    if (userNavigatedRef.current) syncCurrentPage()
  }, [syncCurrentPage, visiblePages])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  const goToPage = (page: number) => {
    const target = Math.min(Math.max(Math.round(page), 1), pageCount || 1)
    const element = pageElementsRef.current.get(target)
    const root = scrollRef.current
    if (!element || !root) return
    setOperationError('')
    userNavigatedRef.current = true
    setCurrentPage(target)
    setPageInput(String(target))
    root.scrollTo({ top: Math.max(0, element.offsetTop - 20), behavior: 'smooth' })
  }

  const jumpToPage = () => {
    const page = Number(pageInput)
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      setOperationError(`请输入 1 至 ${pageCount} 的页码。`)
      return
    }
    goToPage(page)
  }

  const handleInk = useCallback(async (page: number, bbox: NormalizedBBox, points: Array<[number, number]>) => {
    try {
      const ink = await createPageInk(document.id, page, bbox, { color: inkColor, width: inkWidth, points })
      setInksByPage((previous) => ({
        ...previous,
        [page]: [...(previous[page] ?? []), ink],
      }))
      setNotice('墨迹已保存到本页。')
    } catch (reason) {
      setOperationError(`墨迹保存失败：${errorMessage(reason)}`)
    }
  }, [document.id, inkColor, inkWidth])

  const handleEraseInk = useCallback(async (id: string) => {
    try {
      await deletePageInk(id)
      setInksByPage((previous) => {
        const next: Record<number, PageInk[]> = {}
        Object.entries(previous).forEach(([page, items]) => {
          next[Number(page)] = items.filter((ink) => ink.id !== id)
        })
        return next
      })
      setNotice('墨迹已删除。')
    } catch (reason) {
      setOperationError(`删除墨迹失败：${errorMessage(reason)}`)
    }
  }, [])

  const handleCreate = useCallback(async (
    page: PDFPageProxy,
    rect: NormalizedBBox,
    excerpt: string,
    ocrImage?: string,
    archiveImage?: string,
    annotationKind?: 'highlight' | 'rectangle',
  ) => {
    if (creating || recallMode) return
    setCreating(true)
    setOperationError('')
    setNotice('')
    setOcrMessage('')
    let finalExcerpt = excerpt.trim()
    let ocrError = ''
    let usedOcr = false
    // 选区原图始终生成：公式、扫描页、OCR 结果都需要它作为原始证据。
    let cardImage = archiveImage ?? ocrImage

    if (!finalExcerpt && ocrImage) {
      setOcrMessage('正在使用 Apple Vision 识别选中区域…')
      try {
        finalExcerpt = await recognizeText(ocrImage)
        usedOcr = Boolean(finalExcerpt)
      } catch (reason) {
        ocrError = errorMessage(reason)
      } finally {
        setOcrMessage('')
      }
    }

    // 纯文字 OCR 引擎无法识别公式结构，会把公式输出成乱码。命中公式特征时：
    // - 文字来自 PDF 文字层：保留原始字符（可信），同时附上原图供对照版式；
    // - 文字来自 OCR：丢弃乱码，只存原图，由用户手动补录公式。
    const isFormula = Boolean(finalExcerpt) && looksLikeMathFormula(finalExcerpt)
    const ocrFormula = usedOcr && isFormula
    if (ocrFormula) finalExcerpt = ''

    try {
      const card = await createCard({
        source_ref: { document_id: document.id, page: page.pageNumber, bbox: rect },
        excerpt: finalExcerpt,
        question: finalExcerpt
          ? ''
          : isFormula
            ? `第 ${page.pageNumber} 页公式摘录`
            : `第 ${page.pageNumber} 页图像摘录`,
        // 普通文字层摘录不存图，避免数据库被重复截图撑大；公式与 OCR 结果保留原图。
        excerpt_image: finalExcerpt && !isFormula && !usedOcr ? undefined : cardImage,
        annotation: {
          kind: annotationKind ?? (tool === 'rectangle' ? 'rectangle' : 'highlight'),
          geometry: { rects: [rect] },
        },
      })
      if (isFormula && !card.tags.includes('公式')) {
        try {
          await setCardTags(card.id, [...card.tags, '公式'])
        } catch {
          // 打标签失败不影响卡片创建。
        }
      }
      invalidateAnnotations(page.pageNumber)
      callbacksRef.current.onCardsChanged()
      if (ocrFormula) {
        setNotice('选区疑似数学公式，文字 OCR 无法识别公式结构。已保存选区图像，请编辑卡片手动输入公式内容。')
      } else if (isFormula) {
        setNotice('已识别为公式：保留 PDF 原文并附上选区图像，请核对上下标与符号。')
      } else if (ocrError) {
        setOperationError(`OCR 识别失败：${ocrError}。卡片已创建，可编辑摘录补充文字。`)
      } else if (finalExcerpt) {
        setNotice(usedOcr ? 'Apple Vision 识别已完成，卡片与标注已创建。' : '已创建卡片与标注。')
      } else if (cardImage) {
        setNotice('未识别到文字，已创建图像摘录卡片。')
      } else {
        setNotice('未识别到文字，已创建空白摘录卡片，可稍后补充。')
      }
    } catch (reason) {
      setOperationError(`创建失败：${errorMessage(reason)}`)
    } finally {
      setCreating(false)
    }
  }, [createCard, creating, document.id, invalidateAnnotations, recallMode, tool])

  const handleMove = useCallback((annotation: Annotation, geometry: AnnotationGeometry, bbox: NormalizedBBox) => {
    const requestId = (moveRequestsRef.current.get(annotation.id) ?? 0) + 1
    moveRequestsRef.current.set(annotation.id, requestId)
    setAnnotationsByPage((previous) => ({
      ...previous,
      [annotation.page]: (previous[annotation.page] ?? []).map((item) => item.id === annotation.id ? { ...item, geometry } : item),
    }))
    setOperationError('')
    void updateAnnotationGeometry(annotation.id, geometry, bbox)
      .then(() => {
        if (moveRequestsRef.current.get(annotation.id) !== requestId) return
        setNotice('标注位置已保存。')
        callbacksRef.current.onCardsChanged()
      })
      .catch((reason: unknown) => {
        if (moveRequestsRef.current.get(annotation.id) !== requestId) return
        setAnnotationsByPage((previous) => ({
          ...previous,
          [annotation.page]: (previous[annotation.page] ?? []).map((item) => item.id === annotation.id ? annotation : item),
        }))
        setOperationError(`位置保存失败，已还原：${errorMessage(reason)}`)
      })
  }, [])

  const confirmDelete = async (deleteCard: boolean) => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setOperationError('')
    try {
      await removeAnnotation(deleteTarget.id, deleteCard)
      setAnnotationsByPage((previous) => ({
        ...previous,
        [deleteTarget.page]: (previous[deleteTarget.page] ?? []).filter((item) => item.id !== deleteTarget.id),
      }))
      setSelectedAnnotationId(null)
      setDeleteTarget(null)
      setNotice(deleteCard ? '标注与卡片已删除。' : '标注已删除，卡片已保留为孤儿卡片。')
      callbacksRef.current.onCardsChanged()
      await loadCards()
    } catch (reason) {
      setOperationError(`删除失败：${errorMessage(reason)}`)
    } finally {
      setDeleting(false)
    }
  }

  const toggleRecall = () => {
    setOperationError('')
    setSelectedAnnotationId(null)
    if (recallMode) {
      setRecallMode(false)
      setSessionId('')
      return
    }
    setTool('select')
    setRecallMode(true)
    setSessionId(crypto.randomUUID())
    setRevealedCardIds(new Set())
    setRatedCardIds(new Set())
    setReviewedCards({})
    setNotice('回忆会话已开始；点击遮挡块揭示内容。')
  }

  const allAnnotations = useMemo(() => Object.values(annotationsByPage).flat(), [annotationsByPage])
  const cardList = useMemo(() => Object.values(cardsById), [cardsById])
  const selectedAnnotation = allAnnotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null
  const selectedCard = selectedAnnotation
    ? reviewedCards[selectedAnnotation.card_id] ?? cardsById[selectedAnnotation.card_id] ?? null
    : null

  const excerpts = useMemo(() => {
    const result: Record<string, string> = {}
    Object.values(cardsById).forEach((card) => {
      result[card.id] = card.excerpt
    })
    Object.values(reviewedCards).forEach((card) => {
      result[card.id] = card.excerpt
    })
    return result
  }, [cardsById, reviewedCards])

  const handleReveal = useCallback((annotationIds: string[]) => {
    const ids = new Set(annotationIds)
    const revealed = allAnnotations.filter((annotation) => ids.has(annotation.id))
    if (revealed.length === 0) return
    setRevealedCardIds((previous) => {
      const next = new Set(previous)
      revealed.forEach((annotation) => next.add(annotation.card_id))
      return next
    })
    const first = revealed[0]
    if (first) setSelectedAnnotationId(first.id)
  }, [allAnnotations])

  const handleRating = async (rating: Rating) => {
    if (!selectedAnnotation || !selectedCard || ratingBusy || ratedCardIds.has(selectedCard.id) || !sessionId) return
    setRatingBusy(true)
    setOperationError('')
    try {
      const updated = await reviewCard(selectedCard, rating, 'document_recall', sessionId)
      setReviewedCards((previous) => ({ ...previous, [updated.id]: updated }))
      setRatedCardIds((previous) => new Set(previous).add(updated.id))
      setNotice('评分已记录，本会话不会重复计算此卡片。')
      callbacksRef.current.onCardsChanged()
      await loadCards()
    } catch (reason) {
      setOperationError(`评分失败：${errorMessage(reason)}`)
    } finally {
      setRatingBusy(false)
    }
  }

  const zoom = (delta: number) => {
    setScale((previous) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((previous + delta) * 10) / 10)))
  }

  const pageNumbers = useMemo(() => Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1), [pageCount])
  const visibleAnnotationCount = [...visiblePages].reduce((count, page) => count + (annotationsByPage[page]?.length ?? 0), 0)
  const largeDocument = document.file_size > 200 * 1024 * 1024
  const loadingMessage = document.file_status === 'importing' ? '文档正在导入，请稍候…' : largeDocument ? '正在按需读取大型 PDF…' : '正在打开 PDF 文档…'

  /** PDF 页右键菜单把工作区级动作上抛，这里统一分发到已有的工具与对话框。 */
  function handleContextAction(action: PdfContextAction) {
    switch (action.type) {
      case 'tool':
        setTool(action.tool)
        if (action.tool === 'ink') setInkErase(false)
        break
      case 'zoom':
        zoom(action.delta)
        break
      case 'zoom-reset':
        setScale(1)
        break
      case 'page':
        goToPage(currentPage + action.delta)
        break
      case 'recall-toggle':
        toggleRecall()
        break
      case 'tags':
        setTagTarget(action.cardId)
        break
      case 'links':
        setLinkTarget(action.cardId)
        break
      case 'merge':
        setMergeOpen(true)
        break
      case 'delete-annotation':
        setDeleteTarget(action.annotation)
        break
      case 'reveal':
        handleReveal(action.annotationIds)
        break
    }
  }

  return (
    <div className={`pdf-workspace${embedded ? ' is-embedded' : ''}`}>
      {!embedded && (
      <header className="pdf-toolbar">
        <div className="pdf-document-heading">
          <span className="pdf-document-icon">PDF</span>
          <div>
            <strong title={document.title}>{document.title}</strong>
            <small>{pageCount > 0 ? `共 ${pageCount} 页` : '文档工作区'}</small>
          </div>
        </div>

        <div className="pdf-tool-group" aria-label="标注工具">
          <button type="button" className={tool === 'select' ? 'is-active' : ''} aria-pressed={tool === 'select'} onClick={() => setTool('select')} disabled={recallMode}>选择</button>
          <button type="button" className={tool === 'highlight' ? 'is-active' : ''} aria-pressed={tool === 'highlight'} onClick={() => setTool('highlight')} disabled={recallMode}>高亮</button>
          <button type="button" className={tool === 'rectangle' ? 'is-active' : ''} aria-pressed={tool === 'rectangle'} onClick={() => setTool('rectangle')} disabled={recallMode}>矩形</button>
          <button type="button" className={tool === 'text' ? 'is-active' : ''} aria-pressed={tool === 'text'} onClick={() => setTool('text')} disabled={recallMode}>文字</button>
        </div>

        <div className="pdf-zoom-group" aria-label="缩放">
          <button type="button" onClick={() => zoom(-0.1)} disabled={scale <= MIN_SCALE} aria-label="缩小">−</button>
          <button type="button" className="pdf-zoom-value" onClick={() => setScale(1)} title="恢复 100%">{Math.round(scale * 100)}%</button>
          <button type="button" onClick={() => zoom(0.1)} disabled={scale >= MAX_SCALE} aria-label="放大">+</button>
        </div>

        <div className="pdf-page-jump">
          <span>第</span>
          <input
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') jumpToPage()
            }}
            inputMode="numeric"
            aria-label="跳转页码"
          />
          <span>/ {pageCount || '—'} 页</span>
          <button type="button" onClick={jumpToPage} disabled={!pdf || pageCount === 0}>跳转</button>
        </div>

        <button type="button" className={`pdf-recall-toggle ${recallMode ? 'is-active' : ''}`} aria-pressed={recallMode} onClick={toggleRecall} disabled={!pdf}>
          {recallMode ? '退出回忆' : '文档回忆'}
        </button>
      </header>
      )}

      {(operationError || notice || creating || ocrMessage) && (
        <div className={`pdf-operation-bar${embedded ? ' is-floating' : ''} ${operationError ? 'is-error' : ''}`} role={operationError ? 'alert' : 'status'}>
          <span>{operationError || ocrMessage || (creating ? '正在创建卡片与标注…' : notice)}</span>
          {(operationError || notice) && <button type="button" onClick={() => { setOperationError(''); setNotice('') }} aria-label="关闭提示">×</button>}
        </div>
      )}

      <div className="pdf-workspace-body">
        <div
          className="pdf-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={() => { userNavigatedRef.current = true }}
          onPointerDown={() => { userNavigatedRef.current = true }}
        >
          {loading && (
            <div className="pdf-state" role="status">
              <span className="pdf-spinner" />
              <strong>{loadingMessage}</strong>
              <p>{largeDocument ? '文档超过 200MB，仅加载当前可视页面；首次打开可能需要几秒。' : '正在准备连续滚动工作区。'}</p>
            </div>
          )}
          {!loading && loadError && (
            <div className="pdf-state is-error" role="alert">
              <strong>无法打开 PDF</strong>
              <p>{loadError}</p>
              {document.file_status === 'ready' && <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>重新加载</button>}
            </div>
          )}
          {!loading && !loadError && pdf && pageCount === 0 && (
            <div className="pdf-state"><strong>此 PDF 没有页面</strong><p>请选择包含页面的其他文档。</p></div>
          )}
          {!loading && !loadError && pdf && pageCount > 0 && (
            <div className="pdf-pages">
              {pageNumbers.map((pageNumber) => (
                <PdfPage
                  key={`${document.id}-${pageNumber}`}
                  pageNumber={pageNumber}
                  documentId={document.id}
                  shouldRender={renderPages.has(pageNumber)}
                  scale={scale}
                  size={pageSizes[pageNumber] ?? defaultPageSize}
                  annotations={annotationsByPage[pageNumber] ?? EMPTY_ANNOTATIONS}
                  inks={inksByPage[pageNumber] ?? EMPTY_INKS}
                  inkColor={inkColor}
                  inkWidth={inkWidth}
                  inkErase={inkErase}
                  onInk={(bbox, points) => void handleInk(pageNumber, bbox, points)}
                  onEraseInk={(id) => void handleEraseInk(id)}
                  excerpts={excerpts}
                  tool={tool}
                  recallMode={recallMode}
                  revealedCardIds={revealedCardIds}
                  selectedAnnotationId={selectedAnnotationId}
                  getPage={getPage}
                  registerPage={registerPage}
                  onSize={handleSize}
                  onSelect={(annotation) => setSelectedAnnotationId(annotation.id)}
                  onCreate={handleCreate}
                  onMove={handleMove}
                  onReveal={handleReveal}
                  onContextAction={handleContextAction}
                />
              ))}
            </div>
          )}
        </div>

        {!embedded && (
        <aside className="pdf-inspector">
          <div className="pdf-inspector-heading">
            <div>
              <small>{recallMode ? 'ACTIVE RECALL' : 'ANNOTATION'}</small>
              <h2>{recallMode ? '文档回忆' : '标注摘录'}</h2>
            </div>
            <span>第 {currentPage} 页</span>
          </div>

          {selectedAnnotation ? (
            <div className="pdf-selected-card">
              <div className="pdf-selected-meta">
                <span>{selectedAnnotation.kind === 'rectangle' ? '矩形标注' : '高亮标注'}</span>
                <span>第 {selectedAnnotation.page} 页</span>
              </div>
              <blockquote>{selectedCard?.excerpt || excerpts[selectedAnnotation.card_id] || '此标注没有文字摘录。'}</blockquote>
              {recallMode ? (
                revealedCardIds.has(selectedAnnotation.card_id) ? (
                  <div className="pdf-rating-panel">
                    <p>{ratedCardIds.has(selectedAnnotation.card_id) ? '本会话已评分' : '回忆程度如何？'}</p>
                    <div className="pdf-rating-buttons">
                      {(['重来', '困难', '良好', '简单'] as const).map((label, index) => (
                        <button
                          type="button"
                          key={label}
                          onClick={() => void handleRating((index + 1) as Rating)}
                          disabled={ratingBusy || ratedCardIds.has(selectedAnnotation.card_id) || !selectedCard}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {!selectedCard && <small>卡片信息尚未载入，暂时无法评分。</small>}
                  </div>
                ) : <p className="pdf-inspector-hint">点击页面上的遮挡块后再评分。</p>
              ) : (
                <button type="button" className="pdf-delete-button" onClick={() => setDeleteTarget(selectedAnnotation)}>删除标注</button>
              )}
            </div>
          ) : (
            <div className="pdf-inspector-empty">
              <span className="pdf-inspector-symbol">{recallMode ? '?' : '“”'}</span>
              <strong>{recallMode ? '先回忆，再揭示' : '选择一条标注'}</strong>
              <p>{recallMode ? '遮挡块已覆盖当前标注。点击揭示摘录，然后完成一次评分。' : tool === 'text' ? '像 Word 一样拖选文字，选中后可复制或直接建卡。' : tool === 'select' ? '点击标注查看摘录，或拖拽调整位置。' : '在页面上按下并拖拽，创建一条新标注。'}</p>
            </div>
          )}

          <div className="pdf-inspector-footer">
            <div><span>当前可见标注</span><strong>{visibleAnnotationCount}</strong></div>
            <p>{recallMode ? '同一会话中，每张卡片仅记录一次评分。' : '拖动时仅更新内存位置，松开鼠标后才写入本地数据库。'}</p>
          </div>
        </aside>
        )}
      </div>

      {embedded && (
        <>
          {recallMode && selectedAnnotation && revealedCardIds.has(selectedAnnotation.card_id) && (
            <div className="pdf-recall-float" role="group" aria-label="文档回忆评分">
              <span>{selectedCard ? (ratedCardIds.has(selectedCard.id) ? '本会话已评分' : '回忆程度如何？') : '卡片尚未载入'}</span>
              <div>
                {(['重来', '困难', '良好', '简单'] as const).map((label, index) => (
                  <button
                    type="button"
                    key={label}
                    onClick={() => void handleRating((index + 1) as Rating)}
                    disabled={ratingBusy || !selectedCard || ratedCardIds.has(selectedCard.id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {pageCount > 0 && tool !== 'ink' && (
            <div className="pdf-page-pill">
              <button type="button" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="上一页">‹</button>
              <span>第 {currentPage} / {pageCount} 页</span>
              <button type="button" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="下一页">›</button>
            </div>
          )}

          <div className="pdf-dock" role="toolbar" aria-label="标注与阅读工具">
            <button type="button" disabled title="剪切（暂未支持）"><Scissors size={17} /><span>剪切</span></button>
            <button type="button" className={tool === 'select' ? 'is-active' : ''} onClick={() => setTool('select')} disabled={recallMode} aria-pressed={tool === 'select'} title="套索选择"><MousePointer2 size={17} /><span>套索</span></button>
            <button type="button" className={tool === 'text' ? 'is-active' : ''} onClick={() => setTool('text')} disabled={recallMode} aria-pressed={tool === 'text'} title="文字选择：像 Word 一样拖选文字，可复制或建卡"><Type size={17} /><span>文字</span></button>
            <button type="button" className={tool === 'highlight' ? 'is-active' : ''} onClick={() => setTool('highlight')} disabled={recallMode} aria-pressed={tool === 'highlight'} title="高亮颜色"><Highlighter size={17} /><span>颜色</span></button>
            <button type="button" onClick={() => { if (selectedAnnotation) setTagTarget(selectedAnnotation.card_id) }} disabled={!selectedAnnotation} title="给选中标注的卡片加标签"><Tag size={17} /><span>标签</span></button>
            <button type="button" onClick={() => { if (selectedAnnotation) setLinkTarget(selectedAnnotation.card_id) }} disabled={!selectedAnnotation} title="把选中卡片关联到其他卡片"><Link2 size={17} /><span>链接</span></button>
            <button type="button" className={tool === 'rectangle' ? 'is-active' : ''} onClick={() => setTool('rectangle')} disabled={recallMode} aria-pressed={tool === 'rectangle'} title="矩形框选"><Square size={17} /><span>框架</span></button>
            <button type="button" className={tool === 'ink' ? 'is-active' : ''} onClick={() => { setTool(tool === 'ink' ? 'select' : 'ink'); setInkErase(false) }} aria-pressed={tool === 'ink'} title="手写墨迹"><PenLine size={17} /><span>墨迹</span></button>
            <button type="button" onClick={() => setMergeOpen(true)} disabled={cardList.length < 2} title="合并多张卡片"><Merge size={17} /><span>合并</span></button>
            <button type="button" className={recallMode ? 'is-active' : ''} onClick={toggleRecall} disabled={!pdf} aria-pressed={recallMode} title="文档遮挡回忆"><MessageSquare size={17} /><span>{recallMode ? '退出' : '对话'}</span></button>
            <button type="button" onClick={() => { if (selectedAnnotation) setDeleteTarget(selectedAnnotation) }} disabled={!selectedAnnotation} title="删除选中的标注"><Trash2 size={17} /><span>删除</span></button>
            <button type="button" className={dockMenuOpen ? 'is-active' : ''} onClick={() => setDockMenuOpen((open) => !open)} aria-expanded={dockMenuOpen} title="更多：缩放与跳页"><MoreHorizontal size={17} /><span>更多</span></button>
          </div>

          {tool === 'ink' && (
            <div className="pdf-ink-palette" role="group" aria-label="墨迹工具">
              <div className="pdf-ink-colors">
                {INK_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={inkColor === color && !inkErase ? 'is-active' : ''}
                    style={{ background: color }}
                    onClick={() => { setInkColor(color); setInkErase(false) }}
                    aria-label={`墨迹颜色 ${color}`}
                  />
                ))}
              </div>
              <div className="pdf-ink-widths">
                {INK_WIDTHS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={inkWidth === option.value && !inkErase ? 'is-active' : ''}
                    onClick={() => { setInkWidth(option.value); setInkErase(false) }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={inkErase ? 'is-active' : ''}
                onClick={() => setInkErase((value) => !value)}
              >
                橡皮
              </button>
              <button type="button" onClick={() => { setTool('select'); setInkErase(false) }}>完成</button>
            </div>
          )}

          {dockMenuOpen && (
            <div className="pdf-dock-menu" role="dialog" aria-label="缩放与跳页">
              <div className="pdf-dock-menu-row">
                <span>跳转</span>
                <input
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') jumpToPage() }}
                  inputMode="numeric"
                  aria-label="跳转页码"
                />
                <button type="button" onClick={jumpToPage} disabled={!pdf || pageCount === 0}>前往</button>
              </div>
              <div className="pdf-dock-menu-row">
                <span>缩放</span>
                <button type="button" onClick={() => zoom(-0.1)} disabled={scale <= MIN_SCALE}>−</button>
                <button type="button" className="pdf-dock-scale" onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
                <button type="button" onClick={() => zoom(0.1)} disabled={scale >= MAX_SCALE}>+</button>
              </div>
              <button type="button" className="pdf-dock-menu-wide" onClick={() => { setScale(1); setDockMenuOpen(false) }}>恢复 100%</button>
            </div>
          )}
        </>
      )}

      {tagTarget && cardsById[tagTarget] && (
        <TagDialog
          card={cardsById[tagTarget]}
          onClose={() => setTagTarget(null)}
          onSaved={() => {
            callbacksRef.current.onCardsChanged()
            void loadCards()
          }}
        />
      )}

      {linkTarget && cardsById[linkTarget] && (
        <LinkDialog
          card={cardsById[linkTarget]}
          cards={cardList}
          onClose={() => setLinkTarget(null)}
          onChanged={() => callbacksRef.current.onCardsChanged()}
        />
      )}

      {mergeOpen && (
        <MergeDialog
          cards={cardList}
          initialSelection={selectedAnnotation ? [selectedAnnotation.card_id] : []}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            callbacksRef.current.onCardsChanged()
            void loadCards()
          }}
        />
      )}

      {deleteTarget && (
        <div className="pdf-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setDeleteTarget(null)
        }}>
          <div className="pdf-modal" role="dialog" aria-modal="true" aria-labelledby="pdf-delete-title">
            <small>删除标注</small>
            <h2 id="pdf-delete-title">是否同时删除关联卡片？</h2>
            <p>保留卡片会解除它与 PDF 的关联，卡片仍可在复习中使用；彻底删除则不可恢复。</p>
            <div className="pdf-modal-actions">
              <button type="button" onClick={() => void confirmDelete(false)} disabled={deleting}>保留卡片，仅删标注</button>
              <button type="button" className="is-danger" onClick={() => void confirmDelete(true)} disabled={deleting}>彻底删除</button>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
            </div>
            {deleting && <span className="pdf-modal-status">正在删除…</span>}
          </div>
        </div>
      )}
    </div>
  )
}
