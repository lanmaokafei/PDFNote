/**
 * 脑图卡片的「样式主题」。
 *
 * 和 tone.ts（24 节气色，决定「哪一簇」）是两件事：
 * - tone 是**语义**：同一棵子树同色，用来区分知识分组；
 * - style 是**视觉**：卡面、边框、圆角、密度，决定整张画布的气质。
 *
 * 样式按画布保存（一本书一套风格），存 localStorage，不写数据库：
 * 换主题是「看」的偏好，不该占用备份体积，也不该在同步时互相覆盖。
 */

export type MindmapThemeId = 'paper' | 'minimal' | 'outline' | 'tint' | 'ink' | 'block'

export type CardSurface = 'paper' | 'tint' | 'ink'
export type CardRadius = 'sharp' | 'soft' | 'round'
export type CardDensity = 'compact' | 'normal' | 'roomy'
/** 标题栏：淡底（默认）/ 实心主色 / 纯白细线。 */
export type CardHeader = 'tint' | 'solid' | 'plain'
/** 连线：发丝灰（默认）/ 深墨圆点 / 跟随子树色调。 */
export type CardEdgeStyle = 'hairline' | 'ink' | 'tone'
/** 边框：常规 / 发丝 / 无（去掉描边与左侧色条）。 */
export type CardBorder = 'normal' | 'hairline' | 'none'
/** 关联链接（虚线）：中性蓝灰 / 跟随源卡片色调。 */
export type CardLink = 'neutral' | 'tone'

export interface MindmapThemePreset {
  id: MindmapThemeId
  name: string
  /** 菜单与面板里的短说明。 */
  hint: string
  surface: CardSurface
  radius: CardRadius
  density: CardDensity
  header: CardHeader
  edge: CardEdgeStyle
  border: CardBorder
  link: CardLink
  /** 关联链接上是否画「链接」小标签。 */
  linkLabels: boolean
}

export const MINDMAP_THEMES: MindmapThemePreset[] = [
  {
    id: 'paper', name: '宣纸', hint: '白底细边',
    surface: 'paper', radius: 'soft', density: 'normal',
    header: 'tint', edge: 'hairline', border: 'normal', link: 'neutral', linkLabels: true,
  },
  {
    id: 'minimal', name: '极简', hint: '无边框·发丝线',
    surface: 'paper', radius: 'soft', density: 'compact',
    header: 'tint', edge: 'hairline', border: 'normal', link: 'neutral', linkLabels: true,
  },
  {
    id: 'outline', name: '线框', hint: '深描边·直角',
    surface: 'paper', radius: 'sharp', density: 'normal',
    header: 'plain', edge: 'hairline', border: 'normal', link: 'neutral', linkLabels: true,
  },
  {
    id: 'tint', name: '淡彩', hint: '整卡淡底',
    surface: 'tint', radius: 'round', density: 'normal',
    header: 'tint', edge: 'hairline', border: 'normal', link: 'neutral', linkLabels: true,
  },
  {
    id: 'ink', name: '墨色', hint: '深色卡面',
    surface: 'ink', radius: 'soft', density: 'normal',
    header: 'plain', edge: 'hairline', border: 'normal', link: 'neutral', linkLabels: true,
  },
  {
    id: 'block', name: '色块', hint: '实心头·深墨连线',
    surface: 'paper', radius: 'soft', density: 'compact',
    header: 'solid', edge: 'ink', border: 'hairline', link: 'tone', linkLabels: false,
  },
]

export interface MindmapCardStyle {
  theme: MindmapThemeId
  /** null = 跟随主题预设；非 null 是用户单独调的。 */
  surface: CardSurface | null
  radius: CardRadius | null
  density: CardDensity | null
  header: CardHeader | null
  edge: CardEdgeStyle | null
  border: CardBorder | null
  link: CardLink | null
  linkLabels: boolean | null
}

export const DEFAULT_CARD_STYLE: MindmapCardStyle = {
  theme: 'paper',
  surface: null,
  radius: null,
  density: null,
  header: null,
  edge: null,
  border: null,
  link: null,
  linkLabels: null,
}

/** 把主题预设与自定义覆盖合并成最终生效的一组样式。 */
export function resolveCardStyle(style: MindmapCardStyle): {
  surface: CardSurface
  radius: CardRadius
  density: CardDensity
  header: CardHeader
  edge: CardEdgeStyle
  border: CardBorder
  link: CardLink
  linkLabels: boolean
} {
  const preset = MINDMAP_THEMES.find((item) => item.id === style.theme) ?? MINDMAP_THEMES[0]
  return {
    surface: style.surface ?? preset.surface,
    radius: style.radius ?? preset.radius,
    density: style.density ?? preset.density,
    header: style.header ?? preset.header,
    edge: style.edge ?? preset.edge,
    border: style.border ?? preset.border,
    link: style.link ?? preset.link,
    linkLabels: style.linkLabels ?? preset.linkLabels,
  }
}

export function isDefaultCardStyle(style: MindmapCardStyle): boolean {
  return style.theme === DEFAULT_CARD_STYLE.theme
    && style.surface === null
    && style.radius === null
    && style.density === null
    && style.header === null
    && style.edge === null
    && style.border === null
    && style.link === null
    && style.linkLabels === null
}

const STORAGE_PREFIX = 'pdfnote.mindmap.style'

function keyOf(canvasId: string): string {
  return `${STORAGE_PREFIX}.${canvasId}`
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

function sanitize(raw: unknown): MindmapCardStyle {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CARD_STYLE }
  const value = raw as Partial<MindmapCardStyle>
  const theme = MINDMAP_THEMES.some((item) => item.id === value.theme)
    ? value.theme as MindmapThemeId
    : DEFAULT_CARD_STYLE.theme
  const surface = value.surface === 'paper' || value.surface === 'tint' || value.surface === 'ink'
    ? value.surface
    : null
  const radius = value.radius === 'sharp' || value.radius === 'soft' || value.radius === 'round'
    ? value.radius
    : null
  const density = value.density === 'compact' || value.density === 'normal' || value.density === 'roomy'
    ? value.density
    : null
  const header = value.header === 'tint' || value.header === 'solid' || value.header === 'plain'
    ? value.header
    : null
  const edge = value.edge === 'hairline' || value.edge === 'ink' || value.edge === 'tone'
    ? value.edge
    : null
  const border = value.border === 'normal' || value.border === 'hairline' || value.border === 'none'
    ? value.border
    : null
  const link = value.link === 'neutral' || value.link === 'tone'
    ? value.link
    : null
  const linkLabels = typeof value.linkLabels === 'boolean' ? value.linkLabels : null
  return { theme, surface, radius, density, header, edge, border, link, linkLabels }
}

export function readCardStyle(canvasId: string): MindmapCardStyle {
  const store = storage()
  if (!store) return { ...DEFAULT_CARD_STYLE }
  try {
    const raw = store.getItem(keyOf(canvasId))
    return raw ? sanitize(JSON.parse(raw)) : { ...DEFAULT_CARD_STYLE }
  } catch {
    return { ...DEFAULT_CARD_STYLE }
  }
}

export function saveCardStyle(canvasId: string, style: MindmapCardStyle): MindmapCardStyle {
  const next = sanitize(style)
  const store = storage()
  if (store) {
    try {
      store.setItem(keyOf(canvasId), JSON.stringify(next))
    } catch {
      // 存储满 / 隐私模式：本会话仍然生效，只是不跨重启。
    }
  }
  return next
}

/** 选一个主题：清掉自定义覆盖，整张画布一键换风格。 */
export function applyTheme(theme: MindmapThemeId): MindmapCardStyle {
  return {
    theme,
    surface: null,
    radius: null,
    density: null,
    header: null,
    edge: null,
    border: null,
    link: null,
    linkLabels: null,
  }
}
