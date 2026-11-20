/** 解析结果在笔记里的分隔标题；重复解析时整段替换。 */
export const AI_ANALYSIS_MARK = '【AI 解析】'

/**
 * 去掉已有的 AI 解析段。
 *
 * 之前每点一次「AI 解析」就往后追加一段，点三次笔记里就有三段重复内容。
 * 现在以标记为界：标记之前是用户自己的笔记，标记之后整段丢弃，再写入新结果。
 */
export function stripAiAnalysis(note: string): string {
  const index = note.indexOf(AI_ANALYSIS_MARK)
  const base = index >= 0 ? note.slice(0, index) : note
  return base.trim()
}

/** 用新的解析结果替换旧段，返回可直接写回笔记的文本。 */
export function mergeAiAnalysis(note: string, explanation: string): string {
  const body = explanation.trim()
  if (!body) return stripAiAnalysis(note)
  return [stripAiAnalysis(note), `${AI_ANALYSIS_MARK}\n${body}`].filter(Boolean).join('\n\n')
}
