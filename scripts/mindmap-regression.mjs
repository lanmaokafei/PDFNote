import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

/**
 * 复现 React #185：mock Tauri IPC，打开文档进入「左 PDF 右脑图」工作台，
 * 观察内嵌脑图（defaultViewport zoom 0.9）是否触发 Maximum update depth exceeded。
 * 运行前需 dev server（npm run dev -- --host 127.0.0.1）。
 */
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const problems = []

page.on('pageerror', (error) => problems.push(`pageerror: ${error.stack ?? error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

const baseCard = {
  source_ref: null,
  tags: [],
  user_note: '',
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

const CARD_COUNT = Number(process.env.CARD_COUNT ?? 3)
// 1x1 PNG，模拟带公式截图的卡片节点（图片会改变节点高度）。
const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const cards = Array.from({ length: CARD_COUNT }, (_, index) => ({
  ...baseCard,
  id: `c${index + 1}`,
  question: `概念卡片 ${index + 1}：心肌梗死与再灌注策略`,
  excerpt: index % 3 === 0 ? '典型胸痛 + ST 段改变 + 心肌酶升高，需要尽快再灌注。' : '',
  excerpt_image: index % 4 === 0 ? THUMB : null,
  parent_id: index === 0 ? null : `c${Math.max(1, Math.floor(index / 3) + 1)}`,
  sort_order: index,
}))

const document = {
  id: 'doc1',
  title: '测试教材',
  stored_path: 'pdfs/mini.pdf',
  original_path: null,
  content_hash: 'hash',
  file_size: 11264,
  page_count: 1,
  file_status: 'ready',
  last_page: 1,
  created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z',
}

const pdfBase64 = readFileSync(new URL('../test-fixtures/mini.pdf', import.meta.url)).toString('base64')

await page.addInitScript(({ cards, document, pdfBase64 }) => {
  const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0))
  const handlers = {
    get_bootstrap_status: () => ({ database_ready: true, schema_version: 6, document_count: 1, card_count: cards.length }),
    list_cards: () => cards,
    list_documents: () => [document],
    list_due_cards: () => [],
    list_annotations: () => [],
    list_page_inks: () => [],
    list_mindmap_layout: () => cards.map((card, index) => ({
      card_id: card.id,
      canvas_id: 'main',
      x: 80 + index * 260,
      y: 80 + (card.parent_id ? 160 : 0),
      updated_at: '2026-11-03T00:00:00.000Z',
    })),
    list_card_links: () => [],
    list_tags: () => [],
    get_ai_settings: () => ({ baseUrl: '', model: '', apiKey: '' }),
    auto_backup: () => null,
    get_page_ocr: () => null,
    ocr_page_lines: () => [],
    save_page_ocr: () => null,
    update_document_progress: () => null,
    update_document_metadata: () => null,
    resolve_document_path: () => '/tmp/mini.pdf',
    verify_document: () => document,
    relocate_document: () => document,
  }
  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      if (command === 'read_pdf_chunk') {
        const begin = args?.begin ?? 0
        const end = args?.end ?? bytes.length
        return Promise.resolve(bytes.slice(begin, end).buffer)
      }
      const handler = handlers[command]
      if (!handler) return Promise.resolve(null)
      return Promise.resolve(handler())
    },
    transformCallback: (callback) => callback,
  }
}, { cards, document, pdfBase64 })

await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell')
await page.waitForTimeout(600)

// 打开资料库里的文档 → 左 PDF 右脑图
const card = page.locator('.document-card').first()
if (await card.count()) {
  await card.click()
} else {
  problems.push('未渲染文档卡片')
}
await page.waitForTimeout(3500)

const crash = await page.locator('.app-crash').count()
const nodes = await page.locator('.mindmap-node').count()
const pages = await page.locator('.pdf-page').count()
const study = await page.locator('.study-workspace').count()
const bodyText = (await page.locator('body').innerText()).slice(0, 400)

// 拖拽节点：受控 nodes 在拖拽过程中的 position 回调最容易触发循环。
const firstNode = page.locator('.mindmap-node').first()
const box = await firstNode.boundingBox()
const beforeDrag = box
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + 16)
  await page.mouse.down()
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.move(box.x + box.width / 2 + step * 6, box.y + 16 + step * 4, { steps: 2 })
    await page.waitForTimeout(40)
  }
  await page.mouse.up()
  await page.waitForTimeout(600)
  const afterDrag = await firstNode.boundingBox()
  if (beforeDrag && afterDrag
    && Math.abs(afterDrag.x - beforeDrag.x) < 4
    && Math.abs(afterDrag.y - beforeDrag.y) < 4) {
    problems.push('拖拽后节点位置没有变化')
  }
} else {
  problems.push('未找到可拖拽的节点')
}

// 反复改变窗口尺寸：触发 React Flow 重新测量节点。
for (const width of [1200, 1000, 1400, 900, 1300]) {
  await page.setViewportSize({ width, height: 900 })
  await page.waitForTimeout(400)
}

const STEP = process.env.STEP ?? 'all'

// 折叠/展开：节点尺寸大幅变化，最容易触发测量回写循环。
const collapse = STEP === 'outline' ? page.locator('.mindmap-collapse--disabled') : page.locator('.mindmap-collapse').first()
if (await collapse.count()) {
  await collapse.click()
  await page.waitForTimeout(500)
  const expand = page.locator('.mindmap-node').first().locator('.mindmap-collapse')
  if (await expand.count()) {
    await expand.click()
    await page.waitForTimeout(500)
  }
}

// 大纲模式往返
const outlineButton = STEP === 'collapse' ? page.locator('.never-match') : page.getByRole('button', { name: /大纲/ }).first()
if (await outlineButton.count()) {
  await outlineButton.click()
  await page.waitForTimeout(400)
  const back = page.getByRole('button', { name: /返回画布|画布/ }).first()
  if (await back.count()) {
    await back.click()
    await page.waitForTimeout(600)
  }
}

// 选择功能必须仍然生效（回调已改为下一帧合并）。
const selectNode = page.locator('.mindmap-node').first()
await selectNode.click()
await page.waitForTimeout(200)
const selectedCount = await page.locator('.mindmap-node.is-selected').count()
if (selectedCount < 1) problems.push('点击节点后未进入选中态')

await page.locator('.mindmap-node').nth(1).click({ modifiers: ['Meta'] })
await page.waitForTimeout(250)
const selectedMulti = await page.locator('.mindmap-node.is-selected').count()
if (selectedMulti < 2) problems.push(`多选失效：selected=${selectedMulti}`)

const nodesAgain = await page.locator('.mindmap-node').count()

await browser.close()
console.log(JSON.stringify({ problems, crash, nodes, nodesAgain, pages, study, bodyText }, null, 2))
if (problems.length || crash) process.exitCode = 1
