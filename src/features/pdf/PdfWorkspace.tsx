import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from './pdfjs'
import type { OcrLine } from '../../services/pdfnote'
import { CANVAS_CHANGED_EVENT, MINDMAP_CHANGED_EVENT, notifyMindmapChanged, readCanvasId } from '../mindmap/canvas'
import { nextMindmapInsertPoint } from '../mindmap/viewport'
import type {
  Annotation,
  AnnotationGeometry,
  Card,
  Document as PdfDocument,
  NormalizedBBox,
  PageInk,
  PageNote,
  Rating,
} from '../../domain/card'
import {
  createPageInk,
  createPageNote,
  deletePageInk,
  deletePageNote,
  getPageOcr,
  listAnnotations,
  listMindmapLayout,
  listPageInks,
  listPageNotes,
  readPdfChunk,
  getReadingState,
  removeAnnotation,
  saveRecallNote,
  saveTocJson,
  setCardTags,
  updateAnnotationGeometry,
  updateCardContent,
  updatePageNote,
  setReadingPass,
  updateDocumentProgress,
} from '../../services/pdfnote'
import {
  BookOpen,
  Highlighter,
  Link2,
  Merge,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  PenLine,
  Scissors,
  Sparkles,
  Square,
  Tag,
  TextCursorInput,
  Trash2,
  Type,
} from 'lucide-react'
import { LinkDialog, MergeDialog, TagDialog } from '../card/CardDialogs'
import { useCardStore } from '../../store/cardStore'
import { reviewCard } from '../review/scheduler'
import { PdfPage, type PageSize, type PdfContextAction, type PdfTool } from './PdfPage'
import { linesFromTextContent } from './pageText'
import { pageViewBox } from './geometry'
import { BookDigestDialog } from '../book/BookDigestDialog'
import type { DigestPage } from '../../services/book'
import { recognizeText } from './ocr'
import { decideFormulaRecognition } from './formulaRecognition'
import { describeAiFailure } from './aiFailure'
import { pruneCardAnnotations } from './annotationCache'
import { TitleLinkPopover } from './TitleLinkPopover'
import { SizeControl } from '../ink/SizeControl'
import { readSizePreference, saveSizePreference } from '../ink/size'
import { ClozePanel } from './ClozePanel'
import { parentIdForPage, planSkeletonMerge, readPdfOutline, type TocEntry } from './pdfOutline'
import { parseTocText } from './tocText'
import {
  bumpClozeTurn,
  buildCloze,
  checkCloze,
  readClozePreference,
  saveClozePreference,
  type ClozeExercise,
  type ClozeResult,
} from './cloze'
import { buildTitleLinkIndex, type TitleLinkHit } from './titleLink'
import { getAiSettings, isAiConfigured, recognizeSelection } from '../../services/ai'
import './PdfWorkspace.css'

// 必须用 legacy worker：常规 worker 依赖 Map.prototype.getOrInsertComputed，
// macOS 15 及更早的 WKWebView 没有，打开 PDF 会直接失败（详见 ./pdfjs）。
GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.legacy.min.mjs'

const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 }
const PAGE_PROXY_CACHE_LIMIT = 16
const EMPTY_INKS: PageInk[] = []
const INK_COLORS = ['#d94f3d', '#2f6f8f', '#3f7a4c', '#2f3330']
const MIN_SCALE = 0.5
const MAX_SCALE = 3
const EMPTY_ANNOTATIONS: Annotation[] = []
const EMPTY_NOTES: PageNote[] = []


const TITLE_LINK_STORAGE_KEY = 'pdfnote.titleLink.enabled'

function readTitleLinkPreference(): boolean {
  try {
    return window.localStorage.getItem(TITLE_LINK_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export interface PdfWorkspaceProps {
  document: PdfDocument
  onPageCount: (count: number) => void
  onCardsChanged: () => void
  /** 嵌入分栏工作区：隐藏独立页头与标注检查器，改用底部悬浮工具坞。 */
  embedded?: boolean
  /** 外部请求跳到某页（脑图卡片点击页码）。token 保证同一页再次点击也能触发。 */
  jumpTarget?: { documentId: string; page: number; token: number } | null
  onJumpHandled?: () => void
  /**
   * 固定画布：粗读精读工作区把 PDF 的标注也钉在同一张画布上。
   * 不传则跟随本书当前画布（并随画布切换事件更新）。
   */
  canvasId?: string
}

interface TocSkeletonEntry {
  cardId: string
  page: number
  title: string
  level: number
}

const RECALL_TEMPLATE = `【主旨】

【论证】

【与我的关系】

【精读清单】3–5 章 / 还没弄懂的问题`

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

export function PdfWorkspace({
  document,
  onPageCount,
  onCardsChanged,
  jumpTarget,
  onJumpHandled,
  embedded = false,
  canvasId: canvasIdOverride,
}: PdfWorkspaceProps) {
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
  // 标注跟着画布走：同一本书的两张画布各有各的高亮。
  const [activeCanvasId, setActiveCanvasId] = useState(() => canvasIdOverride ?? readCanvasId(document.id))
  /** null = 还没读到画布成员，此时不过滤，避免打开文档时先闪一下空白。 */
  const [canvasCardIds, setCanvasCardIds] = useState<ReadonlySet<string> | null>(null)
  const [annotationVersion, setAnnotationVersion] = useState(0)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState('')
  // 完整错误默认折叠：摘要只留一句，避免整条状态栏被堆栈/网关原文淹没。
  const [operationDetail, setOperationDetail] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailCopied, setDetailCopied] = useState(false)
  // 公式识别失败后保留重试所需的最小上下文：卡片 id + 当时的选区截图。
  const [formulaRetry, setFormulaRetry] = useState<{ cardId: string; image: string } | null>(null)
  const [retrying, setRetrying] = useState(false)
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
  // 粗读 / 精读：阶段与召回随书存数据库；粗读只保留「高亮」一种产出。
  const [readingPass, setReadingPassState] = useState(1)
  const [recallNote, setRecallNote] = useState('')
  const [recallOpen, setRecallOpen] = useState(false)
  const [recallDraft, setRecallDraft] = useState('')
  const [readingBusy, setReadingBusy] = useState(false)
  // 目录骨架：按画布记一份（cardId + 页码 + 层级），用于「新卡自动挂最近小节」。
  const [tocMap, setTocMap] = useState<Record<string, TocSkeletonEntry[]>>({})
  const [tocBuilding, setTocBuilding] = useState(false)
  // 没有内置书签的扫描书：把目录页复制进来，走同一套建骨架 + 自动挂接。
  const [tocPasteOpen, setTocPasteOpen] = useState(false)
  const [tocPasteDraft, setTocPasteDraft] = useState('')
  // 挖空填空：在「整块遮挡」和「揭示」之间多一层，先补关键词再评分。
  const [clozeEnabled, setClozeEnabled] = useState(readClozePreference)
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string[]>>({})
  const [clozeResults, setClozeResults] = useState<Record<string, ClozeResult | null>>({})
  // 每次开始回忆会话 +1：同一条摘录换个空，但会话内保持不变。
  const [clozeTurn, setClozeTurn] = useState(0)
  const clozeCacheRef = useRef(new Map<string, { excerpt: string; turn: number; exercise: ClozeExercise }>())
  const [reviewedCards, setReviewedCards] = useState<Record<string, Card>>({})
  const [dockMenuOpen, setDockMenuOpen] = useState(false)
  const [tagTarget, setTagTarget] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [inksByPage, setInksByPage] = useState<Record<number, PageInk[]>>({})
  // 留白数量少，打开文档时一次性载入，按页分组渲染。
  const [pageNotes, setPageNotes] = useState<PageNote[]>([])
  const [digestOpen, setDigestOpen] = useState(false)
  const [inkColor, setInkColor] = useState(INK_COLORS[0])
  const [inkWidth, setInkWidth] = useState(() => readSizePreference('pen'))
  const [eraserSize, setEraserSize] = useState(() => readSizePreference('eraser'))
  const [inkErase, setInkErase] = useState(false)

  // 连续滑杆：拖一下就落一次偏好，PDF 与笔记本共用同一份记忆。
  const changeInkWidth = (value: number) => {
    setInkWidth(value)
    saveSizePreference('pen', value)
    setInkErase(false)
  }
  const changeEraserSize = (value: number) => {
    setEraserSize(value)
    saveSizePreference('eraser', value)
  }
  // 标题链接默认关闭：卡片库还很小时开启只会有开销，没有「过去的笔记」可浮现。
  const [titleLinkEnabled, setTitleLinkEnabled] = useState(readTitleLinkPreference)
  const [titleLinkPreview, setTitleLinkPreview] = useState<TitleLinkHit | null>(null)
  // 只有用户配置了视觉模型才尝试公式识别；否则保持原图 + 手动补录。
  const [aiReady, setAiReady] = useState(false)
  const [aiTimeoutSecs, setAiTimeoutSecs] = useState(120)

  const firstPass = readingPass === 1

  // 操作提示只停留几秒：否则它会一直浮在页面上，挡住阶段条等控件。
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 打开文档时读阶段与召回；读不到就按粗读处理，不打断文档加载。
  useEffect(() => {
    let active = true
    setTocMap({})
    getReadingState(document.id)
      .then((state) => {
        if (!active) return
        setReadingPassState(state.pass === 2 ? 2 : 1)
        setRecallNote(state.recallNote)
        try {
          setTocMap(state.tocJson ? JSON.parse(state.tocJson) : {})
        } catch {
          setTocMap({})
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [document.id])

  // 粗读只允许点选与高亮；其它工具先收起来，避免一上来就做细节。
  useEffect(() => {
    if (firstPass && tool !== 'select' && tool !== 'highlight') setTool('highlight')
  }, [firstPass, tool])

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

  // 读取可选的视觉模型配置；未配置时公式识别完全走本地路径。
  useEffect(() => {
    let active = true
    getAiSettings()
      .then((settings) => {
        if (!active) return
        setAiReady(isAiConfigured(settings))
        setAiTimeoutSecs(settings.timeoutSecs || 120)
      })
      .catch(() => { if (active) setAiReady(false) })
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail
      setAiReady(Boolean(detail && detail.baseUrl && detail.model))
      if (detail?.timeoutSecs) setAiTimeoutSecs(Number(detail.timeoutSecs))
    }
    window.addEventListener('pdfnote:ai-settings-changed', onChanged)
    return () => {
      active = false
      window.removeEventListener('pdfnote:ai-settings-changed', onChanged)
    }
  }, [])

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
            next[page] = annotations.filter((annotation) =>
              annotation.page === page && !deletedCardIdsRef.current.has(annotation.card_id),
            )
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

  // 画布成员：不在当前画布的卡片，其标注一律不渲染（两遍阅读 / 多画布各自干净）。
  useEffect(() => {
    let active = true
    const reload = () => {
      listMindmapLayout(activeCanvasId || 'main')
        .then((rows) => {
          if (active) setCanvasCardIds(new Set(rows.map((row) => row.card_id)))
        })
        .catch(() => {
          if (active) setCanvasCardIds(null)
        })
    }
    reload()
    window.addEventListener(MINDMAP_CHANGED_EVENT, reload)
    return () => {
      active = false
      window.removeEventListener(MINDMAP_CHANGED_EVENT, reload)
    }
  }, [activeCanvasId])

  // 画布切换：普通阅读里从脑图下拉换画布时，PDF 的标注要跟着换。
  useEffect(() => {
    if (canvasIdOverride) {
      setActiveCanvasId(canvasIdOverride)
      return
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string | null; canvasId: string }>).detail
      if (!detail?.canvasId) return
      if (detail.documentId && detail.documentId !== document.id) return
      setActiveCanvasId(detail.canvasId)
    }
    window.addEventListener(CANVAS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(CANVAS_CHANGED_EVENT, handler)
  }, [canvasIdOverride, document.id])

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

  useEffect(() => {
    let active = true
    setPageNotes([])
    listPageNotes(document.id)
      .then((notes) => { if (active) setPageNotes(notes) })
      .catch(() => {
        // 留白加载失败不影响阅读，静默降级。
      })
    return () => { active = false }
  }, [document.id])

  const notesByPage = useMemo(() => {
    const map: Record<number, PageNote[]> = {}
    for (const note of pageNotes) {
      ;(map[note.page] ??= []).push(note)
    }
    return map
  }, [pageNotes])

  const handleNoteCreate = useCallback(async (page: number, anchorY: number) => {
    try {
      const note = await createPageNote({
        document_id: document.id,
        page,
        anchor_y: anchorY,
      })
      setPageNotes((previous) => [...previous, note])
      setNotice('已添加留白，可直接在页边输入。')
    } catch (reason) {
      setOperationError(`添加留白失败：${errorMessage(reason)}`)
    }
  }, [document.id])

  const handleNoteSave = useCallback(async (id: string, content: string) => {
    try {
      const updated = await updatePageNote({ id, content })
      setPageNotes((previous) => previous.map((note) => (note.id === id ? updated : note)))
    } catch (reason) {
      setOperationError(`保存留白失败：${errorMessage(reason)}`)
    }
  }, [])

  const handleNoteToggle = useCallback(async (id: string, collapsed: boolean) => {
    // 先本地切换保证手感，失败再回滚。
    setPageNotes((previous) => previous.map((note) => (note.id === id ? { ...note, collapsed } : note)))
    try {
      const updated = await updatePageNote({ id, collapsed })
      setPageNotes((previous) => previous.map((note) => (note.id === id ? updated : note)))
    } catch (reason) {
      setPageNotes((previous) => previous.map((note) => (note.id === id ? { ...note, collapsed: !collapsed } : note)))
      setOperationError(`折叠留白失败：${errorMessage(reason)}`)
    }
  }, [])

  const handleNoteDelete = useCallback(async (id: string) => {
    try {
      await deletePageNote(id)
      setPageNotes((previous) => previous.filter((note) => note.id !== id))
      setNotice('留白已删除。')
    } catch (reason) {
      setOperationError(`删除留白失败：${errorMessage(reason)}`)
    }
  }, [])

  /** 取某页文字：优先 PDF 文字层（精确坐标），扫描页回退到 Vision 行级缓存。 */
  const collectPageText = useCallback(async (pageNumber: number): Promise<DigestPage> => {
    const empty: DigestPage = { page: pageNumber, text: '', bbox: null }
    if (!pdf) return empty
    try {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const lines = linesFromTextContent(content, pageViewBox(page.view))
      const text = lines.map((line) => line.text).join('\n').trim()
      if (text && lines.length > 0) {
        const left = Math.min(...lines.map((line) => line.x))
        const top = Math.min(...lines.map((line) => line.y))
        const right = Math.max(...lines.map((line) => line.x + line.width))
        const bottom = Math.max(...lines.map((line) => line.y + line.height))
        return { page: pageNumber, text, bbox: [left, top, right - left, bottom - top] }
      }
    } catch {
      // 文字层不可用（扫描页），继续尝试 OCR 缓存。
    }
    try {
      const record = await getPageOcr(document.id, pageNumber)
      if (record) {
        const lines = JSON.parse(record.linesJson) as OcrLine[]
        const text = lines.map((line) => line.text).join('\n').trim()
        if (text) return { page: pageNumber, text, bbox: null }
      }
    } catch {
      // 没有缓存就跳过这一页。
    }
    return empty
  }, [document.id, pdf])

  // 已删除卡片的标注可能在途请求里返回，写入缓存前要过滤掉。
  const deletedCardIdsRef = useRef<Set<string>>(new Set())
  // 事件处理器需要读到最新缓存，但不应因为它变化而重建监听。
  const annotationsByPageRef = useRef(annotationsByPage)
  useEffect(() => {
    annotationsByPageRef.current = annotationsByPage
  }, [annotationsByPage])

  /**
   * 卡片在别的视图被彻底删除（脑图右键删除、复习删卡等）时，后端级联删除了标注，
   * 但本工作区的标注缓存是独立的，必须显式清理，否则页面上会留下点不掉的“幽灵标注”。
   */
  useEffect(() => {
    const onCardDeleted = (event: Event) => {
      const cardId = (event as CustomEvent<{ cardId?: string }>).detail?.cardId
      if (!cardId) return
      deletedCardIdsRef.current.add(cardId)
      const pruned = pruneCardAnnotations(annotationsByPageRef.current, cardId)
      if (!pruned) return
      setAnnotationsByPage(pruned.pages)
      setSelectedAnnotationId((current) => (current && pruned.removedIds.includes(current) ? null : current))
      setDeleteTarget((current) => (current && pruned.removedIds.includes(current.id) ? null : current))
      // 让这些页下次进入时与数据库重新对齐，防御并发或多端修改。
      for (const page of pruned.affectedPages) invalidateAnnotations(page)
      setNotice(`卡片已删除，PDF 上对应的 ${pruned.removedIds.length} 处标注已同步移除。`)
    }
    window.addEventListener('pdfnote:card-deleted', onCardDeleted)
    return () => window.removeEventListener('pdfnote:card-deleted', onCardDeleted)
  }, [invalidateAnnotations])

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

  // 脑图卡片点击页码：文档加载完成、页面占位元素注册后跳到目标页。
  // 与「恢复阅读进度」一致，用短时多次重试等待元素与尺寸稳定；直接调 goToPage
  // 会因为元素尚未注册而静默失败（尤其是刚切到另一份文档时）。
  useEffect(() => {
    if (loading || !pdf || !jumpTarget || jumpTarget.documentId !== document.id) return
    const target = Math.min(Math.max(Math.round(jumpTarget.page), 1), pageCount || 1)
    const jump = () => {
      const element = pageElementsRef.current.get(target)
      const root = scrollRef.current
      if (!element || !root) return
      setOperationError('')
      userNavigatedRef.current = true
      setCurrentPage(target)
      setPageInput(String(target))
      root.scrollTo({ top: Math.max(0, element.offsetTop - 20), behavior: 'smooth' })
    }
    const timers = [60, 400, 1_200].map((delay) => window.setTimeout(jump, delay))
    // 等重试跑完再清空请求，避免 cleanup 把定时器取消掉。
    const done = window.setTimeout(() => onJumpHandled?.(), 1_600)
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      window.clearTimeout(done)
    }
  }, [document.id, jumpTarget, loading, onJumpHandled, pageCount, pdf])

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

  /**
   * 批量擦除：橡皮拖动时可能一次命中多条，松手才统一删，
   * 免得每一条都写一次数据库、刷一次提示。
   */
  const handleEraseInks = useCallback(async (ids: string[]) => {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    try {
      await Promise.all(unique.map((id) => deletePageInk(id)))
      setInksByPage((previous) => {
        const drop = new Set(unique)
        const next: Record<number, PageInk[]> = {}
        Object.entries(previous).forEach(([page, items]) => {
          next[Number(page)] = items.filter((ink) => !drop.has(ink.id))
        })
        return next
      })
      setNotice(unique.length > 1 ? `已擦除 ${unique.length} 条墨迹。` : '墨迹已删除。')
    } catch (reason) {
      setOperationError(`删除墨迹失败：${errorMessage(reason)}`)
    }
  }, [])

  const handleEraseInk = useCallback((id: string) => {
    void handleEraseInks([id])
  }, [handleEraseInks])

  const clearOperation = useCallback(() => {
    setOperationError('')
    setOperationDetail('')
    setDetailOpen(false)
    setDetailCopied(false)
    setFormulaRetry(null)
    setNotice('')
  }, [])

  /** 用失败时保存的截图重新识别公式，并把 LaTeX 写回同一张卡片的摘录。 */
  const retryFormulaRecognition = useCallback(async () => {
    if (!formulaRetry || retrying) return
    setRetrying(true)
    setOperationError('')
    setOperationDetail('')
    setDetailOpen(false)
    setOcrMessage(`正在重试公式识别（最多等待 ${aiTimeoutSecs} 秒）…`)
    try {
      const latex = (await recognizeSelection(formulaRetry.image, 'formula')).trim()
      if (!latex) throw new Error('模型返回了空内容')
      const current = cardsById[formulaRetry.cardId]
      await updateCardContent({
        id: formulaRetry.cardId,
        excerpt: latex,
        user_note: current?.user_note ?? '',
        question: current?.question ?? '',
      })
      setFormulaRetry(null)
      setNotice('公式已识别为 LaTeX，结果已写入卡片摘录。')
      callbacksRef.current.onCardsChanged()
    } catch (reason) {
      setOperationError('公式识别仍然失败，可查看详情，或稍后按任务号取回。')
      setOperationDetail(errorMessage(reason))
    } finally {
      setOcrMessage('')
      setRetrying(false)
    }
  }, [aiTimeoutSecs, cardsById, formulaRetry, retrying])

  const copyDetail = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(operationDetail)
      setDetailCopied(true)
    } catch {
      // 剪贴板不可用时用户仍可手动选中 pre 里的文本。
    }
  }, [operationDetail])

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
    const formula = decideFormulaRecognition({
      excerpt: finalExcerpt,
      fromOcr: usedOcr,
      aiReady,
      hasImage: Boolean(ocrImage ?? cardImage),
    })
    const isFormula = formula.isFormula
    const ocrFormula = formula.discardExcerpt
    if (ocrFormula) finalExcerpt = ''
    // 文字层公式的原文可信，识别失败时回退到它；OCR 公式只有乱码，回退为空。
    const fallbackExcerpt = finalExcerpt

    // 配置了视觉模型时，把公式选区（优先高清图）交给模型转 LaTeX。
    // 文字层公式与 OCR 公式都走这里——之前只覆盖了 OCR 来源，导致文字层公式没有识别。
    let aiFormula = false
    let aiError = ''
    const aiImage = ocrImage ?? cardImage
    if (formula.useVisionModel && aiImage) {
      const startedAt = Date.now()
      setOcrMessage(`正在用视觉模型识别公式（最多等待 ${aiTimeoutSecs} 秒）…`)
      // 模型首次加载可能很慢，每 10 秒更新一次进度，避免界面看起来卡死。
      const watchdog = window.setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000)
        setOcrMessage(`视觉模型仍在识别公式（已 ${seconds} 秒），最多等待 ${aiTimeoutSecs} 秒…`)
      }, 10_000)
      try {
        const latex = await recognizeSelection(aiImage, 'formula')
        finalExcerpt = latex.trim()
        aiFormula = Boolean(finalExcerpt)
      } catch (reason) {
        finalExcerpt = fallbackExcerpt
        aiError = errorMessage(reason)
      } finally {
        window.clearInterval(watchdog)
        setOcrMessage('')
      }
    }

    try {
      // 从 PDF 划重点建卡时写入读者当前选中的画布，而不是永远塞进 main。
      const targetCanvasId = activeCanvasId
      // 精读时点过「按目录建骨架」：新卡挂到当前页所属的最近小节下，脑图自己长结构。
      const tocParent = parentIdForPage(tocMap[targetCanvasId] ?? [], page.pageNumber)
      // 落点 = 右栏画布此刻的视口中心：用户不用再缩小去找新卡。
      const insertPoint = nextMindmapInsertPoint()
      const card = await createCard({
        canvas_id: targetCanvasId,
        parent_id: tocParent,
        ...(insertPoint ?? {}),
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
      notifyMindmapChanged(targetCanvasId)
      callbacksRef.current.onCardsChanged()
      if (aiFormula) {
        setNotice('公式已由视觉模型识别为 LaTeX，原图同时保留，请核对上下标后保存。')
      } else if (aiError) {
        const failure = describeAiFailure(aiError, Boolean(finalExcerpt))
        setOperationError(failure.summary)
        setOperationDetail(failure.detail)
        setDetailOpen(false)
        setDetailCopied(false)
        if (aiImage) setFormulaRetry({ cardId: card.id, image: aiImage })
      } else if (ocrFormula) {
        setNotice('选区疑似数学公式，文字 OCR 无法识别公式结构。已保存选区图像，请编辑卡片手动输入公式内容，或在设置中配置视觉模型自动识别。')
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
  }, [activeCanvasId, aiReady, aiTimeoutSecs, createCard, creating, document.id, invalidateAnnotations, recallMode, tocMap, tool])

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
      const message = errorMessage(reason)
      // 标注已在别处被删除（如脑图彻底删卡），缓存却还没刷新：
      // 不要再报错留下点不掉的图层，直接从视图移除并说明。
      if (/annotation not found/i.test(message)) {
        setAnnotationsByPage((previous) => ({
          ...previous,
          [deleteTarget.page]: (previous[deleteTarget.page] ?? []).filter((item) => item.id !== deleteTarget.id),
        }))
        setSelectedAnnotationId(null)
        setDeleteTarget(null)
        setNotice('该标注已在其他视图被删除，已从当前页面移除。')
        callbacksRef.current.onCardsChanged()
      } else {
        setOperationError(`删除失败：${message}`)
      }
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
    setClozeAnswers({})
    setClozeResults({})
    setClozeTurn(bumpClozeTurn())
    setNotice(clozeEnabled
      ? '回忆会话已开始；手写墨迹与留白已隐藏，点遮挡块做挖空填空。'
      : '回忆会话已开始；手写墨迹与留白已隐藏，点击遮挡块揭示内容。')
  }

  /** 当前画布上的标注；还没读到成员时先不过滤，避免打开文档闪空白。 */
  const scopedAnnotationsByPage = useMemo(() => {
    if (!canvasCardIds) return annotationsByPage
    const result: Record<number, Annotation[]> = {}
    for (const [page, list] of Object.entries(annotationsByPage)) {
      const kept = list.filter((annotation) => canvasCardIds.has(annotation.card_id))
      if (kept.length > 0) result[Number(page)] = kept
    }
    return result
  }, [annotationsByPage, canvasCardIds])
  const allAnnotations = useMemo(() => Object.values(scopedAnnotationsByPage).flat(), [scopedAnnotationsByPage])
  const cardList = useMemo(() => Object.values(cardsById), [cardsById])
  const titleLinkIndex = useMemo(
    () => (titleLinkEnabled ? buildTitleLinkIndex(cardList) : null),
    [cardList, titleLinkEnabled],
  )
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

  /** 当前标注对应的挖空练习；同一张卡只解析一次，输入过程中不重建段。 */
  const clozeExcerpt = selectedAnnotation
    ? (selectedCard?.excerpt ?? excerpts[selectedAnnotation.card_id] ?? '')
    : ''
  const clozeExercise = useMemo(() => {
    if (!clozeEnabled || !selectedAnnotation) return null
    const cache = clozeCacheRef.current
    const cached = cache.get(selectedAnnotation.card_id)
    if (cached && cached.excerpt === clozeExcerpt && cached.turn === clozeTurn) return cached.exercise
    const exercise = buildCloze(clozeExcerpt, { turn: clozeTurn })
    cache.set(selectedAnnotation.card_id, { excerpt: clozeExcerpt, turn: clozeTurn, exercise })
    return exercise
  }, [clozeEnabled, clozeExcerpt, selectedAnnotation, clozeTurn])
  const clozeCardId = selectedAnnotation?.card_id ?? ''
  const clozeAnswerList = clozeCardId ? (clozeAnswers[clozeCardId] ?? []) : []
  const clozeResult = clozeCardId ? (clozeResults[clozeCardId] ?? null) : null

  const toggleCloze = () => {
    setClozeEnabled((previous) => {
      const next = !previous
      saveClozePreference(next)
      return next
    })
    setClozeAnswers({})
    setClozeResults({})
    setClozeTurn(bumpClozeTurn())
    setNotice(clozeEnabled ? '已关闭挖空，遮挡块回到「点击揭示」。' : '已开启挖空：补全关键词后自动揭示原文。')
  }

  const handleClozeAnswer = (cardId: string, index: number, value: string) => {
    setClozeAnswers((previous) => {
      const list = [...(previous[cardId] ?? [])]
      list[index] = value
      return { ...previous, [cardId]: list }
    })
    // 改了输入就清掉上一次判定，否则旧绿/红框会贴在刚改过的文字上。
    setClozeResults((previous) => (previous[cardId] ? { ...previous, [cardId]: null } : previous))
  }

  const handleClozeCheck = () => {
    if (!selectedAnnotation || !clozeExercise) return
    const cardId = selectedAnnotation.card_id
    const answers = clozeAnswers[cardId] ?? []
    const result = checkCloze(clozeExercise, clozeExercise.blanks.map((_, index) => answers[index] ?? ''))
    setClozeResults((previous) => ({ ...previous, [cardId]: result }))
    if (result.solved) {
      handleReveal([selectedAnnotation.id])
      setNotice(`挖空 ${result.total}/${result.total} 全部补齐，已揭示原文，可以评分了。`)
    } else {
      setNotice(`挖空 ${result.correct}/${result.total} 空命中。`)
    }
  }

  const handleClozeRetry = () => {
    if (!clozeCardId) return
    setClozeAnswers((previous) => ({ ...previous, [clozeCardId]: [] }))
    setClozeResults((previous) => ({ ...previous, [clozeCardId]: null }))
  }

  const handleClozeReveal = () => {
    if (!selectedAnnotation) return
    handleReveal([selectedAnnotation.id])
  }

  /** 切换两遍阅读的阶段；失败就退回原阶段，不留下半套状态。 */
  const changePass = async (pass: 1 | 2) => {
    if (readingBusy || readingPass === pass) return
    const previous = readingPass
    setReadingPassState(pass)
    setReadingBusy(true)
    setOperationError('')
    try {
      const state = await setReadingPass(document.id, pass)
      setReadingPassState(state.pass === 2 ? 2 : 1)
      setRecallNote(state.recallNote)
      if (pass === 1) {
        setTool('highlight')
        setNotice('回到粗读：先把地图建起来，别急着做细节。')
      } else {
        setNotice('进入精读：只读核心章，边读边批注、复述、做卡。')
      }
    } catch (reason) {
      setReadingPassState(previous)
      setOperationError(`切换阅读阶段失败：${errorMessage(reason)}`)
    } finally {
      setReadingBusy(false)
    }
  }

  const openRecall = () => {
    setRecallDraft(recallNote || RECALL_TEMPLATE)
    setRecallOpen(true)
  }

  const submitRecall = async () => {
    if (readingBusy) return
    setReadingBusy(true)
    setOperationError('')
    try {
      const state = await saveRecallNote(document.id, recallDraft)
      setRecallNote(state.recallNote)
      setRecallOpen(false)
      if (firstPass) {
        const next = await setReadingPass(document.id, 2)
        setReadingPassState(next.pass === 2 ? 2 : 1)
        setNotice('已记下粗读的三句话与清单，开始精读：先读清单里的核心章。')
      } else {
        setNotice('召回笔记已保存。')
      }
    } catch (reason) {
      setOperationError(`保存召回笔记失败：${errorMessage(reason)}`)
    } finally {
      setReadingBusy(false)
    }
  }

  /**
   * 把一批目录条目落成骨架：已有骨架只补缺的（增量），没有就全量建。
   * 父先子后建卡，写完映射就通知脑图刷新；已有卡片一律不动，删节只从映射掉出。
   */
  const applySkeleton = async (entries: TocEntry[]) => {
    const existing = tocMap[activeCanvasId] ?? []
    const plan = planSkeletonMerge(existing, entries)
    if (plan.items.length === 0) {
      setNotice('目录里没有可建的小节。')
      return
    }
    const planCardIds: Array<string | undefined> = []
    const saved: TocSkeletonEntry[] = []
    for (const item of plan.items) {
      let cardId = item.cardId
      if (item.action === 'create') {
        const parentId = item.parentIndex === null ? undefined : planCardIds[item.parentIndex]
        const card = await createCard({
          canvas_id: activeCanvasId,
          question: item.title,
          parent_id: parentId,
          sort_order: item.index,
          // 不给 x/y：留 (0,0) 占位，让脑图工作区跑 buildTreeLayout 排成正常的左右树。
          source_ref: {
            document_id: document.id,
            page: item.page,
            bbox: { x: 0.08, y: 0.08, width: 0.04, height: 0.02 },
          },
        })
        cardId = card.id
      }
      planCardIds[item.index] = cardId
      saved.push({ cardId: cardId as string, page: item.page, title: item.title, level: item.level })
    }
    const nextMap = { ...tocMap, [activeCanvasId]: saved }
    setTocMap(nextMap)
    await saveTocJson(document.id, JSON.stringify(nextMap))
    notifyMindmapChanged(activeCanvasId)

    if (existing.length === 0) {
      setNotice(`已按目录建了 ${saved.length} 个骨架节点；之后新建的卡片会自动挂到最近的小节。`)
      return
    }
    const parts: string[] = []
    if (plan.created > 0) parts.push(`新增 ${plan.created} 节`)
    if (plan.kept > 0) parts.push(`保留 ${plan.kept} 节`)
    if (plan.dropped.length > 0) parts.push(`${plan.dropped.length} 节不在新目录里（卡片保留）`)
    if (plan.created === 0) {
      setNotice(parts.length ? `目录没有新增小节：${parts.join('，')}。` : '目录没有可建的小节。')
    } else {
      setNotice(`${parts.join('，')}；画布已按新骨架重排，之后新建的卡片会自动挂到最近的小节。`)
    }
  }

  /** 按 PDF 内置书签建/更新骨架；没有书签就转到「粘贴目录」，不硬造节点。 */
  const buildTocSkeleton = async () => {
    if (!pdf || tocBuilding) return
    setTocBuilding(true)
    setOperationError('')
    try {
      const entries = await readPdfOutline(pdf, { maxDepth: 2, maxEntries: 120 })
      if (entries.length === 0) {
        setTocPasteOpen(true)
        setOperationError('这个 PDF 没有内置书签；把目录复制粘贴进来，一样能建骨架。')
        return
      }
      await applySkeleton(entries)
    } catch (reason) {
      setOperationError(`按目录建骨架失败：${errorMessage(reason)}`)
    } finally {
      setTocBuilding(false)
    }
  }

  /** 粘贴目录：解析成条目后走同一条建骨架路径。 */
  const buildTocFromPaste = async () => {
    if (tocBuilding) return
    const { entries } = parseTocText(tocPasteDraft, { maxEntries: 200 })
    if (entries.length === 0) {
      setOperationError('没认出目录：一行一条，标题和页码之间用点线、Tab 或空格分隔。')
      return
    }
    setTocBuilding(true)
    setOperationError('')
    try {
      setTocPasteOpen(false)
      await applySkeleton(entries)
      setTocPasteDraft('')
    } catch (reason) {
      setOperationError(`按目录建骨架失败：${errorMessage(reason)}`)
    } finally {
      setTocBuilding(false)
    }
  }

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

  /** 标题链接开关：偏好写入 localStorage，下次打开文档保持。 */
  const toggleTitleLink = useCallback(() => {
    setTitleLinkEnabled((previous) => {
      const next = !previous
      try {
        window.localStorage.setItem(TITLE_LINK_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // 隐私模式下 localStorage 不可用，仅本次会话生效。
      }
      return next
    })
  }, [])

  const pageNumbers = useMemo(() => Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1), [pageCount])
  const visibleAnnotationCount = [...visiblePages].reduce((count, page) => count + (scopedAnnotationsByPage[page]?.length ?? 0), 0)
  const largeDocument = document.file_size > 200 * 1024 * 1024
  const loadingMessage = document.file_status === 'importing' ? '文档正在导入，请稍候…' : largeDocument ? '正在按需读取大型 PDF…' : '正在打开 PDF 文档…'

  /** 粘贴框的实时预览：认不出页码的行要当场告诉用户，而不是建完才发现少了几条。 */
  const tocPastePreview = useMemo(() => parseTocText(tocPasteDraft, { maxEntries: 200 }), [tocPasteDraft])
  const tocPasteLevels = useMemo(() => {
    const root = tocPastePreview.entries.filter((entry) => entry.level === 0).length
    return { root, child: tocPastePreview.entries.length - root }
  }, [tocPastePreview])

  /** 阶段条：非嵌入模式贴在工具栏下方，嵌入模式浮在 PDF 左上角。 */
  const passBar = (
    <div className={`pdf-pass-bar${embedded ? ' is-floating' : ''}`} data-pass-bar data-pass={readingPass}>
      <button
        type="button"
        className="pdf-pass-chip"
        data-testid="pdf-pass-chip"
        onClick={() => void changePass(readingPass === 1 ? 2 : 1)}
        disabled={readingBusy || !pdf}
        title="粗读建地图，精读挖重点；点击切换"
      >
        <span className="pdf-pass-index">{readingPass}</span>
        {readingPass === 1 ? '粗读 · 建地图' : '精读 · 挖重点'}
      </button>
      {firstPass ? (
        <>
          <span className="pdf-pass-hint">先建地图：目录、序言、首尾段、图表</span>
          <button type="button" className="pdf-pass-action" data-testid="pdf-pass-finish" onClick={openRecall} disabled={readingBusy || !pdf}>
            粗读完成
          </button>
        </>
      ) : (
        <>
          <button type="button" className="pdf-pass-action" data-testid="toc-skeleton" onClick={() => void buildTocSkeleton()} disabled={!pdf || tocBuilding}>
            {tocBuilding ? '正在更新…' : (tocMap[activeCanvasId]?.length ? '更新目录骨架' : '按目录建骨架')}
          </button>
          <button
            type="button"
            className="pdf-pass-action"
            data-testid="toc-paste-open"
            onClick={() => {
              setOperationError('')
              setTocPasteOpen(true)
            }}
            disabled={!pdf || tocBuilding}
            title="没有书签的扫描书：把目录页的文字复制进来"
          >
            粘贴目录
          </button>
          <button type="button" className="pdf-pass-action" data-testid="pdf-pass-note" onClick={openRecall} disabled={readingBusy}>
            {recallNote ? '看粗读笔记' : '补写三句话'}
          </button>
        </>
      )}
    </div>
  )

  /** PDF 页右键菜单把工作区级动作上抛，这里统一分发到已有的工具与对话框。 */
  function handleContextAction(action: PdfContextAction) {
    switch (action.type) {
      case 'tool':
        if (firstPass && action.tool !== 'select' && action.tool !== 'highlight') {
          setNotice('粗读只标关键词；框选、墨迹、文字到精读再用。')
          break
        }
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
      case 'title-link-toggle':
        toggleTitleLink()
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
          <button type="button" className={tool === 'rectangle' ? 'is-active' : ''} aria-pressed={tool === 'rectangle'} onClick={() => setTool('rectangle')} disabled={recallMode || firstPass} title={firstPass ? '粗读只标关键词，精读再框选' : undefined}>矩形</button>
          <button type="button" className={tool === 'text' ? 'is-active' : ''} aria-pressed={tool === 'text'} onClick={() => setTool('text')} disabled={recallMode || firstPass} title={firstPass ? '粗读只标关键词，精读再拖选文字' : undefined}>文字</button>
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

        <button type="button" className={`pdf-titlelink-toggle ${titleLinkEnabled ? 'is-active' : ''}`} aria-pressed={titleLinkEnabled} onClick={toggleTitleLink} title="标题链接：阅读时自动高亮你过去建过的卡片标题与别名，点击可回看">
          <BookOpen size={14} />
          标题链接
        </button>

        <button
          type="button"
          className="pdf-digest-toggle"
          onClick={() => setDigestOpen(true)}
          disabled={!pdf || pageCount === 0 || firstPass}
          title={firstPass ? '粗读先读完；精读再按目录或 AI 搭骨架' : 'AI 拆书：分块抽取要点，生成问题驱动的脑图骨架'}
        >
          <Sparkles size={14} />
          AI 拆书
        </button>

        <button type="button" className={`pdf-recall-toggle ${recallMode ? 'is-active' : ''}`} aria-pressed={recallMode} onClick={toggleRecall} disabled={!pdf}>
          {recallMode ? '退出回忆' : '文档回忆'}
        </button>

        {recallMode && (
          <button
            type="button"
            className={`pdf-cloze-toggle ${clozeEnabled ? 'is-active' : ''}`}
            aria-pressed={clozeEnabled}
            onClick={toggleCloze}
            title="挖空填空：只留关键词的空，补全后自动揭示原文再评分"
            data-cloze-toggle
          >
            挖空
          </button>
        )}
      </header>
      )}

      {!embedded && passBar}

      {(operationError || notice || creating || ocrMessage) && (
        <div className={`pdf-operation-bar${embedded ? ' is-floating' : ''} ${operationError ? 'is-error' : ''}`} role={operationError ? 'alert' : 'status'}>
          <span>{operationError || ocrMessage || (creating ? '正在创建卡片与标注…' : notice)}</span>
          {formulaRetry && operationError && !creating && (
            <button
              type="button"
              className="pdf-operation-action is-primary"
              onClick={() => void retryFormulaRecognition()}
              disabled={retrying}
            >
              {retrying ? '重试中…' : '重试'}
            </button>
          )}
          {operationDetail && (
            <button
              type="button"
              className="pdf-operation-action"
              aria-expanded={detailOpen}
              onClick={() => setDetailOpen((open) => !open)}
            >
              {detailOpen ? '收起详情' : '查看详情'}
            </button>
          )}
          {(operationError || notice) && <button type="button" onClick={clearOperation} aria-label="关闭提示">×</button>}
        </div>
      )}

      {detailOpen && operationDetail && (
        <div className={`pdf-operation-detail${embedded ? ' is-floating' : ''}`} role="region" aria-label="识别失败详情">
          <pre>{operationDetail}</pre>
          <div className="pdf-operation-detail-actions">
            <button type="button" onClick={() => void copyDetail()}>{detailCopied ? '已复制' : '复制详情'}</button>
            <button type="button" onClick={() => setDetailOpen(false)}>收起</button>
          </div>
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
                  annotations={scopedAnnotationsByPage[pageNumber] ?? EMPTY_ANNOTATIONS}
                  inks={inksByPage[pageNumber] ?? EMPTY_INKS}
                  inkColor={inkColor}
                  inkWidth={inkWidth}
                  eraserSize={eraserSize}
                  onEraseInks={(ids) => void handleEraseInks(ids)}
                  inkErase={inkErase}
                  onInk={(bbox, points) => void handleInk(pageNumber, bbox, points)}
                  onEraseInk={(id) => void handleEraseInk(id)}
                  excerpts={excerpts}
                  tool={tool}
                  recallMode={recallMode}
                  clozeMode={recallMode && clozeEnabled}
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
                  notes={notesByPage[pageNumber] ?? EMPTY_NOTES}
                  onNoteCreate={(anchorY) => void handleNoteCreate(pageNumber, anchorY)}
                  onNoteSave={(id, content) => void handleNoteSave(id, content)}
                  onNoteToggle={(id, collapsed) => void handleNoteToggle(id, collapsed)}
                  onNoteDelete={(id) => void handleNoteDelete(id)}
                  titleLinkIndex={titleLinkIndex}
                  onTitleLink={setTitleLinkPreview}
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
              {/* 挖空未完成前不显示整段摘录，否则等于直接给答案。 */}
              {(!recallMode || !clozeEnabled || revealedCardIds.has(selectedAnnotation.card_id)) && (
                <blockquote>{selectedCard?.excerpt || excerpts[selectedAnnotation.card_id] || '此标注没有文字摘录。'}</blockquote>
              )}
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
                ) : clozeEnabled && clozeExercise ? (
                  <ClozePanel
                    exercise={clozeExercise}
                    answers={clozeAnswerList}
                    result={clozeResult}
                    onAnswerChange={(index, value) => handleClozeAnswer(selectedAnnotation.card_id, index, value)}
                    onCheck={handleClozeCheck}
                    onRetry={handleClozeRetry}
                    onReveal={handleClozeReveal}
                    onDisable={toggleCloze}
                  />
                ) : <p className="pdf-inspector-hint">点击页面上的遮挡块后再评分。</p>
              ) : (
                <button type="button" className="pdf-delete-button" onClick={() => setDeleteTarget(selectedAnnotation)}>删除标注</button>
              )}
            </div>
          ) : (
            <div className="pdf-inspector-empty">
              <span className="pdf-inspector-symbol">{recallMode ? '?' : '“”'}</span>
              <strong>{recallMode ? (clozeEnabled ? '点遮挡块挖空' : '先回忆，再揭示') : '选择一条标注'}</strong>
              <p>{recallMode ? (clozeEnabled ? '遮挡块盖住了关键内容。点开后补全空，答对会自动揭示原文并进入评分。' : '遮挡块已覆盖当前标注。点击揭示摘录，然后完成一次评分。') : tool === 'text' ? '像 Word 一样拖选文字，选中后可复制或直接建卡。' : tool === 'select' ? '点击标注查看摘录，或拖拽调整位置。' : '在页面上按下并拖拽，创建一条新标注。'}</p>
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
          {passBar}

          {recallMode && clozeEnabled && selectedAnnotation && !revealedCardIds.has(selectedAnnotation.card_id) && clozeExercise && (
            <div className="pdf-cloze-float" data-cloze-float>
              <ClozePanel
                floating
                exercise={clozeExercise}
                answers={clozeAnswerList}
                result={clozeResult}
                onAnswerChange={(index, value) => handleClozeAnswer(selectedAnnotation.card_id, index, value)}
                onCheck={handleClozeCheck}
                onRetry={handleClozeRetry}
                onReveal={handleClozeReveal}
                onDisable={toggleCloze}
              />
            </div>
          )}

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
            <button type="button" className={tool === 'text' ? 'is-active' : ''} onClick={() => setTool('text')} disabled={recallMode || firstPass} aria-pressed={tool === 'text'} title={firstPass ? '粗读只标关键词，精读再拖选文字' : '文字选择：像 Word 一样拖选文字，可复制或建卡'}><Type size={17} /><span>文字</span></button>
            <button type="button" className={tool === 'highlight' ? 'is-active' : ''} onClick={() => setTool('highlight')} disabled={recallMode} aria-pressed={tool === 'highlight'} title="高亮颜色"><Highlighter size={17} /><span>颜色</span></button>
            <button type="button" onClick={() => { if (selectedAnnotation) setTagTarget(selectedAnnotation.card_id) }} disabled={!selectedAnnotation} title="给选中标注的卡片加标签"><Tag size={17} /><span>标签</span></button>
            <button type="button" onClick={() => { if (selectedAnnotation) setLinkTarget(selectedAnnotation.card_id) }} disabled={!selectedAnnotation} title="把选中卡片关联到其他卡片"><Link2 size={17} /><span>链接</span></button>
            <button type="button" className={tool === 'rectangle' ? 'is-active' : ''} onClick={() => setTool('rectangle')} disabled={recallMode || firstPass} aria-pressed={tool === 'rectangle'} title={firstPass ? '粗读只标关键词，精读再框选' : '矩形框选'}><Square size={17} /><span>框架</span></button>
            <button type="button" className={tool === 'ink' ? 'is-active' : ''} onClick={() => { setTool(tool === 'ink' ? 'select' : 'ink'); setInkErase(false) }} disabled={firstPass} aria-pressed={tool === 'ink'} title={firstPass ? '粗读只标关键词，精读再手写' : '手写墨迹'}><PenLine size={17} /><span>墨迹</span></button>
            <button type="button" onClick={() => setMergeOpen(true)} disabled={cardList.length < 2} title="合并多张卡片"><Merge size={17} /><span>合并</span></button>
            {recallMode && (
              <button type="button" className={clozeEnabled ? 'is-active' : ''} onClick={toggleCloze} aria-pressed={clozeEnabled} title="挖空填空：补全关键词后自动揭示原文" data-cloze-toggle>
                <TextCursorInput size={17} /><span>挖空</span>
              </button>
            )}
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
              <SizeControl kind="pen" label="笔宽" value={inkWidth} onChange={changeInkWidth} />
              <button
                type="button"
                className={inkErase ? 'is-active' : ''}
                onClick={() => setInkErase((value) => !value)}
                title="橡皮：擦掉不想要的墨迹；选中后可浮动拖动半径，按住可连擦"
              >
                橡皮
              </button>
              {/* 半径滑杆浮在墨迹小菜单上方：最小值是「小」，最大值是「特大」。 */}
              {inkErase && (
                <SizeControl kind="eraser" label="橡皮半径" value={eraserSize} onChange={changeEraserSize} />
              )}
              <button type="button" onClick={() => { setTool('select'); setInkErase(false) }}>完成</button>
            </div>
          )}

          {dockMenuOpen && (
            <div className="pdf-dock-menu" role="dialog" aria-label="缩放与跳页">
              <button type="button" className="pdf-dock-menu-wide is-highlight" onClick={() => { setDigestOpen(true); setDockMenuOpen(false) }}>AI 拆书</button>
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
              <button
                type="button"
                className={`pdf-dock-menu-wide ${titleLinkEnabled ? 'is-active' : ''}`}
                aria-pressed={titleLinkEnabled}
                onClick={() => { toggleTitleLink(); setDockMenuOpen(false) }}
              >
                {titleLinkEnabled ? '关闭标题链接' : '开启标题链接'}
              </button>
            </div>
          )}
        </>
      )}

      {titleLinkPreview && (
        <TitleLinkPopover
          keyword={titleLinkPreview.keyword}
          cards={titleLinkPreview.cardIds.map((id) => cardsById[id]).filter(Boolean)}
          currentDocumentId={document.id}
          onJump={goToPage}
          onClose={() => setTitleLinkPreview(null)}
        />
      )}

      {digestOpen && (
        <BookDigestDialog
          documentId={document.id}
          documentTitle={document.title}
          pageCount={pageCount}
          currentPage={currentPage}
          getPageText={collectPageText}
          onClose={() => setDigestOpen(false)}
          onApplied={() => {
            void loadCards()
            callbacksRef.current.onCardsChanged()
          }}
        />
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

      {tocPasteOpen && (
        <div className="pdf-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !tocBuilding) setTocPasteOpen(false)
        }}>
          <div className="pdf-modal pdf-toc-modal" role="dialog" aria-modal="true" aria-labelledby="pdf-toc-title" data-testid="toc-paste-modal">
            <small>CLOSE READING · SKELETON</small>
            <h2 id="pdf-toc-title">粘贴目录建骨架</h2>
            <p className="pdf-recall-tip">
              从目录页或出版社网站复制过来，一行一条；标题和页码之间用点线、Tab 或空格分开都行。
              只建前两级、最多 200 条，认不出页码的行会列在下面。
            </p>
            <textarea
              data-testid="toc-paste-input"
              value={tocPasteDraft}
              onChange={(event) => setTocPasteDraft(event.target.value)}
              rows={10}
              placeholder={'第一章 绪论 ........ 1\n1.1 研究背景 ........ 3\n1.2 研究问题 ........ 6'}
              disabled={tocBuilding}
              autoFocus
            />
            <p className="pdf-toc-preview" data-testid="toc-paste-preview">
              {tocPasteDraft.trim()
                ? `识别到 ${tocPastePreview.entries.length} 条（一级 ${tocPasteLevels.root} / 二级 ${tocPasteLevels.child}）${tocPastePreview.skipped.length ? `，${tocPastePreview.skipped.length} 行没认出页码` : ''}`
                : '把目录粘进来，这里会显示识别结果。'}
            </p>
            {tocPastePreview.skipped.length > 0 && (
              <ul className="pdf-toc-skipped" data-testid="toc-paste-skipped">
                {tocPastePreview.skipped.slice(0, 4).map((line, index) => (
                  <li key={`${index}-${line.slice(0, 8)}`}>{line}</li>
                ))}
                {tocPastePreview.skipped.length > 4 && <li>…还有 {tocPastePreview.skipped.length - 4} 行</li>}
              </ul>
            )}
            <div className="pdf-modal-actions">
              <button type="button" onClick={() => setTocPasteOpen(false)} disabled={tocBuilding}>取消</button>
              <button
                type="button"
                className="is-primary"
                data-testid="toc-paste-build"
                onClick={() => void buildTocFromPaste()}
                disabled={tocBuilding || tocPastePreview.entries.length === 0}
              >
                {tocBuilding ? '正在建…' : `建 ${tocPastePreview.entries.length} 个骨架`}
              </button>
            </div>
          </div>
        </div>
      )}

      {recallOpen && (
        <div className="pdf-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !readingBusy) setRecallOpen(false)
        }}>
          <div className="pdf-modal pdf-recall-modal" role="dialog" aria-modal="true" aria-labelledby="pdf-recall-title" data-testid="pdf-recall-modal">
            <small>{firstPass ? 'ROUGH READ · MAP' : 'ROUGH READ · NOTE'}</small>
            <h2 id="pdf-recall-title">{firstPass ? '粗读收尾：写下三句话' : '粗读时写下的三句话'}</h2>
            <p className="pdf-recall-tip">
              {firstPass
                ? '不要翻书。这本书讲什么、作者怎么论证、和你有什么关系；再列 3–5 个最值得精读的章节。'
                : '这是粗读时留下的地图与清单，精读时对照着走；读完再回来补上答案。'}
            </p>
            <textarea
              data-testid="pdf-recall-input"
              value={recallDraft}
              onChange={(event) => setRecallDraft(event.target.value)}
              rows={6}
              placeholder={RECALL_TEMPLATE}
              disabled={readingBusy}
              autoFocus
            />
            <div className="pdf-modal-actions">
              <button type="button" onClick={() => setRecallOpen(false)} disabled={readingBusy}>稍后</button>
              <button type="button" className="is-primary" data-testid="pdf-recall-save" onClick={() => void submitRecall()} disabled={readingBusy}>
                {readingBusy ? '保存中…' : firstPass ? '保存并开始精读' : '保存笔记'}
              </button>
            </div>
          </div>
        </div>
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
