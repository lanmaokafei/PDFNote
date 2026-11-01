import { useCallback, useEffect, useState } from 'react'
import './App.css'
import type { BootstrapStatus } from './domain/card'
import { getBootstrapStatus } from './services/pdfnote'

type IconName = 'document' | 'mindmap' | 'review' | 'backup'

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    document: 'M7 3h7l4 4v14H7V3Zm7 0v5h4M10 12h5m-5 4h5',
    mindmap: 'M12 5v4m-6 5v-3h12v3M6 18v2m6-7v7m6-2v2M4 18h4v4H4v-4Zm6-2h4v4h-4v-4Zm6 2h4v4h-4v-4ZM9 2h6v6H9V2Z',
    review: 'M5 4h14v16H5V4Zm4 5h6m-6 4h4m-5 5 2 2 4-5',
    backup: 'M12 3v12m0 0 4-4m-4 4-4-4M5 15v5h14v-5',
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}

const milestones = [
  ['01', '卡片模型与工程骨架', '当前阶段'],
  ['02', 'PDF 导入与标注渲染', '下一阶段'],
  ['03', '三视图与 FSRS 闭环', '已规划'],
  ['04', '备份与崩溃恢复', '已提前'],
  ['05', '主动回忆与离线交付', '已规划'],
]

function App() {
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStatus(await getBootstrapStatus())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    getBootstrapStatus()
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><span>P</span></div>
          <div><strong>PDFNote</strong><small>LOCAL LIBRARY</small></div>
        </div>

        <nav className="navigation" aria-label="主要模块">
          <p className="nav-label">学习空间</p>
          <div className="nav-item active"><Icon name="document" /><span>文档</span><i>01</i></div>
          <div className="nav-item"><Icon name="mindmap" /><span>脑图</span><i>03</i></div>
          <div className="nav-item"><Icon name="review" /><span>复习</span><i>03</i></div>
          <p className="nav-label secondary">数据</p>
          <div className="nav-item"><Icon name="backup" /><span>备份与恢复</span><i>04</i></div>
        </nav>

        <div className="local-status">
          <div className="status-orbit"><span /></div>
          <div><strong>完全本地运行</strong><small>无账号 · 无云端依赖</small></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>工作区</span><b>/</b><strong>架构基础</strong></div>
          <button className="quiet-button" onClick={() => void refresh()} disabled={loading}>
            {loading ? '检查中…' : '重新自检'}
          </button>
        </header>

        <div className="content-wrap">
          <section className="intro">
            <div>
              <p className="eyebrow"><span /> CARD-CENTRIC ARCHITECTURE</p>
              <h1>一张卡片，<br /><em>三种理解方式。</em></h1>
              <p className="intro-copy">从 PDF 摘录开始，让知识在文档、脑图与复习之间自然流动。没有副本，没有同步，只有同一个 Card。</p>
            </div>
            <button className="import-button" disabled title="PDF 导入将在阶段二实现">
              <span>＋</span> 导入 PDF <small>阶段二开放</small>
            </button>
          </section>

          <section className="metrics" aria-label="本地数据状态">
            <div><span>文档</span><strong>{status?.document_count ?? '—'}</strong><small>DOCUMENTS</small></div>
            <div><span>知识卡片</span><strong>{status?.card_count ?? '—'}</strong><small>CARDS</small></div>
            <div><span>数据结构</span><strong>v{status?.schema_version ?? 1}</strong><small>SQLITE SCHEMA</small></div>
            <div className="connection-metric"><span>存储引擎</span><strong><i className={status?.database_ready ? 'online' : ''} />{status?.database_ready ? '已连接' : '浏览器预览'}</strong><small>RUSQLITE · WAL</small></div>
          </section>
          {error && <p className="error-banner">数据库自检失败：{error}</p>}

          <section className="projection-section">
            <div className="section-heading">
              <div><p className="eyebrow">ONE SOURCE OF TRUTH</p><h2>同一份数据，三个投影</h2></div>
              <span className="schema-pill">CARD AXIS · 001</span>
            </div>
            <div className="projection-grid">
              <article className="projection-card pdf-card">
                <div className="card-top"><span className="projection-icon"><Icon name="document" /></span><small>PDF PROJECTION</small><b>01</b></div>
                <div className="pdf-preview"><i /><i /><i className="highlighted" /><i /><i /></div>
                <h3>文档高亮</h3><p>source_ref 指向页码与归一化坐标，让卡片回到知识发生的位置。</p>
              </article>
              <article className="projection-card map-card">
                <div className="card-top"><span className="projection-icon"><Icon name="mindmap" /></span><small>MINDMAP PROJECTION</small><b>02</b></div>
                <div className="map-preview"><span>核心概念</span><i /><span>子节点</span></div>
                <h3>脑图节点</h3><p>parent_id 与 sort_order 描述结构，节点永不保存内容副本。</p>
              </article>
              <article className="projection-card review-card">
                <div className="card-top"><span className="projection-icon"><Icon name="review" /></span><small>REVIEW PROJECTION</small><b>03</b></div>
                <div className="review-preview"><span>Q</span><i /><i /><b>显示答案</b></div>
                <h3>复习闪卡</h3><p>FSRS 状态直接属于 Card，评分在任何视图都更新同一条记录。</p>
              </article>
            </div>
          </section>

          <section className="roadmap-section">
            <div className="section-heading"><div><p className="eyebrow">DELIVERY SEQUENCE</p><h2>从架构到完整学习闭环</h2></div><span className="progress-label">1 / 6 阶段进行中</span></div>
            <div className="milestone-list">
              {milestones.map(([number, title, label], index) => (
                <div className={`milestone ${index === 0 ? 'current' : ''}`} key={number}>
                  <span>{number}</span><strong>{title}</strong><small>{label}</small>
                </div>
              ))}
            </div>
          </section>

          <footer className="foundation-note"><span>✓</span><p><strong>数据边界已锁定</strong>　前端不直接执行 SQL；建卡、视图移除与删除由 Rust 事务保证一致性。</p></footer>
        </div>
      </main>
    </div>
  )
}

export default App
