/** 当前选中的画布按「文档」分别记住；独立脑图视图用全局 key。 */
export const DEFAULT_CANVAS_ID = 'main'
const STORAGE_KEY = 'pdfnote.mindmap.canvas'

export function canvasPreferenceKey(documentId?: string | null): string {
  return documentId ? `${STORAGE_KEY}.${documentId}` : STORAGE_KEY
}

/**
 * 原始偏好值；没选过返回 null。
 * 用来区分「用户主动选了全局画布」和「从来没打开过这本书」——
 * 后者才应该自动补一张本书专属画布。
 */
export function readCanvasPreference(documentId?: string | null): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const value = localStorage.getItem(canvasPreferenceKey(documentId))
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

export function readCanvasId(documentId?: string | null): string {
  return readCanvasPreference(documentId) ?? DEFAULT_CANVAS_ID
}

/** 文档专属画布的默认名字：与后端导入时的命名保持一致（最长 60 字）。 */
export function documentCanvasName(title?: string | null): string {
  const value = (title ?? '').trim()
  if (!value) return '本书脑图'
  return Array.from(value).slice(0, 60).join('')
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
