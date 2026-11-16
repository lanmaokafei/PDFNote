import { useEffect, useRef } from 'react'
import { addReadingTime } from '../../services/pdfnote'
import { localDayKey } from './readingStats'

/** 每隔多久把累计时长写一次库（同时也在切换文档、页面隐藏、卸载时 flush）。 */
const FLUSH_SECONDS = 15
/** 单次 tick 最多认 60 秒：休眠唤醒后的巨大间隔不算阅读。 */
const MAX_TICK_SECONDS = 60

/**
 * 阅读计时：文档打开且页面可见时累计秒数，定期落库。
 *
 * 只在 PDF 工作区调用；写库失败会把时长退回待提交，下一次一起补。
 */
export function useReadingTimer(documentId: string | null, enabled: boolean): void {
  const pendingRef = useRef(0)

  useEffect(() => {
    if (!documentId || !enabled) return
    const id = documentId
    let last = Date.now()

    const tick = () => {
      const current = Date.now()
      const delta = (current - last) / 1000
      last = current
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (delta > 0 && delta <= MAX_TICK_SECONDS) pendingRef.current += delta
    }

    const flush = () => {
      const seconds = Math.floor(pendingRef.current)
      if (seconds < 1) return
      pendingRef.current -= seconds
      void addReadingTime(id, localDayKey(new Date()), seconds).catch(() => {
        // 写失败退回待提交，下次一起补；不打断阅读。
        pendingRef.current += seconds
      })
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        tick()
        flush()
      } else {
        last = Date.now()
      }
    }
    const onUnload = () => {
      tick()
      flush()
    }

    const ticker = window.setInterval(tick, 1000)
    const flusher = window.setInterval(flush, FLUSH_SECONDS * 1000)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.clearInterval(ticker)
      window.clearInterval(flusher)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onUnload)
      tick()
      flush()
    }
  }, [documentId, enabled])
}
