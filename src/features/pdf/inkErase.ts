/**
 * 橡皮命中判定：把「橡皮圈碰到哪条笔迹」算清楚。
 *
 * 纯函数，不依赖 pdfjs / DOM，所以可以直接单测；
 * PdfPage 只负责把墨迹折线换算成 SVG 坐标后调用这里。
 */

export interface InkHitCandidate {
  id: string
  /** SVG 坐标下的折线点。 */
  points: Array<[number, number]>
  /** SVG 坐标下的线宽。 */
  width: number
}

export interface InkHit {
  id: string
  distance: number
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * 在「橡皮光标」半径内找命中的墨迹，按距离从近到远返回。
 *
 * 命中距离 = 橡皮半径 + 线宽一半：细笔画不需要正好点在线上，
 * 这样调大橡皮就能轻松选中要清理的笔迹。
 */
export function findInkHits(
  cursor: { x: number; y: number },
  candidates: readonly InkHitCandidate[],
  radius: number,
): InkHit[] {
  const hits: InkHit[] = []
  for (const candidate of candidates) {
    const { points } = candidate
    if (points.length === 0) continue
    let distance: number
    if (points.length === 1) {
      distance = Math.hypot(cursor.x - points[0][0], cursor.y - points[0][1])
    } else {
      distance = Infinity
      for (let index = 1; index < points.length; index += 1) {
        const [ax, ay] = points[index - 1]
        const [bx, by] = points[index]
        const segment = distanceToSegment(cursor.x, cursor.y, ax, ay, bx, by)
        if (segment < distance) distance = segment
      }
    }
    if (distance <= radius + candidate.width / 2) {
      hits.push({ id: candidate.id, distance })
    }
  }
  return hits.sort((left, right) => left.distance - right.distance)
}
