import type { OutlineNode } from '../../services/book'

/** 读者可选的拆分层级：一章书常常是「章 → 小节 → 名词 → 解释」，所以最深给到 5 层。 */
export const MIN_DEPTH = 1
export const MAX_DEPTH = 5
export const DEFAULT_DEPTH = 2
export const DEPTH_STORAGE_KEY = 'pdfnote.digest.depth'

export interface DepthOption {
  value: number
  label: string
  hint: string
}

export const DEPTH_OPTIONS: DepthOption[] = [
  { value: 1, label: '只列主题', hint: '一层：只给全书/章节的大标题，快速鸟瞰' },
  { value: 2, label: '主题 → 要点', hint: '两层（默认）：每个主题下挂关键要点，适合快速通读' },
  { value: 3, label: '主题 → 要点 → 名词', hint: '三层：要点里的核心概念、方法名单独成节点' },
  { value: 4, label: '章 → 小节 → 名词 → 解释', hint: '四层：名词再展开定义、条件与举例，教材/论文精读推荐' },
  { value: 5, label: '四层 + 补充', hint: '五层：再补参数、边界、反例与易错点，适合备考' },
]

/** 任何来源（localStorage / 模型 / 旧数据）的值都收敛到 1–5，缺省 2。 */
export function normalizeDepth(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_DEPTH
  return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(value)))
}

export function readDepth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_DEPTH
    const raw = localStorage.getItem(DEPTH_STORAGE_KEY)
    if (raw === null || raw === '') return DEFAULT_DEPTH
    return normalizeDepth(raw)
  } catch {
    return DEFAULT_DEPTH
  }
}

export function saveDepth(depth: number): number {
  const value = normalizeDepth(depth)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEPTH_STORAGE_KEY, String(value))
    }
  } catch {
    // 隐私模式下写不进去也不影响本次会话
  }
  return value
}

export function countOutlineNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countOutlineNodes(node.children ?? []), 0)
}

/** 空树算 0 层；非空树返回实际最大层数（用于预览里显示模型有没有偷懒）。 */
export function outlineDepth(nodes: OutlineNode[]): number {
  if (!nodes.length) return 0
  return 1 + Math.max(...nodes.map((node) => outlineDepth(node.children ?? [])))
}
