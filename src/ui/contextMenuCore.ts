import { useCallback, useState } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: LucideIcon
  /** 右侧提示，例如快捷键或状态。 */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** 标记为当前生效的选项，右侧显示对勾。 */
  checked?: boolean
  onSelect: () => void
}

export interface ContextMenuSection {
  id: string
  title?: string
  items: ContextMenuItem[]
}

export interface ContextMenuState {
  x: number
  y: number
  title?: string
  sections: ContextMenuSection[]
}

export type ContextMenuContent = Omit<ContextMenuState, 'x' | 'y'>

/** 只需要坐标与取消默认行为的事件对象；React 与原生事件都兼容。 */
export interface MenuAnchor {
  clientX: number
  clientY: number
  target?: EventTarget | null
  preventDefault?: () => void
  stopPropagation?: () => void
}

/** 输入框、文本域等保留系统原生菜单（复制/粘贴/拼写），不弹应用菜单。 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const show = useCallback((event: MenuAnchor, content: ContextMenuContent) => {
    if (isEditableTarget(event.target)) return
    event.preventDefault?.()
    // 阻止冒泡到 App 的兜底菜单，让最具体的元素菜单生效。
    event.stopPropagation?.()
    setMenu({ x: event.clientX, y: event.clientY, ...content })
  }, [])
  const close = useCallback(() => setMenu(null), [])
  return { menu, show, close }
}

/** 接管 WKWebView 原生右键菜单（通常只有 Reload），输入框仍保留系统菜单。 */
export function installNativeContextMenuGuard(): void {
  window.addEventListener('contextmenu', (event) => {
    if (isEditableTarget(event.target)) return
    event.preventDefault()
  }, { capture: true })
}
