import { useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { BackupResult } from '../../domain/card'
import { autoBackup, exportBackup, importBackup } from '../../services/pdfnote'
import './BackupWorkspace.css'

type ImportMode = 'merge' | 'overwrite'
type Operation = 'export' | 'import' | 'auto' | null

interface CompletedOperation {
  title: string
  path: string
  documents?: number
  cards?: number
  detail: string
}

const BACKUP_FILTERS = [{ name: 'PDFNote 备份', extensions: ['zip'] }]

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function backupFileName(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `PDFNote-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`
}

function resultFromBackup(title: string, result: BackupResult, detail: string): CompletedOperation {
  return {
    title,
    path: result.path,
    documents: result.documents,
    cards: result.cards,
    detail,
  }
}

export function BackupWorkspace() {
  const [mode, setMode] = useState<ImportMode>('merge')
  const [busy, setBusy] = useState<Operation>(null)
  const [result, setResult] = useState<CompletedOperation | null>(null)
  const [error, setError] = useState('')
  const [pendingOverwrite, setPendingOverwrite] = useState<string | null>(null)
  const locked = busy !== null || pendingOverwrite !== null

  const handleExport = async () => {
    if (locked) return
    setBusy('export')
    setResult(null)
    setError('')
    try {
      const destinationPath = await save({
        title: '选择备份保存位置',
        defaultPath: backupFileName(),
        filters: BACKUP_FILTERS,
        canCreateDirectories: true,
      })
      if (!destinationPath) return
      const backup = await exportBackup(destinationPath)
      setResult(resultFromBackup('手动备份已完成', backup, '请将备份文件复制到外部磁盘或其他可信位置，不要只保留在当前电脑中。'))
    } catch (reason) {
      setError(`导出备份失败：${errorMessage(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleAutoBackup = async () => {
    if (locked) return
    setBusy('auto')
    setResult(null)
    setError('')
    try {
      const path = await autoBackup()
      setResult({
        title: '自动备份已完成',
        path,
        detail: '备份已写入应用数据目录。自动备份用于本机恢复，不能替代独立的手动备份副本。',
      })
    } catch (reason) {
      setError(`自动备份失败：${errorMessage(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleImport = async () => {
    if (locked) return
    setBusy('import')
    setResult(null)
    setError('')
    try {
      const sourcePath = await open({
        title: '选择 PDFNote 备份文件',
        filters: BACKUP_FILTERS,
        multiple: false,
        directory: false,
      })
      if (!sourcePath) return
      if (mode === 'overwrite') {
        setPendingOverwrite(sourcePath)
        return
      }
      const backup = await importBackup(sourcePath, 'merge')
      setResult(resultFromBackup('合并导入已完成', backup, '现有数据未被预先清空，备份内容已按合并模式导入。请核对文档和卡片数量。'))
    } catch (reason) {
      setError(`导入备份失败：${errorMessage(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  const confirmOverwrite = async () => {
    if (!pendingOverwrite || busy) return
    const sourcePath = pendingOverwrite
    setPendingOverwrite(null)
    setBusy('import')
    setResult(null)
    setError('')
    try {
      const backup = await importBackup(sourcePath, 'overwrite')
      setResult(resultFromBackup('覆盖恢复已完成', backup, '当前数据已由备份内容替换。请核对文档、卡片及 PDF 文件是否完整。'))
    } catch (reason) {
      setError(`覆盖恢复失败：${errorMessage(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="backup-workspace">
      <header className="backup-header">
        <div>
          <p className="backup-eyebrow">LOCAL DATA · PORTABLE BACKUP</p>
          <h1>备份与恢复</h1>
          <p>将学习数据与 PDF 资料打包保存，在设备故障或更换电脑时恢复。</p>
        </div>
        <span className="backup-local-badge"><i />完全本地处理</span>
      </header>

      <section className="backup-safety-note" aria-label="数据安全提示">
        <span className="backup-note-mark">i</span>
        <div>
          <strong>先备份，再恢复</strong>
          <p>备份可能包含私人文献与笔记，请妥善保管。执行导入前，尤其覆盖恢复前，建议先手动导出一份当前数据。</p>
        </div>
      </section>

      {result && (
        <section className="backup-result" role="status" aria-live="polite">
          <div className="backup-result-heading">
            <span className="backup-result-mark">OK</span>
            <div><h2>{result.title}</h2><p>{result.detail}</p></div>
          </div>
          {(result.documents !== undefined || result.cards !== undefined) && (
            <div className="backup-result-counts">
              {result.documents !== undefined && <span>文档 <strong>{result.documents}</strong></span>}
              {result.cards !== undefined && <span>卡片 <strong>{result.cards}</strong></span>}
            </div>
          )}
          <div className="backup-result-path"><span>文件位置</span><code>{result.path}</code></div>
        </section>
      )}

      {error && (
        <section className="backup-error" role="alert">
          <strong>操作未完成</strong>
          <p>{error}</p>
          <span>请检查文件路径、备份文件及桌面应用运行环境。不要删除现有备份后重试。</span>
        </section>
      )}

      <div className="backup-grid">
        <section className="backup-panel">
          <div className="backup-panel-heading">
            <span className="backup-step">01</span>
            <div><h2>创建备份</h2><p>生成可携带的完整 ZIP 备份包</p></div>
          </div>

          <div className="backup-action-card">
            <div>
              <h3>手动导出</h3>
              <p>自己选择文件名和保存位置，适合换机、迁移或长期留存。</p>
            </div>
            <button className="backup-primary" type="button" onClick={() => void handleExport()} disabled={locked}>
              {busy === 'export' ? '正在导出…' : '选择位置并导出'}
            </button>
          </div>

          <div className="backup-action-card secondary">
            <div>
              <h3>立即自动备份</h3>
              <p>写入应用数据目录中的 backups 文件夹，无需选择路径。</p>
            </div>
            <button type="button" onClick={() => void handleAutoBackup()} disabled={locked}>
              {busy === 'auto' ? '正在备份…' : '创建自动备份'}
            </button>
          </div>

          <p className="backup-panel-footnote">自动备份仍位于本机。为防止磁盘损坏导致同时丢失，请另外保留手动导出的副本。</p>
        </section>

        <section className="backup-panel">
          <div className="backup-panel-heading">
            <span className="backup-step">02</span>
            <div><h2>导入与恢复</h2><p>从已有 PDFNote ZIP 备份恢复数据</p></div>
          </div>

          <fieldset className="backup-mode" disabled={locked}>
            <legend>选择导入方式</legend>
            <label className={mode === 'merge' ? 'selected' : ''}>
              <input type="radio" name="backup-mode" value="merge" checked={mode === 'merge'} onChange={() => setMode('merge')} />
              <span><strong>合并导入</strong><small>保留当前数据，不会先清空；将备份内容合并到当前库。</small></span>
            </label>
            <label className={mode === 'overwrite' ? 'selected danger' : 'danger'}>
              <input type="radio" name="backup-mode" value="overwrite" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
              <span><strong>覆盖恢复</strong><small>用备份替换当前数据；仅存在于当前库的内容将丢失。</small></span>
            </label>
          </fieldset>

          <button className={`backup-import ${mode === 'overwrite' ? 'danger' : ''}`} type="button" onClick={() => void handleImport()} disabled={locked}>
            {busy === 'import' ? '正在处理…' : mode === 'overwrite' ? '选择备份并覆盖恢复' : '选择备份并合并导入'}
          </button>
          <p className="backup-import-hint">
            {mode === 'overwrite' ? '选择文件后还会要求再次确认，确认前不会执行覆盖。' : '适合把另一台设备的内容加入当前资料库。'}
          </p>
        </section>
      </div>

      <section className="backup-migration">
        <div className="backup-migration-heading">
          <span className="backup-step">03</span>
          <div><h2>换机恢复步骤</h2><p>按顺序操作，避免遗漏 PDF 或学习记录</p></div>
        </div>
        <ol>
          <li><span>1</span><div><strong>在旧电脑导出</strong><p>点击“选择位置并导出”，等待显示文档和卡片数量。</p></div></li>
          <li><span>2</span><div><strong>安全转移备份包</strong><p>通过移动硬盘或可信传输方式，将完整 ZIP 文件复制到新电脑。</p></div></li>
          <li><span>3</span><div><strong>在新电脑导入</strong><p>空资料库可选择覆盖恢复；已有数据时先备份，再按需选择合并。</p></div></li>
          <li><span>4</span><div><strong>核对恢复结果</strong><p>检查文档、卡片、PDF 页面与复习状态，确认无误后再清理旧副本。</p></div></li>
        </ol>
      </section>

      <footer className="backup-footer-note">
        <strong>数据安全说明</strong>
        <p>备份与导入均由 PDFNote 桌面端在本地执行，本界面不上传文件。导入期间请保持应用运行，并确保目标磁盘有足够可用空间。</p>
      </footer>

      {pendingOverwrite && (
        <div className="backup-dialog-backdrop" role="presentation">
          <section className="backup-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="overwrite-title" aria-describedby="overwrite-description">
            <span className="backup-warning-mark">!</span>
            <h2 id="overwrite-title">确认覆盖当前数据？</h2>
            <p id="overwrite-description">此操作会用备份内容替换当前资料库，仅存在于当前库中的文档、卡片和复习记录将无法从当前库找回。</p>
            <div className="backup-confirm-file"><span>待导入文件</span><code>{pendingOverwrite}</code></div>
            <p className="backup-confirm-advice">如果尚未备份当前数据，请取消并先手动导出。</p>
            <div className="backup-confirm-actions">
              <button type="button" onClick={() => setPendingOverwrite(null)} autoFocus>取消，保留当前数据</button>
              <button className="danger" type="button" onClick={() => void confirmOverwrite()}>确认覆盖并恢复</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default BackupWorkspace
