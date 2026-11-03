import { useLayoutEffect, useRef } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { splitMathText } from './latex'

interface MathTextProps {
  text: string
  className?: string
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character])
}

function renderToHtml(text: string): string {
  if (!text) return ''
  const segments = splitMathText(text)
  if (segments.every((segment) => segment.kind === 'text')) {
    return escapeHtml(text).replace(/\n/g, '<br />')
  }
  return segments
    .map((segment) => {
      if (segment.kind === 'text') {
        return `<span class="math-text-plain">${escapeHtml(segment.value).replace(/\n/g, '<br />')}</span>`
      }
      return katex.renderToString(segment.value, {
        displayMode: segment.display,
        throwOnError: false,
        strict: false,
        trust: false,
      })
    })
    .join('')
}

// 同一个公式会在多个视图反复出现（脑图、大纲、复习），缓存渲染结果避免重复排版。
const cache = new Map<string, string>()
const CACHE_LIMIT = 400

function renderCached(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const html = renderToHtml(text)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(text, html)
  return html
}

/**
 * 把卡片文本按 LaTeX 渲染。
 *
 * 纯文本原样输出；含 `$...$` 等定界符或整段裸 LaTeX 时交给 KaTeX。
 * `throwOnError: false` 会把非法公式显示成红字而不是抛异常，
 * 所以渲染失败也不会影响卡片其余内容。
 */
export function MathText({ text, className }: MathTextProps) {
  const rootRef = useRef<HTMLSpanElement>(null)

  // 卡片只有两三百像素宽，长公式会被裁掉右侧。按容器可用宽度等比缩小字号，
  // 最多缩到 60%（再小就看不清了，宁可让用户横向滚动）。
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('.katex-display').forEach((display) => {
      const katex = display.querySelector<HTMLElement>('.katex')
      if (!katex) return
      katex.style.fontSize = ''
      // 基准字号由 CSS 按场景给（卡片 11px、大纲 11px、复习卡更大）。
      const basePx = Number.parseFloat(window.getComputedStyle(katex).fontSize) || 11
      let currentPx = basePx
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const available = display.clientWidth
        const needed = display.scrollWidth
        if (available <= 0 || needed <= available + 1) break
        const nextPx = Math.max(basePx * 0.7, currentPx * (available / needed))
        if (Math.abs(nextPx - currentPx) < 0.3) break
        katex.style.fontSize = `${nextPx}px`
        currentPx = nextPx
      }
    })
  }, [text])

  return (
    <span
      ref={rootRef}
      className={`math-text${className ? ` ${className}` : ''}`}
      // KaTeX 输出的 HTML 已由其内部转义，文本段在 renderToHtml 里逐个转义。
      dangerouslySetInnerHTML={{ __html: renderCached(text) }}
    />
  )
}
