/**
 * LaTeX 检测与切分。
 *
 * 卡片摘录大多来自 AI 公式识别，存的是**不带定界符的裸 LaTeX**
 * （例如 `H = -\sum_{i=1}^{n} P(x_i) \log_2 P(x_i)`），
 * 所以除了 `$...$` / `$$...$$` / `\[...\]` / `\(...\)`，
 * 还要能把整段裸 LaTeX 识别出来。
 */
export interface MathSegment {
  kind: 'text' | 'math'
  value: string
  /** 块级公式（独占一行、居中）。 */
  display: boolean
}

const LATEX_COMMAND = /\\[a-zA-Z]+/
const DELIMITER_PATTERN = /\$\$|\\\[|\\\(|\$/g

function countCjk(text: string): number {
  return (text.match(/[\u3400-\u9fff]/g) ?? []).length
}

/** 这段文字是否应该整体按公式渲染。 */
export function looksLikeLatex(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 500) return false
  // 有 LaTeX 命令（\sum、\frac、\log…）时允许夹少量中文（\text{中文}）。
  if (LATEX_COMMAND.test(trimmed)) return countCjk(trimmed) <= 2
  if (countCjk(trimmed) > 0) return false
  // 上下标写法：E = mc^2、x_i + x_{i+1}。
  if (/[\^_]/.test(trimmed) && /[A-Za-z]/.test(trimmed)) return true
  // 纯符号公式：运算符足够多且含字母数字。
  const operators = (trimmed.match(/[=+\-*/<>≤≥∑∏∫√π∞]/g) ?? []).length
  return operators >= 2 && /[A-Za-z0-9]/.test(trimmed)
}

function findNextDelimiter(text: string, from: number) {
  DELIMITER_PATTERN.lastIndex = from
  const match = DELIMITER_PATTERN.exec(text)
  if (!match) return null
  const token = match[0]
  const close = token === '$$' ? '$$' : token === '\\[' ? '\\]' : token === '\\(' ? '\\)' : '$'
  return {
    start: match.index,
    contentStart: match.index + token.length,
    close,
    display: token === '$$' || token === '\\[',
  }
}

/** 拆分混排文本；整段裸 LaTeX 会变成一个 display 段落。 */
export function splitMathText(text: string): MathSegment[] {
  if (!text) return []
  const segments: MathSegment[] = []
  let index = 0
  let buffer = ''

  while (index < text.length) {
    const delimiter = findNextDelimiter(text, index)
    if (!delimiter) break
    const closeIndex = text.indexOf(delimiter.close, delimiter.contentStart)
    if (closeIndex === -1) {
      // 定界符没闭合：当普通文本处理，避免吞掉后续内容。
      buffer += text.slice(index)
      index = text.length
      break
    }
    buffer += text.slice(index, delimiter.start)
    const value = text.slice(delimiter.contentStart, closeIndex).trim()
    if (buffer) {
      segments.push({ kind: 'text', value: buffer, display: false })
      buffer = ''
    }
    if (value) segments.push({ kind: 'math', value, display: delimiter.display })
    index = closeIndex + delimiter.close.length
  }

  buffer += text.slice(index)
  if (buffer) segments.push({ kind: 'text', value: buffer, display: false })

  const hasMath = segments.some((segment) => segment.kind === 'math')
  if (!hasMath && looksLikeLatex(text)) {
    return [{ kind: 'math', value: text.trim(), display: true }]
  }
  return segments.length > 0 ? segments : [{ kind: 'text', value: text, display: false }]
}
