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
}: StudyWorkspaceProps) {
  const [ratio, setRatio] = useState(54)
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
          jumpTarget={jumpTarget}
          onJumpHandled={onJumpHandled}
          onPageCount={onPageCount}
          onCardsChanged={onCardsChanged}
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
          <div className="study-pane is-mindmap">
            <MindmapWorkspace compact onCardsChanged={onCardsChanged} />
          </div>
        </>
      )}
    </div>
  )
}
