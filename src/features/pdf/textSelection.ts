import type { NormalizedBBox } from '../../domain/card'

export interface TextSelectionInfo {
  text: string
  bbox: NormalizedBBox
  left: number
  top: number
}

/**
 * Read the native DOM selection restricted to one page's text layer.
 * Exported so a right-click can re-read the current selection even when the
 * floating action bar has not been shown yet.
 */
export function readTextSelection(root: HTMLElement): TextSelectionInfo | null {
  const selection = window.getSelection()
  const text = selection?.toString().trim() ?? ''
  if (!text || !selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  // A cross-page selection belongs to a common ancestor above this page.
  if (!root.contains(range.commonAncestorContainer)) return null
  const rect = range.getBoundingClientRect()
  const pageRect = root.getBoundingClientRect()
  if (pageRect.width <= 0 || pageRect.height <= 0 || rect.width <= 0 || rect.height <= 0) return null
  const x = Math.min(1, Math.max(0, (rect.left - pageRect.left) / pageRect.width))
  const y = Math.min(1, Math.max(0, (rect.top - pageRect.top) / pageRect.height))
  const right = Math.min(1, Math.max(0, (rect.right - pageRect.left) / pageRect.width))
  const bottom = Math.min(1, Math.max(0, (rect.bottom - pageRect.top) / pageRect.height))
  return {
    text,
    bbox: {
      x,
      y,
      width: Math.max(0.002, right - x),
      height: Math.max(0.002, bottom - y),
    },
    left: Math.max(8, Math.min(pageRect.width - 180, rect.left - pageRect.left)),
    top: Math.min(pageRect.height - 44, rect.bottom - pageRect.top + 8),
  }
}
