import { useEffect, useState } from 'react'
import { Cpu, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import {
  EMPTY_AI_SETTINGS,
  getAiSettings,
  isAiConfigured,
  saveAiSettings,
  type AiSettings,
} from '../../services/ai'
import './SettingsDialog.css'

interface SettingsDialogProps {
  onClose: () => void
  /** 配置变化后通知调用方刷新「公式能否 AI 识别」的判断。 */
  onSaved?: (settings: AiSettings) => void
}

export function SettingsDialog({ onClose, onSaved }: SettingsDialogProps) {
  const [draft, setDraft] = useState<AiSettings>(EMPTY_AI_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    let active = true
    getAiSettings()
      .then((settings) => {
        if (!active) return
        setDraft(settings)
        setLoaded(true)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoaded(true)
      })
    return () => { active = false }
  }, [])

  const notify = (saved: AiSettings) => {
    onSaved?.(saved)
    // PDF 工作区监听此事件，实时切换「公式能否交给模型识别」。
    window.dispatchEvent(new CustomEvent<AiSettings>('pdfnote:ai-settings-changed', { detail: saved }))
  }

  const save = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await saveAiSettings(draft)
      setDraft(saved)
      setNotice(isAiConfigured(saved) ? '已保存。公式识别将使用该模型。' : '已清除模型配置，应用恢复完全离线。')
      notify(saved)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await saveAiSettings(EMPTY_AI_SETTINGS)
      setDraft(saved)
      setNotice('已清除模型配置，应用恢复完全离线。')
      notify(saved)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div>
            <small>SETTINGS</small>
            <h2 id="settings-title">AI 识别选区（可选）</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭设置">×</button>
        </header>

        <p className="settings-intro">
          <ShieldCheck size={15} />
          默认完全离线。只有在这里填写模型地址后，公式/表格识别才会把选区截图发送到该地址；
          其余功能不联网，配置保存在本机应用数据目录的 <code>settings.json</code>。
        </p>

        {!loaded && <p className="settings-status">正在读取设置…</p>}

        <label>
          <span>Base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
            placeholder="http://127.0.0.1:11434/v1"
            spellCheck={false}
            autoComplete="off"
          />
          <small>OpenAI 兼容接口。本机 Ollama 填 <code>http://127.0.0.1:11434/v1</code>；云端填服务商的 <code>/v1</code> 地址。</small>
        </label>

        <label>
          <span>模型名</span>
          <input
            value={draft.model}
            onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
            placeholder="qwen2.5vl:7b"
            spellCheck={false}
            autoComplete="off"
          />
          <small>需要能读图的视觉模型。Ollama 示例：<code>ollama pull qwen2.5vl:7b</code>；也可用 LM Studio 的本地服务。</small>
        </label>

        <label>
          <span>API Key（本机模型留空）</span>
          <div className="settings-key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏密钥' : '显示密钥'}>
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <small>Key 以明文保存在本机设置文件，不会进入备份包，也不会随备份导出。</small>
        </label>

        <p className="settings-hint">
          <Cpu size={14} />
          未配置时，公式选区仍按原逻辑保存原图，由你手动补录；配置后识别结果会写入卡片摘录（LaTeX）并保留原图对照。
        </p>

        {error && <p className="settings-error" role="alert">{error}</p>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}

        <footer>
          <button type="button" onClick={() => void clear()} disabled={busy || !isAiConfigured(draft)}>清除配置</button>
          <button type="button" onClick={() => void save()} disabled={busy || !loaded} className="primary">
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  )
}
