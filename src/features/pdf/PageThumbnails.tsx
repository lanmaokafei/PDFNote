import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from './pdfjs'

interface PageThumbnailsProps {
  pdf: PDFDocumentProxy | null
  pageCount: number
  currentPage: number
  /** 点击缩略图：跳到该页。 */
  onSelect: (page: number) => void
  onClose: () => void
}

/**
 * 页面缩略图侧栏。
 *
 * 缩略图按可视区懒渲染：300 页的书也只画看得到的那几张，
 * 渲染好的 dataURL 缓存在内存里，滚回去不用重画。
 */
export function PageThumbnails({ pdf, pageCount, currentPage, onSelect, onClose }: PageThumbnailsProps) {
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const cacheRef = useRef<Map<number, string>>(new Map())
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const railRef = useRef<HTMLDivElement | null>(null)

  const renderThumb = useCallback((page: number) => {
    if (!pdf || cacheRef.current.has(page)) return
    // 串行渲染：和主视图共用 pdf.js worker，并发会让正在滚动的主页面卡顿。
    queueRef.current = queueRef.current.then(async () => {
      if (cacheRef.current.has(page)) return
      try {
        const target = await pdf.getPage(page)
        const base = target.getViewport({ scale: 1 })
        const scale = 104 / base.width
        const viewport = target.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) return
        await target.render({ canvas, canvasContext: context, viewport }).promise
        const url = canvas.toDataURL('image/jpeg', 0.72)
        cacheRef.current.set(page, url)
        setThumbs((current) => ({ ...current, [page]: url }))
        target.cleanup()
      } catch {
        // 单页失败不影响其它缩略图。
      }
    })
  }, [pdf])

  // 换文档：清空缓存。
  useEffect(() => {
    cacheRef.current = new Map()
    setThumbs({})
  }, [pdf])

  // 当前页出现在侧栏里时自动滚到可见位置。
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const active = rail.querySelector<HTMLElement>(`[data-thumb-page="${currentPage}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [currentPage])

  return (
    <aside className="pdf-thumbs" data-testid="pdf-thumbs" aria-label="页面缩略图">
      <header>
        <span>页面</span>
        <button type="button" onClick={onClose} aria-label="关闭缩略图侧栏" data-testid="pdf-thumbs-close">×</button>
      </header>
      <div className="pdf-thumbs-rail" ref={railRef}>
        {Array.from({ length: pageCount }, (_, index) => {
          const page = index + 1
          return (
            <Thumb
              key={page}
              page={page}
              url={thumbs[page]}
              active={page === currentPage}
              onVisible={renderThumb}
              onSelect={onSelect}
            />
          )
        })}
      </div>
    </aside>
  )
}

interface ThumbProps {
  page: number
  url?: string
  active: boolean
  onVisible: (page: number) => void
  onSelect: (page: number) => void
}

function Thumb({ page, url, active, onVisible, onSelect }: ThumbProps) {
  const ref = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element || url) return
    if (typeof IntersectionObserver === 'undefined') {
      onVisible(page)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(page)
        observer.disconnect()
      }
    }, { root: element.closest('.pdf-thumbs-rail'), rootMargin: '240px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onVisible, page, url])

  return (
    <button
      ref={ref}
      type="button"
      className={`pdf-thumb${active ? ' is-active' : ''}`}
      data-thumb-page={page}
      data-testid="pdf-thumb"
      aria-current={active}
      title={`第 ${page} 页`}
      onClick={() => onSelect(page)}
    >
      <span className="pdf-thumb-frame">
        {url ? <img src={url} alt={`第 ${page} 页缩略图`} loading="lazy" /> : <span className="pdf-thumb-skeleton" />}
      </span>
      <em>{page}</em>
    </button>
  )
}
