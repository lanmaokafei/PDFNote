/** 脑图搜索：在问题 / 摘录 / 笔记里找关键词，按「命中字段 + 位置」排优先级。 */

export interface SearchableCard {
  id: string
  question: string
  excerpt: string
  user_note: string
}

export interface SearchHit {
  id: string
  score: number
}

function normalize(value: string): string {
  return value.toLowerCase()
}

/**
 * 多关键词用空格分隔，要求全部命中（AND）；排序按「问题 > 摘录 > 笔记」，
 * 同一字段里越靠前越优先，最后按原顺序稳定输出。
 */
export function searchCards(cards: readonly SearchableCard[], query: string, limit = 200): SearchHit[] {
  const tokens = normalize(query).split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return []
  const hits: SearchHit[] = []

  for (const card of cards) {
    const question = normalize(card.question)
    const excerpt = normalize(card.excerpt)
    const note = normalize(card.user_note)
    let score = 0
    let matchedAll = true
    for (const token of tokens) {
      const inQuestion = question.indexOf(token)
      const inExcerpt = excerpt.indexOf(token)
      const inNote = note.indexOf(token)
      if (inQuestion < 0 && inExcerpt < 0 && inNote < 0) {
        matchedAll = false
        break
      }
      // 字段权重 + 位置加权：开头命中比文中命中更重要。
      if (inQuestion >= 0) score += 300 - Math.min(inQuestion, 200)
      else if (inExcerpt >= 0) score += 200 - Math.min(inExcerpt, 150)
      else score += 100 - Math.min(inNote, 90)
    }
    if (matchedAll) hits.push({ id: card.id, score })
  }

  return hits
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit))
}
