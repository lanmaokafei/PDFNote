import { useCallback, useRef, useState } from 'react'
import type { Document } from '../../domain/card'
import { MindmapWorkspace } from '../mindmap/MindmapWorkspace'
import { PdfWorkspace } from '../pdf/PdfWorkspace'
import './StudyWorkspace.css'

interface StudyWorkspaceProps {
  document: Document
  showMindmap: boolean
  jumpTarget?: { documentId: string; page: number; token: number } | null
  onJumpHandled?: () => void
  onPageCount: (count: number) => void
  onCardsChanged: () => void
  /** 固定画布：粗读精读工作区把 PDF 标注与脑图都钉在专属画布上。 */
  canvasId?: string
  /** 粗读精读模式：只有这个模块显示阶段条与骨架入口。 */
  closeReading?: boolean
}

const MIN_RATIO = 32
const MAX_RATIO = 74

/** 左文档、右脑图的同屏工作区；两栏共享同一份 Card 数据。 */
export function StudyWorkspace({
  document,
  showMindmap,
  jumpTarget,
  onJumpHandled,
  onPageCount,
  onCardsChanged,
  canvasId,
  closeReading = false,
}: StudyWorkspaceProps) {
  const [ratio, setRatio] = useState(54)
  // 文档回忆时右侧脑图整栏遮住：卡片标题和摘录都摆在那儿等于把答案摊开。
  const [recallActive, setRecallActive] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0) return
    const next = ((event.clientX - bounds.left) / bounds.width) * 100
    setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)))
  }, [])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <div className={`study-workspace${showMindmap ? '' : ' is-pdf-only'}`} ref={containerRef}>
      <div
        className="study-pane is-pdf"
        style={showMindmap ? { flexBasis: `${ratio}%` } : { flexBasis: '100%' }}
      >
        <PdfWorkspace
          document={document}
          embedded
          closeReading={closeReading}
          canvasId={canvasId}
          jumpTarget={jumpTarget}
          onJumpHandled={onJumpHandled}
          onPageCount={onPageCount}
          onCardsChanged={onCardsChanged}
          onRecallChange={setRecallActive}
        />
      </div>

      {showMindmap && (
        <>
          <div
            className="study-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文档与脑图宽度"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <span aria-hidden="true" />
          </div>
          <div className={`study-pane is-mindmap${recallActive ? ' is-recall-masked' : ''}`}>
            <MindmapWorkspace
              compact
              documentId={document.id}
              documentTitle={document.title}
              fixedCanvasId={canvasId ?? null}
              onCardsChanged={onCardsChanged}
            />
            {recallActive && (
              <div className="study-recall-mask" role="status" data-testid="study-recall-mask">
                <strong>文档回忆中</strong>
                <p>脑图已遮住，避免直接看到卡片答案。要对照脑图请先退出回忆。</p>
                <button
                  type="button"
                  data-testid="study-recall-mask-exit"
                  onClick={() => window.dispatchEvent(new Event('pdfnote:stop-recall'))}
                >
                  退出回忆
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
