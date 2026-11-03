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

const pdfBytes = readFileSync(new URL('../test-fixtures/mini.pdf', import.meta.url))
const pdfBase64 = pdfBytes.toString('base64')

const document = {
  id: 'doc1',
  title: '测试教材',
  stored_path: 'pdfs/mini.pdf',
  original_path: null,
  content_hash: 'hash',
  file_size: pdfBytes.length,
  page_count: 1,
  file_status: 'ready',
  last_page: 1,
  created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z',
}

await page.addInitScript(({ cards, document, pdfBase64 }) => {
  const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0))
  const cardState = cards.map((card) => ({ ...card }))
  const handlers = {
    get_bootstrap_status: () => ({ database_ready: true, schema_version: 6, document_count: 1, card_count: cardState.length }),
    list_cards: () => cardState,
    set_card_collapsed: (args) => {
      const card = cardState.find((item) => item.id === args?.id)
      if (card) card.collapsed = Boolean(args?.collapsed)
      return card ?? null
    },
    list_documents: () => [document],
    list_due_cards: () => [],
    list_annotations: () => [{
      id: 'ann-1',
      card_id: 'c1',
      kind: 'highlight',
      page: 1,
      geometry: { rects: [{ x: 0.1, y: 0.12, width: 0.32, height: 0.05 }] },
      style: {},
      created_at: '2026-11-03T00:00:00.000Z',
      updated_at: '2026-11-03T00:00:00.000Z',
    }],
    remove_annotation: () => {
      throw new Error('annotation not found')
    },
    delete_card: (args) => {
      const index = cardState.findIndex((item) => item.id === args?.id)
      if (index >= 0) cardState.splice(index, 1)
      return null
    },
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
  window.__calls = []
  window.__cardState = cardState
  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      window.__calls.push(command)
      if (command === 'read_pdf_chunk') {
        const begin = args?.begin ?? 0
        const end = args?.end ?? bytes.length
        return Promise.resolve(bytes.slice(begin, end).buffer)
      }
      const handler = handlers[command]
      if (!handler) return Promise.resolve(null)
      return Promise.resolve(handler(args))
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

if (STEP === 'context') {
  // 右键节点 → 折叠子节点，验证菜单动作真的改变了画布。
  const before = await page.locator('.mindmap-node').count()
  const target = page.locator('.mindmap-node').first()
  const targetBox = await target.boundingBox()
  if (!targetBox) {
    problems.push('右键目标节点不可见')
  } else {
    await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + 16, { button: 'right' })
    await page.waitForSelector('.context-menu', { timeout: 3000 })
    const toggleItem = page.locator('.context-menu-item', { hasText: '折叠子节点' }).first()
    if (!(await toggleItem.count())) {
      problems.push('右键菜单缺少折叠项')
    } else {
      const disabled = await toggleItem.getAttribute('aria-disabled')
      if (disabled === 'true') problems.push('折叠项处于禁用状态')
      await toggleItem.click()
      await page.waitForTimeout(900)
      const after = await page.locator('.mindmap-node').count()
      const calls = await page.evaluate(() => window.__calls.slice(-12))
      const state = await page.evaluate(() => window.__cardState.find((card) => card.id === 'c1')?.collapsed)
      const toggleText = await page.locator('.mindmap-collapse').first().innerText().catch(() => '?')
      if (!(after < before)) problems.push(`右键折叠未生效：${before} → ${after}；calls=${calls.join(',')}；mock.collapsed=${state}；按钮=${toggleText}`)
    }
  }
  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP }, null, 2))
  if (problems.length) process.exitCode = 1
  process.exit(0)
}

if (STEP === 'stale') {
  // 后端标注已不存在（缓存过期）：删除应自愈，而不是报“删除失败”。
  await page.waitForTimeout(1200)
  const before = await page.locator('.pdf-annotation').count()
  const rect = page.locator('.pdf-annotation rect').first()
  const rectBox = await rect.boundingBox()
  if (!rectBox) {
    problems.push('标注未渲染')
  } else {
    await page.mouse.click(rectBox.x + rectBox.width / 2, rectBox.y + rectBox.height / 2, { button: 'right' })
    await page.waitForSelector('.context-menu', { timeout: 3000 })
    await page.locator('.context-menu-item', { hasText: '删除标注' }).first().click()
    await page.waitForSelector('.pdf-modal', { timeout: 3000 })
    await page.getByRole('button', { name: '保留卡片，仅删标注' }).click()
    await page.waitForTimeout(900)
  }
  const after = await page.locator('.pdf-annotation').count()
  const text = await page.locator('body').innerText()
  if (text.includes('删除失败')) problems.push('仍然显示删除失败')
  if (!text.includes('已在其他视图被删除')) problems.push('未给出自愈提示')
  if (after !== 0) problems.push(`幽灵标注未移除：${before} → ${after}`)

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, before, after }, null, 2))
  if (problems.length) process.exitCode = 1
  process.exit(0)
}

if (STEP === 'cascade') {
  // 脑图彻底删卡后，PDF 上的标注必须立刻消失（不能留下点不掉的幽灵图层）。
  await page.waitForTimeout(1200)
  const before = await page.locator('.pdf-annotation').count()
  const target = page.locator('.mindmap-node').first()
  const targetBox = await target.boundingBox()
  if (!targetBox) {
    problems.push('脑图节点不可见')
  } else {
    await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + 16, { button: 'right' })
    await page.waitForSelector('.context-menu', { timeout: 3000 })
    await page.locator('.context-menu-item', { hasText: '彻底删除卡片' }).first().click()
    await page.waitForSelector('.mindmap-confirm', { timeout: 3000 })
    await page.getByRole('button', { name: /确认彻底删除/ }).click()
    await page.waitForTimeout(1500)
  }
  const after = await page.locator('.pdf-annotation').count()
  const bodyText = await page.locator('body').innerText()
  if (before === 0) problems.push('初始标注未渲染，无法验证联动')
  if (after !== 0) problems.push(`删卡后 PDF 标注未清除：${before} → ${after}`)
  if (!bodyText.includes('已同步移除')) problems.push('未提示标注已同步移除')

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, before, after }, null, 2))
  if (problems.length) process.exitCode = 1
  process.exit(0)
}

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
