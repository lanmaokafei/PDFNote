/** 当前选中的画布按「文档」分别记住；独立脑图视图用全局 key。 */
export const DEFAULT_CANVAS_ID = 'main'
const STORAGE_KEY = 'pdfnote.mindmap.canvas'

export function canvasPreferenceKey(documentId?: string | null): string {
  return documentId ? `${STORAGE_KEY}.${documentId}` : STORAGE_KEY
}

export function readCanvasId(documentId?: string | null): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CANVAS_ID
    const value = localStorage.getItem(canvasPreferenceKey(documentId))
    return value && value.trim() ? value : DEFAULT_CANVAS_ID
  } catch {
    return DEFAULT_CANVAS_ID
  }
}

export function saveCanvasId(documentId: string | null | undefined, canvasId: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(canvasPreferenceKey(documentId), canvasId.trim() || DEFAULT_CANVAS_ID)
  } catch {
    // 隐私模式下 localStorage 不可用，切换仍然在本会话生效。
  }
}

/** 画布下拉里显示的归属说明。 */
export function canvasScopeLabel(documentId: string | null | undefined): string {
  return documentId ? '本书' : '全局'
}

/** 其他工作区（PDF 建卡、AI 拆书、Anki 导入）写入卡片后通知脑图重新读取画布成员。 */
export const MINDMAP_CHANGED_EVENT = 'pdfnote:mindmap-changed'

export function notifyMindmapChanged(canvasId?: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(MINDMAP_CHANGED_EVENT, { detail: { canvasId } }))
}
