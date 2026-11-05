import { useCallback, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FileText, Loader2, X } from 'lucide-react'
import {
  importAnkiTxt,
  previewAnkiTxt,
  type AnkiImportResult,
  type AnkiPreview,
} from '../../services/anki'
import './AnkiImportDialog.css'

interface AnkiImportDialogProps {
  canvasId: string
  canvasName: string
  busy: boolean
  onClose: () => void
  onImported: (result: AnkiImportResult) => void
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** 解析 AnkiDroid 导出 txt → 勾选牌组 → 批量写入当前画布。 */
export function AnkiImportDialog({
  canvasId,
  canvasName,
  busy,
  onClose,
  onImported,
}: AnkiImportDialogProps) {
  const [sourcePath, setSourcePath] = useState('')
  const [preview, setPreview] = useState<AnkiPreview | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  const chooseFile = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'AnkiDroid 导出', extensions: ['txt'] }],
      })
      if (!picked) return
      const path = Array.isArray(picked) ? picked[0] : picked
      const result = await previewAnkiTxt(path)
      setSourcePath(path)
      setPreview(result)
      setSelected(new Set(result.decks.map((deck) => deck.name)))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  const toggleDeck = (name: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const selectedCount = useMemo(
    () => preview?.decks
      .filter((deck) => selected.has(deck.name))
      .reduce((sum, deck) => sum + deck.count, 0) ?? 0,
    [preview, selected],
  )

  const runImport = async () => {
    if (!sourcePath || !preview || importing) return
    setImporting(true)
    setError('')
    try {
      const result = await importAnkiTxt({
        source_path: sourcePath,
        canvas_id: canvasId,
        deck_names: [...selected],
      })
      onImported(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="anki-dialog-backdrop" role="presentation">
      <div className="anki-dialog" role="dialog" aria-modal="true" aria-label="导入 Anki 牌组">
        <header className="anki-dialog-head">
          <div>
            <span className="anki-eyebrow">ANKIDROID TXT</span>
            <h2><FileText size={16} /> 导入 Anki 牌组</h2>
            <p>问题与答案变成脑图卡片，牌组 <code>::</code> 层级变成分组节点。目标画布：<strong>{canvasName}</strong></p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="anki-dialog-body">
          <button type="button" className="anki-pick" data-testid="anki-pick" onClick={() => void chooseFile()} disabled={loading || importing}>
            {loading ? <Loader2 size={14} className="is-spinning" /> : <FileText size={14} />}
            {sourcePath ? '重新选择 txt 文件' : '选择 AnkiDroid 导出的 txt 文件'}
          </button>
          {sourcePath && <p className="anki-path" title={sourcePath}>{sourcePath}</p>}

          {preview && (
            <>
              <div className="anki-summary" data-testid="anki-summary">
                <span>{preview.format === 'anki-standard' ? '标准导出（含牌组 / 答案）' : '仅正面导出'}</span>
                <strong data-testid="anki-total">{preview.total} 张卡片</strong>
                <span>{preview.has_answers ? '含答案' : '无答案列'}</span>
                <span>{preview.decks.length} 个牌组</span>
              </div>

              <div className="anki-decks">
                <div className="anki-decks-head">
                  <strong>选择要导入的牌组</strong>
                  <div>
                    <button type="button" onClick={() => setSelected(new Set(preview.decks.map((deck) => deck.name)))}>全选</button>
                    <button type="button" onClick={() => setSelected(new Set())}>全不选</button>
                  </div>
                </div>
                {preview.decks.map((deck) => (
                  <label key={deck.name} className="anki-deck-row" data-testid="anki-deck">
                    <input
                      type="checkbox"
                      checked={selected.has(deck.name)}
                      onChange={() => toggleDeck(deck.name)}
                    />
                    <span className="anki-deck-name">{deck.name}</span>
                    <span className="anki-deck-count">{deck.count} 张</span>
                  </label>
                ))}
              </div>

              <div className="anki-samples">
                <strong>内容预览（前 {preview.samples.length} 条）</strong>
                {preview.samples.map((sample, index) => (
                  <div className="anki-sample" key={`${index}-${sample.front}`}>
                    <span className="anki-sample-deck">{sample.deck}</span>
                    <p className="anki-sample-front">{sample.front}</p>
                    {sample.back && <p className="anki-sample-back">{sample.back}</p>}
                  </div>
                ))}
              </div>
            </>
          )}
          {error && <p className="anki-error" role="alert">{error}</p>}
        </div>

        <footer className="anki-dialog-foot">
          <span>将导入 {selectedCount} 张卡片（重复题目会跳过）</span>
          <div>
            <button type="button" onClick={onClose} disabled={importing}>取消</button>
            <button
              type="button"
              className="primary"
              data-testid="anki-import"
              onClick={() => void runImport()}
              disabled={!preview || busy || importing || selectedCount === 0 || loading}
            >
              {importing ? '导入中…' : '导入到当前画布'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
