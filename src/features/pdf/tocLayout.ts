/** 骨架节点在画布上的落点。 */
export interface SkeletonPoint {
  x: number
  y: number
}

/** 子节点相对父节点向右偏移多少像素（与脑图卡片宽度大致一致）。 */
export const SKELETON_CHILD_DX = 340
/** 没有兄弟节点时，子节点相对父节点向下偏移。 */
export const SKELETON_FIRST_CHILD_DY = 80
/** 兄弟节点之间的垂直间距。 */
export const SKELETON_SIBLING_GAP = 120
/** 根节点之间的垂直间距。 */
export const SKELETON_ROOT_GAP = 160
/** 没有参照物时的起点。 */
const ORIGIN: SkeletonPoint = { x: 80, y: 80 }

/**
 * 给「更新骨架」时新增的节点找落点：挂到父节点右侧、已有兄弟下面，
 * 这样已有卡片的位置完全不动，不需要整张画布重排。
 *
 * 没有父节点（或父节点还没定位）时当作根节点排在已有根节点下面。
 */
export function placeSkeletonNode(input: {
  parent: SkeletonPoint | null
  /** 同一父节点下、已经有坐标的兄弟的 y。 */
  siblingYs: readonly number[]
  /** 已经有坐标的根节点的 y。 */
  rootYs: readonly number[]
}): SkeletonPoint {
  const { parent, siblingYs, rootYs } = input
  if (parent) {
    const y = siblingYs.length > 0
      ? Math.max(...siblingYs) + SKELETON_SIBLING_GAP
      : parent.y + SKELETON_FIRST_CHILD_DY
    return { x: parent.x + SKELETON_CHILD_DX, y }
  }
  const y = rootYs.length > 0 ? Math.max(...rootYs) + SKELETON_ROOT_GAP : ORIGIN.y
  return { x: ORIGIN.x, y }
}
