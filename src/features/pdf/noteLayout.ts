import { useEffect, useState } from 'react'

/**
 * 留白的两种排法：
 * - `overlay`：便签浮在页面右侧（默认，页边草稿的旧行为）；
 * - `gutter`：页面在正文下方长出一条留白区（纸面变长），便签排在区里，不遮挡正文。
 */
export type NoteLayout = 'overlay' | 'gutter'

export const NOTE_LAYOUT_KEY = 'pdfnote.pdf.noteLayout'
export const NOTE_LAYOUT_EVENT = 'pdfnote:note-layout'
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readNoteLayout(): NoteLayout {
  return storage()?.getItem(NOTE_LAYOUT_KEY) === 'gutter' ? 'gutter' : 'overlay'
}

export function writeNoteLayout(mode: NoteLayout): void {
  storage()?.setItem(NOTE_LAYOUT_KEY, mode)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<NoteLayout>(NOTE_LAYOUT_EVENT, { detail: mode }))
  }
}

/** 页面组件与工具栏共享同一份偏好：任何一处切换，所有页立刻跟着变。 */
export function useNoteLayout(): [NoteLayout, (mode: NoteLayout) => void] {
  const [mode, setMode] = useState<NoteLayout>(readNoteLayout)
  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<NoteLayout>).detail
      setMode(next === 'gutter' ? 'gutter' : 'overlay')
    }
    window.addEventListener(NOTE_LAYOUT_EVENT, handler)
    return () => window.removeEventListener(NOTE_LAYOUT_EVENT, handler)
  }, [])
  return [mode, writeNoteLayout]
}
