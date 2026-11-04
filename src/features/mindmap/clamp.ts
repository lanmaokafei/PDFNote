/** 超过这个长度（或含换行）的正文才折叠成 3 行。 */
export const COLLAPSE_THRESHOLD = 72

/**
 * 短笔记直接完整显示，长文本才需要「点击展开 + 滚动条」：
 * AI 解析会写入多段解释，含换行时即使字数不多也必须可展开。
 * 公式不在这里判定——KaTeX 块级公式必须完整显示（纵向被裁会切掉公式下半部分），
 * 它的横向溢出由 `.katex-display` 自己的滚动条处理。
 */
export function isClampable(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  return value.length > COLLAPSE_THRESHOLD || value.includes('\n')
}
