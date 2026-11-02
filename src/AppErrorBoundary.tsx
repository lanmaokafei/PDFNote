import { Component, type ErrorInfo, type ReactNode } from 'react'
import { appendCrashLog, isTauriRuntime } from './services/pdfnote'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string | null
  logged: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, logged: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentStack = info.componentStack ?? null
    this.setState({ componentStack })
    console.error('PDFNote UI crashed', error, componentStack)
    // 把错误消息与 React 组件栈写入本地日志（logs/crash-*.log），
    // 生产构建里组件栈是定位渲染循环（如 React #185）的唯一线索。
    if (!isTauriRuntime() || this.state.logged) return
    const timestamp = new Date().toISOString()
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    void appendCrashLog(
      `[${timestamp}] PDFNote UI crashed\n${message}\n--- component stack ---${componentStack ?? '(unavailable)'}\n`,
    ).then(() => this.setState({ logged: true }))
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="app-crash">
        <div className="app-crash-card">
          <span className="app-crash-mark">!</span>
          <p className="app-crash-eyebrow">LOCAL DATA IS SAFE</p>
          <h1>界面暂时无法继续</h1>
          <p>你的数据库、PDF 与复习记录仍在本地磁盘中，未被删除。可以重新载入界面；若反复出现，请先通过备份文件保留数据。</p>
          <pre>{this.state.error.message}</pre>
          {this.state.componentStack && (
            <details className="app-crash-stack">
              <summary>技术细节（反馈问题时请附上）</summary>
              <pre>{this.state.componentStack}</pre>
            </details>
          )}
          <p className="app-crash-note">
            本次崩溃已自动记录到应用数据目录 logs/ 下的 crash 日志，便于后续诊断。
          </p>
          <button type="button" onClick={() => window.location.reload()}>重新载入</button>
        </div>
      </main>
    )
  }
}
