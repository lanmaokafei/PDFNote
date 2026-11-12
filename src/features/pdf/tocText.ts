import type { TocEntry } from './pdfOutline'

/** 粘贴目录的解析结果：能识别的条目 + 没认出来的行（界面上要告诉用户，不静默丢）。 */
export interface TocTextResult {
  entries: TocEntry[]
  skipped: string[]
}

export interface TocTextOptions {
  /** 条目上限，防止粘进整本书的索引；默认 200。 */
  maxEntries?: number
}

/** 「目录」「Contents」这类标题行不是条目。 */
const HEADER_LINE = /^(目\s*录|contents|table\s+of\s+contents)$/i

/**
 * 一行目录：标题 + 点线/省略号（可选）+ 空白（可选）+ 页码。
 * 点线和空白至少要有一个，否则「绪论12」这种分不清是页码还是编号的行不猜。
 */
const PAGE_TAIL = /^(.*?)([.·・…⋯]*)([ \u3000]*)(\d{1,4})(?:[ \u3000]*[-–—~][ \u3000]*\d{1,4})?$/u

const MAX_PAGE = 3000

function stripTrailingLeaders(value: string): string {
  return value.replace(/[.·・…⋯\s\u3000]+$/u, '').replace(/^[.·・…⋯\s\u3000]+/u, '')
}

/** 从编号推层级：`1` 一级、`1.1` 二级、`1.1.1` 三级（最多到 2）。 */
function numberingLevel(title: string): number {
  // 「（一）」这类中文小标题通常是二级。
  if (/^[（(][一二三四五六七八九十百]+[）)]/u.test(title)) return 1
  const arabic = /^(\d+(?:[.．]\d+)*)/u.exec(title)
  if (arabic) return Math.min(2, arabic[1].split(/[.．]/u).length - 1)
  if (/^第\s*[一二三四五六七八九十百零〇\d]+\s*[章节篇部卷]/u.test(title)) return 0
  if (/^[一二三四五六七八九十百]+[、.．]/u.test(title)) return 0
  if (/^(chapter|part)\s/iu.test(title)) return 0
  return 0
}

function parseLine(line: string): { title: string; page: number } | null {
  const match = PAGE_TAIL.exec(line)
  if (!match) return null
  const [, rawTitle, leaders, gap, pageText] = match
  if (!leaders && !gap) return null
  const title = stripTrailingLeaders(rawTitle).replace(/\s+/gu, ' ').trim()
  if (!title) return null
  // 纯数字「标题」多半是把正文行号粘进来了。
  if (/^\d+$/u.test(title)) return null
  const page = Number(pageText)
  if (!Number.isFinite(page) || page < 1 || page > MAX_PAGE) return null
  return { title: Array.from(title).slice(0, 120).join(''), page }
}

/**
 * 解析粘贴进来的目录文本（一章一行，标题与页码之间用点线 / 省略号 / Tab / 空格分隔）。
 *
 * 层级优先看缩进，其次看编号（`1` → 一级、`1.1` → 二级）；层级一次最多往下走一层，
 * 避免粘进来的文本层级跳变导致接树时挂错父节点。
 */
export function parseTocText(text: string, options: TocTextOptions = {}): TocTextResult {
  const maxEntries = Math.max(1, Math.min(2000, options.maxEntries ?? 200))
  const entries: TocEntry[] = []
  const skipped: string[] = []
  let previousLevel = -1

  for (const rawLine of text.split(/\r?\n/u)) {
    // Tab 与全角空格先统一成半角，缩进才好量。
    const line = rawLine.replace(/\u00a0/gu, ' ').replace(/\t/gu, '  ').replace(/\u3000/gu, '  ')
    const trimmed = line.trim()
    if (!trimmed) continue
    if (HEADER_LINE.test(trimmed)) continue

    const parsed = parseLine(trimmed)
    if (!parsed) {
      skipped.push(trimmed)
      continue
    }
    if (entries.length >= maxEntries) break

    const indent = Math.floor((line.length - line.trimStart().length) / 2)
    let level = Math.min(2, Math.max(indent, numberingLevel(parsed.title)))
    if (entries.length === 0) level = 0
    // 一次只能往下走一层：`1` 后面直接跟 `1.1.1` 时压成二级。
    level = Math.min(level, previousLevel + 1)
    previousLevel = level

    const last = entries[entries.length - 1]
    if (last && last.title === parsed.title && last.page === parsed.page) continue
    entries.push({ title: parsed.title, page: parsed.page, level })
  }

  return { entries, skipped }
}
