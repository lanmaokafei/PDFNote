import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MathText } from '../../ui/MathText'
import { isClampable } from './clamp'

export type FieldVariant = 'node' | 'outline'

interface ExpandableFieldProps {
  field: 'excerpt' | 'note'
  label: string
  text: string
  variant: FieldVariant
  /** 空内容时的占位文字，只用于卡片节点。 */
  emptyLabel?: string
  /** 摘录图片等附属内容，插在标题与正文之间。 */
  children?: ReactNode
}

/**
 * 卡片正文（摘录 / 笔记）共用：点击标题或正文展开全文，超长内容在卡片内滚动。
 *
 * - `nodrag` 让展开后可以拖选文字而不拖动节点；`nowheel` 让滚轮作用于文本而不是平移画布。
 * - `overscroll-behavior: contain`（CSS）防止滚到底后把滚动传给 React Flow。
 * - 内容写回变长时自动展开，AI 解析完不必再点一次。
 */
export function ExpandableField({
  field,
  label,
  text,
  variant,
  emptyLabel,
  children,
}: ExpandableFieldProps) {
  const [expanded, setExpanded] = useState(false)
  const previousText = useRef(text)

  // 首次渲染不展开；之后只在文本变长（AI 解析追加 / 编辑补充）时自动展开。
  useEffect(() => {
    const before = previousText.current
    previousText.current = text
    if (text !== before && text.length > before.length) setExpanded(true)
  }, [text])

  const clampable = isClampable(text)
  const open = clampable && expanded
  const canExpand = clampable && Boolean(text) && !open

  return (
    <section
      className={`mindmap-field mindmap-field-${variant}${open ? ' is-open' : ''}`}
      data-field={field}
    >
      {clampable && text ? (
        <button
          type="button"
          className="mindmap-field-label nodrag"
          aria-expanded={open}
          title={open ? '收起全文' : '点击展开全文'}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="mindmap-field-name">{label}</span>
          <span className="mindmap-field-hint">{open ? '收起 ⌃' : '展开 ⌄'}</span>
        </button>
      ) : (
        <span className="mindmap-field-label is-static">
          <span className="mindmap-field-name">{label}</span>
        </span>
      )}
      {children}
      <p
        className={[
          'mindmap-field-text',
          open ? 'is-open nodrag nowheel' : clampable && text ? 'is-clamped' : '',
          !text ? 'is-empty' : '',
        ].filter(Boolean).join(' ')}
        onClick={canExpand ? () => setExpanded(true) : undefined}
        title={canExpand ? '点击展开全文' : undefined}
      >
        {text ? <MathText text={text} /> : (emptyLabel ?? '')}
      </p>
    </section>
  )
}
