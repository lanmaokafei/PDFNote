/**
 * 删除卡片的「可撤销」通知。
 *
 * 删除现在是软删除（进回收站），所以删完还能撤回。这里只负责广播
 * 「刚刚移除了哪些卡片」，撤销按钮与 ⌘Z 由 App 统一处理。
 */
export const CARD_TRASHED_EVENT = 'pdfnote:card-trashed'

export function notifyCardTrashed(ids: string[]): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CARD_TRASHED_EVENT, { detail: { ids } }))
}
