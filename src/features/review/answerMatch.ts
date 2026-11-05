/**
 * 主动回忆输入与参考答案的本地文本对比。
 *
 * 设计约束：
 * - 纯前端、完全离线、不写数据库；结果只是给用户自评提供参考，绝不代替 FSRS 评分。
 * - 中英混排：英文按词，中文按单字 + 二元组，避免引入分词词典。
 * - 用加权 F1 同时衡量「覆盖了多少答案」与「写的内容有多少是相关的」，
 *   这样只写关键词不会被长答案淹没，整段乱贴也不会得到高分。
 */

export type AnswerMatchLevel =
  | 'empty'
  | 'no-answer'
  | 'excellent'
  | 'good'
  | 'partial'
  | 'miss'

export interface AnswerMatch {
  level: AnswerMatchLevel
  /** 0–1，加权 token 的 F1；无输入或无答案时为 0。 */
  score: number
  /** 参考答案里已被输入覆盖的要点片段。 */
  matched: string[]
  /** 参考答案里尚未覆盖的要点片段。 */
  missing: string[]
  /** 一句话反馈。 */
  summary: string
  /** 用户输入的有效字符数（去掉首尾空白后）。 */
  inputLength: number
}

export const MATCH_LABELS: Record<AnswerMatchLevel, string> = {
  empty: '未输入',
  'no-answer': '无文字答案',
  excellent: '很接近',
  good: '要点大部分命中',
  partial: '部分命中',
  miss: '偏差较大',
}

const MATCH_SUMMARIES: Record<AnswerMatchLevel, string> = {
  empty: '这次没有输入回忆内容，下面是参考答案。',
  'no-answer': '这张卡片没有可对比的文字答案，请对照下方内容自评。',
  excellent: '很接近参考答案，要点基本都写到了。',
  good: '抓住了主要要点，还有少量内容没覆盖。',
  partial: '写出了部分要点，建议对照下方答案补全。',
  miss: '与参考答案重合很少，建议重读答案后再评分。',
}

/** 中英文里的高频虚词，不参与匹配，否则「的、是、the」会虚高分数。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'into', 'about', 'not', 'but', 'you', 'its', 'can',
  'of', 'to', 'in', 'on', 'is', 'it', 'as', 'at', 'by', 'be', 'or', 'an',
  '的', '了', '是', '在', '和', '与', '及', '或', '为', '以', '其', '之',
  '也', '都', '而', '中', '上', '下', '不', '有', '这', '那', '被', '把',
  '从', '对', '可', '会', '能', '将', '又', '就', '个', '们', '于', '所',
])

const MAX_KEY_POINTS = 4
const MAX_TERM_LENGTH = 14
const MAX_TERM_SCAN = 16

/**
 * 归一化：去 HTML 标签与常见实体，LaTeX 命令只保留命令名（\log → log），
 * 全角转半角、小写、标点变空格。保留中文、字母和数字。
 */
export function normalizeAnswerText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
    .replace(/\\([a-zA-Z]+)/g, ' $1 ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 与 normalizeAnswerText 相同，但保留大小写，用于生成可读的反馈要点。 */
function readableText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
    .replace(/\\([a-zA-Z]+)/g, ' $1 ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function addToken(weights: Map<string, number>, token: string, weight: number) {
  weights.set(token, Math.max(weights.get(token) ?? 0, weight))
}

/** 每个片段的 token 权重表：英文/数字词权重高，中文二元组居中，单字兜底权重低。 */
function tokenWeights(text: string): Map<string, number> {
  const weights = new Map<string, number>()
  const parts = normalizeAnswerText(text).match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []
  for (const part of parts) {
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length < 2 || STOP_WORDS.has(part)) continue
      addToken(weights, part, part.length >= 4 ? 1.6 : 1.1)
      continue
    }
    const chars = Array.from(part)
    for (const char of chars) {
      if (!STOP_WORDS.has(char)) addToken(weights, char, 0.35)
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      addToken(weights, chars.slice(index, index + 2).join(''), 1)
    }
  }
  return weights
}

function sumWeights(weights: Map<string, number>): number {
  let total = 0
  for (const weight of weights.values()) total += weight
  return total
}

function intersectionWeight(
  left: Map<string, number>,
  right: Map<string, number>,
): number {
  let total = 0
  for (const [token, weight] of left) {
    const other = right.get(token)
    if (other !== undefined) total += Math.min(weight, other)
  }
  return total
}

interface KeyTerm {
  text: string
  hit: boolean
}

/**
 * 从参考答案里抽取可读的「词/短语」要点，并标注用户是否写到。
 * 中文按字符覆盖合并连续片段，英文按词命中。
 * 它只负责反馈展示，评分仍用二元组 F1，避免单字命中把分数抬高。
 */
function collectKeyTerms(input: string, referenceTexts: string[]): KeyTerm[] {
  const inputChars = new Set(
    Array.from(normalizeAnswerText(input)).filter((char) => /[\p{Script=Han}]/u.test(char)),
  )
  const inputTokens = new Set(tokenWeights(input).keys())
  const terms: KeyTerm[] = []
  const seen = new Set<string>()

  const push = (text: string, hit: boolean) => {
    const label = text.length > MAX_TERM_LENGTH ? `${text.slice(0, MAX_TERM_LENGTH)}…` : text
    if (!label || seen.has(label)) return
    seen.add(label)
    terms.push({ text: label, hit })
  }

  for (const text of referenceTexts) {
    const chunks = readableText(text).match(/[\p{Script=Han}]+|[a-zA-Z0-9]+/gu) ?? []
    for (const chunk of chunks) {
      if (/^[a-zA-Z0-9]+$/.test(chunk)) {
        const word = chunk.toLowerCase()
        if (word.length >= 2 && !STOP_WORDS.has(word)) push(chunk, inputTokens.has(word))
        continue
      }
      let run = ''
      let runHit: boolean | null = null
      for (const char of Array.from(chunk)) {
        const hit = inputChars.has(char)
        if (runHit !== null && hit !== runHit) {
          if (run.length >= 2) push(run, runHit)
          run = ''
        }
        runHit = hit
        run += char
      }
      if (run.length >= 2 && runHit !== null) push(run, runHit)
      if (terms.length >= MAX_TERM_SCAN) break
    }
    if (terms.length >= MAX_TERM_SCAN) break
  }
  return terms
}

/**
 * 对比用户输入与参考答案（原文摘录 + 个人笔记）。
 * 只在答案已经揭示之后调用并展示，避免提前泄露答案要点。
 */
export function evaluateAnswer(input: string, referenceTexts: string[]): AnswerMatch {
  const inputLength = input.trim().length
  const reference = referenceTexts.filter((text) => typeof text === 'string').join('\n')
  const referenceWeights = tokenWeights(reference)
  const referenceTotal = sumWeights(referenceWeights)

  // 没有文字答案时优先说明卡片本身的情况，否则用户会误以为是自己忘了输入。
  if (!referenceTotal) {
    return {
      level: 'no-answer', score: 0, matched: [], missing: [],
      summary: MATCH_SUMMARIES['no-answer'], inputLength,
    }
  }
  if (!inputLength) {
    return { level: 'empty', score: 0, matched: [], missing: [], summary: MATCH_SUMMARIES.empty, inputLength }
  }

  const inputWeights = tokenWeights(input)
  const inputTotal = sumWeights(inputWeights)
  const shared = intersectionWeight(referenceWeights, inputWeights)
  const recall = shared / referenceTotal
  const precision = inputTotal ? shared / inputTotal : 0
  const score = recall + precision > 0
    ? (2 * recall * precision) / (recall + precision)
    : 0

  const level: AnswerMatchLevel = score >= 0.68
    ? 'excellent'
    : score >= 0.38
      ? 'good'
      : score >= 0.12
        ? 'partial'
        : 'miss'

  const terms = collectKeyTerms(input, referenceTexts)
  const matched = terms.filter((term) => term.hit).slice(0, MAX_KEY_POINTS).map((term) => term.text)
  const missing = terms.filter((term) => !term.hit).slice(0, MAX_KEY_POINTS).map((term) => term.text)

  return {
    level,
    score,
    matched,
    missing,
    summary: MATCH_SUMMARIES[level],
    inputLength,
  }
}
