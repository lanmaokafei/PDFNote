import type { CardDensity, CardRadius, CardSurface, MindmapCardStyle } from './style'
import { DEFAULT_CARD_STYLE, MINDMAP_THEMES, applyTheme } from './style'

interface MindmapStylePanelProps {
  style: MindmapCardStyle
  onChange: (next: MindmapCardStyle) => void
  onClose: () => void
}

const SURFACES: Array<{ value: CardSurface | null; label: string }> = [
  { value: null, label: '跟随主题' },
  { value: 'paper', label: '纸白' },
  { value: 'tint', label: '淡彩' },
  { value: 'ink', label: '墨色' },
]

const RADII: Array<{ value: CardRadius | null; label: string }> = [
  { value: null, label: '跟随主题' },
  { value: 'sharp', label: '直角' },
  { value: 'soft', label: '小圆' },
  { value: 'round', label: '大圆' },
]

const DENSITIES: Array<{ value: CardDensity | null; label: string }> = [
  { value: null, label: '跟随主题' },
  { value: 'compact', label: '紧凑' },
  { value: 'normal', label: '标准' },
  { value: 'roomy', label: '宽松' },
]

/**
 * 卡片样式面板：主题一键替换整套，下面三组做单项微调。
 * 所有改动立即生效并写入当前画布的本地偏好，不需要再点保存。
 */
export function MindmapStylePanel({ style, onChange, onClose }: MindmapStylePanelProps) {
  return (
    <section className="mindmap-style-panel" data-testid="style-panel" aria-label="卡片样式">
      <header className="mindmap-style-head">
        <div>
          <h2>卡片样式</h2>
          <p>作用于当前画布，仅本机保存</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭样式面板" data-testid="style-close">×</button>
      </header>

      <div className="mindmap-style-themes" role="radiogroup" aria-label="主题">
        {MINDMAP_THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={style.theme === theme.id}
            data-testid={`style-theme-${theme.id}`}
            className={`mindmap-style-theme${style.theme === theme.id ? ' is-active' : ''}`}
            onClick={() => onChange(applyTheme(theme.id))}
          >
            <span className="mindmap-style-swatch" data-theme={theme.id} aria-hidden="true">
              <i />
              <b />
            </span>
            <strong>{theme.name}</strong>
            <small>{theme.hint}</small>
          </button>
        ))}
      </div>

      <Group
        label="卡面"
        field="surface"
        options={SURFACES}
        value={style.surface}
        onPick={(surface) => onChange({ ...style, surface })}
      />
      <Group
        label="圆角"
        field="radius"
        options={RADII}
        value={style.radius}
        onPick={(radius) => onChange({ ...style, radius })}
      />
      <Group
        label="密度"
        field="density"
        options={DENSITIES}
        value={style.density}
        onPick={(density) => onChange({ ...style, density })}
      />

      <footer className="mindmap-style-foot">
        <button
          type="button"
          data-testid="style-reset"
          onClick={() => onChange({ ...DEFAULT_CARD_STYLE })}
        >恢复默认</button>
        <span>{style.theme === DEFAULT_CARD_STYLE.theme && !style.surface && !style.radius && !style.density ? '当前为默认样式' : '已自定义'}</span>
      </footer>
    </section>
  )
}

interface GroupProps<T extends string> {
  label: string
  field: string
  options: Array<{ value: T | null; label: string }>
  value: T | null
  onPick: (value: T | null) => void
}

function Group<T extends string>({ label, field, options, value, onPick }: GroupProps<T>) {
  return (
    <div className="mindmap-style-group">
      <span className="mindmap-style-label">{label}</span>
      <div className="mindmap-style-options">
        {options.map((option) => (
          <button
            key={option.value ?? 'auto'}
            type="button"
            data-testid={`style-${field}-${option.value ?? 'auto'}`}
            className={value === option.value ? 'is-active' : ''}
            onClick={() => onPick(option.value)}
          >{option.label}</button>
        ))}
      </div>
    </div>
  )
}
