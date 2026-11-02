import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { clampMenuPosition, type MenuPosition } from './contextMenuPosition'
import type { ContextMenuState } from './contextMenuCore'
import './ContextMenu.css'

/**
 * 全局只允许一个菜单打开。分栏工作区里 PDF 与脑图各自持有菜单实例，
 * 新菜单出现时必须先关掉另一个，否则会出现两层浮层。
 */
let activeClose: (() => void) | null = null

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const onCloseRef = useRef(onClose)
  const rootRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<{ state: ContextMenuState; position: MenuPosition } | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const position = measured?.state === state ? measured.position : null
  const flatItems = useMemo(() => state?.sections.flatMap((section) => section.items) ?? [], [state])
  const itemOffsets = useMemo(
    () => state?.sections.map((_, sectionIndex) =>
      state.sections.slice(0, sectionIndex).reduce((total, section) => total + section.items.length, 0),
    ) ?? [],
    [state],
  )

  // 在其它 effect 之前同步回调，窗口事件触发时拿到的始终是最新值。
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!state) return
    const closeThis = () => onCloseRef.current()
    activeClose?.()
    activeClose = closeThis
    return () => {
      if (activeClose === closeThis) activeClose = null
    }
  }, [state])

  useEffect(() => {
    setActiveIndex(-1)
  }, [state])

  useLayoutEffect(() => {
    if (!state || position) return
    const element = rootRef.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    setMeasured({
      state,
      position: clampMenuPosition(
        state.x,
        state.y,
        bounds.width,
        bounds.height,
        window.innerWidth,
        window.innerHeight,
      ),
    })
  }, [state, position])

  useEffect(() => {
    if (!state) return
    const isInside = (target: EventTarget | null) =>
      Boolean(target instanceof Node && rootRef.current?.contains(target))
    const close = () => onCloseRef.current()
    const handlePointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) close()
    }
    const handleScroll = (event: Event) => {
      if (!isInside(event.target)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((current) => {
          if (flatItems.length === 0) return -1
          let next = current
          for (let attempt = 0; attempt < flatItems.length; attempt += 1) {
            next = (next + step + flatItems.length) % flatItems.length
            if (!flatItems[next].disabled) return next
          }
          return -1
        })
        return
      }
      if (event.key === 'Enter' && activeIndex >= 0) {
        const item = flatItems[activeIndex]
        if (item && !item.disabled) {
          event.preventDefault()
          close()
          item.onSelect()
        }
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [state, flatItems, activeIndex])

  if (!state || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={rootRef}
      className="context-menu"
      role="menu"
      aria-label={state.title || '上下文菜单'}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {state.title && <div className="context-menu-title" title={state.title}>{state.title}</div>}
      {state.sections.map((section, sectionIndex) => (
        <div className="context-menu-section" key={section.id} role="group" aria-label={section.title}>
          {sectionIndex > 0 && <div className="context-menu-divider" role="separator" />}
          {section.title && <div className="context-menu-section-title">{section.title}</div>}
          {section.items.map((item, itemIndex) => {
            const currentIndex = (itemOffsets[sectionIndex] ?? 0) + itemIndex
            const Icon = item.icon
            const className = [
              'context-menu-item',
              item.danger ? 'is-danger' : '',
              item.disabled ? 'is-disabled' : '',
              activeIndex === currentIndex ? 'is-active' : '',
            ].filter(Boolean).join(' ')
            return (
              <button
                key={item.id}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                className={className}
                disabled={item.disabled}
                onMouseEnter={() => setActiveIndex(currentIndex)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (item.disabled) return
                  onCloseRef.current()
                  item.onSelect()
                }}
              >
                <span className="context-menu-icon" aria-hidden="true">
                  {Icon ? <Icon size={15} strokeWidth={1.8} /> : null}
                </span>
                <span className="context-menu-label">{item.label}</span>
                {item.checked && (
                  <span className="context-menu-check" aria-hidden="true"><Check size={14} strokeWidth={2.2} /></span>
                )}
                {item.hint && <span className="context-menu-hint">{item.hint}</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>,
    document.body,
  )
}
