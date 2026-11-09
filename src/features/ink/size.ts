/** 墨迹 / 橡皮的连续尺寸：PDF 墨迹小菜单与笔记本 dock 共用一套范围与偏好。 */

/** 笔宽是归一化值（相对页宽），两端对应原先的「细 / 粗」。 */
export const PEN_WIDTH_MIN = 0.0018
export const PEN_WIDTH_MAX = 0.0072
export const PEN_WIDTH_STEP = 0.0002
export const PEN_WIDTH_DEFAULT = 0.0028

/** 橡皮半径（CSS px）：最小为原「小」，最大为原「特大」。 */
export const ERASER_RADIUS_MIN = 8
export const ERASER_RADIUS_MAX = 56
export const ERASER_RADIUS_STEP = 1
export const ERASER_RADIUS_DEFAULT = 18

export type SizeKind = 'pen' | 'eraser'

const PREF_KEY = 'pdfnote.ink.size'

interface SizePref {
  pen?: number
  eraser?: number
}

export function sizeRange(kind: SizeKind): { min: number; max: number; step: number; fallback: number } {
  return kind === 'pen'
    ? { min: PEN_WIDTH_MIN, max: PEN_WIDTH_MAX, step: PEN_WIDTH_STEP, fallback: PEN_WIDTH_DEFAULT }
    : { min: ERASER_RADIUS_MIN, max: ERASER_RADIUS_MAX, step: ERASER_RADIUS_STEP, fallback: ERASER_RADIUS_DEFAULT }
}

/** 落在范围内才用；脏数据（NaN / 越界）一律回落到默认值。 */
export function clampSize(kind: SizeKind, value: number): number {
  const { min, max, fallback } = sizeRange(kind)
  if (!Number.isFinite(value) || value < min || value > max) return fallback
  return value
}

/** 工具条上显示的数字：笔宽换算成「每 1000 单位」，橡皮直接是 px。 */
export function formatSize(kind: SizeKind, value: number): string {
  return kind === 'pen'
    ? (value * 1000).toFixed(1)
    : Math.round(value).toString()
}

export function sizeUnit(kind: SizeKind): string {
  return kind === 'pen' ? '‰' : 'px'
}

/** 预览圆点直径（px）：笔宽按归一化宽度放大，橡皮按半径画圆圈。 */
export function previewDiameter(kind: SizeKind, value: number): number {
  return kind === 'pen'
    ? Math.max(3, Math.min(18, value * 1000 * 2.2))
    : Math.max(8, Math.min(40, value * 0.8))
}

function readPref(): SizePref {
  try {
    const raw = globalThis.localStorage.getItem(PREF_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SizePref
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function readSizePreference(kind: SizeKind): number {
  const value = readPref()[kind]
  return clampSize(kind, typeof value === 'number' ? value : Number.NaN)
}

export function saveSizePreference(kind: SizeKind, value: number): void {
  try {
    const pref = readPref()
    pref[kind] = clampSize(kind, value)
    globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(pref))
  } catch {
    /* localStorage 不可用时只影响记忆，不影响当前值 */
  }
}
