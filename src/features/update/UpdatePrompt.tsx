import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, CloudDownload, Download, RefreshCw, Rocket } from 'lucide-react'
import {
  checkForUpdate,
  downloadUpdate,
  formatBytes,
  onUpdateProgress,
  openUpdateInstaller,
  progressPercent,
  quitApp,
  rememberDismissedVersion,
  type DownloadProgress,
  type UpdateInfo,
} from '../../services/update'
import './UpdatePrompt.css'

type Phase = 'checking' | 'available' | 'downloading' | 'downloaded' | 'installed' | 'up-to-date' | 'error'

interface UpdatePromptProps {
  /** 启动自动检查拿到的更新信息；为空则挂载后自行检查（设置里手动触发）。 */
  initialInfo?: UpdateInfo | null
  onClose: () => void
}

export function UpdatePrompt({ initialInfo, onClose }: UpdatePromptProps) {
  const [phase, setPhase] = useState<Phase>(
    initialInfo ? (initialInfo.updateAvailable ? 'available' : 'up-to-date') : 'checking',
  )
  const [info, setInfo] = useState<UpdateInfo | null>(initialInfo ?? null)
  const [downloadedPath, setDownloadedPath] = useState('')
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: 0 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const unlistenRef = useRef<(() => void) | null>(null)
  // 只在挂载时决定要不要自检：下载过程中 initialInfo 被自动检查回填也不允许打断进度监听。
  const initialInfoRef = useRef(initialInfo)

  const runCheck = useCallback(async () => {
    setPhase('checking')
    setError('')
    try {
      const result = await checkForUpdate()
      setInfo(result)
      setPhase(result.updateAvailable ? 'available' : 'up-to-date')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    if (!initialInfoRef.current) void runCheck()
    return () => {
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }, [runCheck])

  /** 点「稍后」：记住该版本不再自动弹，关闭对话框。 */
  const dismiss = () => {
    if (info?.updateAvailable) rememberDismissedVersion(info.latestVersion)
    onClose()
  }

  const startDownload = async () => {
    if (!info || busy) return
    setBusy(true)
    setError('')
    setProgress({ downloaded: 0, total: info.downloadSize })
    setPhase('downloading')
    unlistenRef.current?.()
    unlistenRef.current = await onUpdateProgress((next) => setProgress(next))
    try {
      const path = await downloadUpdate(info)
      setDownloadedPath(path)
      setPhase('downloaded')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('error')
    } finally {
      unlistenRef.current?.()
      unlistenRef.current = null
      setBusy(false)
    }
  }

  const install = async () => {
    if (!downloadedPath || busy) return
    setBusy(true)
    setError('')
    try {
      await openUpdateInstaller(downloadedPath)
      setPhase('installed')
      // 安装器窗口起来后必须退出应用：运行中的 PDFNote.app 会被 Finder 判定「正在使用中」，
      // 拖进 Applications 覆盖安装会失败。留 2 秒让用户看到提示。
      window.setTimeout(() => {
        void quitApp().catch(() => undefined)
      }, 2000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  const percent = progressPercent(progress.downloaded, progress.total)
  const locked = busy || phase === 'downloading'

  return (
    <div className="update-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !locked) dismiss()
    }}>
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header>
          <div>
            <small>UPDATE</small>
            <h2 id="update-title">软件更新</h2>
          </div>
          <button type="button" onClick={dismiss} disabled={locked} aria-label="关闭更新提示">×</button>
        </header>

        {phase === 'checking' && (
          <p className="update-status" role="status">正在检查 GitHub Releases…</p>
        )}

        {phase === 'up-to-date' && (
          <p className="update-status is-ok" role="status">
            <CheckCircle2 size={16} />
            <span>
              已是最新版本（{info?.currentVersion || '—'}）。
              <small>更新来源：GitHub Releases 正式版。</small>
            </span>
          </p>
        )}

        {phase === 'available' && info && (
          <>
            <p className="update-status is-new" role="status">
              <Rocket size={16} />
              <span>
                发现新版本 <strong>v{info.latestVersion}</strong>（当前 v{info.currentVersion}）。
                <small>包体 {formatBytes(info.downloadSize)} · SHA-256 校验 · 下载完成后需点击升级。</small>
              </span>
            </p>
            {info.releaseNotes.trim() && (
              <details className="update-notes">
                <summary>更新说明</summary>
                <pre>{info.releaseNotes.trim()}</pre>
              </details>
            )}
          </>
        )}

        {phase === 'downloading' && (
          <div className="update-progress" role="status">
            <div className="update-progress-label">
              <CloudDownload size={15} />
              <span>正在下载 v{info?.latestVersion}…</span>
              <strong>{percent}%</strong>
            </div>
            <div
              className="update-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="update-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <small>
              {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
              {progress.total > 0 && progress.downloaded >= progress.total ? '（正在校验 SHA-256…）' : ''}
            </small>
          </div>
        )}

        {phase === 'downloaded' && (
          <p className="update-status is-ready" role="status">
            <CheckCircle2 size={16} />
            <span>
              下载完成并通过 SHA-256 校验。
              <small>点击「立即升级」打开安装器，把 PDFNote.app 拖进 Applications 覆盖安装。</small>
            </span>
          </p>
        )}

        {phase === 'installed' && (
          <p className="update-status is-ok" role="status">
            <CheckCircle2 size={16} />
            <span>
              安装器已打开，应用将自动退出。
              <small>
                运行中的 PDFNote.app 无法被覆盖——本应用会在 2 秒后退出。
                退出后把 PDFNote.app 拖进 Applications 覆盖安装，再重新打开即完成升级。
              </small>
            </span>
          </p>
        )}

        {phase === 'error' && (
          <p className="update-error" role="alert">
            <AlertTriangle size={15} />
            <span>{error || '更新失败，请重试。'}</span>
          </p>
        )}

        <footer>
          {phase === 'available' && (
            <button type="button" onClick={dismiss} disabled={locked}>稍后</button>
          )}
          {phase === 'downloaded' && (
            <button type="button" onClick={dismiss} disabled={locked}>稍后</button>
          )}
          {(phase === 'checking' || phase === 'up-to-date' || phase === 'downloading') && (
            <button type="button" onClick={onClose} disabled={locked}>关闭</button>
          )}
          {phase === 'installed' && (
            <button type="button" onClick={() => { void quitApp().catch(() => undefined) }}>
              立即退出
            </button>
          )}
          {phase === 'error' && (
            <button type="button" onClick={dismiss} disabled={busy}>关闭</button>
          )}
          <span className="update-footer-spacer" />
          {phase === 'error' && (
            <button type="button" onClick={() => void runCheck()} disabled={busy} className="primary">
              <RefreshCw size={13} />
              重新检查
            </button>
          )}
          {phase === 'available' && (
            <button type="button" onClick={() => void startDownload()} disabled={locked} className="primary">
              <Download size={13} />
              下载升级
            </button>
          )}
          {phase === 'downloaded' && (
            <button type="button" onClick={() => void install()} disabled={locked} className="primary">
              <Rocket size={13} />
              立即升级
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
