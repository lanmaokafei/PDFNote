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
  excerpt: index === 0
    ? 'H = -\\sum_{i=1}^{n} P(x_i) \\log_2 P(x_i)'
    : index === 1
      ? '熵的定义是 $H = -\\sum p \\log p$，单位 bit。'
      : index % 3 === 0
        ? '典型胸痛 + ST 段改变 + 心肌酶升高，需要尽快再灌注。'
        : '',
  excerpt_image: index % 4 === 0 ? THUMB : null,
  source_ref: index === 0
    ? { document_id: 'doc1', page: 1, bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } }
    : null,
  // ARRANGE_FOREST=1 模拟「26 张互不相连的卡片」，复现自动整理变成长条的旧问题。
  parent_id: process.env.ARRANGE_FOREST === '1'
    ? null
    : index === 0 ? null : `c${Math.max(1, Math.floor(index / 3) + 1)}`,
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

await page.addInitScript(({ cards, document, pdfBase64, dense }) => {
  const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0))
  const cardState = cards.map((card) => ({ ...card }))
  const noteState = []
  window.__noteState = noteState
  const digestNotes = []
  window.__digestNotes = digestNotes
  window.__synthesizeDepth = null
  window.__chunkDepth = null
  window.__lastOutline = null
  const layoutState = []
  window.__layoutState = layoutState
  // 0.20.0 多画布：每张画布有自己的 mindmap_layout 成员；main 装全部种子卡片。
  const canvasState = [
    { id: 'main', document_id: null, name: '默认画布', created_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z' },
    { id: 'doc-canvas', document_id: 'doc1', name: '本书脑图 A', created_at: '2026-11-04T00:00:00.000Z', updated_at: '2026-11-04T00:00:00.000Z' },
    { id: 'book-canvas-b', document_id: 'doc1', name: '本书脑图 B', created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z' },
  ]
  const layoutMembership = {
    main: cards.map((card) => card.id),
    'doc-canvas': cards.slice(0, 2).map((card) => card.id),
    'book-canvas-b': cards.slice(0, 1).map((card) => card.id),
  }
  window.__canvasState = canvasState
  window.__layoutMembership = layoutMembership
  window.__canvasOps = []
  window.__ankiImportInputs = []
  window.__clearCanvasIds = []
  window.__clearModes = []
  // 模拟真实的 AI 解析：多段长解释，写回笔记后必须能展开并靠滚动条查看。
  const explainText = [
    '是什么：信息熵度量随机变量的不确定性，是编码长度的理论下界。',
    '为什么：概率分布越均匀，平均意外程度越高，熵也就越大。',
    ...Array.from({ length: 14 }, (_, index) =>
      `要点 ${index + 1}：在第 ${index + 1} 类情形下，交叉熵与相对熵的差决定了编码冗余；` +
      '实际应用中要注意样本量不足带来的估计偏差，以及不同对数底对应的单位换算。'),
    '怎么用：先估计分布，再计算每个符号的最优码长，最后与等长编码比较压缩率。',
    '易错点：把熵和方差混为一谈；忽略对数底导致 bit 与 nat 混用。',
  ].join('\n')
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
    list_book_notes: () => digestNotes,
    analyze_book_chunk: (args) => {
      const input = args?.input ?? {}
      window.__chunkDepth = input.depth ?? null
      const pages = input.pages ?? []
      const note = {
        chunk_index: input.chunk_index,
        page_start: pages[0]?.page ?? 1,
        page_end: pages[pages.length - 1]?.page ?? 1,
        summary: '这一块讲熵的定义',
        items: [{
          kind: '定义',
          title: '信息熵',
          excerpt: 'H = -sum p log p',
          page: pages[0]?.page ?? 1,
          aliases: 'entropy',
        }],
        pages,
      }
      digestNotes.push(note)
      return note
    },
    synthesize_book: (args) => {
      const depth = Math.min(5, Math.max(1, Number(args?.depth ?? 2)))
      window.__synthesizeDepth = depth
      const make = (level) => ({
        title: level === 1 ? '背景' : `第 ${level} 层节点`,
        excerpt: level === 1 ? '熵用来度量不确定性' : '原文摘录',
        page: 1,
        aliases: '',
        children: level < depth ? [make(level + 1)] : [],
      })
      const outline = { title: '测试教材', mode: 'structure', depth, nodes: [make(1)] }
      window.__lastOutline = outline
      return outline
    },
    apply_book_outline: () => {
      const count = (nodes) => nodes.reduce((sum, item) => sum + 1 + count(item.children ?? []), 0)
      return count(window.__lastOutline?.nodes ?? [])
    },
    clear_book_analysis: () => null,
    list_page_notes: (args) => noteState.filter((note) => note.document_id === args?.documentId),
    create_page_note: (args) => {
      const input = args?.input ?? {}
      const note = {
        id: `note-${noteState.length + 1}`,
        document_id: input.document_id,
        page: input.page,
        anchor_y: input.anchor_y ?? 0.08,
        content: '',
        collapsed: false,
        color: 'amber',
        created_at: '2026-11-04T00:00:00.000Z',
        updated_at: '2026-11-04T00:00:00.000Z',
      }
      noteState.push(note)
      return note
    },
    update_page_note: (args) => {
      const input = args?.input ?? {}
      const note = noteState.find((item) => item.id === input.id)
      if (!note) throw new Error('留白不存在')
      if (input.content !== undefined) note.content = input.content
      if (input.collapsed !== undefined) note.collapsed = input.collapsed
      if (input.anchor_y !== undefined) note.anchor_y = input.anchor_y
      return { ...note }
    },
    delete_page_note: (args) => {
      const index = noteState.findIndex((item) => item.id === args?.id)
      if (index >= 0) noteState.splice(index, 1)
      return null
    },
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
    create_card: (args) => {
      const input = args?.input ?? {}
      const created = {
        ...cards[0],
        id: `new-card-${cardState.length + 1}`,
        question: input.question ?? '',
        excerpt: input.excerpt ?? '',
        user_note: input.user_note ?? '',
        parent_id: null,
        sort_order: input.sort_order ?? 0,
        source_ref: input.source_ref ?? null,
        excerpt_image: null,
        tags: [],
        surface_pdf: false,
        surface_mindmap: true,
        surface_review: true,
      }
      cardState.push(created)
      const canvasId = input.canvas_id ?? 'main'
      const ids = layoutMembership[canvasId] ?? (layoutMembership[canvasId] = [])
      ids.push(created.id)
      return { ...created }
    },
    clear_mindmap_cards: (args) => {
      const mode = args?.mode ?? 'remove'
      window.__clearModes.push(mode)
      window.__clearCanvasIds.push(args?.canvasId ?? null)
      if (mode === 'delete') {
        const count = cardState.length
        cardState.splice(0, cardState.length)
        return count
      }
      let count = 0
      for (const card of cardState) {
        if (card.surface_mindmap) { card.surface_mindmap = false; count += 1 }
      }
      return count
    },
    save_mindmap_layout: (args) => {
      const items = args?.items ?? args?.layouts ?? []
      if (Array.isArray(items)) layoutState.push(...items)
      return null
    },
    list_page_inks: () => [],
    list_mindmap_layout: (args) => {
      const canvasId = args?.canvasId ?? 'main'
      const ids = layoutMembership[canvasId] ?? []
      return ids.map((id, index) => {
        const seeded = cards.findIndex((card) => card.id === id)
        // main 上的种子卡片沿用旧坐标，保证既有场景的位置断言不变。
        const isSeededOnMain = seeded >= 0 && canvasId === 'main'
        // DENSE=1：把卡片铺成密集网格，模拟真实 Anki 题库（26 个牌组 × 数十道题），
        // 用于验证缩小后视口里同时出现几百个节点时是否仍然流畅。
        if (dense && seeded >= 0) {
          return {
            card_id: id,
            canvas_id: canvasId,
            x: 80 + (seeded % 24) * 300,
            y: 80 + Math.floor(seeded / 24) * 190,
            updated_at: '2026-11-03T00:00:00.000Z',
          }
        }
        return {
          card_id: id,
          canvas_id: canvasId,
          x: isSeededOnMain ? 80 + seeded * 260 : 80 + (index % 6) * 280,
          y: isSeededOnMain ? 80 + (cards[seeded].parent_id ? 160 : 0) : 80 + Math.floor(index / 6) * 200,
          updated_at: '2026-11-03T00:00:00.000Z',
        }
      })
    },
    list_mindmap_canvases: (args) => {
      const documentId = args?.documentId ?? null
      return canvasState
        .filter((entry) => documentId === null || entry.document_id === null || entry.document_id === documentId)
        .map((entry) => ({ ...entry, card_count: (layoutMembership[entry.id] ?? []).length }))
    },
    create_mindmap_canvas: (args) => {
      const input = args?.input ?? {}
      const entry = {
        id: input.id || `canvas-${canvasState.length + 1}`,
        document_id: input.document_id ?? null,
        name: input.name || '新画布',
        card_count: 0,
        created_at: '2026-11-05T00:00:00.000Z',
        updated_at: '2026-11-05T00:00:00.000Z',
      }
      canvasState.push(entry)
      layoutMembership[entry.id] = []
      window.__canvasOps.push({ kind: 'create', id: entry.id, name: entry.name, document_id: entry.document_id })
      return { ...entry }
    },
    rename_mindmap_canvas: (args) => {
      const entry = canvasState.find((item) => item.id === args?.id)
      if (entry) entry.name = args?.name ?? entry.name
      window.__canvasOps.push({ kind: 'rename', id: args?.id, name: args?.name })
      return { ...(entry ?? {}), card_count: (layoutMembership[args?.id] ?? []).length }
    },
    delete_mindmap_canvas: (args) => {
      const index = canvasState.findIndex((item) => item.id === args?.id)
      const removed = (layoutMembership[args?.id] ?? []).length
      if (index >= 0) canvasState.splice(index, 1)
      delete layoutMembership[args?.id]
      window.__canvasOps.push({ kind: 'delete', id: args?.id })
      return removed
    },
    preview_anki_txt: () => ({
      format: 'anki-standard',
      total: 3,
      has_answers: true,
      decks: [
        { name: '教材::第一章', count: 2 },
        { name: '教材::第二章', count: 1 },
      ],
      samples: [
        { deck: '教材::第一章', front: '什么是信息熵？', back: '度量不确定性' },
        { deck: '教材::第一章', front: '什么是条件熵？', back: '已知 X 时 Y 的不确定性' },
      ],
    }),
    import_anki_txt: (args) => {
      const input = args?.input ?? {}
      const canvasId = input.canvas_id || 'main'
      window.__ankiImportInputs.push({ ...input })
      const selected = Array.isArray(input.deck_names)
        ? input.deck_names
        : ['教材::第一章', '教材::第二章']
      const ids = layoutMembership[canvasId] ?? (layoutMembership[canvasId] = [])
      const base = {
        ...cards[0], id: '', question: '', excerpt: '', user_note: '', tags: [],
        source_ref: null, excerpt_image: null, parent_id: null, sort_order: 0,
        surface_pdf: false, surface_mindmap: true, surface_review: true,
      }
      const additions = []
      if (!ids.includes('anki-group')) {
        additions.push({ ...base, id: 'anki-group', question: '教材', surface_review: false })
      }
      if (selected.includes('教材::第一章')) {
        if (!ids.includes('anki-q1')) additions.push({ ...base, id: 'anki-q1', question: '什么是信息熵？', excerpt: '度量不确定性', parent_id: 'anki-group', sort_order: 1, tags: ['第一章'] })
        if (!ids.includes('anki-q2')) additions.push({ ...base, id: 'anki-q2', question: '什么是条件熵？', excerpt: '已知 X 时 Y 的不确定性', parent_id: 'anki-group', sort_order: 2, tags: ['第一章'] })
      }
      if (selected.includes('教材::第二章') && !ids.includes('anki-q3')) {
        additions.push({ ...base, id: 'anki-q3', question: '什么是互信息？', excerpt: '两个变量共享的信息量', parent_id: 'anki-group', sort_order: 3, tags: ['第二章'] })
      }
      for (const item of additions) {
        if (!cardState.some((card) => card.id === item.id)) cardState.push(item)
        if (!ids.includes(item.id)) ids.push(item.id)
      }
      return {
        imported: additions.filter((item) => item.surface_review).length,
        groups: additions.some((item) => item.id === 'anki-group') ? 1 : 0,
        skipped: 0,
        canvas_id: canvasId,
      }
    },
    'plugin:dialog|open': () => '/tmp/anki-sample.txt',
    list_card_links: () => [],
    list_tags: () => [],
    get_ai_settings: () => ({ baseUrl: '', model: '', apiKey: '' }),
    explain_card: () => explainText,
    update_card_content: (args) => {
      const input = args?.input ?? args ?? {}
      const index = cardState.findIndex((item) => item.id === input.id)
      if (index < 0) return null
      // 真实 IPC 返回的是反序列化后的新对象；mock 也必须换引用，
      // 否则 zustand 的 Object.is 比较会让卡片节点跳过重渲染。
      const next = { ...cardState[index] }
      if (input.question !== undefined) next.question = input.question
      if (input.excerpt !== undefined) next.excerpt = input.excerpt
      if (input.user_note !== undefined) next.user_note = input.user_note
      cardState[index] = next
      return { ...next }
    },
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
}, { cards, document, pdfBase64, dense: process.env.DENSE === '1' })

await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell')
await page.waitForTimeout(600)

// STEP=perf：只测量「点开文档 → 脑图可用」这段，不跑拖拽 / resize，避免污染数据。
// 用于几千张卡片时的加载性能回归（画布默认嵌入在右栏，视口里只放得下几个节点）。
if (process.env.STEP === 'perf') {
  await page.evaluate(() => {
    window.__perf = { longTasks: [], start: performance.now() }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perf.longTasks.push(Math.round(entry.duration))
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch { /* 老浏览器不支持 longtask */ }
  })
  const started = Date.now()
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  const firstNodeMs = Date.now() - started
  await page.waitForTimeout(2500)
  const settleMs = Date.now() - started
  const metrics = await page.evaluate(() => {
    const perf = window.__perf
    const longTasks = perf.longTasks
    return {
      nodes: document.querySelectorAll('.mindmap-node').length,
      flowNodes: document.querySelectorAll('.react-flow__node').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
      katex: document.querySelectorAll('.mindmap-node .katex').length,
      images: document.querySelectorAll('.mindmap-node img').length,
      domTotal: document.querySelectorAll('*').length,
      longTaskCount: longTasks.length,
      longTaskTotal: longTasks.reduce((sum, value) => sum + value, 0),
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      timings: window.__mindmapPerf ?? null,
    }
  })
  // 大图必须依赖视口裁剪：1483 张卡时 DOM 里只该挂视口内的十几个节点。
  if (CARD_COUNT > 200 && metrics.nodes > 80) {
    problems.push(`视口裁剪失效：${CARD_COUNT} 张卡挂载了 ${metrics.nodes} 个节点`)
  }
  await browser.close()
  console.log(JSON.stringify({
    problems,
    step: 'perf',
    cardCount: CARD_COUNT,
    firstNodeMs,
    settleMs,
    ...metrics,
  }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=zoom-drag：缩小到能看见上百个节点后，连续点击 + 拖动几张卡。
// 这是「缩小后拖几次像卡死」的复现场景：低缩放下视口覆盖节点数暴涨，
// 每次挂载/测量/选中都可能重建整张 nodes 表。
if (process.env.STEP === 'zoom-drag') {
  await page.evaluate(() => {
    window.__perf = { longTasks: [] }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__perf.longTasks.push(Math.round(entry.duration))
      }).observe({ entryTypes: ['longtask'] })
    } catch { /* ignore */ }
  })
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(1500)

  const readZoom = () => page.evaluate(() => {
    const viewport = document.querySelector('.react-flow__viewport')
    if (!viewport) return 1
    return Number(new DOMMatrix(getComputedStyle(viewport).transform).a.toFixed(3))
  })

  // 用 ⌘+滚轮缩小（画布左下角的 Controls 在分栏里会被 PDF 工具坞挡住，点不到）。
  // 指针放在左上角（树根附近）再缩，缩放后视口里仍是内容最密的一块。
  const pane = await page.locator('.react-flow__pane').first().boundingBox()
  if (!pane) {
    problems.push('画布不可见，无法缩小')
  } else {
    await page.mouse.move(pane.x + 80, pane.y + 80)
    await page.keyboard.down('Meta')
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, 300)
      await page.waitForTimeout(140)
    }
    await page.keyboard.up('Meta')
  }
  await page.waitForTimeout(600)
  const zoom = await readZoom()
  const nodesAtZoom = await page.locator('.mindmap-node').count()
  // 只统计拖拽阶段的长任务，别把首屏加载算进来。
  await page.evaluate(() => { window.__perf.longTasks = [] })

  // 用 rAF 计帧：拖拽墙钟时间含 Playwright 逐事件派发的固定开销，
  // 帧率才是用户感知的「断断续续」。
  await page.evaluate(() => {
    window.__frames = { count: 0, start: performance.now(), worst: 0, last: performance.now(), slow: 0 }
    const tick = () => {
      const now = performance.now()
      const delta = now - window.__frames.last
      window.__frames.last = now
      if (window.__frames.count > 0) {
        window.__frames.worst = Math.max(window.__frames.worst, Math.round(delta))
        if (delta > 50) window.__frames.slow += 1
      }
      window.__frames.count += 1
      window.__frames.raf = requestAnimationFrame(tick)
    }
    window.__frames.raf = requestAnimationFrame(tick)
  })
  const dragMs = []
  for (let round = 0; round < 3; round += 1) {
    const node = page.locator('.mindmap-node').nth(round)
    if (!(await node.count())) break
    const box = await node.boundingBox()
    if (!box) break
    const started = Date.now()
    await page.evaluate(() => { window.__nodeRenders = 0; window.__ctxBuilds = 0; window.__nodeMounts = 0; window.__nodeMounts = 0 })
    // 低缩放下节点只有几像素高，必须点正中心，否则会落到画布上变成平移。
    await page.mouse.move(box.x + box.width / 2, box.y + Math.max(1, box.height / 2))
    await page.mouse.down()
    for (let step = 0; step < 8; step += 1) {
      await page.mouse.move(box.x + box.width / 2 + step * 5, box.y + Math.max(1, box.height / 2) + step * 6, { steps: 2 })
    }
    await page.mouse.up()
    dragMs.push(Date.now() - started)
    await page.waitForTimeout(350)
  }

  const frames = await page.evaluate(() => {
    cancelAnimationFrame(window.__frames.raf)
    const elapsed = performance.now() - window.__frames.start
    return {
      frames: window.__frames.count,
      elapsed: Math.round(elapsed),
      fps: Math.round((window.__frames.count / elapsed) * 1000),
      worstFrame: window.__frames.worst,
      slowFrames: window.__frames.slow,
    }
  })

  const metrics = await page.evaluate(() => {
    const longTasks = window.__perf.longTasks
    return {
      nodes: document.querySelectorAll('.mindmap-node').length,
      liteNodes: document.querySelectorAll('.mindmap-node.is-lite').length,
      katex: document.querySelectorAll('.mindmap-node .katex').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
      domTotal: document.querySelectorAll('*').length,
      longTaskCount: longTasks.length,
      longTaskTotal: longTasks.reduce((sum, value) => sum + value, 0),
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    }
  })
  // 低缩放必须整体降级为「标题条」：不该再出现 KaTeX，DOM 也要受控。
  if (zoom < 0.45) {
    if (metrics.liteNodes !== metrics.nodes) {
      problems.push(`低缩放未整体降级：lite=${metrics.liteNodes} / nodes=${metrics.nodes}`)
    }
    if (metrics.katex > 0) problems.push(`低缩放仍在渲染 KaTeX：${metrics.katex}`)
    if (metrics.domTotal > 12000) problems.push(`低缩放 DOM 过大：${metrics.domTotal}`)
  }
  if (metrics.longTaskMax > 400) {
    problems.push(`拖拽出现 ${metrics.longTaskMax}ms 长任务`)
  }
  if (dragMs.length && Math.max(...dragMs) > 700) {
    problems.push(`单次拖拽耗时 ${Math.max(...dragMs)}ms`)
  }
  if (frames.worstFrame > 320) {
    problems.push(`拖拽出现 ${frames.worstFrame}ms 单帧`)
  }
  await browser.close()
  console.log(JSON.stringify({ problems, step: 'zoom-drag', cardCount: CARD_COUNT, zoom, nodesAtZoom, dragMs, frames, ...metrics }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=insert-center：PDF 建卡后脑图刷新，新卡必须落在画布当前视口中心，
// 而不是固定原点 / 左下角。这里用脑图自己的「新建」验证同一条落点链路。
if (process.env.STEP === 'insert-center') {
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(1200)

  // 先把画布拖到别处，确保「视口中心」和默认视口不同。
  const pane = await page.locator('.react-flow__pane').first().boundingBox()
  if (!pane) {
    problems.push('画布不可见，无法平移')
  } else {
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2)
    await page.mouse.down()
    await page.mouse.move(pane.x + pane.width / 2 + 180, pane.y + pane.height / 2 + 140, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(500)
  }

  const center = await page.evaluate(() => {
    const host = document.querySelector('.mindmap-flow-host')
    const viewport = document.querySelector('.react-flow__viewport')
    const rect = host.getBoundingClientRect()
    const matrix = new DOMMatrix(getComputedStyle(viewport).transform)
    return {
      x: (rect.width / 2 - matrix.e) / matrix.a,
      y: (rect.height / 2 - matrix.f) / matrix.a,
      zoom: Number(matrix.a.toFixed(3)),
    }
  })

  const createCard = async (question) => {
    await page.locator('.mindmap-float-actions button', { hasText: '新建' }).first().click()
    await page.waitForSelector('.mindmap-editor', { timeout: 4000 })
    await page.locator('.mindmap-editor textarea').first().fill(question)
    await page.getByRole('button', { name: '创建卡片' }).click()
    await page.waitForTimeout(1000)
    const id = await page.evaluate(() => {
      const items = window.__cardState ?? []
      return items[items.length - 1]?.id ?? null
    })
    return page.evaluate((cardId) => {
      const rows = (window.__layoutState ?? []).filter((row) => row.card_id === cardId)
      return rows[rows.length - 1] ?? null
    }, id)
  }

  const first = await createCard('视口中心测试卡一')
  const second = await createCard('视口中心测试卡二')

  const expectX = center.x - 254 / 2
  const expectY = center.y - 190 / 2
  if (!first) problems.push('第一张新卡没有写入布局')
  if (!second) problems.push('第二张新卡没有写入布局')
  if (first) {
    if (Math.abs(first.x - expectX) > 3 || Math.abs(first.y - expectY) > 3) {
      problems.push(`新卡没有落在视口中心：期望 (${expectX.toFixed(0)}, ${expectY.toFixed(0)})，实际 (${first.x}, ${first.y})`)
    }
    if (first.x === 80 && first.y >= 80) problems.push('新卡仍在旧的固定坐标')
  }
  if (first && second) {
    if (Math.abs(second.x - first.x - 36) > 2) {
      problems.push(`连续建卡没有错开：${first.x} → ${second.x}`)
    }
  }

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'insert-center', zoom: center.zoom, center, first, second }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

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

if (STEP === 'math') {
  await page.waitForTimeout(1200)
  const katexCount = await page.locator('.mindmap-node .katex').count()
  const displayCount = await page.locator('.mindmap-node .katex-display').count()
  if (katexCount < 1) problems.push('脑图卡片没有渲染 LaTeX')
  if (displayCount < 1) problems.push('块级公式没有按 display 模式渲染')
  const formulaText = await page.locator('.mindmap-node .katex').first().innerText().catch(() => '')
  if (!formulaText.includes('H')) problems.push(`公式内容异常：${formulaText.slice(0, 40)}`)

  // 字体是否真正加载（打包后 woff2 走 assets，缺字体会显示成方框）
  const fontLoaded = await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))
  if (!fontLoaded) problems.push('KaTeX 字体未加载')

  // 公式卡片的截图必须隐藏（与渲染结果重复，还会把公式挤出卡片）；
  // 纯图片卡片仍要保留截图。
  // 公式不能被段落 line-clamp 或容器高度裁切
  const clipping = await page.evaluate(() => {
    const display = document.querySelector('.mindmap-node .katex-display')
    const paragraph = display?.closest('p')
    const node = display?.closest('.mindmap-node')
    return {
      paragraph: paragraph ? { client: paragraph.clientHeight, scroll: paragraph.scrollHeight } : null,
      display: display ? { client: display.clientHeight, scroll: display.scrollHeight, width: display.clientWidth, scrollWidth: display.scrollWidth } : null,
      node: node ? { client: node.clientHeight, scroll: node.scrollHeight } : null,
    }
  })
  if (clipping.paragraph && clipping.paragraph.scroll > clipping.paragraph.client + 1) {
    problems.push(`公式段落被截断：${JSON.stringify(clipping.paragraph)}`)
  }
  if (clipping.node && clipping.node.scroll > clipping.node.client + 1) {
    problems.push(`卡片高度截断公式：${JSON.stringify(clipping.node)}`)
  }
  if (!clipping.display) problems.push('未找到块级公式容器')
  if (clipping.display && clipping.display.scrollWidth > clipping.display.width + 2) {
    problems.push(`公式横向溢出：${clipping.display.scrollWidth} > ${clipping.display.width}`)
  }

  const formulaNodeImages = await page.locator('.mindmap-node').first().locator('.mindmap-node-image').count()
  const totalImages = await page.locator('.mindmap-node-image').count()
  if (formulaNodeImages !== 0) problems.push(`公式卡片仍显示截图：${formulaNodeImages}`)
  if (totalImages < 1) problems.push('无公式的图片卡片被误隐藏')

  if (process.env.SHOT) {
    await page.locator('.mindmap-node').first().screenshot({ path: '/tmp/formula-card.png' })
  }
  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, katexCount, displayCount, fontLoaded, clipping, formulaNodeImages, totalImages }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'pan') {
  await page.waitForTimeout(1200)
  const viewport = page.locator('.react-flow__viewport')
  const before = await viewport.getAttribute('style')
  const pane = await page.locator('.react-flow__pane').boundingBox()
  if (!pane) {
    problems.push('画布不可见')
  } else {
    // 左键从空白处拖动：应立即平移画布（旧版本左键是框选，画布不动）
    const startX = pane.x + pane.width * 0.62
    const startY = pane.y + pane.height * 0.72
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(startX - step * 9, startY - step * 5, { steps: 2 })
    }
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
  const after = await viewport.getAttribute('style')
  if (before === after) problems.push(`左键拖拽空白未平移画布：${before}`)

  // 触控板双指滑动（wheel）也应平移
  const beforeWheel = await viewport.getAttribute('style')
  if (pane) {
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2)
    await page.mouse.wheel(0, 160)
    await page.waitForTimeout(300)
  }
  const afterWheel = await viewport.getAttribute('style')
  if (beforeWheel === afterWheel) problems.push('滚动/双指滑动未平移画布')

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, before, after, beforeWheel, afterWheel }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'arrange') {
  await page.waitForTimeout(1400)
  // 顶部完整工具栏只在独立脑图视图出现：先关文档再进脑图。
  const nav = page.locator('.app-top button')
  if (await nav.count() >= 4) {
    await nav.nth(0).click()
    await page.waitForTimeout(700)
    await nav.nth(3).click()
    await page.waitForTimeout(1500)
  }
  const arrange = page.locator('.mindmap-toolbar-actions button', { hasText: '自动整理' })
  if (!(await arrange.count())) {
    problems.push('缺少「自动整理」按钮')
  } else {
    await arrange.click()
    await page.waitForTimeout(1100)
  }
  const layout = await page.evaluate(() => window.__layoutState ?? [])
  const saved = layout.slice(-Number(process.env.CARD_COUNT ?? 3))
  if (saved.length < Number(process.env.CARD_COUNT ?? 3)) {
    problems.push(`自动整理未保存全部坐标：${saved.length}`)
  }
  if (saved.length) {
    const xs = saved.map((item) => item.x)
    const ys = saved.map((item) => item.y)
    const width = Math.max(...xs) - Math.min(...xs) + 254
    const height = Math.max(...ys) - Math.min(...ys) + 190
    if (height > 2600 || height / width > 1.5) {
      problems.push(`整理后仍是细长竖条：${Math.round(width)}×${Math.round(height)}`)
    }
    // 旧实现把根节点纵向堆成数千像素，fitView 后缩放会小到看不清卡片。
    const transform = await page.locator('.react-flow__viewport').first().getAttribute('style').catch(() => '')
    const zoom = Number(/scale\(([\d.]+)\)/.exec(transform ?? '')?.[1] ?? 0)
    if (zoom < 0.2) problems.push(`整理后视图未对齐，缩放过小：${zoom}`)
  }
  const calls = await page.evaluate(() => window.__calls.slice(-12))
  if (!calls.includes('save_mindmap_layout')) problems.push('整理未保存布局')
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT })

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, savedCount: saved.length, layout: saved.slice(0, 3) }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'clear') {
  await page.waitForTimeout(1400)
  const nav = page.locator('.app-top button')
  if (await nav.count() >= 4) {
    await nav.nth(0).click()
    await page.waitForTimeout(700)
    await nav.nth(3).click()
    await page.waitForTimeout(1500)
  }
  const clearButton = page.locator('.mindmap-toolbar-actions button', { hasText: '清空卡片' })
  if (!(await clearButton.count())) {
    problems.push('缺少「清空卡片」按钮')
  } else {
    await clearButton.click()
    await page.waitForSelector('.mindmap-confirm.clear-cards', { timeout: 3000 })
    const text = await page.locator('.mindmap-confirm.clear-cards').innerText()
    for (const label of ['仅清空脑图', '彻底删除', String(process.env.CARD_COUNT ?? 3)]) {
      if (!text.includes(label)) problems.push(`清空对话框缺少内容：${label}`)
    }
    // 先验证较安全的 remove：卡片仍在，但画布与统计都清空。
    await page.locator('.mindmap-confirm.clear-cards button', { hasText: '仅清空脑图' }).click()
    await page.waitForTimeout(800)
    const nodesAfterRemove = await page.locator('.mindmap-node').count()
    const state = await page.evaluate(() => ({
      total: window.__cardState.length,
      visible: window.__cardState.filter((card) => card.surface_mindmap).length,
    }))
    if (nodesAfterRemove !== 0) problems.push(`仅清空脑图后仍有节点：${nodesAfterRemove}`)
    if (state.total < 1 || state.visible !== 0) problems.push(`仅清空脑图语义错误：${JSON.stringify(state)}`)

    // 恢复投影后刷新，再走「彻底删除」这条不可逆路径。
    await page.evaluate(() => {
      for (const card of window.__cardState) card.surface_mindmap = true
    })
    await page.locator('.mindmap-toolbar-actions button', { hasText: '刷新' }).click()
    await page.waitForTimeout(800)
    await clearButton.click()
    await page.waitForSelector('.mindmap-confirm.clear-cards', { timeout: 3000 })
    await page.locator('.mindmap-confirm.clear-cards button', { hasText: '彻底删除' }).click()
    await page.waitForTimeout(800)
    const finalNodes = await page.locator('.mindmap-node').count()
    const remaining = await page.evaluate(() => window.__cardState.length)
    if (finalNodes !== 0 || remaining !== 0) {
      problems.push(`彻底删除后仍有残留：nodes=${finalNodes}, cards=${remaining}`)
    }
  }
  const modes = await page.evaluate(() => window.__clearModes ?? [])
  if (!modes.includes('remove') || !modes.includes('delete')) {
    problems.push(`两种清空模式未都调用：${JSON.stringify(modes)}`)
  }

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, modes }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'canvas') {
  await page.waitForTimeout(1400)
  const picker = page.locator('[data-testid="canvas-select"]').first()
  const expected = Number(process.env.CARD_COUNT ?? 3)
  if (!(await picker.count())) {
    problems.push('缺少画布选择器')
  } else {
    const initialNodes = await page.locator('.mindmap-node').count()
    if (initialNodes !== expected) problems.push(`默认画布节点数异常：${initialNodes} / ${expected}`)
    const options = await picker.locator('option').allTextContents()
    if (options.length < 3) problems.push(`画布下拉选项不足：${JSON.stringify(options)}`)

    // 画布常驻红线：切换画布不允许卸载并重建 React Flow。
    await page.evaluate(() => {
      document.querySelector('.react-flow')?.setAttribute('data-canvas-probe', 'kept')
    })
    await picker.selectOption('doc-canvas')
    await page.waitForTimeout(1100)
    const nodesOnA = await page.locator('.mindmap-node').count()
    if (nodesOnA !== 2) problems.push(`本书脑图 A 应只有 2 张卡片，实际 ${nodesOnA}`)
    const probe = await page.locator('.react-flow').first().getAttribute('data-canvas-probe').catch(() => null)
    if (probe !== 'kept') problems.push('切换画布时 React Flow 被卸载重建')

    await picker.selectOption('book-canvas-b')
    await page.waitForTimeout(900)
    const nodesOnB = await page.locator('.mindmap-node').count()
    if (nodesOnB !== 1) problems.push(`本书脑图 B 应只有 1 张卡片，实际 ${nodesOnB}`)
    await picker.selectOption('main')
    await page.waitForTimeout(900)
    const nodesBack = await page.locator('.mindmap-node').count()
    if (nodesBack !== expected) problems.push(`切回默认画布后节点数异常：${nodesBack}`)

    // 新建（默认绑定本书）→ 重命名 → 删除，验证 CRUD 与回落。
    await page.locator('[data-testid="canvas-create"]').first().click()
    await page.waitForSelector('[data-testid="canvas-name"]')
    await page.locator('[data-testid="canvas-name"]').fill('回归专用画布')
    const bind = page.locator('[data-testid="canvas-bind"]')
    if (!(await bind.count())) problems.push('缺少「绑定到当前这本书」选项')
    else if (!(await bind.isChecked())) problems.push('文档工作台新建画布时未默认绑定本书')
    await page.locator('[data-testid="canvas-submit"]').click()
    await page.waitForTimeout(1100)
    const created = await page.evaluate(() => (window.__canvasOps ?? []).filter((op) => op.kind === 'create'))
    if (created.length !== 1 || created[0].document_id !== 'doc1') {
      problems.push(`新建画布未绑定文档：${JSON.stringify(created)}`)
    }
    const activeId = await picker.inputValue()
    if (activeId === 'main') problems.push('新建画布后没有自动切换')
    const emptyNodes = await page.locator('.mindmap-node').count()
    if (emptyNodes !== 0) problems.push(`新建画布应为空，实际 ${emptyNodes} 个节点`)

    await page.locator('[data-testid="canvas-rename"]').first().click()
    await page.waitForSelector('[data-testid="canvas-name"]')
    await page.locator('[data-testid="canvas-name"]').fill('回归专用画布（改名）')
    await page.locator('[data-testid="canvas-submit"]').click()
    await page.waitForTimeout(700)
    const renamed = await page.evaluate(() => (window.__canvasOps ?? []).filter((op) => op.kind === 'rename'))
    if (renamed.length !== 1 || renamed[0].name !== '回归专用画布（改名）') {
      problems.push(`重命名未生效：${JSON.stringify(renamed)}`)
    }

    await page.locator('[data-testid="canvas-delete"]').first().click()
    await page.waitForSelector('[data-testid="canvas-submit"]')
    await page.locator('[data-testid="canvas-submit"]').click()
    await page.waitForTimeout(1100)
    const deleted = await page.evaluate(() => (window.__canvasOps ?? []).filter((op) => op.kind === 'delete'))
    if (deleted.length !== 1) problems.push('删除画布未调用后端')
    const finalId = await picker.inputValue()
    if (finalId !== 'main') problems.push(`删除当前画布后未回落到 main：${finalId}`)
    const finalNodes = await page.locator('.mindmap-node').count()
    if (finalNodes !== expected) problems.push(`删除画布后默认画布卡片未恢复：${finalNodes}`)
  }
  const ops = await page.evaluate(() => window.__canvasOps ?? [])
  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, ops }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'anki') {
  await page.waitForTimeout(1400)
  const picker = page.locator('[data-testid="canvas-select"]').first()
  // 先切到本书画布 A，验证导入只影响当前画布。
  await picker.selectOption('doc-canvas')
  await page.waitForTimeout(900)
  const beforeA = await page.locator('.mindmap-node').count()
  const open = page.locator('[data-testid="anki-open"]').first()
  if (!(await open.count())) {
    problems.push('缺少导入 Anki 入口')
  } else {
    await open.click()
    await page.waitForSelector('.anki-dialog')
    await page.locator('[data-testid="anki-pick"]').click()
    await page.waitForSelector('[data-testid="anki-summary"]')
    const total = await page.locator('[data-testid="anki-total"]').innerText()
    if (!total.includes('3')) problems.push(`预览卡数异常：${total}`)
    const decks = await page.locator('[data-testid="anki-deck"]').count()
    if (decks !== 2) problems.push(`牌组数异常：${decks}`)
    await page.locator('[data-testid="anki-deck"]').nth(1).locator('input').uncheck()
    const foot = await page.locator('.anki-dialog-foot').innerText()
    if (!foot.includes('2 张卡片')) problems.push(`勾选后导入数量未更新：${foot.slice(0, 80)}`)
    await page.locator('.anki-decks-head button', { hasText: '全选' }).click()
    await page.locator('[data-testid="anki-import"]').click()
    await page.waitForTimeout(1600)
    const inputs = await page.evaluate(() => window.__ankiImportInputs ?? [])
    if (inputs.length !== 1 || inputs[0].canvas_id !== 'doc-canvas') {
      problems.push(`导入目标画布错误：${JSON.stringify(inputs)}`)
    }
    const afterA = await page.locator('.mindmap-node').count()
    if (afterA <= beforeA) problems.push(`导入后画布 A 节点没有增加：${beforeA} → ${afterA}`)
    const notice = await page.locator('.mindmap-notice').innerText().catch(() => '')
    if (!notice.includes('已导入')) problems.push(`缺少导入结果提示：${notice.slice(0, 80)}`)

    await picker.selectOption('main')
    await page.waitForTimeout(900)
    const titles = await page.locator('.mindmap-node').allInnerTexts()
    if (titles.some((text) => text.includes('什么是信息熵'))) problems.push('Anki 卡片串到了默认画布')
    const membership = await page.evaluate(() => window.__layoutMembership ?? {})
    if ((membership.main ?? []).some((id) => id.startsWith('anki-'))) {
      problems.push('默认画布成员被 Anki 导入污染')
    }
    if (!(membership['doc-canvas'] ?? []).includes('anki-q1')) {
      problems.push('目标画布未登记新导入的卡片')
    }
  }
  const membership = await page.evaluate(() => window.__layoutMembership ?? {})
  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, membership }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'card-actions') {
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    window.__sourceEvents = []
    window.addEventListener('pdfnote:open-source', (event) => {
      window.__sourceEvents.push(event.detail)
    })
  })

  const pageTag = page.locator('.mindmap-node-page').first()
  if (!(await pageTag.count())) {
    problems.push('带来源的卡片缺少页码标签')
  } else {
    const label = await pageTag.innerText()
    if (!label.includes('P1')) problems.push(`页码标签内容异常：${label}`)
    await pageTag.click()
    await page.waitForTimeout(500)
  }
  const events = await page.evaluate(() => window.__sourceEvents ?? [])
  if (!events.some((item) => item?.documentId === 'doc1' && item?.page === 1)) {
    problems.push('点击页码标签没有派发跳页事件')
  }

  const explain = page.locator('.mindmap-explain-action').first()
  if (!(await explain.count())) {
    problems.push('有 Q 的卡片缺少 AI 解析入口')
  } else {
    await explain.click()
    await page.waitForTimeout(1000)
  }
  const calls = await page.evaluate(() => window.__calls.slice(-20))
  if (!calls.includes('explain_card')) problems.push('AI 解析未调用模型命令')
  if (!calls.includes('update_card_content')) problems.push('AI 解析结果未写回卡片')
  const note = await page.evaluate(() => window.__cardState?.[0]?.user_note ?? '')
  if (!note.includes('AI 解析')) problems.push('AI 解析结果未写入笔记')

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, events, calls: calls.slice(-8), note: note.slice(0, 80) }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'note-expand') {
  await page.waitForTimeout(1500)
  const node = page.locator('.mindmap-node').first()
  const noteField = node.locator('.mindmap-field[data-field="note"]')
  const noteText = noteField.locator('.mindmap-field-text')
  if (!(await noteField.count())) problems.push('卡片缺少笔记字段')

  const explain = node.locator('.mindmap-explain-action')
  if (!(await explain.count())) {
    problems.push('卡片缺少 AI 解析入口')
  } else {
    await explain.click()
    await page.waitForTimeout(1200)
  }

  // AI 解析写回后必须自动展开，不能仍停在 3 行截断。
  const fieldClass = (await noteField.getAttribute('class')) ?? ''
  if (!fieldClass.includes('is-open')) problems.push('AI 解析写回后笔记没有自动展开')

  const metrics = await noteText.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      lineClamp: style.webkitLineClamp,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      client: element.clientHeight,
      scroll: element.scrollHeight,
      chars: element.innerText.length,
    }
  })
  if (!['none', 'unset', ''].includes(metrics.lineClamp)) {
    problems.push(`展开后仍被行数截断：${metrics.lineClamp}`)
  }
  if (metrics.overflowY !== 'auto') problems.push(`展开后没有纵向滚动条：${metrics.overflowY}`)
  if (metrics.scroll <= metrics.client + 8) problems.push('AI 解析内容不够长，未复现滚动场景')
  if (metrics.chars < 400) problems.push(`笔记正文没有完整渲染：${metrics.chars} 字`)
  const zIndex = await node.evaluate((element) => {
    const wrapper = element.closest('.react-flow__node')
    return wrapper ? Number.parseInt(getComputedStyle(wrapper).zIndex, 10) || 0 : 0
  })
  if (zIndex < 20) problems.push(`展开的卡片没有浮到相邻节点上方：z-index=${zIndex}`)

  if (process.env.SHOT) {
    await node.screenshot({ path: '/tmp/pdfnote-note-expand.png' })
  }

  // 滚轮应该滚笔记，不能平移 / 缩放画布。
  const viewport = page.locator('.react-flow__viewport')
  const beforeWheel = await viewport.getAttribute('style')
  const box = await noteText.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 60))
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(320)
  } else {
    problems.push('展开的笔记没有可交互区域')
  }
  const scrollTop = await noteText.evaluate((element) => element.scrollTop)
  const afterWheel = await viewport.getAttribute('style')
  if (scrollTop <= 0) problems.push('滚轮没有滚动笔记正文')
  if (beforeWheel !== afterWheel) problems.push('滚动笔记时画布被平移')

  // 收起 → 点击正文再次展开。
  await noteField.locator('button.mindmap-field-label').click()
  await page.waitForTimeout(250)
  if (!((await noteText.getAttribute('class')) ?? '').includes('is-clamped')) {
    problems.push('点击收起后没有恢复折叠')
  }
  await noteText.click()
  await page.waitForTimeout(250)
  if (!((await noteText.getAttribute('class')) ?? '').includes('is-open')) {
    problems.push('点击笔记正文没有展开全文')
  }

  // 大纲视图也要能看到并展开笔记（旧版只显示两行摘录）。
  const outlineButton = page.getByRole('button', { name: /大纲/ }).first()
  if (await outlineButton.count()) {
    await outlineButton.click()
    await page.waitForTimeout(450)
    const outlineNote = page
      .locator('.mindmap-outline-body .mindmap-field[data-field="note"] .mindmap-field-text')
      .first()
    if (!(await outlineNote.count())) {
      problems.push('大纲视图没有显示卡片笔记')
    } else {
      if (!((await outlineNote.getAttribute('class')) ?? '').includes('is-clamped')) {
        problems.push('大纲笔记没有折叠提示')
      }
      await outlineNote.click()
      await page.waitForTimeout(250)
      if (!((await outlineNote.getAttribute('class')) ?? '').includes('is-open')) {
        problems.push('大纲笔记点击后没有展开')
      }
    }
  }

  if (await page.locator('.app-crash').count()) problems.push('展开笔记触发了 React 更新循环')

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, metrics, scrollTop, viewportStable: beforeWheel === afterWheel }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'outline-back') {
  await page.waitForTimeout(1200)
  // 独立脑图视图（非嵌入，fitView 生效）才可能复现；刷新后文档关闭，顶栏「脑图」可直接进入。
  if (process.env.STANDALONE !== '0') {
    const topButtons = page.locator('.app-top button')
    const topCount = await topButtons.count()
    if (topCount >= 4) {
      await topButtons.nth(0).click()   // 资料库：关闭当前文档
      await page.waitForTimeout(800)
      await topButtons.nth(3).click()   // 脑图：进入独立视图
      await page.waitForTimeout(1600)
    } else {
      problems.push(`顶栏按钮数量异常：${topCount}`)
    }
  }
  const workspaceCount = await page.locator('.mindmap-workspace').count()
  const standalone = await page.locator('.mindmap-workspace.is-embedded').count() === 0
  if (!workspaceCount) {
    const bodyText = (await page.locator('body').innerText()).slice(0, 300)
    problems.push(`没有进入脑图视图：${bodyText}`)
  }
  const nodesBefore = await page.locator('.mindmap-node').count()
  // 给画布 DOM 打标记：若大纲切换把 React Flow 卸载重建，标记会消失。
  await page.evaluate(() => {
    const flow = document.querySelector('.react-flow')
    if (flow) flow.dataset.persistenceProbe = 'kept'
  })
  await page.getByRole('button', { name: /大纲/ }).first().click()
  await page.waitForTimeout(600)
  const flowInOutline = await page.locator('.react-flow[data-persistence-probe="kept"]').count()
  if (!flowInOutline) problems.push('切到大纲时画布被卸载')
  await page.getByRole('button', { name: /返回画布|画布/ }).first().click()
  await page.waitForTimeout(1200)
  const flowAfter = await page.locator('.react-flow[data-persistence-probe="kept"]').count()
  if (!flowAfter) problems.push('切回画布时 React Flow 被重建')
  const nodesAfter = await page.locator('.mindmap-node').count()
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style')
  const nodeBox = await page.locator('.mindmap-node').first().boundingBox().catch(() => null)
  const paneBox = await page.locator('.react-flow').first().boundingBox().catch(() => null)
  const visible = Boolean(
    nodeBox && paneBox
    && nodeBox.x < paneBox.x + paneBox.width && nodeBox.x + nodeBox.width > paneBox.x
    && nodeBox.y < paneBox.y + paneBox.height && nodeBox.y + nodeBox.height > paneBox.y
  )
  if (nodesAfter === 0) problems.push('切回画布后节点消失')
  if (!visible) problems.push('切回画布后节点不在可视区域')

  // 滚轮缩小一次，看看是否仍不可见（判断是 viewport 还是渲染问题）
  if (paneBox) {
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2)
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(500)
  }
  const viewportAfterZoom = await page.locator('.react-flow__viewport').getAttribute('style')
  const nodeBoxAfterZoom = await page.locator('.mindmap-node').first().boundingBox().catch(() => null)

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, standalone, nodesBefore, nodesAfter, viewport, viewportAfterZoom, nodeBox, paneBox, visible, nodeBoxAfterZoom }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'depth') {
  const openDigest = async () => {
    await page.waitForTimeout(1200)
    const topButton = page.locator('.pdf-digest-toggle')
    const dockButton = page.locator('.pdf-dock button[title="更多：缩放与跳页"]')
    if (await topButton.count()) {
      await topButton.click()
    } else if (await dockButton.count()) {
      await dockButton.click()
      await page.locator('.pdf-dock-menu-wide', { hasText: 'AI 拆书' }).click()
    } else {
      problems.push('缺少 AI 拆书入口')
    }
    await page.waitForSelector('.digest-dialog', { timeout: 5000 })
  }

  await openDigest()
  const select = page.locator('[data-testid="digest-depth"]')
  if (!(await select.count())) {
    problems.push('缺少拆分层级选择器')
  } else {
    const initial = await select.inputValue()
    if (initial !== '2') problems.push(`默认拆分层级应为 2，实际 ${initial}`)
    await select.selectOption('4')
    await page.waitForTimeout(200)
    const meta = await page.locator('.digest-meta').innerText()
    if (!meta.includes('目标 4 层')) problems.push('切换层级后元信息未更新')
    const stored = await page.evaluate(() => localStorage.getItem('pdfnote.digest.depth'))
    if (stored !== '4') problems.push('拆分层级没有持久化')

    // 刷新页面，验证读者设置被记住，且不带旧骨架。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-shell', { timeout: 10000 })
    await page.waitForTimeout(600)
    const docCard = page.locator('.document-card').first()
    if (await docCard.count()) await docCard.click()
    await page.waitForTimeout(3000)
    await openDigest()
    const remembered = await page.locator('[data-testid="digest-depth"]').inputValue()
    if (remembered !== '4') problems.push(`刷新后拆分层级丢失：${remembered}`)
    if (await page.locator('.digest-outline').count()) problems.push('刷新后仍显示旧骨架')

    await page.locator('.digest-dialog footer button', { hasText: '开始分析' }).click()
    await page.waitForTimeout(1200)
    await page.locator('.digest-dialog footer button', { hasText: '汇总骨架' }).click()
    await page.waitForSelector('.digest-outline', { timeout: 5000 })
    const depthSent = await page.evaluate(() => window.__synthesizeDepth)
    if (depthSent !== 4) problems.push(`汇总命令未收到 4 层：${depthSent}`)
    const chunkDepth = await page.evaluate(() => window.__chunkDepth ?? null)
    if (chunkDepth !== 4) problems.push(`阶段一未收到 4 层：${chunkDepth}`)
    if (!(await page.locator('.digest-outline li[data-depth="3"]').count())) problems.push('4 层骨架没有渲染到第 4 层')
    if (await page.locator('.digest-outline li[data-depth="4"]').count()) problems.push('4 层骨架出现了第 5 层')
    const head = await page.locator('.digest-outline-head').innerText()
    if (!head.includes('4 节点') || !head.includes('4 层 / 目标 4 层')) problems.push(`骨架统计不对：${head}`)

    await page.locator('.digest-dialog footer button', { hasText: '写入脑图' }).click()
    await page.waitForTimeout(800)
    const applied = await page.locator('.digest-dialog').innerText()
    if (!applied.includes('4 张卡片')) problems.push('4 层骨架写入数量不对')

    // 改成 2 层：旧骨架必须失效，命令参数也要跟着变。
    await page.locator('[data-testid="digest-depth"]').selectOption('2')
    await page.waitForTimeout(150)
    if (await page.locator('.digest-outline').count()) problems.push('切换层级后没有清掉旧骨架')
    const applyButton = page.locator('.digest-dialog footer button', { hasText: '写入脑图' })
    if (!(await applyButton.isDisabled())) problems.push('没有骨架时「写入脑图」应禁用')
    await page.locator('.digest-dialog footer button', { hasText: '汇总骨架' }).click()
    await page.waitForSelector('.digest-outline', { timeout: 5000 })
    const shallowSent = await page.evaluate(() => window.__synthesizeDepth)
    if (shallowSent !== 2) problems.push(`改回 2 层后命令仍收到 ${shallowSent}`)
    if (await page.locator('.digest-outline li[data-depth="2"]').count()) problems.push('2 层骨架出现了第 3 层')
  }

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'digest') {
  await page.waitForTimeout(1200)
  const topButton = page.locator('.pdf-digest-toggle')
  const dockButton = page.locator('.pdf-dock button[title="更多：缩放与跳页"]')
  if (await topButton.count()) {
    await topButton.click()
  } else if (await dockButton.count()) {
    await dockButton.click()
    await page.locator('.pdf-dock-menu-wide', { hasText: 'AI 拆书' }).click()
  } else {
    problems.push('缺少 AI 拆书入口')
  }
  if (await page.locator('.digest-dialog').count()) {

    await page.locator('.digest-dialog footer button', { hasText: '开始分析' }).click()
    await page.waitForTimeout(1200)
    const progressText = await page.locator('.digest-dialog').innerText()
    if (!progressText.includes('已完成')) problems.push('分块分析未完成')

    await page.locator('.digest-dialog footer button', { hasText: '汇总骨架' }).click()
    await page.waitForSelector('.digest-outline', { timeout: 5000 })
    const treeText = await page.locator('.digest-outline').innerText()
    if (!treeText.includes('背景')) problems.push('骨架预览没有内容')

    await page.locator('.digest-dialog footer button', { hasText: '写入脑图' }).click()
    await page.waitForTimeout(800)
    const applied = await page.locator('.digest-dialog').innerText()
    if (!applied.includes('2 张卡片')) problems.push('写入脑图未给出结果')
  }
  const calls = await page.evaluate(() => window.__calls.slice(-12))
  for (const expected of ['analyze_book_chunk', 'synthesize_book', 'apply_book_outline']) {
    if (!calls.includes(expected)) problems.push(`缺少命令调用：${expected}`)
  }
  const noteCount = await page.evaluate(() => window.__digestNotes?.length ?? 0)
  if (noteCount < 1) problems.push('分块笔记没有落库')

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, noteCount, calls }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

if (STEP === 'notes') {
  await page.waitForTimeout(1200)
  const pageBox = await page.locator('.pdf-page').first().boundingBox()
  if (!pageBox) {
    problems.push('PDF 页面不可见')
  } else {
    await page.mouse.click(pageBox.x + pageBox.width * 0.4, pageBox.y + pageBox.height * 0.35, { button: 'right' })
    await page.waitForSelector('.context-menu', { timeout: 3000 })
    const addNote = page.locator('.context-menu-item', { hasText: '在此页添加留白' }).first()
    if (!(await addNote.count())) problems.push('右键菜单缺少「添加留白」')
    else {
      await addNote.click()
      await page.waitForSelector('.pdf-note', { timeout: 3000 })
    }
  }
  const noteCount = await page.locator('.pdf-note').count()
  if (noteCount !== 1) problems.push(`留白数量异常：${noteCount}`)

  const textarea = page.locator('.pdf-note textarea')
  if (await textarea.count()) {
    await textarea.fill('页边草稿：熵的单位是 bit')
    await page.locator('.pdf-note header').click()
    await page.waitForTimeout(500)
  }
  const saved = await page.evaluate(() => window.__noteState?.[0]?.content ?? '')
  if (!saved.includes('bit')) problems.push(`留白未保存：${saved}`)

  await page.locator('.pdf-note header button[aria-label="折叠留白"]').click()
  await page.waitForTimeout(500)
  const collapsed = await page.locator('.pdf-note.is-collapsed').count()
  if (!collapsed) problems.push('留白折叠未生效')

  await page.locator('.pdf-note-dot').click()
  await page.waitForTimeout(300)
  await page.locator('.pdf-note header button[aria-label="删除留白"]').click()
  await page.waitForTimeout(500)
  const remaining = await page.locator('.pdf-note').count()
  if (remaining !== 0) problems.push(`删除留白后仍显示：${remaining}`)

  await browser.close()
  console.log(JSON.stringify({ problems, step: STEP, noteCount, saved, collapsed, remaining }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

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
  process.exit(problems.length ? 1 : 0)
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
  process.exit(problems.length ? 1 : 0)
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
  process.exit(problems.length ? 1 : 0)
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
