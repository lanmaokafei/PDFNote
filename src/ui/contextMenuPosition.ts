export interface MenuPosition {
  left: number
  top: number
}

/**
 * Keep a context menu fully inside the viewport. When the pointer is close to
 * the right/bottom edge the menu flips to the other side of the cursor, then is
 * clamped as a final guard (e.g. very small windows or long menus).
 */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 8,
): MenuPosition {
  const gap = Math.max(0, padding)
  let left = Number.isFinite(x) ? x : gap
  let top = Number.isFinite(y) ? y : gap

  if (left + width + gap > viewportWidth) {
    const flipped = x - width
    left = flipped >= gap ? flipped : Math.max(gap, viewportWidth - width - gap)
  }
  if (top + height + gap > viewportHeight) {
    const flipped = y - height
    top = flipped >= gap ? flipped : Math.max(gap, viewportHeight - height - gap)
  }

  const maxLeft = Math.max(gap, viewportWidth - width - gap)
  const maxTop = Math.max(gap, viewportHeight - height - gap)
  return {
    left: Math.min(maxLeft, Math.max(gap, left)),
    top: Math.min(maxTop, Math.max(gap, top)),
  }
}
