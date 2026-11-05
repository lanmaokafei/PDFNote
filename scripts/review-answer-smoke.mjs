import { chromium } from 'playwright-core'

/**
 * 复习工作区「主动回忆输入 → 答案对比反馈」端到端冒烟。
 * 运行前需 dev server（npm run dev -- --host 127.0.0.1）。
 * 覆盖：提示已替换、揭示前不泄露答案、快捷键揭示、匹配度实时更新、
 * 清空回落、评分后输入框重置、无文字答案的降级反馈。
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
    id: 'r1',
    question: '线粒体的主要功能是什么？',
    excerpt: '线粒体是细胞的能量工厂，负责通过氧化磷酸化产生 ATP。',
    user_note: 'ATP 是细胞内通用的能量货币。',
  },
  {
    ...baseCard,
    id: 'r2',
    question: '这张卡片没有文字答案',
    excerpt: '',
    user_note: '',
  },
]

const fullAnswer = `${cards[0].excerpt}${cards[0].user_note}`

await page.addInitScript(({ cards }) => {
  const state = cards.map((card) => ({ ...card }))
  window.__reviewCalls = []
  window.__cardState = state
  const stats = {
    due_now: state.length,
    completed_today: 0,
    correct_today: 0,
    backlog: 0,
    daily: [],
  }
  const handlers = {
    get_bootstrap_status: () => ({
      database_ready: true,
      schema_version: 9,
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

function parsePercent(text) {
  const match = /(\d+)%/.exec(text ?? '')
  return match ? Number(match[1]) : -1
}

try {
  await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-shell')
  await page.getByRole('tab', { name: /复习/ }).first().click()
  await page.waitForSelector('.review-card', { timeout: 10000 })

  const input = page.locator('[data-testid="review-recall-input"]')
  const feedback = page.locator('[data-testid="review-match"]')
  const level = page.locator('[data-testid="review-match-level"]')
  const score = page.locator('[data-testid="review-match-score"]')
  const hit = page.locator('[data-testid="review-match-hit"]')
  const miss = page.locator('[data-testid="review-match-miss"]')

  const body = await page.locator('body').innerText()
  check(!body.includes('请在心里组织答案'), '旧静态提示仍然存在')
  check(await input.isVisible(), '主动回忆输入框没有渲染')
  check(await feedback.count() === 0, '揭示答案前就渲染了对比反馈')
  check(await page.locator('.review-answer').count() === 0, '揭示答案前就显示了背面')
  check(!body.includes('能量工厂'), '揭示答案前泄露了参考答案')

  // 完整答案 + Ctrl+Enter 揭示
  await input.fill(fullAnswer)
  await input.press('Control+Enter')
  await feedback.waitFor({ timeout: 4000 })
  const exactLevel = await level.innerText()
  const exactScore = parsePercent(await score.innerText())
  check(exactLevel.includes('很接近'), `完整答案应判为「很接近」，实际 ${exactLevel}`)
  check(exactScore >= 90, `完整答案匹配度应接近满分，实际 ${exactScore}%`)
  check(await hit.count() === 1, '完整答案应展示已写到的要点')
  check(await miss.count() === 0, '完整答案不应有待补要点')
  check(await page.locator('.review-answer').count() === 1, '快捷键没有揭示背面')
  await page.screenshot({ path: '/tmp/pdfnote-review-answer-full.png', fullPage: true })

  // 改成无关内容，反馈应实时变差
  await input.fill('今天天气很好适合散步')
  await page.waitForTimeout(120)
  const missLevel = await level.innerText()
  const missScore = parsePercent(await score.innerText())
  check(missLevel.includes('偏差'), `无关输入应判为「偏差较大」，实际 ${missLevel}`)
  check(missScore < exactScore, `无关输入匹配度应下降：${exactScore}% → ${missScore}%`)
  check(await miss.count() === 1, '无关输入应展示待补要点')

  // 清空输入：不泄露要点、不显示百分比
  await page.getByRole('button', { name: '清空' }).click()
  await page.waitForTimeout(120)
  check((await level.innerText()).includes('未输入'), '清空后没有回到「未输入」')
  check(await score.count() === 0, '未输入时不应显示匹配度')
  check(await hit.count() === 0 && await miss.count() === 0, '未输入时仍泄露了答案要点')

  // 只写关键词：部分命中且要点可读
  await input.fill('线粒体产生 ATP')
  await page.waitForTimeout(120)
  const partialScore = parsePercent(await score.innerText())
  check(partialScore > missScore && partialScore < exactScore, `部分答案匹配度应在两者之间：${partialScore}%`)
  check((await hit.innerText()).includes('线粒体'), '已写到要点里没有「线粒体」')
  check((await miss.innerText()).includes('货币'), '待补要点里没有第二句的内容')

  // 评分进入下一张：输入与反馈都必须复位
  await page.locator('.review-rating.good').click()
  await page.waitForTimeout(700)
  check((await page.locator('.review-question h2').innerText()).includes('没有文字答案'), '评分后没有进入第二张卡')
  check((await input.inputValue()) === '', '切卡后输入没有清空')
  check(await feedback.count() === 0, '切卡后仍显示上一张的对比反馈')
  check((await page.evaluate(() => window.__reviewCalls.length)) === 1, '评分没有提交一次复习记录')

  // 无文字答案的降级反馈
  await page.locator('[data-testid="review-reveal"]').click()
  await feedback.waitFor({ timeout: 4000 })
  check((await level.innerText()).includes('无文字答案'), '无文字答案未给出降级反馈')
  check(await score.count() === 0, '无文字答案不应显示匹配度')

  await page.screenshot({ path: '/tmp/pdfnote-review-answer.png', fullPage: true })
} catch (error) {
  problems.push(`smoke aborted: ${error.stack ?? error.message}`)
}

console.log(JSON.stringify({ step: 'review-answer', problems }, null, 2))
await browser.close()
process.exit(problems.length ? 1 : 0)
