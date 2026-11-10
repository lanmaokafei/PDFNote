import { chromium } from 'playwright-core'

/**
 * 复习工作区「挖空复习」端到端冒烟（0.40.0）。
 * 运行前需 dev server（npm run dev -- --host 127.0.0.1）。
 * 覆盖：默认关闭 → 打开后正面换成填空、揭示前不泄露背面 → 答错标红并给出答案、
 * 不揭示背面 → 重来 / 全对自动揭示背面并出现评分 → 无摘录卡片退回自由作答 →
 * 偏好持久化 → 关闭后回到自由作答。
 */
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const problems = []

page.on('pageerror', (error) => problems.push(`pageerror: ${error.stack ?? error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

const baseCard = {
  source_ref: null,
  tags: [],
  excerpt_image: null,
  link_aliases: '',
  parent_id: null,
  sort_order: 0,
  collapsed: false,
  stability: 0,
  difficulty: 0,
  elapsed_days: 0,
  scheduled_days: 0,
  learning_steps: 0,
  due: '2026-11-03T00:00:00.000Z',
  last_review: null,
  reps: 0,
  lapses: 0,
  review_state: 'new',
  surface_pdf: false,
  surface_mindmap: true,
  surface_review: true,
  created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z',
}

const cards = [
  {
    ...baseCard,
    id: 'c1',
    question: '线粒体的功能是什么？',
    excerpt: '线粒体是细胞的能量工厂，负责通过氧化磷酸化产生 ATP。',
    user_note: 'ATP 是细胞内通用的能量货币。',
  },
  {
    ...baseCard,
    id: 'c2',
    question: '这张卡片没有摘录，只能自由作答',
    excerpt: '',
    user_note: '',
  },
]

await page.addInitScript(({ cards }) => {
  const state = cards.map((card) => ({ ...card }))
  window.__cardState = state
  window.__reviewCalls = []
  const stats = { due_now: state.length, completed_today: 0, correct_today: 0, backlog: 0, daily: [] }
  const handlers = {
    get_bootstrap_status: () => ({
      database_ready: true,
      schema_version: 11,
      document_count: 0,
      card_count: state.length,
    }),
    list_documents: () => [],
    list_cards: () => state,
    list_due_cards: () => state,
    get_review_stats: () => stats,
    update_card_content: (args) => {
      const input = args?.input ?? {}
      const index = state.findIndex((card) => card.id === input.id)
      if (index < 0) return null
      state[index] = { ...state[index], ...input }
      return state[index]
    },
    record_review: (args) => {
      window.__reviewCalls.push(args?.input ?? {})
      const card = state.find((item) => item.id === args?.input?.card_id)
      return card ? { ...card, due: '2026-12-01T00:00:00.000Z' } : null
    },
    auto_backup: () => null,
  }
  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      const handler = handlers[command]
      return Promise.resolve(handler ? handler(args) : null)
    },
    transformCallback: (callback) => callback,
  }
}, { cards })

function check(condition, message) {
  if (!condition) problems.push(message)
}

const openReview = async () => {
  await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-shell')
  await page.getByRole('tab', { name: /复习/ }).first().click()
  await page.waitForSelector('.review-card', { timeout: 10000 })
}

try {
  await openReview()

  const toggle = page.locator('[data-testid="review-cloze-toggle"]')
  check(await toggle.isVisible(), '头部没有挖空复习开关')
  check(!(await toggle.getAttribute('aria-pressed'))?.includes('true'), '挖空复习默认不应开启')
  check(await page.locator('[data-testid="review-recall-input"]').count() === 1, '默认没有自由作答输入框')

  // 打开挖空：正面换成「摘录 + 空」，背面必须仍然隐藏。
  await toggle.click()
  await page.waitForTimeout(250)
  check((await toggle.getAttribute('aria-pressed')) === 'true', '开关没有进入激活态')
  check(await page.locator('[data-testid="review-recall-input"]').count() === 0, '挖空模式下仍渲染了自由作答输入框')
  const blanks = await page.locator('.pdf-cloze-input').count()
  check(blanks >= 1, `挖空没有生成输入框：${blanks}`)
  check(await page.locator('.review-answer').count() === 0, '挖空未完成就揭示了背面')
  const frontText = await page.locator('.review-card').innerText()
  check(frontText.includes('细胞的'), '挖空句子没有保留上下文（整句被藏了）')

  // 答错：标红 + 给出正确答案，但绝不揭示背面、不出现评分。
  await page.locator('.pdf-cloze-input').first().fill('完全不对的答案')
  await page.locator('.pdf-cloze-actions button.is-primary').click()
  await page.waitForTimeout(250)
  const afterWrong = await page.evaluate(() => ({
    feedback: document.querySelector('[data-cloze-feedback]')?.textContent ?? '',
    wrong: document.querySelectorAll('.pdf-cloze-input.is-wrong').length,
    answer: document.querySelectorAll('.review-answer').length,
    rating: document.querySelectorAll('.review-rating').length,
  }))
  check(afterWrong.feedback.includes('应为'), `答错没有给出正确答案：${afterWrong.feedback}`)
  check(afterWrong.wrong >= 1, '答错没有标红')
  check(afterWrong.answer === 0, '答错却揭示了背面')
  check(afterWrong.rating === 0, '未揭示就出现了评分按钮')

  // 重来后空着检查一次，把所有标准答案读出来，再逐空填对。
  await page.locator('.pdf-cloze-actions button', { hasText: '重来' }).click()
  await page.waitForTimeout(150)
  await page.locator('.pdf-cloze-actions button.is-primary').click()
  await page.waitForTimeout(250)
  const emptyFeedback = await page.locator('[data-cloze-feedback]').textContent()
  const answers = [...emptyFeedback.matchAll(/(?:应为|答案是)「(.+?)」/g)].map((match) => match[1])
  check(answers.length === blanks, `正确答案数量不匹配：${answers.length}/${blanks}`)
  for (let index = 0; index < answers.length; index += 1) {
    await page.locator('.pdf-cloze-input').nth(index).fill(answers[index])
  }
  await page.locator('.pdf-cloze-actions button.is-primary').click()
  await page.waitForTimeout(400)
  const solved = await page.evaluate(() => ({
    answer: document.querySelectorAll('.review-answer').length,
    done: document.querySelectorAll('[data-testid="review-cloze-done"]').length,
    rating: document.querySelectorAll('.review-rating').length,
    notice: document.querySelector('.review-notice')?.textContent ?? '',
  }))
  check(solved.answer === 1, '全部答对后没有揭示背面')
  check(solved.done === 1, '全部答对后没有收起填空面板')
  check(solved.rating === 4, `全部答对后评分按钮数量不对：${solved.rating}`)
  check(solved.notice.includes('全部补齐'), `缺少完成提示：${solved.notice}`)
  await page.screenshot({ path: '/tmp/pdfnote-review-cloze.png', fullPage: true })

  // 评分进入下一张（无摘录）：退回自由作答并说明原因。
  await page.locator('.review-rating.good').click()
  await page.waitForTimeout(600)
  check((await page.locator('.review-question h2').innerText()).includes('没有摘录'), '评分后没有进入下一张')
  check(await page.locator('[data-testid="review-recall-input"]').count() === 1, '无摘录卡片没有退回自由作答')
  check(await page.locator('[data-testid="review-cloze-fallback"]').count() === 1, '无摘录卡片没有给出降级说明')
  check(await page.locator('.pdf-cloze-input').count() === 0, '无摘录卡片仍渲染了填空')

  // 偏好持久化：刷新后仍处于挖空模式。
  await openReview()
  check((await page.locator('[data-testid="review-cloze-toggle"]').getAttribute('aria-pressed')) === 'true', '刷新后挖空偏好没有保留')
  check(await page.locator('.pdf-cloze-input').count() >= 1, '刷新后没有进入挖空模式')

  // 关闭：回到自由作答。
  await page.locator('[data-testid="review-cloze-toggle"]').click()
  await page.waitForTimeout(250)
  check(await page.locator('.pdf-cloze-input').count() === 0, '关闭后仍渲染填空')
  check(await page.locator('[data-testid="review-recall-input"]').count() === 1, '关闭后没有回到自由作答')
} catch (error) {
  problems.push(`smoke aborted: ${error.stack ?? error.message}`)
}

console.log(JSON.stringify({ step: 'review-cloze', problems }, null, 2))
await browser.close()
process.exit(problems.length ? 1 : 0)
