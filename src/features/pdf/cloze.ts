/**
 * 文档回忆的「挖空填空」（cloze）。
 *
 * 设计约束：
 * - 纯函数、完全离线、不写数据库；挖空结果只用于提示，评分仍由用户按 FSRS 自评。
 * - 不做中文分词（不引词典、不联网）：按标点/虚词把摘录切成短语，再挑信息量高的短语挖空。
 * - 公式（$…$、\(…\)、含反斜杠的片段）一律保留为可见文本，绝不挖空——挖公式只会变成猜字符。
 * - 挑不出合适的空就老实退化成整句回忆（reason 非空），不要硬挖出一个无意义的空。
 */
import { normalizeAnswerText } from '../review/answerMatch'

export interface ClozeBlank {
  id: string
  answer: string
  /** 提示：首字 + 长度，例如「心…（5 字）」。 */
  hint: string
  /** 答案字符数，用于输入框宽度与占位点。 */
  length: number
}

export type ClozeSegment =
  | { kind: 'text'; text: string }
  | { kind: 'blank'; blank: ClozeBlank }

export interface ClozeExercise {
  excerpt: string
  segments: ClozeSegment[]
  blanks: ClozeBlank[]
  /** 非空 = 这段摘录不适合作挖空，UI 退回「整句回忆」。 */
  reason: string
}

export type ClozeVerdict = 'correct' | 'close' | 'wrong' | 'empty'

export interface ClozeBlankFeedback {
  id: string
  answer: string
  input: string
  verdict: ClozeVerdict
}

export interface ClozeResult {
  items: ClozeBlankFeedback[]
  correct: number
  total: number
  solved: boolean
  summary: string
}

const CLOZE_STORAGE_KEY = 'pdfnote.recall.cloze'

/** 挖空偏好：默认开启，回忆时直接可以填空。 */
export function readClozePreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(CLOZE_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveClozePreference(enabled: boolean) {
  try {
    globalThis.localStorage?.setItem(CLOZE_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // 隐私模式下 localStorage 不可用，仅本次会话生效。
  }
}

/** 英文虚词不挖，避免把 the / of 变成空。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'into', 'about', 'not', 'but', 'you', 'its', 'can',
  'of', 'to', 'in', 'on', 'is', 'it', 'as', 'at', 'by', 'be', 'or', 'an',
])

/** 单字虚词：把中文长串切开，本身留在可见文本里，不参与挖空。 */
const HAN_BREAK = new Set('与和及或在为是的了着过把被从对以而并且就都也还很更最')

/** 短语开头的功能词：挖空时剥掉，剩下的才是真正要记的内容。 */
const PREFIX_WORDS = [
  '患者', '病人', '本例', '临床', '目前', '本次', '结果', '情况',
  '出现', '发生', '显示', '表明', '说明', '可见', '发现', '提示',
  '需要', '可以', '应该', '能够', '我们', '他们', '它们', '因此', '但是', '如果',
  '因为', '所以', '以及', '同时', '例如', '比如', '包括', '通过', '对于', '其中',
  '由于', '然而', '而且', '所有', '每个', '这个', '这些', '那些', '一种', '一组',
  '存在', '进行', '具有', '表现', '导致', '引起', '常见', '主要', '一般',
  '通常', '必须', '可能', '仍然', '已经', '继续', '开始',
  '立即', '及时', '尽早', '积极', '酌情', '予以', '给予',
]

/** 短语结尾的功能词，同上。 */
const SUFFIX_WORDS = [
  '等等', '等', '的', '了', '是', '和', '与', '及', '或', '在', '为',
  '时', '后', '前', '中', '上', '下', '者', '地', '得',
]

/** 泛化词不挖：挖「定义」「作用」考不出任何知识。 */
const GENERIC_TERMS = new Set([
  '定义', '概念', '含义', '意义', '特点', '作用', '原因', '结果', '方法',
  '过程', '问题', '内容', '情况', '方面', '关系', '时候', '结论', '基础',
  '条件', '原则', '目的', '步骤', '类型', '分类', '部分', '表现',
])

const MATH_PATTERN = /\$[^$]+\$|\\\([^)]*\\\)|\\\[[^\]]*\\\]/g
const TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9.'’-]*|\d+(?:[.,]\d+)*%?|[\p{Script=Han}]+|[^\p{Script=Han}A-Za-z0-9]+/gu

interface Piece {
  text: string
  /** 是否可以作为挖空答案。 */
  candidate: boolean
  score: number
  /** 累计字符偏移，用于保证两个空之间留有上下文。 */
  offset: number
}

function charCount(text: string): number {
  return Array.from(text).length
}

/** 反复剥掉首尾功能词；保证剥完至少还剩 2 个字，否则原样返回。 */
function trimAffixes(text: string): string {
  let value = text
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of PREFIX_WORDS) {
      if (value.length > prefix.length + 1 && value.startsWith(prefix)) {
        value = value.slice(prefix.length)
        changed = true
      }
    }
    for (const suffix of SUFFIX_WORDS) {
      if (value.length > suffix.length + 1 && value.endsWith(suffix)) {
        value = value.slice(0, -suffix.length)
        changed = true
      }
    }
  }
  return value
}

function hanScore(length: number): number {
  if (length <= 1) return 0
  if (length === 2) return 1
  if (length === 3) return 2.2
  if (length === 4) return 2.8
  if (length === 5) return 3
  return 3.2
}

/**
 * 把连续汉字按虚词切开，每段去掉首尾功能词后作为候选。
 * 段太长（> 6 字）时只取前 6 字，剩下的留作上下文。
 */
function pushHanPieces(run: string, pieces: Piece[], offsetRef: { value: number }) {
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    const start = offsetRef.value
    offsetRef.value += buffer.length
    const trimmed = trimAffixes(buffer)
    const index = trimmed.length >= 2 ? buffer.indexOf(trimmed) : -1
    if (index < 0) {
      pieces.push({ text: buffer, candidate: false, score: 0, offset: start })
      buffer = ''
      return
    }
    const chars = Array.from(trimmed)
    // 超过 6 字的短语只挖前 6 字：中文术语多半是修饰语 + 中心词，挖整句会变成默写。
    const answer = chars.length > 6 ? chars.slice(0, 6).join('') : trimmed
    const rest = chars.length > 6 ? chars.slice(6).join('') : ''
    if (index > 0) pieces.push({ text: buffer.slice(0, index), candidate: false, score: 0, offset: start })
    const usable = !GENERIC_TERMS.has(answer)
    pieces.push({
      text: answer,
      candidate: usable,
      score: usable ? hanScore(charCount(answer)) : 0,
      offset: start + index,
    })
    const tail = rest + buffer.slice(index + trimmed.length)
    if (tail) pieces.push({ text: tail, candidate: false, score: 0, offset: start + index + answer.length })
    buffer = ''
  }
  for (const char of Array.from(run)) {
    if (HAN_BREAK.has(char)) {
      flush()
      pieces.push({ text: char, candidate: false, score: 0, offset: offsetRef.value })
      offsetRef.value += 1
      continue
    }
    buffer += char
  }
  flush()
}

/** 解析摘录：公式、标点、数字、英文与中文短语各自成为一片。 */
function parsePieces(text: string): Piece[] {
  const pieces: Piece[] = []
  const offsetRef = { value: 0 }
  // 先把公式区段摘出来，后面按普通文本片段逐个扫描。
  let cursor = 0
  const mathRanges: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(MATH_PATTERN)) {
    const start = match.index ?? 0
    mathRanges.push({ start, end: start + match[0].length })
  }
  const scan = (chunk: string) => {
    for (const match of chunk.matchAll(TOKEN_PATTERN)) {
      const token = match[0]
      if (/^[A-Za-z]/.test(token)) {
        const lower = token.toLowerCase()
        const candidate = charCount(token) >= 3 && !STOP_WORDS.has(lower)
        pieces.push({
          text: token,
          candidate,
          score: candidate ? 1.2 + (charCount(token) >= 5 ? 0.8 : 0) : 0,
          offset: offsetRef.value,
        })
        offsetRef.value += charCount(token)
        continue
      }
      if (/^\d/.test(token)) {
        // 数字（含百分比）几乎是永远值得挖的内容。
        pieces.push({ text: token, candidate: true, score: 3.6, offset: offsetRef.value })
        offsetRef.value += charCount(token)
        continue
      }
      if (/^\p{Script=Han}/u.test(token)) {
        pushHanPieces(token, pieces, offsetRef)
        continue
      }
      pieces.push({ text: token, candidate: false, score: 0, offset: offsetRef.value })
      offsetRef.value += charCount(token)
    }
  }

  while (cursor < text.length) {
    const range = mathRanges.find((item) => item.start >= cursor)
    if (!range) {
      scan(text.slice(cursor))
      break
    }
    if (range.start > cursor) scan(text.slice(cursor, range.start))
    const mathText = text.slice(range.start, range.end)
    pieces.push({ text: mathText, candidate: false, score: 0, offset: offsetRef.value })
    offsetRef.value += charCount(mathText)
    cursor = range.end
  }
  return pieces
}

export interface BuildClozeOptions {
  /** 最多挖几个空；默认 2，超过 3 个基本是在考默写。 */
  maxBlanks?: number
}

/**
 * 从摘录生成挖空练习。
 * 挑不出空时 `reason` 非空，调用方应退回「整句回忆」。
 */
export function buildCloze(excerpt: string, options: BuildClozeOptions = {}): ClozeExercise {
  const maxBlanks = Math.max(1, Math.min(4, options.maxBlanks ?? 2))
  const raw = (excerpt ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim()
  const empty: ClozeExercise = { excerpt: raw, segments: [], blanks: [], reason: '没有可挖空的文字摘录' }
  if (!raw) return empty

  const pieces = parsePieces(raw)
  // 没有 $ 包裹的裸 LaTeX（\sum、x_i、^{n}）同样是公式，挖空只会变成猜字符；
  // 但 $…$ 里的公式只是句中的可见片段，仍按普通文本处理。
  const outsideMath = raw.replace(/\$[^$]+\$|\\\([^)]*\\\)|\\\[[^\]]*\\\]/g, ' ')
  if (/\\[A-Za-z]{2,}/.test(outsideMath)) {
    return { excerpt: raw, segments: [], blanks: [], reason: '这段摘录是公式，整句回忆即可' }
  }
  // 公式片段不算「可回忆的文字」，否则一条纯公式摘录会被硬挖成一个空。
  const visibleChars = pieces.reduce((total, piece) => {
    if (/^\$|^\\/.test(piece.text)) return total
    const count = piece.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
    return total + count
  }, 0)
  if (visibleChars < 4) {
    return { excerpt: raw, segments: [], blanks: [], reason: '这段摘录太短或只有公式，整句回忆即可' }
  }

  const candidates = pieces
    .map((piece, index) => ({ piece, index }))
    .filter((item) => item.piece.candidate)
    .sort((a, b) => b.piece.score - a.piece.score)

  const picked: Array<{ index: number; offset: number; length: number }> = []
  for (const item of candidates) {
    if (picked.length >= maxBlanks) break
    const length = charCount(item.piece.text)
    // 两个空之间必须留足够线索：中文至少隔 6 个字，英文至少隔一个短语。
    const minGap = Math.max(6, length + 2)
    const tooClose = picked.some((chosen) => Math.abs(chosen.offset - item.piece.offset) < Math.max(minGap, chosen.length + 2))
    if (tooClose) continue
    picked.push({ index: item.index, offset: item.piece.offset, length })
  }
  if (picked.length === 0) {
    return { excerpt: raw, segments: [], blanks: [], reason: '摘录里没有合适的挖空词，整句回忆即可' }
  }

  const pickedIndexes = new Set(picked.map((item) => item.index))
  const segments: ClozeSegment[] = []
  const blanks: ClozeBlank[] = []
  const pushText = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.kind === 'text') last.text += text
    else segments.push({ kind: 'text', text })
  }

  pieces.forEach((piece, index) => {
    if (!pickedIndexes.has(index)) {
      pushText(piece.text)
      return
    }
    const length = charCount(piece.text)
    const unit = /^[\d.,%]+$/.test(piece.text) ? '位' : '字'
    const blank: ClozeBlank = {
      id: `b${blanks.length}`,
      answer: piece.text,
      hint: `${Array.from(piece.text)[0]}…（${length} ${unit}）`,
      length,
    }
    blanks.push(blank)
    segments.push({ kind: 'blank', blank })
  })

  return { excerpt: raw, segments, blanks, reason: '' }
}

function compact(text: string): string {
  return normalizeAnswerText(text).replace(/\s+/g, '')
}

function editDistance(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]
}

/** 单空判定：完全一致算对，差一字算「接近」，其余算错。 */
export function judgeClozeBlank(input: string, answer: string): ClozeVerdict {
  const value = compact(input)
  if (!value) return 'empty'
  const target = compact(answer)
  if (!target) return 'empty'
  if (value === target) return 'correct'
  const targetLength = Array.from(target).length
  const distance = editDistance(value, target)
  // 5 字术语写错 2 个字仍算「接近」：这里只是提示，判对判错仍由用户自评。
  const tolerance = Math.max(1, Math.ceil(targetLength / 3))
  if (distance <= tolerance) return 'close'
  // 多写/少写一整个短语时也放行，避免「心肌酶升高」被判死。
  if (targetLength >= 3 && (value.includes(target) || target.includes(value))) return 'close'
  return 'wrong'
}

export function checkCloze(exercise: ClozeExercise, inputs: string[]): ClozeResult {
  const items: ClozeBlankFeedback[] = exercise.blanks.map((blank, index) => {
    const input = inputs[index] ?? ''
    return { id: blank.id, answer: blank.answer, input, verdict: judgeClozeBlank(input, blank.answer) }
  })
  const correct = items.filter((item) => item.verdict === 'correct').length
  const total = items.length
  const empty = items.filter((item) => item.verdict === 'empty').length
  const close = items.filter((item) => item.verdict === 'close').length
  const solved = total > 0 && correct === total
  let summary = ''
  if (solved) summary = `全部 ${total} 空都补齐了。`
  else if (empty === total) summary = '还没有填空。'
  else if (correct === 0) summary = close > 0 ? '差一点，先看看提示再试。' : '还没对上，先看看原文。'
  else summary = `${correct}/${total} 空答对${close > 0 ? `，${close} 空接近` : ''}。`
  return { items, correct, total, solved, summary }
}
