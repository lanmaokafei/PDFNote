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
  return (
    <span
      className={`math-text${className ? ` ${className}` : ''}`}
      // KaTeX 输出的 HTML 已由其内部转义，文本段在 renderToHtml 里逐个转义。
      dangerouslySetInnerHTML={{ __html: renderCached(text) }}
    />
  )
}
