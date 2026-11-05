import { useState } from 'react'
import type { MindmapCanvas } from '../../domain/card'
import {
  createMindmapCanvas,
  deleteMindmapCanvas,
  listMindmapCanvases,
  renameMindmapCanvas,
} from '../../services/pdfnote'
import { DEFAULT_CANVAS_ID, canvasScopeLabel } from './canvas'

interface CanvasSwitcherProps {
  documentId?: string | null
  canvasId: string
  canvases: MindmapCanvas[]
  busy: boolean
  compact?: boolean
  onSelect: (id: string) => void
  /** 画布列表变化后由工作区统一刷新；activeId 用于新建/删除后切换选中项。 */
  onCanvasesChanged: (canvases: MindmapCanvas[], activeId?: string) => void
  onError: (message: string) => void
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** 画布下拉 + 新建 / 重命名 / 删除；独立视图与嵌入分栏共用。 */
export function CanvasSwitcher({
  documentId,
  canvasId,
  canvases,
  busy,
  compact = false,
  onSelect,
  onCanvasesChanged,
  onError,
}: CanvasSwitcherProps) {
  const [dialog, setDialog] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const [bindToDocument, setBindToDocument] = useState(true)
  const [pending, setPending] = useState(false)
  const current = canvases.find((canvas) => canvas.id === canvasId)

  const refresh = async (activeId?: string) => {
    const list = await listMindmapCanvases(documentId ?? null)
    onCanvasesChanged(list, activeId)
  }

  const openCreate = () => {
    setName(`脑图 ${canvases.length + 1}`)
    setBindToDocument(Boolean(documentId))
    setDialog('create')
  }
  const openRename = () => {
    setName(current?.name ?? '')
    setDialog('rename')
  }

  const submit = async () => {
    if (pending) return
    setPending(true)
    try {
      if (dialog === 'create') {
        const created = await createMindmapCanvas({
          id: crypto.randomUUID(),
          name: name.trim(),
          document_id: bindToDocument && documentId ? documentId : null,
        })
        await refresh(created.id)
      } else if (dialog === 'rename' && current) {
        await renameMindmapCanvas(current.id, name.trim())
        await refresh()
      } else if (dialog === 'delete' && current && current.id !== DEFAULT_CANVAS_ID) {
        await deleteMindmapCanvas(current.id)
        await refresh(DEFAULT_CANVAS_ID)
      }
      setDialog(null)
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={`mindmap-canvas-switcher${compact ? ' is-compact' : ''}`}>
      <label className="mindmap-canvas-picker">
        <span>画布</span>
        <select
          aria-label="选择脑图画布"
          data-testid="canvas-select"
          value={canvasId}
          disabled={busy || !canvases.length}
          onChange={(event) => onSelect(event.target.value)}
        >
          {canvases.length === 0 && <option value={canvasId}>{canvasId}</option>}
          {canvases.map((canvas) => (
            <option key={canvas.id} value={canvas.id}>
              {canvas.name} · {canvas.document_id ? '本书' : '全局'} · {canvas.card_count} 张
            </option>
          ))}
        </select>
      </label>
      <button type="button" data-testid="canvas-create" onClick={openCreate} disabled={busy} title="新增画布">＋</button>
      <button type="button" data-testid="canvas-rename" onClick={openRename} disabled={busy || !current} title="重命名画布">重命名</button>
      <button
        type="button"
        data-testid="canvas-delete"
        className="is-danger"
        onClick={() => setDialog('delete')}
        disabled={busy || !current || current.id === DEFAULT_CANVAS_ID}
        title="删除画布（保留卡片内容）"
      >
        删除
      </button>

      {dialog && (
        <div className="mindmap-canvas-dialog" role="dialog" aria-modal="true">
          <div className="mindmap-canvas-dialog-card">
            <strong>
              {dialog === 'create' ? '新增脑图画布' : dialog === 'rename' ? '重命名画布' : '删除画布'}
            </strong>
            {dialog === 'delete' ? (
              <p>
                将移除「{current?.name}」上的 {current?.card_count ?? 0} 个节点布局，卡片内容仍保留在其他画布或资料库里。此操作不可撤销。
              </p>
            ) : (
              <>
                <input
                  autoFocus
                  aria-label="画布名称"
                  data-testid="canvas-name"
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
                  placeholder="画布名称"
                />
                {dialog === 'create' && documentId && (
                  <label className="mindmap-canvas-bind">
                    <input
                      type="checkbox"
                      data-testid="canvas-bind"
                      checked={bindToDocument}
                      onChange={(event) => setBindToDocument(event.target.checked)}
                    />
                    绑定到当前这本书（取消勾选则创建全局画布）
                  </label>
                )}
                {dialog === 'create' && !documentId && (
                  <p className="mindmap-canvas-hint">独立脑图视图里新建的是全局画布；打开某本书后可再建专属画布。</p>
                )}
                <p className="mindmap-canvas-hint">新建后卡片与坐标与现有画布完全隔离。</p>
              </>
            )}
            <div className="mindmap-canvas-dialog-actions">
              <button type="button" onClick={() => setDialog(null)} disabled={pending}>取消</button>
              <button
                type="button"
                className={dialog === 'delete' ? 'is-danger primary' : 'primary'}
                data-testid="canvas-submit"
                onClick={() => void submit()}
                disabled={pending || (dialog !== 'delete' && !name.trim())}
              >
                {pending ? '处理中…' : dialog === 'delete' ? '删除画布' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
      <span className="mindmap-canvas-scope">{canvasScopeLabel(documentId)} · {canvases.length} 张画布</span>
    </div>
  )
}
