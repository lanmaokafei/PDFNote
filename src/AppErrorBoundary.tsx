import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('PDFNote UI crashed', error, info.componentStack)
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
          <button type="button" onClick={() => window.location.reload()}>重新载入</button>
        </div>
      </main>
    )
  }
}
