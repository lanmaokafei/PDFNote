import { useEffect, useRef } from 'react'
import type { ClozeExercise, ClozeResult } from './cloze'
import './ClozePanel.css'

interface ClozePanelProps {
  exercise: ClozeExercise
  answers: string[]
  result: ClozeResult | null
  /** 嵌入模式：面板浮在 PDF 上而不是待在右侧检查器里。 */
  floating?: boolean
  onAnswerChange: (index: number, value: string) => void
  onCheck: () => void
  onRetry: () => void
  onReveal: () => void
  onDisable: () => void
}

const VERDICT_LABELS = {
  correct: '对',
  close: '接近',
  wrong: '错',
  empty: '未填',
} as const

/**
 * 文档回忆里的挖空填空面板：摘录按「短语 + 空」渲染，
 * 补全后自动揭示原文并进入评分；挑不出空时退回整句回忆。
 */
export function ClozePanel({
  exercise,
  answers,
  result,
  floating = false,
  onAnswerChange,
  onCheck,
  onRetry,
  onReveal,
  onDisable,
}: ClozePanelProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])
  const blanks = exercise.blanks

  // 换卡片 / 换摘录时自动把光标放到第一个空，键盘可以直接开始填。
  useEffect(() => {
    if (blanks.length === 0) return
    const empty = answers.findIndex((value) => !value?.trim())
    const target = inputRefs.current[empty >= 0 ? empty : 0]
    target?.focus()
    // 只跟 exercise 走：答题过程中不要抢走焦点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise.excerpt])

  const focusBlank = (index: number) => {
    if (index < 0 || index >= blanks.length) return
    inputRefs.current[index]?.focus()
    inputRefs.current[index]?.select()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === 'Escape') {
      event.currentTarget.blur()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    // 中文输入法选词时回车只提交候选词，不要跳到下一空。
    if (event.nativeEvent.isComposing) return
    const next = answers.findIndex((value, position) => position > index && !value?.trim())
    if (next >= 0) focusBlank(next)
    else onCheck()
  }

  const feedbackFor = (id: string) => result?.items.find((item) => item.id === id) ?? null
  const wrongItems = result?.items.filter((item) => item.verdict !== 'correct') ?? []

  return (
    <section className={`pdf-cloze${floating ? ' is-floating' : ''}`} data-cloze-panel>
      <header className="pdf-cloze-head">
        <div>
          <small>CLOZE</small>
          <strong>挖空填空</strong>
        </div>
        <div className="pdf-cloze-head-actions">
          <span className="pdf-cloze-count">{blanks.length > 0 ? `${blanks.length} 空` : '整句'}</span>
          <button type="button" className="pdf-cloze-link" onClick={onDisable} title="关闭挖空，回到整块遮挡回忆">
            关闭
          </button>
        </div>
      </header>

      {exercise.reason ? (
        <div className="pdf-cloze-fallback">
          <p>{exercise.reason}。</p>
          <button type="button" onClick={onReveal}>揭示这段摘录</button>
        </div>
      ) : (
        <>
          <p className="pdf-cloze-sentence" data-cloze-sentence>
            {exercise.segments.map((segment, index) => {
              if (segment.kind === 'text') return <span key={`t-${index}`}>{segment.text}</span>
              const blankIndex = blanks.findIndex((blank) => blank.id === segment.blank.id)
              const feedback = feedbackFor(segment.blank.id)
              return (
                <input
                  key={segment.blank.id}
                  ref={(element) => { inputRefs.current[blankIndex] = element }}
                  type="text"
                  className={`pdf-cloze-input${feedback ? ` is-${feedback.verdict}` : ''}`}
                  data-cloze-blank={segment.blank.id}
                  data-blank-index={blankIndex}
                  value={answers[blankIndex] ?? ''}
                  onChange={(event) => onAnswerChange(blankIndex, event.target.value)}
                  onKeyDown={(event) => handleKeyDown(event, blankIndex)}
                  aria-label={`第 ${blankIndex + 1} 空，提示 ${segment.blank.hint}`}
                  title={segment.blank.hint}
                  placeholder={'·'.repeat(Math.min(segment.blank.length, 8))}
                  style={{ width: `${Math.min(14, Math.max(4, segment.blank.length + 2))}ch` }}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="text"
                />
              )
            })}
          </p>

          {result && (
            <p className={`pdf-cloze-feedback is-${result.solved ? 'solved' : 'open'}`} data-cloze-feedback>
              {result.summary}
              {wrongItems.length > 0 && (
                <span className="pdf-cloze-answers">
                  {wrongItems.map((item) => (
                    <span key={item.id}>
                      第 {blanks.findIndex((blank) => blank.id === item.id) + 1} 空
                      <b>{VERDICT_LABELS[item.verdict]}</b>
                      {item.verdict !== 'empty' && `：应为「${item.answer}」`}
                      {item.verdict === 'empty' && `：答案是「${item.answer}」`}
                    </span>
                  ))}
                </span>
              )}
            </p>
          )}

          <div className="pdf-cloze-actions">
            <button type="button" className="is-primary" onClick={onCheck} disabled={blanks.length === 0}>
              检查
            </button>
            <button type="button" onClick={onRetry} disabled={!result}>重来</button>
            <button type="button" className="pdf-cloze-reveal" onClick={onReveal}>揭示原文</button>
            <small>Enter 下一空 · 最后一空 Enter 检查</small>
          </div>
        </>
      )}
    </section>
  )
}
