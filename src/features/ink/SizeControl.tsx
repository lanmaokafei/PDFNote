import { useEffect, useRef, useState } from 'react'
import {
  clampSize,
  formatSize,
  previewDiameter,
  sizeRange,
  sizeUnit,
  type SizeKind,
} from './size'
import './SizeControl.css'

interface SizeControlProps {
  kind: SizeKind
  /** 触发按钮上的名字，如「笔宽」「橡皮半径」。 */
  label: string
  value: number
  onChange: (value: number) => void
}

/**
 * 浮动在墨迹小菜单 / 笔记本 dock 上方的连续尺寸控件。
 * 只用一个触发按钮占位，点开后是滑杆：拖到哪里就是哪里，两端对应原「小 → 特大」。
 */
export function SizeControl({ kind, label, value, onChange }: SizeControlProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const { min, max, step } = sizeRange(kind)
  const current = clampSize(kind, value)
  const minLabel = kind === 'eraser' ? '小' : '细'
  const maxLabel = kind === 'eraser' ? '特大' : '粗'

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={`ink-size-control is-${kind}`} ref={wrapperRef}>
      <button
        type="button"
        className={`ink-size-trigger${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-label={`${label}，当前 ${formatSize(kind, current)}${sizeUnit(kind)}，点击拖动调整`}
        data-testid={`ink-size-trigger-${kind}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={`ink-size-preview${kind === 'eraser' ? ' is-eraser' : ''}`}
          style={{ width: previewDiameter(kind, current), height: previewDiameter(kind, current) }}
          aria-hidden="true"
        />
        <span className="ink-size-trigger-text">
          {label}
          <em data-testid={`ink-size-value-${kind}`}>
            {formatSize(kind, current)}{sizeUnit(kind)}
          </em>
        </span>
      </button>

      {open && (
        <div className="ink-size-popover" role="dialog" aria-label={`${label}滑杆`} data-testid={`ink-size-popover-${kind}`}>
          <header>
            <strong>{label}</strong>
            <span>{formatSize(kind, current)}{sizeUnit(kind)}</span>
          </header>
          <div className="ink-size-live" aria-hidden="true">
            <span
              className={`ink-size-preview${kind === 'eraser' ? ' is-eraser' : ''}`}
              style={{ width: previewDiameter(kind, current), height: previewDiameter(kind, current) }}
            />
          </div>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={current}
            aria-label={`${label}滑杆`}
            data-testid={`ink-size-slider-${kind}`}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
          />
          <div className="ink-size-bounds">
            <span>{minLabel}</span>
            <span>{maxLabel}</span>
          </div>
          <p>{kind === 'eraser' ? '半径越大，圈到的笔迹越多' : '拖动即可改变笔画粗细'}</p>
        </div>
      )}
    </div>
  )
}
