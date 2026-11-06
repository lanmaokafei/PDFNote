/**
 * 脑图视口中心 → 新卡片落点。
 *
 * PDF 划重点建卡发生在左栏，落点却要由右栏画布当前的平移/缩放决定。
 * 两栏之间没有 props 关系，所以这里用一个极小的模块级共享状态：
 * 脑图在视口变化时写入中心点，建卡方读取并换算成「卡片左上角坐标」。
 *
 * 只存内存：重启后没有视口中心，建卡回落数据库默认值，由脑图首次刷新时补位。
 */
export interface MindmapPoint {
  x: number
  y: number
}

/** 卡片估算尺寸，用于把「中心点」换算成「左上角坐标」。 */
const NODE_WIDTH = 254
const NODE_HEIGHT = 190
/** 连续建卡时在中心附近错开，避免叠成一摞。 */
const OFFSET_STEP = 36
const OFFSET_RING = 3

let viewportCenter: MindmapPoint | null = null
let insertSequence = 0

export function setMindmapViewportCenter(point: MindmapPoint | null): void {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    viewportCenter = null
    return
  }
  viewportCenter = point
}

export function readMindmapViewportCenter(): MindmapPoint | null {
  return viewportCenter
}

/** 画布切换或重新加载时重置错开序号，新会话的第一张卡仍然落在正中心。 */
export function resetMindmapInsertSequence(): void {
  insertSequence = 0
}

/**
 * 下一张新卡片的左上角坐标：以视口中心为基准，按 3×3 环错开。
 * 没有视口中心（脑图未挂载）时返回 undefined，交给数据库默认值。
 */
export function nextMindmapInsertPoint(): MindmapPoint | undefined {
  if (!viewportCenter) return undefined
  const slot = insertSequence % (OFFSET_RING * OFFSET_RING)
  insertSequence += 1
  const column = slot % OFFSET_RING
  const row = Math.floor(slot / OFFSET_RING)
  return {
    x: Math.round(viewportCenter.x - NODE_WIDTH / 2 + column * OFFSET_STEP),
    y: Math.round(viewportCenter.y - NODE_HEIGHT / 2 + row * OFFSET_STEP),
  }
}
