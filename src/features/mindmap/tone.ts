/**
 * 脑图卡片的色彩体系：二十四节气色。
 *
 * 色值取自《中国传统色》二十四节气 96 色（每节气起承转合四色），
 * 这里为每个节气挑一个「明度适中、能当识别标记」的颜色：
 * 春天的嫩黄嫩绿、夏天的浓绿朱红、秋天的赭金蓝紫、冬天的灰蓝紫，
 * 合起来正好是一条自然推进的色相环。
 *
 * 每张卡片不直接存颜色，而是按「所属子树的根」稳定推导：
 * 同一棵子树同色 → 脑图天然形成彩色簇群，而不是一片杂色。
 */

export interface SolarTone {
  /** 节气名。 */
  term: string
  /** 传统色名（《中国传统色》里该节气的色名）。 */
  color: string
  /** 主色：左侧色条、徽标描边、选中环。 */
  bar: string
  /** 极浅底色：卡片头部、低缩放标题条。 */
  wash: string
  /** 深色同族色：淡底上的文字。 */
  ink: string
  /** 主色 22% 透明度：选中光晕。 */
  ring: string
}

type Seed = [term: string, color: string, bar: string]

const SEEDS: Seed[] = [
  // 春：嫩黄 → 黄绿 → 桃粉 → 暖褐 → 雾紫 → 草绿
  ['立春', '缃叶', '#ECD452'],
  ['雨水', '春辰', '#A9BE7B'],
  ['惊蛰', '杨妃', '#F091A0'],
  ['春分', '紫磨金', '#BC836B'],
  ['清明', '紫菂', '#9B8EA9'],
  ['谷雨', '庭芜绿', '#68945C'],
  // 夏：橄榄 → 墨绿 → 雌黄 → 砖红 → 深蓝 → 绛红
  ['立夏', '水龙吟', '#84A729'],
  ['小满', '官绿', '#2A6E3F'],
  ['芒种', '雌黄', '#B4884D'],
  ['夏至', '赩炽', '#CB523E'],
  ['小暑', '柔蓝', '#106898'],
  ['大暑', '茹藘', '#A35F65'],
  // 秋：浅蓝 → 天水碧 → 青灰 → 栾华 → 杏子 → 棠梨
  ['立秋', '窃蓝', '#88ABDA'],
  ['处暑', '天水碧', '#5AA4AE'],
  ['白露', '千山翠', '#6B7D73'],
  ['秋分', '栾华', '#C0AD5E'],
  ['寒露', '杏子', '#DA9233'],
  ['霜降', '棠梨', '#B15A43'],
  // 冬：石绿 → 胭脂水 → 暮山紫 → 鞓红 → 井天 → 紫府
  ['立冬', '石绿', '#206864'],
  ['小雪', '胭脂水', '#B95A89'],
  ['大雪', '暮山紫', '#A4ABD6'],
  ['冬至', '鞓红', '#B04552'],
  ['小寒', '井天', '#A4C9CC'],
  ['大寒', '紫府', '#995D7F'],
]

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '')
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** 与白色混合：ratio 是白色占比（0.92 → 只剩 8% 原色）。 */
function tint(rgb: Rgb, ratio: number): Rgb {
  return {
    r: rgb.r + (255 - rgb.r) * ratio,
    g: rgb.g + (255 - rgb.g) * ratio,
    b: rgb.b + (255 - rgb.b) * ratio,
  }
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) hue = ((bn - rn) / delta + 2) / 6
  else hue = ((rn - gn) / delta + 4) / 6
  return [hue, saturation, lightness]
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  if (saturation === 0) {
    const value = lightness * 255
    return { r: value, g: value, b: value }
  }
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (offset: number) => {
    let t = hue + offset
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: channel(1 / 3) * 255, g: channel(0) * 255, b: channel(2 / 3) * 255 }
}

/**
 * 深色同族色：把主色压到约 34% 亮度，保证在 8% 淡底上对比度足够，
 * 同时保留色相，让「立春的黄」和「谷雨的绿」即使只深浅也能区分。
 */
function deepen(rgb: Rgb, target = 0.30): Rgb {
  const [hue, saturation, lightness] = rgbToHsl(rgb)
  // 深色主色（石绿、柔蓝）不能再按固定亮度压：取「目标值与主色下探」的较小者，
  // 否则深蓝的「深字」反而比主色更亮，淡底上的文字会糊成一片。
  // 饱和度不抬下限：灰调色（白露·千山翠）压深后仍应是灰调，不能变成鲜绿。
  const next = Math.min(target, Math.max(0.14, lightness - 0.18))
  return hslToRgb(hue, Math.min(saturation, 0.72), next)
}

function ringOf(rgb: Rgb, alpha = 0.22): string {
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`
}

export const SOLAR_TONES: SolarTone[] = SEEDS.map(([term, color, bar]) => {
  const rgb = parseHex(bar)
  return {
    term,
    color,
    bar: toHex(rgb),
    wash: toHex(tint(rgb, 0.87)),
    ink: toHex(deepen(rgb)),
    ring: ringOf(rgb),
  }
})

/** 色调在色板里的序号（0–23），越界自动回绕。 */
export function toneAt(index: number): SolarTone {
  const size = SOLAR_TONES.length
  return SOLAR_TONES[((index % size) + size) % size]
}

/** 稳定哈希：同一个 id 永远落在同一个色相，与加载顺序、卡片增删无关。 */
export function toneIndexOf(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash) % SOLAR_TONES.length
}

/**
 * 沿 parent 链找到子树根。成环（历史脏数据）时退回起点，不会死循环。
 * 整棵子树沿用根的颜色，脑图才会「一簇一色」而不是每张卡一个色。
 */
export function rootIdOf(
  cardId: string,
  parentOf: ReadonlyMap<string, string | null>,
): string {
  let current = cardId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parentOf.get(current)
    if (!parent) return current
    // 父卡不在这张画布里（跨画布父子、或卡片已被删）：当前可见链的顶端就是它的根。
    if (!parentOf.has(parent)) return current
    current = parent
  }
  return cardId
}

/**
 * 一次性算出整张画布的「卡片 → 色调序号」。
 *
 * 带路径压缩：1483 张卡、每张都从头走父链会是 O(n × 深度)，
 * 这里第一次走过就把整条链的根记下来，后续 O(1)。
 */
export function toneIndexMap(
  parentOf: ReadonlyMap<string, string | null>,
  overrides: Overrides = {},
): Map<string, number> {
  const roots = new Map<string, string>()
  const result = new Map<string, number>()

  const resolve = (start: string): string => {
    const path: string[] = []
    let current = start
    let root = start
    for (;;) {
      const cached = roots.get(current)
      if (cached !== undefined) {
        root = cached
        break
      }
      path.push(current)
      const parent = parentOf.get(current)
      // 父卡不在这张画布里（跨画布父子、或卡片已删）：当前可见链的顶端就是根。
      if (!parent || !parentOf.has(parent) || path.includes(parent)) {
        root = current
        break
      }
      current = parent
    }
    for (const id of path) roots.set(id, root)
    return root
  }

  for (const id of parentOf.keys()) {
    const override = overrides[id]
    result.set(id, typeof override === 'number' ? override : toneIndexOf(resolve(id)))
  }
  return result
}

const OVERRIDE_KEY = 'pdfnote.mindmap.tone'

type Overrides = Record<string, number>

let overrideCache: Overrides | null = null

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** 手动指定的色调（点徽标循环换色后写入）。一次读盘，之后走内存缓存。 */
export function toneOverrides(): Overrides {
  if (overrideCache) return overrideCache
  const store = storage()
  if (!store) {
    overrideCache = {}
    return overrideCache
  }
  try {
    const raw = store.getItem(OVERRIDE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    overrideCache = parsed && typeof parsed === 'object' ? parsed as Overrides : {}
  } catch {
    overrideCache = {}
  }
  return overrideCache
}

export function readToneOverride(cardId: string): number | null {
  const value = toneOverrides()[cardId]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function saveToneOverride(cardId: string, index: number): Overrides {
  const next = { ...toneOverrides(), [cardId]: ((index % SOLAR_TONES.length) + SOLAR_TONES.length) % SOLAR_TONES.length }
  overrideCache = next
  const store = storage()
  if (store) {
    try {
      store.setItem(OVERRIDE_KEY, JSON.stringify(next))
    } catch {
      // 存储满 / 隐私模式：颜色仍在本会话生效，只是不跨重启。
    }
  }
  return next
}

export function clearToneOverride(cardId: string): Overrides {
  const current = toneOverrides()
  if (!(cardId in current)) return current
  const next = { ...current }
  delete next[cardId]
  overrideCache = next
  const store = storage()
  try {
    store?.setItem(OVERRIDE_KEY, JSON.stringify(next))
  } catch {
    // 同上。
  }
  return next
}

/** 测试用：重置内存缓存，模拟重新读盘。 */
export function resetToneCache(): void {
  overrideCache = null
}
