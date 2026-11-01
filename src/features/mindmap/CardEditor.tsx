import { useState, type FormEvent } from 'react'
import type { Card } from '../../domain/card'

export interface CardDraft {
  question: string
  excerpt: string
  user_note: string
}

interface CardEditorProps {
  card: Card | null
  busy: boolean
  onClose: () => void
  onSave: (draft: CardDraft) => Promise<boolean>
}

export function CardEditor({ card, busy, onClose, onSave }: CardEditorProps) {
  const [draft, setDraft] = useState<CardDraft>({
    question: card?.question ?? '',
    excerpt: card?.excerpt ?? '',
    user_note: card?.user_note ?? '',
  })
  const [validationError, setValidationError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.question.trim() && !draft.excerpt.trim() && !draft.user_note.trim()) {
      setValidationError('问题、摘录和笔记至少填写一项。')
      return
    }
    setValidationError('')
    await onSave(draft)
  }

  return (
    <div className="mindmap-overlay">
      <aside className="mindmap-editor" role="dialog" aria-modal="true" aria-labelledby="mindmap-editor-title">
        <header>
          <div>
            <span className="mindmap-eyebrow">{card ? 'EDIT CARD' : 'NEW INDEPENDENT CARD'}</span>
            <h2 id="mindmap-editor-title">{card ? '编辑卡片' : '新建独立卡片'}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭编辑器">×</button>
        </header>
        <p className="mindmap-editor-description">
          {card ? '保存后通过 loadCards 同步文档、脑图与复习视图。' : '不设置父节点；创建后可拖动到另一节点上建立层级。'}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>问题</span>
            <textarea
              autoFocus
              rows={3}
              value={draft.question}
              onChange={(event) => setDraft((current) => ({ ...current, question: event.target.value }))}
              placeholder="这张卡片要帮助你回忆什么？"
            />
          </label>
          <label>
            <span>原文摘录</span>
            <textarea
              rows={6}
              value={draft.excerpt}
              onChange={(event) => setDraft((current) => ({ ...current, excerpt: event.target.value }))}
              placeholder="保留与问题相关的原文或上下文"
            />
          </label>
          <label>
            <span>个人笔记</span>
            <textarea
              rows={5}
              value={draft.user_note}
              onChange={(event) => setDraft((current) => ({ ...current, user_note: event.target.value }))}
              placeholder="记录你的理解、联想或补充"
            />
          </label>
          {validationError && <p className="mindmap-form-error" role="alert">{validationError}</p>}
          <footer>
            <button type="button" className="mindmap-button" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="mindmap-button primary" disabled={busy}>
              {busy ? '保存中…' : card ? '保存修改' : '创建卡片'}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  )
}

export type ConfirmationKind = 'remove' | 'delete'

interface ConfirmationDialogProps {
  kind: ConfirmationKind
  cardTitle: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmationDialog({ kind, cardTitle, busy, onCancel, onConfirm }: ConfirmationDialogProps) {
  const removing = kind === 'remove'
  return (
    <div className="mindmap-overlay confirmation">
      <section className="mindmap-confirm" role="alertdialog" aria-modal="true" aria-labelledby="mindmap-confirm-title">
        <span className={`mindmap-confirm-mark ${kind}`} aria-hidden="true">{removing ? '−' : '!'}</span>
        <span className="mindmap-eyebrow">{removing ? 'REMOVE PROJECTION' : 'PERMANENT DELETE'}</span>
        <h2 id="mindmap-confirm-title">{removing ? '仅从脑图移除？' : '彻底删除这张卡片？'}</h2>
        <p className="mindmap-confirm-card">“{cardTitle}”</p>
        {removing ? (
          <p>只关闭此卡片的脑图投影，<strong>PDF 标注与复习记录都会保留</strong>。子节点将按现有数据规则重新连接。</p>
        ) : (
          <p>将永久删除卡片及其内容，<strong>PDF 与复习视图也无法再使用它</strong>。此操作不可撤销。</p>
        )}
        <footer>
          <button type="button" className="mindmap-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className={`mindmap-button ${removing ? 'warning' : 'danger'}`} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : removing ? '确认移除脑图' : '确认彻底删除'}
          </button>
        </footer>
      </section>
    </div>
  )
}
