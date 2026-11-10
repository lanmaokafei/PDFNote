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
  // NO_QUESTION=1 模拟 PDF 划重点建的卡（有摘录、没有 question）；
  // 同时让第 3 张三者全空，用来验证「纯结构节点禁用 AI」这一支。
  question: process.env.NO_QUESTION === '1' && (index === 0 || index === 2)
    ? ''
    : `概念卡片 ${index + 1}：心肌梗死与再灌注策略`,
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
  // BOARD=1：给卡片分配标签与复习状态，验证卡片盒的分栏、过滤与拖拽改标签。
  tags: process.env.BOARD === '1'
    ? (index % 4 === 0
      ? ['心内']
      : index % 4 === 1
        ? ['心内', '药理']
        : index % 4 === 2
          ? ['药理']
          : [])
    : [],
  review_state: process.env.BOARD === '1'
    ? (index % 3 === 0 ? 'review' : index % 3 === 1 ? 'learning' : 'new')
    : 'new',
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

await page.addInitScript(({ cards, document, pdfBase64, dense, canvasPref, emptyDocCanvas, styleLink, board, recallSeed, clozeSeed, readingSeedPass, readingSeedNote }) => {
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
  const inkState = []
  window.__inkState = inkState
  // 0.36.0：笔记本、图层、笔记本墨迹
  const notebookState = []
  const layerState = []
  const notebookInkState = []
  window.__notebookState = notebookState
  window.__layerState = layerState
  window.__notebookInkState = notebookInkState
  // 0.38.0：画布涂鸦与卡片图层
  const canvasInkState = []
  const layerMemberState = []
  window.__canvasInkState = canvasInkState
  window.__layerMemberState = layerMemberState
  // 全局 main 画布自带一个图层，和真机 createLayer 的行为一致。
  layerState.push({
    id: 'canvas-layer-1',
    scope: 'canvas',
    owner_id: 'main',
    name: '主层',
    visible: true,
    locked: false,
    sort_order: 0,
    created_at: '2026-11-09T00:00:00.000Z',
  })
  // RECALL_SEED=1：预置一条手写与一条留白，验证文档回忆会把它们一起藏起来。
  if (recallSeed) {
    inkState.push({
      id: 'ink-seed',
      document_id: 'doc1',
      page: 1,
      bbox: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
      style: { color: '#d94f3d', width: 0.004, points: [[0.2, 0.2], [0.35, 0.3]] },
      created_at: '2026-11-04T00:00:00.000Z',
      updated_at: '2026-11-04T00:00:00.000Z',
    })
    noteState.push({
      id: 'note-seed',
      document_id: 'doc1',
      page: 1,
      anchor_y: 0.3,
      content: '页边草稿：回忆时应该一起隐藏。',
      collapsed: false,
      color: 'amber',
      created_at: '2026-11-04T00:00:00.000Z',
      updated_at: '2026-11-04T00:00:00.000Z',
    })
  }
  // 0.20.0 多画布：每张画布有自己的 mindmap_layout 成员；main 装全部种子卡片。
  const canvasState = [
    { id: 'main', document_id: null, name: '默认画布', created_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z' },
    { id: 'doc-canvas', document_id: 'doc1', name: '本书脑图 A', created_at: '2026-11-04T00:00:00.000Z', updated_at: '2026-11-04T00:00:00.000Z' },
    { id: 'book-canvas-b', document_id: 'doc1', name: '本书脑图 B', created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z' },
  ]
  // EMPTY_DOC_CANVAS=1：模拟「这本 PDF 还没有自己的画布」（新导入 / 旧版本数据），
  // 用来验证打开时会自动补建并选中专属画布。
  if (emptyDocCanvas) {
    for (let index = canvasState.length - 1; index >= 0; index -= 1) {
      if (canvasState[index].document_id === document.id) canvasState.splice(index, 1)
    }
  }
  // CANVAS_PREF=none 时不预置画布偏好，让页面走「没有偏好」的解析分支。
  if (canvasPref && canvasPref !== 'none') {
    try { localStorage.setItem(`pdfnote.mindmap.canvas.${document.id}`, canvasPref) } catch { /* ignore */ }
  }
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
  // 两遍阅读：状态放 sessionStorage，刷新页面后仍能读到，用来验证「关掉再打开还记得」。
  const readingKey = 'mock-reading-state'
  const readStored = () => {
    try {
      return JSON.parse(sessionStorage.getItem(readingKey) ?? 'null')
    } catch {
      return null
    }
  }
  let readingState = readStored() ?? {
    documentId: document.id,
    pass: readingSeedPass ? Number(readingSeedPass) : 1,
    recallNote: readingSeedNote ?? '',
    updatedAt: '',
  }
  const storeReading = () => {
    try {
      sessionStorage.setItem(readingKey, JSON.stringify(readingState))
    } catch {
      // 忽略：内存里仍然是最新状态
    }
  }
  window.__readingState = () => readingState

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
    // 0.36.0 手写本：内存里维护 notebooks / layers / notebook_inks。
    list_notebooks: () => notebookState.map((item) => ({ ...item })),
    create_notebook: (args) => {
      const input = args?.input ?? {}
      const timestamp = '2026-11-08T00:00:00.000Z'
      const notebook = {
        id: `notebook-${notebookState.length + 1}`,
        title: input.title ?? '未命名',
        paper: input.paper ?? 'lined',
        created_at: timestamp,
        updated_at: timestamp,
      }
      notebookState.push(notebook)
      layerState.push({
        id: `layer-${layerState.length + 1}`,
        scope: 'notebook',
        owner_id: notebook.id,
        name: '图层 1',
        visible: true,
        locked: false,
        sort_order: 0,
        created_at: timestamp,
      })
      return { ...notebook }
    },
    update_notebook: (args) => {
      const input = args?.input ?? {}
      const notebook = notebookState.find((item) => item.id === input.id)
      if (!notebook) throw new Error('notebook not found')
      notebook.title = input.title ?? notebook.title
      notebook.paper = input.paper ?? notebook.paper
      notebook.updated_at = '2026-11-08T00:00:01.000Z'
      return { ...notebook }
    },
    delete_notebook: (args) => {
      const id = args?.id
      const index = notebookState.findIndex((item) => item.id === id)
      if (index >= 0) notebookState.splice(index, 1)
      for (let i = layerState.length - 1; i >= 0; i -= 1) {
        if (layerState[i].owner_id === id) layerState.splice(i, 1)
      }
      for (let i = notebookInkState.length - 1; i >= 0; i -= 1) {
        if (notebookInkState[i].notebook_id === id) notebookInkState.splice(i, 1)
      }
      return null
    },
    list_layers: (args) => layerState
      .filter((item) => item.scope === args?.scope && item.owner_id === args?.ownerId)
      .map((item) => ({ ...item })),
    create_layer: (args) => {
      const input = args?.input ?? {}
      const order = layerState.filter((item) => item.owner_id === input.owner_id).length
      const layer = {
        id: `layer-${layerState.length + 1}`,
        scope: input.scope ?? 'notebook',
        owner_id: input.owner_id,
        name: input.name || `图层 ${order + 1}`,
        visible: true,
        locked: false,
        sort_order: order,
        created_at: '2026-11-08T00:00:00.000Z',
      }
      layerState.push(layer)
      return { ...layer }
    },
    update_layer: (args) => {
      const input = args?.input ?? {}
      const layer = layerState.find((item) => item.id === input.id)
      if (!layer) throw new Error('layer not found')
      if (input.name !== undefined && input.name.trim()) layer.name = input.name.trim()
      if (input.visible !== undefined) layer.visible = input.visible
      if (input.locked !== undefined) layer.locked = input.locked
      return { ...layer }
    },
    delete_layer: (args) => {
      const id = args?.id
      const index = layerState.findIndex((item) => item.id === id)
      if (index >= 0) layerState.splice(index, 1)
      for (let i = notebookInkState.length - 1; i >= 0; i -= 1) {
        if (notebookInkState[i].layer_id === id) notebookInkState.splice(i, 1)
      }
      for (let i = canvasInkState.length - 1; i >= 0; i -= 1) {
        if (canvasInkState[i].layer_id === id) canvasInkState.splice(i, 1)
      }
      for (let i = layerMemberState.length - 1; i >= 0; i -= 1) {
        if (layerMemberState[i].layer_id === id) layerMemberState.splice(i, 1)
      }
      return null
    },
    list_notebook_inks: (args) => notebookInkState
      .filter((item) => item.notebook_id === args?.notebookId)
      .map((item) => ({ ...item })),
    create_notebook_ink: (args) => {
      const input = args?.input ?? {}
      const ink = {
        id: `nink-${notebookInkState.length + 1}`,
        notebook_id: input.notebook_id,
        page: input.page ?? 1,
        layer_id: input.layer_id,
        bbox: input.bbox,
        style: input.style,
        created_at: '2026-11-08T00:00:00.000Z',
        updated_at: '2026-11-08T00:00:00.000Z',
      }
      notebookInkState.push(ink)
      return { ...ink }
    },
    delete_notebook_ink: (args) => {
      const index = notebookInkState.findIndex((item) => item.id === args?.id)
      if (index >= 0) notebookInkState.splice(index, 1)
      return null
    },
    list_canvas_inks: (args) => canvasInkState
      .filter((item) => item.canvas_id === args?.canvasId)
      .map((item) => ({ ...item })),
    create_canvas_ink: (args) => {
      const input = args?.input ?? {}
      const ink = {
        id: `cink-${canvasInkState.length + 1}`,
        canvas_id: input.canvas_id,
        layer_id: input.layer_id,
        points: input.points ?? [],
        style: input.style ?? {},
        created_at: '2026-11-09T00:00:00.000Z',
        updated_at: '2026-11-09T00:00:00.000Z',
      }
      canvasInkState.push(ink)
      return { ...ink }
    },
    delete_canvas_ink: (args) => {
      const index = canvasInkState.findIndex((item) => item.id === args?.id)
      if (index >= 0) canvasInkState.splice(index, 1)
      return null
    },
    list_layer_members: (args) => layerMemberState
      .filter((item) => item.canvas_id === args?.canvasId)
      .map((item) => ({ ...item })),
    set_card_layer: (args) => {
      const input = args?.input ?? {}
      for (let i = layerMemberState.length - 1; i >= 0; i -= 1) {
        if (layerMemberState[i].canvas_id === input.canvas_id && layerMemberState[i].card_id === input.card_id) {
          layerMemberState.splice(i, 1)
        }
      }
      if (input.layer_id) {
        layerMemberState.push({
          layer_id: input.layer_id,
          card_id: input.card_id,
          canvas_id: input.canvas_id,
        })
      }
      return null
    },
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
    get_reading_state: () => readingState,
    set_reading_pass: (args) => {
      readingState = { ...readingState, pass: args?.input?.pass ?? 1, updatedAt: new Date().toISOString() }
      storeReading()
      return readingState
    },
    save_recall_note: (args) => {
      readingState = { ...readingState, recallNote: args?.input?.note ?? '', updatedAt: new Date().toISOString() }
      storeReading()
      return readingState
    },
    list_annotations: () => [
      {
        id: 'ann-1',
        card_id: 'c1',
        kind: 'highlight',
        page: 1,
        geometry: { rects: [{ x: 0.1, y: 0.12, width: 0.32, height: 0.05 }] },
        style: {},
        created_at: '2026-11-03T00:00:00.000Z',
        updated_at: '2026-11-03T00:00:00.000Z',
      },
      // CLOZE_SEED=1：再加一条「有句子的摘录」，用来验证挖空填空（c1 是公式，走整句回忆）。
      ...(clozeSeed ? [
        {
          id: 'ann-2',
          card_id: 'c2',
          kind: 'highlight',
          page: 1,
          geometry: { rects: [{ x: 0.1, y: 0.32, width: 0.36, height: 0.05 }] },
          style: {},
          created_at: '2026-11-03T00:00:00.000Z',
          updated_at: '2026-11-03T00:00:00.000Z',
        },
        {
          id: 'ann-3',
          card_id: 'c4',
          kind: 'highlight',
          page: 1,
          geometry: { rects: [{ x: 0.1, y: 0.52, width: 0.42, height: 0.05 }] },
          style: {},
          created_at: '2026-11-03T00:00:00.000Z',
          updated_at: '2026-11-03T00:00:00.000Z',
        },
      ] : []),
    ],
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
        parent_id: input.parent_id ?? null,
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
    // STYLE_LINK=1：给 c1→c2 建一条关联链接，用来验证虚线颜色与「链接」标签开关。
    list_card_links: () => (styleLink
      ? [{ id: 'link-1', source_card_id: 'c1', target_card_id: 'c2', label: '', created_at: '2026-11-03T00:00:00.000Z' }]
      : []),
    list_tags: () => (board ? ['心内', '药理', '空标签'] : []),
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
    // 卡片盒拖拽：改写标签后返回新对象（换引用，避免 zustand 跳过重渲染）。
    set_card_tags: (args) => {
      const card = cardState.find((item) => item.id === args?.cardId)
      if (!card) throw new Error('卡片不存在')
      card.tags = [...(args?.tags ?? [])]
      card.updated_at = new Date().toISOString()
      window.__cardState = cardState
      return { ...card }
    },
    // 大纲编辑：一次提交整层结构；mock 只按 updates 改父子与顺序。
    apply_card_order: (args) => {
      const updates = args?.updates ?? []
      window.__orderCalls = (window.__orderCalls ?? 0) + 1
      window.__lastOrder = updates
      for (const update of updates) {
        const card = cardState.find((item) => item.id === update.id)
        if (!card) throw new Error(`卡片不存在：${update.id}`)
        card.parent_id = update.parent_id ?? null
        card.sort_order = update.sort_order
      }
      return null
    },
    list_page_inks: () => inkState.slice(),
    create_page_ink: (args) => {
      const input = args ?? {}
      const ink = {
        id: `ink${inkState.length + 1}`,
        document_id: input.documentId ?? 'doc1',
        page: input.page ?? 1,
        bbox: input.bbox ?? { x: 0, y: 0, width: 0.1, height: 0.1 },
        style: input.style ?? { color: '#d94f3d', width: 0.0028, points: [] },
        created_at: '2026-11-03T00:00:00.000Z',
        updated_at: '2026-11-03T00:00:00.000Z',
      }
      inkState.push(ink)
      window.__inkState = inkState
      return ink
    },
    delete_page_ink: (args) => {
      const id = args?.id
      const index = inkState.findIndex((item) => item.id === id)
      if (index >= 0) inkState.splice(index, 1)
      window.__inkState = inkState
      return null
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
    }, { cards, document, pdfBase64, dense: process.env.DENSE === '1', canvasPref: process.env.CANVAS_PREF ?? 'main', emptyDocCanvas: process.env.EMPTY_DOC_CANVAS === '1', styleLink: process.env.STYLE_LINK === '1', board: process.env.BOARD === '1', recallSeed: process.env.RECALL_SEED === '1', clozeSeed: process.env.CLOZE_SEED === '1', readingSeedPass: process.env.READING_SEED_PASS ?? '', readingSeedNote: process.env.READING_SEED_NOTE ?? '' })

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

// STEP=doc-canvas：这本 PDF 还没有自己的画布（新导入 / 旧版本数据）时，
// 打开应自动补建一张并选中，而不是落到全局 main（上一本书的 AI 拆书内容）。
if (process.env.STEP === 'doc-canvas') {
  await page.locator('.document-card').first().click()
  await page.waitForSelector('[data-testid="canvas-select"]', { timeout: 30000 })
  await page.waitForTimeout(1500)

  const picker = page.locator('[data-testid="canvas-select"]').first()
  const ops = await page.evaluate(() => window.__canvasOps ?? [])
  const created = ops.filter((op) => op.kind === 'create' && op.document_id === 'doc1')
  if (created.length !== 1) {
    problems.push(`没有自动补建专属画布：${JSON.stringify(ops)}`)
  }
  const active = await picker.inputValue()
  if (!created.length || active !== created[0].id) {
    problems.push(`自动补建后没有选中新画布：active=${active}`)
  }
  if (created.length && created[0].name !== '测试教材') {
    problems.push(`画布没有用文档标题命名：${created[0].name}`)
  }
  const nodes = await page.locator('.mindmap-node').count()
  if (nodes !== 0) problems.push(`新画布应为空，实际 ${nodes} 个节点`)
  const stored = await page.evaluate(() => {
    try { return localStorage.getItem('pdfnote.mindmap.canvas.doc1') } catch { return null }
  })
  if (!created.length || stored !== created[0].id) {
    problems.push(`没有记住当前画布，下次打开无法自动关联：${stored}`)
  }

  // 回到资料库再打开同一本书：必须复用上次的画布，不能再新建一张。
  await page.getByRole('tab', { name: /资料库/ }).click()
  await page.waitForSelector('.document-card', { timeout: 15000 })
  await page.locator('.document-card').first().click()
  await page.waitForSelector('[data-testid="canvas-select"]', { timeout: 30000 })
  await page.waitForTimeout(1200)
  const opsAfter = await page.evaluate(() => (window.__canvasOps ?? []).filter((op) => op.kind === 'create'))
  const activeAfter = await picker.inputValue()
  if (opsAfter.length !== 1) problems.push(`重新打开文档又新建了画布：${JSON.stringify(opsAfter)}`)
  if (!created.length || activeAfter !== created[0].id) {
    problems.push(`重新打开文档没有关联上次的画布：${activeAfter}`)
  }

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'doc-canvas', active, created, stored }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=textlayer：PDF 文字层必须按 run 渲染 —— 字号来自 PDF transform，
// 基线来自文字项 y；旧的「行高 × 0.86 + 整行拉伸」会让选区压不住字形。
if (process.env.STEP === 'textlayer') {
  await page.locator('.document-card').first().click()
  await page.waitForSelector('.pdf-canvas', { timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '文字', exact: true }).click()
  await page.waitForSelector('.pdf-text-run', { timeout: 60000 })
  await page.waitForTimeout(700)

  const info = await page.evaluate(() => {
    const layer = document.querySelector('.pdf-text-layer')
    const runs = [...document.querySelectorAll('.pdf-text-run')]
    const lines = [...document.querySelectorAll('.pdf-text-line')]
    return {
      layerHeight: layer ? layer.getBoundingClientRect().height : 0,
      runs: runs.length,
      lines: lines.length,
      linesWithoutRuns: lines.filter((line) => !line.querySelector('.pdf-text-run')).length,
      fontSizes: runs.slice(0, 4).map((run) => parseFloat(getComputedStyle(run).fontSize)),
      firstRunText: runs[0]?.textContent ?? '',
    }
  })

  // 测试 PDF 的正文是 12pt / 页高 792pt，渲染字号应精确等于这个比例（±2%）。
  const expectedRatio = 12 / 792
  const ratio = info.layerHeight > 0 ? info.fontSizes[0] / info.layerHeight : 0
  if (Math.abs(ratio - expectedRatio) > expectedRatio * 0.02) {
    problems.push(`文字层字号比例不符：${ratio.toFixed(5)}，期望 ${expectedRatio.toFixed(5)}`)
  }
  if (info.runs === 0 || info.linesWithoutRuns > 0) {
    problems.push(`文字层没有按 run 渲染：runs=${info.runs} 无 run 行=${info.linesWithoutRuns}`)
  }
  if (!info.firstRunText.includes('PDFNote')) {
    problems.push(`第一个 run 文本异常：${info.firstRunText}`)
  }

  const selection = await page.evaluate(() => {
    const run = document.querySelector('.pdf-text-run')
    const node = run?.querySelector('span')?.firstChild
    if (!node) return null
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(4, (node.textContent ?? '').length))
    const current = window.getSelection()
    current?.removeAllRanges()
    current?.addRange(range)
    const rect = range.getBoundingClientRect()
    return { text: current?.toString() ?? '', height: rect.height, width: rect.width }
  })
  if (!selection || selection.text !== 'PDFN') {
    problems.push(`文字层选区异常：${JSON.stringify(selection)}`)
  } else if (selection.height < info.fontSizes[0] * 0.75 || selection.height > info.fontSizes[0] * 1.7) {
    // 选区框是行盒高度（略大于字号），只要覆盖字形即可，不要求等于字号。
    problems.push(`选区高度 ${selection.height.toFixed(1)} 与字号 ${info.fontSizes[0].toFixed(1)} 不匹配`)
  }

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'textlayer', ratio, ...info, selection }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=textlayer：PDF 文字层必须按 run 渲染 —— 字号来自 PDF transform，
// 基线来自文字项 y；旧的「行高 × 0.86 + 整行拉伸」会让选区压不住字形。
if (process.env.STEP === 'textlayer') {
  await page.locator('.document-card').first().click()
  await page.waitForSelector('.pdf-canvas', { timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '文字', exact: true }).click()
  await page.waitForSelector('.pdf-text-run', { timeout: 60000 })
  await page.waitForTimeout(700)

  const info = await page.evaluate(() => {
    const layer = document.querySelector('.pdf-text-layer')
    const runs = [...document.querySelectorAll('.pdf-text-run')]
    const lines = [...document.querySelectorAll('.pdf-text-line')]
    return {
      layerHeight: layer ? layer.getBoundingClientRect().height : 0,
      runs: runs.length,
      lines: lines.length,
      linesWithoutRuns: lines.filter((line) => !line.querySelector('.pdf-text-run')).length,
      fontSizes: runs.slice(0, 4).map((run) => parseFloat(getComputedStyle(run).fontSize)),
      firstRunText: runs[0]?.textContent ?? '',
    }
  })

  // 测试 PDF 的正文是 12pt / 页高 792pt，渲染字号应精确等于这个比例（±2%）。
  const expectedRatio = 12 / 792
  const ratio = info.layerHeight > 0 ? info.fontSizes[0] / info.layerHeight : 0
  if (Math.abs(ratio - expectedRatio) > expectedRatio * 0.02) {
    problems.push(`文字层字号比例不符：${ratio.toFixed(5)}，期望 ${expectedRatio.toFixed(5)}`)
  }
  if (info.runs === 0 || info.linesWithoutRuns > 0) {
    problems.push(`文字层没有按 run 渲染：runs=${info.runs} 无 run 行=${info.linesWithoutRuns}`)
  }
  if (!info.firstRunText.includes('PDFNote')) {
    problems.push(`第一个 run 文本异常：${info.firstRunText}`)
  }

  const selection = await page.evaluate(() => {
    const run = document.querySelector('.pdf-text-run')
    const node = run?.querySelector('span')?.firstChild
    if (!node) return null
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, Math.min(4, (node.textContent ?? '').length))
    const current = window.getSelection()
    current?.removeAllRanges()
    current?.addRange(range)
    const rect = range.getBoundingClientRect()
    return { text: current?.toString() ?? '', height: rect.height, width: rect.width }
  })
  if (!selection || selection.text !== 'PDFN') {
    problems.push(`文字层选区异常：${JSON.stringify(selection)}`)
  } else if (Math.abs(selection.height - info.fontSizes[0]) > Math.max(2, info.fontSizes[0] * 0.2)) {
    problems.push(`选区高度 ${selection.height.toFixed(1)} 与字号 ${info.fontSizes[0].toFixed(1)} 不匹配`)
  }

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'textlayer', ratio, ...info, selection }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=explain：AI 解析必须对每张有内容的卡片开放。
// 以前用 `card.question.trim() &&` 条件渲染，PDF 划重点建的卡（只有摘录）整条入口被滤掉。
if (process.env.STEP === 'explain') {
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(1500)

  const buttons = await page.evaluate(() => [...document.querySelectorAll('.mindmap-node')].map((node) => {
    const button = node.querySelector('.mindmap-explain-action')
    return {
      hasButton: Boolean(button),
      disabled: button ? button.disabled : null,
      title: button ? button.getAttribute('title') : null,
    }
  }))

  if (buttons.length < 3) problems.push(`卡片数量异常：${buttons.length}`)
  const missing = buttons.filter((item) => !item.hasButton).length
  if (missing) problems.push(`${missing} 张卡片没有 AI 解析入口`)
  // 第 1 张：无 question、有公式摘录 → 可解析，且提示文案指向摘录。
  if (buttons[0]?.disabled !== false) problems.push('只有摘录的卡片 AI 解析被禁用')
  if (!String(buttons[0]?.title ?? '').includes('摘录')) {
    problems.push(`无 question 的卡片提示文案没改：${buttons[0]?.title}`)
  }
  // 第 3 张：三者全空 → 按钮保留但禁用。
  if (buttons[2]?.disabled !== true) problems.push('空卡片的 AI 解析仍可点击')
  if (!String(buttons[2]?.title ?? '').includes('还没有内容')) {
    problems.push(`空卡片提示文案不对：${buttons[2]?.title}`)
  }

  const first = page.locator('.mindmap-node').first()
  await first.locator('.mindmap-explain-action').click()
  await page.waitForTimeout(1600)
  const note = await first.locator('.mindmap-field[data-field="note"] .mindmap-field-text').innerText()
  if (!note.includes('AI 解析')) {
    problems.push(`无 question 的卡片没有写回解析结果：${note.slice(0, 40)}`)
  }
  const errorNode = page.locator('.mindmap-error')
  if ((await errorNode.count()) > 0) {
    problems.push(`AI 解析报错：${await errorNode.first().innerText()}`)
  }

  if (process.env.SHOT) await first.screenshot({ path: '/tmp/pdfnote-explain.png' })
  await browser.close()
  console.log(JSON.stringify({ problems, step: 'explain', buttons, noteChars: note.length }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=ink-erase：橡皮必须可调大小，圈到的笔迹就能擦掉（不必正好点在线上）。
if (process.env.STEP === 'ink-erase') {
  await page.locator('.document-card').first().click()
  await page.waitForSelector('.pdf-annotation-layer', { timeout: 30000 })
  await page.waitForTimeout(1500)

  // 进入墨迹工具
  await page.locator('.pdf-dock button', { hasText: '墨迹' }).first().click()
  await page.waitForSelector('.pdf-ink-palette', { timeout: 5000 })

  const svg = page.locator('.pdf-annotation-layer').first()
  const box = await svg.boundingBox()
  if (!box) {
    problems.push('找不到页面画布')
    await browser.close()
    console.log(JSON.stringify({ problems, step: 'ink-erase' }))
    process.exit(1)
  }

  // 画两条线：上面一条、下面一条
  const drawLine = async (y) => {
    await page.mouse.move(box.x + 110, box.y + y)
    await page.mouse.down()
    for (let index = 1; index <= 8; index += 1) {
      await page.mouse.move(box.x + 110 + index * 12, box.y + y)
    }
    await page.mouse.up()
    await page.waitForTimeout(200)
  }
  await drawLine(180)
  await drawLine(280)

  const inkCount = () => page.locator('.pdf-ink').count()
  if ((await inkCount()) !== 2) problems.push(`画两条线后应有 2 条墨迹，实际 ${await inkCount()}`)

  // 笔宽滑杆：浮在墨迹小菜单上方，可拖到两端
  await page.locator('[data-testid="ink-size-trigger-pen"]').click()
  await page.waitForSelector('[data-testid="ink-size-popover-pen"]', { timeout: 5000 })
  const penSlider = page.locator('[data-testid="ink-size-slider-pen"]')
  const penBounds = await penSlider.evaluate((input) => ({ min: Number(input.min), max: Number(input.max) }))
  if (!(penBounds.min === 0.0018 && penBounds.max === 0.0072)) {
    problems.push(`笔宽滑杆范围异常：${JSON.stringify(penBounds)}`)
  }
  await penSlider.focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(200)
  const penMin = await page.locator('[data-testid="ink-size-value-pen"]').innerText()
  if (!penMin.includes('1.8')) problems.push(`笔宽最小值不是「细」：${penMin}`)
  await page.keyboard.press('End')
  await page.waitForTimeout(200)
  const penMax = await page.locator('[data-testid="ink-size-value-pen"]').innerText()
  if (!penMax.includes('7.2')) problems.push(`笔宽最大值异常：${penMax}`)

  // 点橡皮：半径滑杆浮层出现，最小 = 小(8)，最大 = 特大(56)
  await page.locator('.pdf-ink-palette > button', { hasText: '橡皮' }).click()
  await page.locator('[data-testid="ink-size-trigger-eraser"]').click()
  await page.waitForSelector('[data-testid="ink-size-popover-eraser"]', { timeout: 5000 })
  const eraserSlider = page.locator('[data-testid="ink-size-slider-eraser"]')
  const eraserBounds = await eraserSlider.evaluate((input) => ({
    min: Number(input.min), max: Number(input.max), step: Number(input.step),
  }))
  if (!(eraserBounds.min === 8 && eraserBounds.max === 56 && eraserBounds.step === 1)) {
    problems.push(`橡皮半径滑杆范围异常：${JSON.stringify(eraserBounds)}`)
  }
  await eraserSlider.focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  const eraserMin = await page.locator('[data-testid="ink-size-value-eraser"]').innerText()
  if (!eraserMin.includes('8')) problems.push(`橡皮最小值不是「小」：${eraserMin}`)
  await page.keyboard.press('End')
  await page.waitForTimeout(200)
  const eraserMax = await page.locator('[data-testid="ink-size-value-eraser"]').innerText()
  if (!eraserMax.includes('56')) problems.push(`橡皮最大值不是「特大」：${eraserMax}`)
  if (process.env.SHOT) {
    // 元素截图会把浮层裁掉，必须截整个视口才能看到浮在菜单上方的滑杆。
    await page.screenshot({ path: '/tmp/pdfnote-eraser-palette.png' })
  }

  // 拖到最大后，页面上的光标圆圈半径要跟着变
  await page.mouse.move(box.x + 150, box.y + 180)
  await page.waitForTimeout(350)
  const cursor = await page.evaluate(() => {
    const circle = document.querySelector('.pdf-eraser-cursor')
    return circle ? Number.parseFloat(circle.getAttribute('r') ?? '0') : 0
  })
  if (!(cursor > 20)) problems.push(`特大橡皮的光标半径太小：${cursor}`)
  if (process.env.SHOT) {
    await svg.screenshot({ path: '/tmp/pdfnote-eraser-cursor.png' })
  }

  // 悬停命中：靠近上面那条线，它应该高亮
  await page.mouse.move(box.x + 150, box.y + 196)
  await page.waitForTimeout(300)
  const hovered = await page.locator('.pdf-ink.is-hover').count()
  if (hovered < 1) problems.push('悬停在笔迹附近时没有命中高亮')

  // 按住横穿两条线：特大橡皮一次擦掉
  await page.mouse.move(box.x + 150, box.y + 150)
  await page.mouse.down()
  for (let step = 0; step <= 10; step += 1) {
    await page.mouse.move(box.x + 150, box.y + 150 + step * 18)
    await page.waitForTimeout(60)
  }
  await page.mouse.up()
  await page.waitForTimeout(600)

  const after = await inkCount()
  const stored = await page.evaluate(() => (window.__inkState ?? []).length)
  if (after !== 0) problems.push(`拖动擦除后仍有 ${after} 条墨迹未删`)
  if (stored !== 0) problems.push(`后端还留着 ${stored} 条墨迹`)

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'ink-erase', penBounds, penMin, penMax, eraserBounds, eraserMin, eraserMax, cursor, hovered, after, stored }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=style：卡片右键菜单必须能打开样式面板，主题一键替换整套、
// 单项可自定义、选择按画布保存在本地。
if (process.env.STEP === 'style') {
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(1400)

  const node = page.locator('.react-flow__node').first()
  await node.click({ button: 'right' })
  await page.waitForSelector('.context-menu', { timeout: 5000 })
  const styleItem = page.locator('.context-menu-item', { hasText: '卡片样式' })
  if (!(await styleItem.count())) problems.push('卡片右键菜单没有「卡片样式」入口')
  await styleItem.first().click()
  await page.waitForSelector('[data-testid="style-panel"]', { timeout: 5000 })
  await page.waitForTimeout(300)
  if (process.env.SHOT) {
    await page.locator('[data-testid="style-panel"]').screenshot({ path: '/tmp/pdfnote-style-panel.png' })
  }

  const readCard = () => page.evaluate(() => {
    const card = document.querySelector('.mindmap-node')
    const title = document.querySelector('.mindmap-node-header h3')
    const root = document.querySelector('.mindmap-workspace')
    return {
      bg: getComputedStyle(card).backgroundColor,
      radius: getComputedStyle(card).borderRadius,
      titleSize: title ? getComputedStyle(title).fontSize : null,
      theme: root?.dataset.mmTheme ?? null,
      surface: root?.dataset.mmSurface ?? null,
      density: root?.dataset.mmDensity ?? null,
      stored: localStorage.getItem('pdfnote.mindmap.style.main'),
    }
  })

  const before = await readCard()
  if (before.theme !== 'paper') problems.push(`默认主题不是 paper：${before.theme}`)
  if (before.bg !== 'rgb(255, 255, 255)') problems.push(`默认卡面不是白色：${before.bg}`)

  // 1) 一键换整套：墨色
  await page.locator('[data-testid="style-theme-ink"]').click()
  await page.waitForTimeout(400)
  const ink = await readCard()
  if (ink.theme !== 'ink') problems.push(`主题没有切到 ink：${ink.theme}`)
  if (ink.bg !== 'rgb(36, 41, 37)') problems.push(`墨色卡面没有生效：${ink.bg}`)
  if (!ink.stored || !ink.stored.includes('ink')) problems.push('样式没有写入本地偏好')

  // 2) 二十四节气色板：直接点色块换这张卡的颜色，不必再靠 Q 徽标循环
  const swatchCount = await page.locator('[data-testid^="style-swatch-"]').count()
  if (swatchCount !== 24) problems.push(`色板不是 24 色：${swatchCount}`)
  const readTone = () => page.evaluate(() => {
    const node = document.querySelector('.mindmap-node')
    return {
      bar: getComputedStyle(node).borderLeftColor,
      stored: localStorage.getItem('pdfnote.mindmap.tone'),
    }
  })
  const toneBefore = await readTone()
  await page.locator('[data-testid="style-swatch-5"]').click()
  await page.waitForTimeout(350)
  const tonePicked = await readTone()
  if (tonePicked.bar === toneBefore.bar) problems.push('点色块没有改变卡片颜色')
  if (!tonePicked.stored || !tonePicked.stored.includes('"c1"')) {
    problems.push(`手动配色没有落盘：${tonePicked.stored}`)
  }
  await page.locator('[data-testid="style-tone-auto"]').click()
  await page.waitForTimeout(350)
  const toneAuto = await readTone()
  if (toneAuto.bar === tonePicked.bar) problems.push('点「跟随子树」没有恢复自动配色')

  // 3) 单项自定义：大圆角 + 宽松密度
  await page.locator('[data-testid="style-radius-round"]').click()
  await page.waitForTimeout(250)
  await page.locator('[data-testid="style-density-roomy"]').click()
  await page.waitForTimeout(350)
  const custom = await readCard()
  if (custom.radius !== '14px') problems.push(`圆角没有变成 14px：${custom.radius}`)
  if (custom.titleSize !== '10.5px') problems.push(`密度没有变成宽松：字号 ${custom.titleSize}`)

  // 4) 换主题会清掉自定义覆盖
  await page.locator('[data-testid="style-theme-outline"]').click()
  await page.waitForTimeout(350)
  const outline = await readCard()
  if (outline.radius !== '2px') problems.push(`线框主题圆角应为 2px：${outline.radius}`)
  if (outline.titleSize !== '10px') problems.push(`换主题没有清掉密度覆盖：${outline.titleSize}`)

  // 5) 新增「色块」主题：实心标题栏 + 深墨连线（圆点、无箭头）+ 隐藏链接标签
  const readLook = () => page.evaluate(() => {
    const root = document.querySelector('.mindmap-workspace')
    const node = document.querySelector('.mindmap-node')
    const header = node?.querySelector('.mindmap-node-header')
    const title = node?.querySelector('.mindmap-node-header h3')
    const hexToRgb = (hex) => {
      const value = hex.replace('#', '')
      if (value.length !== 6) return ''
      const number = parseInt(value, 16)
      return `rgb(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255})`
    }
    const luminance = (color) => {
      const [r, g, b] = (color.match(/\d+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
      const channel = (value) => {
        const srgb = value / 255
        return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const contrast = (a, b) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (light + 0.05) / (dark + 0.05)
    }
    const paths = [...document.querySelectorAll('.react-flow__edge-path')]
    // 关联链接是虚线（stroke-dasharray），层级连线是实线；用它区分最稳。
    const isLink = (path) => getComputedStyle(path).strokeDasharray !== 'none'
    const hierarchyPaths = paths.filter((path) => !isLink(path))
    const linkPaths = paths.filter((path) => isLink(path))
    const bar = node ? getComputedStyle(node).getPropertyValue('--tone-bar').trim() : ''
    const wash = node ? getComputedStyle(node).getPropertyValue('--tone-wash').trim() : ''
    return {
      theme: root?.dataset.mmTheme ?? null,
      headerAttr: root?.dataset.mmHeader ?? null,
      headerBg: header ? getComputedStyle(header).backgroundColor : null,
      barRgb: bar ? hexToRgb(bar) : '',
      washRgb: wash ? hexToRgb(wash) : '',
      titleContrast: title && header
        ? contrast(getComputedStyle(title).color, getComputedStyle(header).backgroundColor)
        : 0,
      stripe: node ? getComputedStyle(node).borderLeftWidth : null,
      strokes: hierarchyPaths.map((path) => getComputedStyle(path).stroke),
      markerEnds: hierarchyPaths.map((path) => path.getAttribute('marker-end')).filter(Boolean),
      linkStrokes: linkPaths.map((path) => getComputedStyle(path).stroke),
      linkLabels: document.querySelectorAll('.react-flow__edge-text, .react-flow__edge-textbg').length,
      dots: document.querySelectorAll('.react-flow__edge circle').length,
    }
  })

  await page.locator('[data-testid="style-theme-block"]').click()
  await page.waitForTimeout(500)
  const block = await readLook()
  if (block.theme !== 'block') problems.push(`主题没有切到 block：${block.theme}`)
  if (block.headerBg !== block.barRgb) problems.push(`实心头背景不是主色：${block.headerBg} vs ${block.barRgb}`)
  if (block.titleContrast < 4.5) problems.push(`实心头字色对比度不足：${block.titleContrast.toFixed(2)}`)
  if (block.stripe !== '0px') problems.push(`实心头应去掉左侧色条：${block.stripe}`)
  if (!block.strokes.length) problems.push('画布没有渲染连线')
  if (!block.strokes.every((stroke) => stroke === 'rgb(47, 58, 51)')) {
    problems.push(`层级连线不是深墨色：${block.strokes.slice(0, 3)}`)
  }
  if (block.markerEnds.length > 0) problems.push(`深墨连线不应有箭头：${block.markerEnds.length}`)
  if (block.dots < 2) problems.push(`连线端点圆点缺失：${block.dots}`)
  if (process.env.SHOT) {
    await page.locator('.mindmap-workspace').first().screenshot({ path: '/tmp/pdfnote-style-block-solid.png' })
  }
  if (process.env.STYLE_LINK === '1') {
    if (block.linkLabels !== 0) problems.push(`色块主题不应显示链接标签：${block.linkLabels}`)
    // 关联链接跟随源卡片色调（不是默认蓝灰 #7d9dab）。
    if (block.linkStrokes.length && block.linkStrokes.every((stroke) => stroke === 'rgb(125, 157, 171)')) {
      problems.push(`关联链接没有跟随色调：${block.linkStrokes.join(',')}`)
    }
  }

  // 6) 单项覆盖：标题栏改回淡底、链接标签打开（都不该被主题锁死）
  await page.locator('[data-testid="style-header-tint"]').click()
  await page.waitForTimeout(350)
  const tinted = await readLook()
  if (tinted.headerBg !== tinted.washRgb) problems.push(`标题栏没有回到淡底：${tinted.headerBg} vs ${tinted.washRgb}`)
  await page.locator('[data-testid="style-link-labels-on"]').click()
  await page.waitForTimeout(350)
  const labelled = await readLook()
  if (process.env.STYLE_LINK === '1' && labelled.linkLabels < 1) problems.push('打开「链接标签」后没有显示标签')

  // 7) 重载后仍然生效
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-shell')
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(1200)
  const after = await readCard()
  if (after.theme !== 'block') problems.push(`重载后主题丢失：${after.theme}`)
  if (after.radius !== '8px') problems.push(`重载后圆角丢失：${after.radius}`)

  if (process.env.SHOT) {
    await page.locator('.mindmap-workspace').first().screenshot({ path: '/tmp/pdfnote-style-block.png' })
  }
  await browser.close()
  console.log(JSON.stringify({ problems, step: 'style', before, ink, custom, outline, block, tinted, labelled, after }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=tone：卡片必须按「子树根」分到二十四节气色，而不是一片同色。
// 配合 ARRANGE_FOREST=1 CARD_COUNT=26 跑（26 张互不相连的卡片 = 26 棵独立子树）。
if (process.env.STEP === 'tone') {
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(1500)

  const info = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.mindmap-node')]
    const toneOf = (node) => [...node.classList].find((name) => name.startsWith('mindmap-tone-')) ?? null
    const tones = nodes.map(toneOf)
    const bars = [...new Set(nodes.map((node) => getComputedStyle(node).getPropertyValue('--tone-bar').trim()))]
    const header = nodes[0]?.querySelector('.mindmap-node-header') ?? null
    return {
      total: nodes.length,
      missingTone: tones.filter((tone) => tone === null).length,
      distinct: new Set(tones).size,
      distinctBars: bars.length,
      sampleBars: bars.slice(0, 8),
      borderLeft: nodes[0] ? getComputedStyle(nodes[0]).borderLeftColor : null,
      headerBg: header ? getComputedStyle(header).backgroundColor : null,
      bodyBg: nodes[0] ? getComputedStyle(nodes[0]).backgroundColor : null,
    }
  })

  if (info.total < 20) problems.push(`卡片数量异常：${info.total}`)
  if (info.missingTone > 0) problems.push(`${info.missingTone} 个节点没有色调类`)
  if (info.distinct < 10) problems.push(`森林场景只有 ${info.distinct} 种色调，颜色仍然单调`)
  if (info.distinct !== info.distinctBars) {
    problems.push(`色调类与 CSS 变量不一致：${info.distinct} 类 / ${info.distinctBars} 色`)
  }
  if (info.bodyBg !== 'rgb(255, 255, 255)') problems.push(`卡片底不是白色：${info.bodyBg}`)

  // 点徽标 → 换下一个节气色，并写入本地偏好
  const firstNode = page.locator('.react-flow__node').first()
  const toneOfNode = () => firstNode.evaluate((element) =>
    [...element.querySelector('.mindmap-node').classList].find((name) => name.startsWith('mindmap-tone-')) ?? null)
  const before = await toneOfNode()
  await firstNode.locator('.mindmap-node-index').click()
  await page.waitForTimeout(500)
  const after = await toneOfNode()
  if (before === after) problems.push(`点击徽标没有换色：仍是 ${before}`)

  const stored = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('pdfnote.mindmap.tone') ?? 'null') } catch { return null }
  })
  if (!stored || Object.keys(stored).length === 0) problems.push('手动换色没有写入 localStore')
  if (after) {
    const index = Number(String(after).replace('mindmap-tone-', ''))
    const saved = Object.values(stored ?? {}).map(Number)
    if (!saved.includes(index)) problems.push(`本地偏好和画布颜色不一致：${saved} vs ${index}`)
  }

  // 森林场景整理成网格：26 棵树挤成一行时看不出配色层次。
  const arrange = page.getByRole('button', { name: '整理', exact: true })
  if (await arrange.count()) {
    await arrange.first().click()
    await page.waitForTimeout(1200)
  }
  await page.locator('.mindmap-workspace').first().screenshot({ path: '/tmp/tone-cards.png' })

  // 低缩放（lite）下颜色是唯一的辨认依据：节点必须保留各自的色调，不能退回一片灰。
  const pane = await page.locator('.react-flow__pane').first().boundingBox()
  let lite = null
  if (pane) {
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2)
    await page.keyboard.down('Meta')
    for (let index = 0; index < 10; index += 1) {
      await page.mouse.wheel(0, 300)
      await page.waitForTimeout(120)
    }
    await page.keyboard.up('Meta')
    await page.waitForTimeout(700)
    lite = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.mindmap-node.is-lite')]
      return {
        count: nodes.length,
        withTone: nodes.filter((node) => [...node.classList].some((name) => name.startsWith('mindmap-tone-'))).length,
        distinctBars: new Set(nodes.map((node) => getComputedStyle(node).getPropertyValue('--tone-bar').trim())).size,
        backgrounds: new Set(nodes.map((node) => getComputedStyle(node).backgroundColor)).size,
      }
    })
    if (lite.count === 0) problems.push('低缩放没有进入 lite 模式')
    if (lite.withTone !== lite.count) problems.push(`lite 节点丢失色调：${lite.withTone}/${lite.count}`)
    if (lite.distinctBars < 3) problems.push(`lite 只剩 ${lite.distinctBars} 种颜色`)
    await page.locator('.mindmap-workspace').first().screenshot({ path: '/tmp/tone-lite.png' })
  }

  // 微缩导航图（独立视图才有 MiniMap）：色块必须跟随节气色调，不能一片同色。
  await page.locator('.app-segment', { hasText: '资料库' }).click()
  await page.waitForTimeout(400)
  await page.locator('.app-segment', { hasText: '脑图' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForSelector('.react-flow__minimap-node', { timeout: 10000 }).catch(() => null)
  await page.waitForTimeout(800)
  const minimap = await page.evaluate(() => {
    // MiniMap 的 rect 用 style.fill 上色，computed style 归一成 rgb()，与 --tone-bar 的 hex 对齐。
    const toRgb = (hex) => {
      const value = hex.trim().replace('#', '')
      if (value.length !== 6) return ''
      const number = parseInt(value, 16)
      return `rgb(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255})`
    }
    const bars = new Set(
      [...document.querySelectorAll('.mindmap-node')]
        .map((node) => toRgb(getComputedStyle(node).getPropertyValue('--tone-bar')))
        .filter(Boolean),
    )
    const rects = [...document.querySelectorAll('.react-flow__minimap-node')]
    const fills = rects.map((rect) => getComputedStyle(rect).fill)
    return {
      rectCount: rects.length,
      distinctFills: new Set(fills).size,
      offTone: fills.filter((fill) => !bars.has(fill)).length,
    }
  })
  if (minimap.rectCount === 0) problems.push('独立视图未渲染微缩导航图')
  if (minimap.distinctFills < 3) problems.push(`微缩图颜色单调：${minimap.distinctFills} 种`)
  if (minimap.offTone > 0) problems.push(`微缩图有 ${minimap.offTone} 个色块不跟随节点色调`)

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'tone', ...info, before, after, stored, lite, minimap }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=board：卡片盒按标签分栏、过滤、拖拽改标签。配合 BOARD=1 CARD_COUNT=8 跑。
if (process.env.STEP === 'board') {
  await page.locator('.app-segment', { hasText: '卡片盒' }).click()
  await page.waitForSelector('.board-columns', { timeout: 10000 })
  await page.waitForTimeout(300)

  const readBoard = () => page.evaluate(() => {
    const columns = [...document.querySelectorAll('.board-column')]
    return {
      labels: columns.map((column) => column.dataset.columnLabel),
      counts: Object.fromEntries(columns.map((column) => [
        column.dataset.columnId,
        column.querySelectorAll('.board-card').length,
      ])),
      total: document.querySelectorAll('.board-card').length,
    }
  })

  const initial = await readBoard()
  for (const label of ['#心内', '#药理', '未分组']) {
    if (!initial.labels.includes(label)) problems.push(`缺少分栏 ${label}：${initial.labels.join(',')}`)
  }
  if (!initial.labels.includes('#空标签')) problems.push('空标签列没有保留（拖拽需要落点）')
  if (initial.counts.__untagged__ !== 2) problems.push(`未分组应为 2 张：${initial.counts.__untagged__}`)
  // 多标签卡片会同时出现在两列：8 张卡共 10 个落位。
  if (initial.total !== 10) problems.push(`标签列卡片总数应为 10：${initial.total}`)

  // 标签过滤
  await page.locator('[data-testid="board-tag"]').selectOption('药理')
  await page.waitForTimeout(250)
  const byTag = await readBoard()
  if (byTag.counts['心内'] !== 2) problems.push(`按药理过滤后心内应为 2 张：${byTag.counts['心内']}`)
  if (byTag.counts.__untagged__ !== 0) problems.push(`按药理过滤后未分组应为 0：${byTag.counts.__untagged__}`)

  // 关键词过滤（先清标签筛选）
  await page.locator('[data-testid="board-tag"]').selectOption('')
  await page.locator('[data-testid="board-search"]').fill('概念卡片 2')
  await page.waitForTimeout(250)
  // 多标签卡片会同时出现在两列，命中数要按卡号去重，不能数 DOM 节点。
  const searchHits = await page.evaluate(() => new Set(
    [...document.querySelectorAll('.board-card')].map((element) => element.dataset.cardId),
  ).size)
  if (searchHits !== 1) problems.push(`搜索命中卡片数异常：${searchHits}`)
  await page.locator('[data-testid="board-search"]').fill('')
  await page.waitForTimeout(250)

  // 书目分组：只有 c1 有原文位置
  await page.locator('[data-testid="board-group-document"]').click()
  await page.waitForTimeout(250)
  const byDocument = await readBoard()
  if (!byDocument.labels.includes('测试教材')) problems.push(`书目分组缺少文档列：${byDocument.labels.join(',')}`)
  if (!byDocument.labels.includes('未关联文档')) problems.push('书目分组缺少未关联列')

  // 状态分组：固定三档
  await page.locator('[data-testid="board-group-state"]').click()
  await page.waitForTimeout(250)
  const byState = await readBoard()
  if (byState.labels.join(',') !== '新卡,学习中,复习中') problems.push(`状态分栏异常：${byState.labels.join(',')}`)
  if (byState.counts.new !== 2 || byState.counts.learning !== 3 || byState.counts.review !== 3) {
    problems.push(`状态分组数量异常：${JSON.stringify(byState.counts)}`)
  }

  // 拖拽：把只有「心内」的 c1 拖到空标签列
  await page.locator('[data-testid="board-group-tag"]').click()
  await page.waitForTimeout(300)
  await page.locator('.board-card[data-card-id="c1"]').first()
    .dragTo(page.locator('.board-column[data-column-id="空标签"]'))
  await page.waitForTimeout(700)
  const draggedTags = await page.evaluate(() => window.__cardState.find((item) => item.id === 'c1')?.tags ?? [])
  if (JSON.stringify(draggedTags) !== JSON.stringify(['空标签'])) {
    problems.push(`拖拽后标签应为 [空标签]：${JSON.stringify(draggedTags)}`)
  }
  const afterDrag = await readBoard()
  if (afterDrag.counts['空标签'] !== 1) problems.push(`空标签列应有 1 张：${afterDrag.counts['空标签']}`)
  if (afterDrag.counts['心内'] !== 3) problems.push(`心内列应剩 3 张：${afterDrag.counts['心内']}`)

  if (process.env.SHOT) {
    await page.screenshot({ path: '/tmp/pdfnote-board.png' })
  }

  // 点卡片回原文：c1 有 source_ref，应打开文档工作台
  await page.locator('.board-card[data-card-id="c1"]').first().click()
  await page.waitForSelector('.study-workspace', { timeout: 30000 })
    .catch(() => problems.push('点卡片没有回到原文工作台'))

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'board', initial, byTag, byDocument, byState, afterDrag, draggedTags }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=recall：文档回忆要把手写与留白一起藏起来，退出后恢复。配合 RECALL_SEED=1 跑。
if (process.env.STEP === 'recall') {
  await page.locator('.document-card').first().click()
  await page.waitForSelector('.pdf-annotation-layer', { timeout: 30000 })
  await page.waitForTimeout(1500)

  const readRecall = () => page.evaluate(() => ({
    inks: document.querySelectorAll('.pdf-ink').length,
    notes: document.querySelectorAll('.pdf-note').length,
    masks: document.querySelectorAll('.pdf-recall-mask').length,
  }))

  const before = await readRecall()
  if (before.inks < 1) problems.push(`预置手写没有渲染：${before.inks}`)
  if (before.notes < 1) problems.push(`预置留白没有渲染：${before.notes}`)

  await page.locator('button[title="文档遮挡回忆"]').first().click()
  await page.waitForTimeout(700)
  const during = await readRecall()
  if (during.inks !== 0) problems.push(`回忆态仍显示手写：${during.inks}`)
  if (during.notes !== 0) problems.push(`回忆态仍显示留白：${during.notes}`)
  if (during.masks < 1) problems.push(`回忆态没有遮挡块：${during.masks}`)

  await page.locator('button[title="文档遮挡回忆"]').first().click()
  await page.waitForTimeout(500)
  const after = await readRecall()
  if (after.inks !== before.inks) problems.push(`退出回忆后手写没有恢复：${after.inks}/${before.inks}`)
  if (after.notes !== before.notes) problems.push(`退出回忆后留白没有恢复：${after.notes}/${before.notes}`)

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'recall', before, during, after }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=cloze：文档回忆的挖空填空。配合 CLOZE_SEED=1 跑：
// c1（ann-1）是公式摘录 → 退化成整句回忆；c4（ann-3）有完整句子 → 生成 2 个空。
if (process.env.STEP === 'cloze') {
  await page.locator('.document-card').first().click()
  await page.waitForSelector('.pdf-annotation-layer', { timeout: 30000 })
  await page.waitForTimeout(1200)

  const toggleRecall = async () => {
    await page.locator('button[title="文档遮挡回忆"]').first().click()
    await page.waitForTimeout(600)
  }

  await toggleRecall()
  const masksBefore = await page.locator('.pdf-recall-mask').count()
  if (masksBefore < 3) problems.push(`遮挡块不足：${masksBefore}`)
  const toggleActive = await page.locator('[data-cloze-toggle]').first().evaluate((el) => el.classList.contains('is-active'))
  if (!toggleActive) problems.push('回忆态没有默认开启挖空')

  // 公式摘录：不硬挖空，给出「揭示这段摘录」，且未完成前不能显示整段原文。
  await page.locator('[data-mask-index="0"]').click()
  await page.waitForTimeout(300)
  const formula = await page.evaluate(() => ({
    fallback: document.querySelectorAll('.pdf-cloze-fallback').length,
    inputs: document.querySelectorAll('.pdf-cloze-input').length,
    reveal: document.querySelectorAll('.pdf-cloze-fallback button').length,
    text: document.querySelector('.pdf-cloze-fallback')?.textContent ?? '',
  }))
  if (formula.fallback !== 1) problems.push(`公式摘录没有退化成整句回忆：${formula.fallback}`)
  if (formula.inputs !== 0) problems.push(`公式摘录不应生成输入框：${formula.inputs}`)
  if (formula.reveal !== 1) problems.push('公式摘录没有提供揭示入口')
  if (!formula.text.includes('公式')) problems.push(`公式退化的说明不对：${formula.text}`)

  // 句子摘录：点开是输入框（c4 那句能挖出 2 个空）。
  await page.locator('[data-mask-index="2"]').click()
  await page.waitForTimeout(300)
  const blankCount = await page.locator('.pdf-cloze-input').count()
  if (blankCount !== 2) problems.push(`c4 那句应挖出 2 个空：${blankCount}`)
  // 记录本轮挖的词（aria-label 里带首字与字数），用来验证「再进一次会换空」。
  const readBlankHints = () => page.evaluate(() => [...document.querySelectorAll('.pdf-cloze-input')]
    .map((element) => element.getAttribute('aria-label') ?? ''))
  const firstHints = await readBlankHints()

  // 先故意答错：标红 + 给出正确答案，且不揭示遮罩、不出现评分。
  await page.locator('.pdf-cloze-input').first().fill('完全不对的答案')
  await page.locator('.pdf-cloze-actions button.is-primary').click()
  await page.waitForTimeout(300)
  const wrong = await page.evaluate(() => ({
    feedback: document.querySelector('[data-cloze-feedback]')?.textContent ?? '',
    wrongInputs: document.querySelectorAll('.pdf-cloze-input.is-wrong').length,
    masks: document.querySelectorAll('.pdf-recall-mask').length,
    rating: document.querySelectorAll('.pdf-rating-buttons button').length,
  }))
  if (!wrong.feedback.includes('应为')) problems.push(`答错没有给出正确答案：${wrong.feedback}`)
  if (wrong.wrongInputs < 1) problems.push('答错没有标红')
  if (wrong.masks !== masksBefore) problems.push(`答错不该揭示遮罩：${wrong.masks}/${masksBefore}`)
  if (wrong.rating !== 0) problems.push('未揭示就出现了评分按钮')

  // 清空后检查一次，把所有空的标准答案从反馈里读出来（按空顺序）。
  await page.locator('.pdf-cloze-actions button', { hasText: '重来' }).click()
  await page.waitForTimeout(200)
  await page.locator('.pdf-cloze-actions button.is-primary').click()
  await page.waitForTimeout(300)
  const emptyFeedback = await page.locator('[data-cloze-feedback]').textContent()
  const answers = [...emptyFeedback.matchAll(/(?:应为|答案是)「(.+?)」/g)].map((match) => match[1])
  if (answers.length !== blankCount) problems.push(`正确答案数量不匹配：${answers.length}/${blankCount}`)

  for (let index = 0; index < answers.length; index += 1) {
    await page.locator('.pdf-cloze-input').nth(index).fill(answers[index])
  }
  await page.locator('.pdf-cloze-actions button.is-primary').click()
  await page.waitForTimeout(500)
  // 文档工作区是左 PDF 右脑图（embedded），揭示后评分条浮在 PDF 右上角，而不是右侧检查器。
  const solved = await page.evaluate(() => ({
    masks: document.querySelectorAll('.pdf-recall-mask').length,
    rating: document.querySelectorAll('.pdf-recall-float button').length,
    cloze: document.querySelectorAll('[data-cloze-panel]').length,
    notice: document.querySelector('.pdf-operation-bar')?.textContent ?? '',
  }))
  if (solved.masks !== masksBefore - 1) problems.push(`全部答对后遮罩没有消失：${solved.masks}/${masksBefore}`)
  if (solved.rating !== 4) problems.push(`答对后没有出现评分：${solved.rating}`)
  if (solved.cloze !== 0) problems.push('答对后填空面板没有收起')
  if (!solved.notice.includes('全部补齐')) problems.push(`缺少完成提示：${solved.notice}`)

  // 关掉挖空：遮挡块回到「点击揭示」的整块回忆。
  await toggleRecall()
  await toggleRecall()
  // 第二次进入回忆应该换一批空（同一个 turn 内稳定，换了会话才轮换）。
  await page.locator('[data-mask-index="2"]').click()
  await page.waitForTimeout(300)
  const secondHints = await readBlankHints()
  if (secondHints.length !== firstHints.length) {
    problems.push(`换空后空数变了：${secondHints.length}/${firstHints.length}`)
  } else if (secondHints.join('|') === firstHints.join('|')) {
    problems.push(`再次进入回忆没有换空：${secondHints.join(' / ')}`)
  }
  await page.locator('[data-cloze-toggle]').first().click()
  await page.waitForTimeout(300)
  const offActive = await page.locator('[data-cloze-toggle]').first().evaluate((el) => el.classList.contains('is-active'))
  if (offActive) problems.push('关闭挖空后开关仍是激活态')
  await page.locator('[data-mask-index="2"]').click()
  await page.waitForTimeout(300)
  const plainReveal = await page.evaluate(() => ({
    masks: document.querySelectorAll('.pdf-recall-mask').length,
    panels: document.querySelectorAll('[data-cloze-panel]').length,
    rating: document.querySelectorAll('.pdf-recall-float button').length,
  }))
  if (plainReveal.masks !== masksBefore - 1) problems.push(`关闭挖空后点击没有直接揭示：${plainReveal.masks}`)
  if (plainReveal.panels !== 0) problems.push('关闭挖空后仍渲染填空面板')
  if (plainReveal.rating !== 4) problems.push('关闭挖空后揭示没有出现评分')

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'cloze', masksBefore, blankCount, answers, firstHints, secondHints, wrong, solved, plainReveal }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=two-pass：粗读精读的阶段切换、粗读的工具门禁、自由召回与持久化。
if (process.env.STEP === 'two-pass') {
  const openDoc = async () => {
    await page.locator('.document-card').first().click()
    await page.waitForSelector('.pdf-annotation-layer', { timeout: 30000 })
    await page.waitForTimeout(1200)
  }
  const dockDisabled = (label) => page.evaluate((text) => {
    const button = [...document.querySelectorAll('.pdf-dock button')].find((item) => item.textContent?.includes(text))
    return button ? button.disabled : null
  }, label)

  await openDoc()
  const initial = {
    pass: await page.getAttribute('[data-pass-bar]', 'data-pass'),
    bar: await page.locator('[data-pass-bar]').innerText(),
    finish: await page.locator('[data-testid="pdf-pass-finish"]').count(),
    rectangle: await dockDisabled('框架'),
    ink: await dockDisabled('墨迹'),
    text: await dockDisabled('文字'),
  }
  if (initial.pass !== '1') problems.push(`默认不是粗读：${initial.pass}`)
  if (!initial.bar.includes('粗读')) problems.push(`阶段条没有写「粗读」：${initial.bar}`)
  if (initial.finish !== 1) problems.push('粗读缺少「粗读完成」入口')
  if (!initial.rectangle || !initial.ink || !initial.text) {
    problems.push(`粗读没有收起细节工具：${JSON.stringify(initial)}`)
  }

  // 读完第一遍 → 写「我记得的」→ 自动进入第二遍
  await page.locator('[data-testid="pdf-pass-finish"]').click()
  await page.waitForSelector('[data-testid="pdf-recall-modal"]', { timeout: 5000 })
  await page.locator('[data-testid="pdf-recall-input"]').fill('第一章：三个机制、两个前提')
  await page.locator('[data-testid="pdf-recall-save"]').click()
  await page.waitForTimeout(800)
  const afterFinish = {
    pass: await page.getAttribute('[data-pass-bar]', 'data-pass'),
    bar: await page.locator('[data-pass-bar]').innerText(),
    note: await page.evaluate(() => window.__readingState?.().recallNote ?? ''),
    rectangle: await dockDisabled('框架'),
    modal: await page.locator('[data-testid="pdf-recall-modal"]').count(),
  }
  if (afterFinish.pass !== '2') problems.push(`保存召回后没有进入精读：${afterFinish.pass}`)
  if (!afterFinish.bar.includes('精读')) problems.push(`阶段条没有写「精读」：${afterFinish.bar}`)
  if (!afterFinish.bar.includes('看召回笔记')) problems.push(`第二遍没有召回入口：${afterFinish.bar}`)
  if (afterFinish.note !== '第一章：三个机制、两个前提') problems.push(`召回没有写到后端：${afterFinish.note}`)
  if (afterFinish.rectangle !== false) problems.push('精读工具没有解锁')
  if (afterFinish.modal !== 0) problems.push('保存后弹窗没有关闭')

  // 回看召回
  await page.locator('[data-testid="pdf-pass-note"]').click()
  await page.waitForTimeout(300)
  const recalled = await page.locator('[data-testid="pdf-recall-input"]').inputValue()
  if (recalled !== '第一章：三个机制、两个前提') problems.push(`召回回看不一致：${recalled}`)
  await page.locator('.pdf-modal-actions button', { hasText: '稍后' }).click()
  await page.waitForTimeout(250)

  // 切回第一遍：工具重新收起
  await page.locator('[data-testid="pdf-pass-chip"]').click()
  await page.waitForTimeout(700)
  const backToFirst = {
    pass: await page.getAttribute('[data-pass-bar]', 'data-pass'),
    rectangle: await dockDisabled('框架'),
  }
  if (backToFirst.pass !== '1') problems.push(`切不回粗读：${backToFirst.pass}`)
  if (backToFirst.rectangle !== true) problems.push('回到粗读后细节工具没有收起')

  // 再切回第二遍，刷新页面后阶段与召回仍在（读的是后端状态而不是内存）
  await page.locator('[data-testid="pdf-pass-chip"]').click()
  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-shell')
  await openDoc()
  const persisted = {
    pass: await page.getAttribute('[data-pass-bar]', 'data-pass'),
    bar: await page.locator('[data-pass-bar]').innerText(),
  }
  if (persisted.pass !== '2') problems.push(`刷新后阶段丢失：${persisted.pass}`)
  if (!persisted.bar.includes('看召回笔记')) problems.push('刷新后召回入口丢失')

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'two-pass', initial, afterFinish, backToFirst, persisted }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=notebook：手写本创建、无限页、多图层、隐藏、橡皮、纸样切换、删除。
if (process.env.STEP === 'notebook') {
  await page.locator('.app-segment', { hasText: '笔记本' }).click()
  await page.waitForSelector('.notebook-shelf', { timeout: 10000 })

  await page.locator('.notebook-primary').click()
  await page.locator('[data-testid="notebook-title"]').fill('回归演草本')
  await page.locator('[data-testid="notebook-create"]').click()
  await page.waitForSelector('.notebook-editor', { timeout: 10000 })
  await page.waitForSelector('.notebook-page', { timeout: 10000 })
  await page.waitForTimeout(500)

  const drawStroke = async (offsetY) => {
    const box = await page.locator('.notebook-page').first().boundingBox()
    if (!box) return false
    const startX = box.x + box.width * 0.3
    const startY = box.y + box.height * offsetY
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(startX + step * 14, startY + step * 4, { steps: 1 })
    }
    await page.mouse.up()
    await page.waitForTimeout(400)
    return true
  }

  const pageCount = await page.locator('.notebook-page').count()
  if (pageCount !== 4) problems.push(`初始页数应为 4：${pageCount}`)

  if (!(await drawStroke(0.25))) problems.push('没有找到第一页')
  const afterFirst = await page.evaluate(() => window.__notebookInkState.length)
  if (afterFirst !== 1) problems.push(`第一笔没有落库：${afterFirst}`)
  if ((await page.locator('.notebook-page').first().locator('path').count()) < 1) problems.push('第一笔没有渲染')

  // 新图层 → 第二笔画进新层
  await page.locator('.notebook-layers header button').click()
  await page.waitForTimeout(350)
  if ((await page.locator('.notebook-layer').count()) !== 2) problems.push('没有新增图层')
  const secondLayerId = await page.locator('.notebook-layer').nth(1).getAttribute('data-layer-id')
  if (!(await drawStroke(0.42))) problems.push('第二笔没有画布')
  const afterSecond = await page.evaluate(() => window.__notebookInkState.map((ink) => ink.layer_id))
  if (afterSecond[1] !== secondLayerId) problems.push(`第二笔没有写进新图层：${afterSecond[1]} vs ${secondLayerId}`)

  // 隐藏第二层：只剩一条可见笔迹
  await page.locator('.notebook-layer').nth(1).locator('button[title="隐藏图层"]').click()
  await page.waitForTimeout(400)
  if ((await page.locator('.notebook-page').first().locator('path').count()) !== 1) {
    problems.push('隐藏图层后笔迹没有减少')
  }
  await page.locator('.notebook-layer').nth(1).locator('button[title="显示图层"]').click()
  await page.waitForTimeout(400)

  // 橡皮擦掉第一笔（第一层）
  await page.locator('.notebook-tool-group button[title="橡皮"]').click()
  // 与 PDF 墨迹一致：浮动半径滑杆，拖到最大（特大 56px）
  await page.locator('[data-testid="ink-size-trigger-eraser"]').click()
  await page.waitForSelector('[data-testid="ink-size-popover-eraser"]', { timeout: 5000 })
  const notebookSlider = page.locator('[data-testid="ink-size-slider-eraser"]')
  const notebookBounds = await notebookSlider.evaluate((input) => ({ min: Number(input.min), max: Number(input.max) }))
  if (!(notebookBounds.min === 8 && notebookBounds.max === 56)) {
    problems.push(`笔记本橡皮滑杆范围与墨迹不一致：${JSON.stringify(notebookBounds)}`)
  }
  await notebookSlider.focus()
  await page.keyboard.press('End')
  await page.waitForTimeout(200)
  {
    const box = await page.locator('.notebook-page').first().boundingBox()
    if (box) {
      const x = box.x + box.width * 0.34
      await page.mouse.move(x, box.y + box.height * 0.22)
      await page.mouse.down()
      for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(x + step * 3, box.y + box.height * 0.22 + step * 8, { steps: 1 })
      }
      await page.mouse.up()
      await page.waitForTimeout(600)
    }
  }
  const afterErase = await page.evaluate(() => window.__notebookInkState.length)
  if (afterErase !== 1) problems.push(`橡皮后应剩 1 笔：${afterErase}`)

  // 纸样切换
  await page.locator('.notebook-paper select').selectOption('grid')
  await page.waitForTimeout(400)
  if (!(await page.locator('.notebook-page.is-grid').count())) problems.push('切换纸样后页面没有变网格')
  const paperSaved = await page.evaluate(() => window.__notebookState[0]?.paper)
  if (paperSaved !== 'grid') problems.push(`纸样没有写回：${paperSaved}`)

  // 无限纸张：滚到底部自动加页
  const beforeScroll = await page.locator('.notebook-page').count()
  await page.evaluate(() => {
    const scroller = document.querySelector('.notebook-scroll')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForTimeout(800)
  const afterScroll = await page.locator('.notebook-page').count()
  if (afterScroll <= beforeScroll) problems.push(`滚到底部没有加纸：${beforeScroll} → ${afterScroll}`)

  if (process.env.SHOT) {
    await page.evaluate(() => {
      const scroller = document.querySelector('.notebook-scroll')
      if (scroller) scroller.scrollTop = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: '/tmp/pdfnote-notebook.png' })
  }

  // 返回书架并删除
  await page.locator('.notebook-back').click()
  await page.waitForSelector('.notebook-shelf', { timeout: 5000 })
  if (!(await page.locator('.notebook-card').count())) problems.push('返回后没有笔记本卡片')
  await page.locator('.notebook-card .notebook-actions button', { hasText: '删除' }).first().click()
  await page.locator('[data-testid="notebook-delete-confirm"]').click()
  await page.waitForTimeout(400)
  if (await page.locator('.notebook-card').count()) problems.push('删除后仍显示笔记本卡片')

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'notebook', pageCount, afterFirst, afterSecond, afterErase, paperSaved, beforeScroll, afterScroll }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=outline-edit：大纲行内改标题、回车建同级、Tab/Shift+Tab 缩进、拖拽成子级。
if (process.env.STEP === 'outline-edit') {
  await page.locator('.document-card').first().click()
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /大纲/ }).first().click()
  await page.waitForSelector('.mindmap-outline-list', { timeout: 10000 })
  await page.waitForTimeout(300)

  const readCards = () => page.evaluate(() => window.__cardState.map((card) => ({
    id: card.id,
    parent_id: card.parent_id,
    sort_order: card.sort_order,
    question: card.question,
  })))

  // 1) 行内改标题 → 回车建同级
  await page.locator('.mindmap-outline-title').first().click()
  await page.locator('[data-testid="outline-input"]').waitFor()
  await page.locator('[data-testid="outline-input"]').fill('改过的一级标题')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)

  const afterEnter = await readCards()
  const renamed = afterEnter.find((card) => card.id === 'c1')
  if (renamed?.question !== '改过的一级标题') problems.push(`行内标题没有写回问题字段：${renamed?.question}`)
  const created = afterEnter.find((card) => card.id.startsWith('new-card-'))
  if (!created) problems.push('回车没有新建卡片')
  const orderAfterEnter = await page.evaluate(() => window.__lastOrder ?? [])
  if (!orderAfterEnter.some((item) => item.id === created?.id && item.parent_id === null && item.sort_order === 1)) {
    problems.push(`回车后新卡没有排到同级第二位：${JSON.stringify(orderAfterEnter)}`)
  }
  if (!(await page.locator('[data-testid="outline-input"]').count())) problems.push('新建后没有进入编辑态')

  // 2) Tab 缩进为上一项（c1）的子级
  await page.locator('[data-testid="outline-input"]').fill('子项标题')
  const draftBeforeTab = await page.locator('[data-testid="outline-input"]').inputValue()
  if (draftBeforeTab !== '子项标题') problems.push(`Tab 前输入框内容异常：${draftBeforeTab}`)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(900)
  const afterIndent = await readCards()
  const indented = afterIndent.find((card) => card.id === created?.id)
  if (indented?.parent_id !== 'c1') problems.push(`Tab 后父级应为 c1：${indented?.parent_id}`)
  if (indented?.question !== '子项标题') problems.push(`Tab 前没有保存标题：${indented?.question}`)
  const depthOfCreated = await page
    .locator(`.mindmap-outline-row[data-card-id="${created?.id}"]`)
    .getAttribute('data-depth')
  if (depthOfCreated !== '1') problems.push(`Tab 后大纲深度应为 1：${depthOfCreated}`)
  if (process.env.SHOT) {
    await page.locator('.mindmap-outline').screenshot({ path: '/tmp/pdfnote-outline-edit.png' })
  }

  // 3) Shift+Tab 提升回顶层，排在原父节点后面
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(900)
  const afterOutdent = await readCards()
  const outdented = afterOutdent.find((card) => card.id === created?.id)
  if (outdented?.parent_id !== null) problems.push(`Shift+Tab 后父级应为空：${outdented?.parent_id}`)
  if (outdented?.sort_order !== 1) problems.push(`提升后应排第 2：${outdented?.sort_order}`)

  // 4) 拖到另一行中间：成为它的子级
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator('.mindmap-outline-row[data-card-id="c3"]')
    .dragTo(page.locator('.mindmap-outline-row[data-card-id="c2"]'))
  await page.waitForTimeout(900)
  const afterDrag = await readCards()
  const dragged = afterDrag.find((card) => card.id === 'c3')
  if (dragged?.parent_id !== 'c2') problems.push(`拖拽后 c3 的父级应为 c2：${dragged?.parent_id}`)

  // 5) 同级 sort_order 不能重复
  const orderMap = afterDrag.reduce((acc, item) => {
    const key = item.parent_id ?? 'root'
    acc[key] = [...(acc[key] ?? []), item.sort_order]
    return acc
  }, {})
  const duplicated = Object.entries(orderMap)
    .filter(([, orders]) => new Set(orders).size !== orders.length)
  if (duplicated.length) problems.push(`同级出现重复 sort_order：${JSON.stringify(duplicated)}`)

  await browser.close()
  console.log(JSON.stringify({ problems, step: 'outline-edit', draftBeforeTab, afterEnter, afterIndent, afterOutdent, afterDrag }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

// STEP=canvas-ink：画布涂鸦（世界坐标）+ 脑图分层（墨迹与卡片一起显隐）。
if (process.env.STEP === 'canvas-ink') {
  await page.locator('.app-segment', { hasText: '脑图' }).click()
  await page.waitForSelector('.mindmap-flow-host', { timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('.mindmap-node').length > 0, null, { timeout: 120000 })
  await page.waitForTimeout(900)

  const pane = await page.locator('.react-flow__pane').boundingBox()
  if (!pane) {
    problems.push('找不到画布 pane')
    await browser.close()
    console.log(JSON.stringify({ problems, step: 'canvas-ink' }, null, 2))
    process.exit(1)
  }

  const drawStroke = async (offsetY) => {
    const startX = pane.x + pane.width * 0.28
    const startY = pane.y + pane.height * offsetY
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(startX + step * 14, startY + step * 3, { steps: 1 })
    }
    await page.mouse.up()
    await page.waitForTimeout(400)
  }

  const inkCount = () => page.evaluate(() => window.__canvasInkState.length)
  const pathCount = () => page.locator('[data-testid="mindmap-ink-svg"] path').count()

  // 1) 进入涂鸦、画第一笔
  await page.locator('[data-testid="mindmap-ink-toggle"]').click()
  await page.waitForSelector('[data-testid="mindmap-ink-overlay"]', { timeout: 5000 })
  await drawStroke(0.25)
  if ((await inkCount()) !== 1) problems.push(`第一笔没有落库：${await inkCount()}`)
  if ((await pathCount()) !== 1) problems.push(`第一笔没有渲染：${await pathCount()}`)

  // 2) 退出涂鸦后平移：世界坐标笔迹必须跟着视口一起移动
  await page.locator('[data-testid="mindmap-ink-toggle"]').click()
  const pathBefore = await page.locator('[data-testid="mindmap-ink-svg"] path').first().boundingBox()
  await page.mouse.move(pane.x + pane.width * 0.6, pane.y + pane.height * 0.5)
  await page.mouse.wheel(0, 160)
  await page.waitForTimeout(500)
  const pathAfter = await page.locator('[data-testid="mindmap-ink-svg"] path').first().boundingBox()
  if (!pathBefore || !pathAfter || Math.abs(pathAfter.y - pathBefore.y) < 40) {
    problems.push(`平移后墨迹没有跟随世界坐标：${JSON.stringify({ pathBefore, pathAfter })}`)
  }

  // 3) 新图层 → 第二笔画进新层
  await page.locator('[data-testid="mindmap-ink-toggle"]').click()
  await page.locator('[data-testid="mindmap-layer-toggle"]').click()
  await page.waitForSelector('[data-testid="mindmap-layer-panel"]', { timeout: 5000 })
  await page.locator('[data-testid="mindmap-layer-add"]').click()
  await page.waitForTimeout(350)
  const rows = await page.locator('.mindmap-layer-row').count()
  if (rows !== 2) problems.push(`新建图层后应有 2 层：${rows}`)
  const secondLayerId = await page.locator('.mindmap-layer-row').nth(1).getAttribute('data-layer-id')
  await drawStroke(0.65)
  const secondInk = await page.evaluate(() => window.__canvasInkState[1]?.layer_id)
  if (secondInk !== secondLayerId) problems.push(`第二笔没有写进新层：${secondInk} vs ${secondLayerId}`)

  // 4) 隐藏第二层：只剩第一笔
  await page.locator(`.mindmap-layer-row[data-layer-id="${secondLayerId}"] button[title="隐藏图层"]`).click()
  await page.waitForTimeout(400)
  if ((await pathCount()) !== 1) problems.push(`隐藏图层后笔迹没有减少：${await pathCount()}`)

  // 5) 把选中卡片归入隐藏层 → 该卡片也应消失
  await page.locator('[data-testid="mindmap-ink-toggle"]').click()
  await page.locator('.react-flow__node').first().click()
  await page.waitForTimeout(350)
  await page.locator('[data-testid="mindmap-layer-assign"]').click()
  await page.waitForTimeout(400)
  const assigned = await page.evaluate(() => window.__layerMemberState.length)
  if (assigned < 1) problems.push(`卡片没有归入图层：${assigned}`)
  const hiddenNode = await page.locator('.react-flow__node[data-id="c1"]').count()
  if (hiddenNode !== 0) problems.push('隐藏图层后归入该层的卡片仍然显示')

  // 恢复显示：墨迹与卡片一起回来
  await page.locator(`.mindmap-layer-row[data-layer-id="${secondLayerId}"] button[title="显示图层"]`).click()
  await page.waitForTimeout(450)
  if ((await pathCount()) !== 2) problems.push(`恢复图层后应有 2 笔：${await pathCount()}`)
  if ((await page.locator('.react-flow__node[data-id="c1"]').count()) !== 1) problems.push('恢复图层后卡片没有回来')

  // 6) 橡皮（半径滑杆拖到最大）擦掉第一笔
  await page.locator('[data-testid="mindmap-ink-toggle"]').click()
  await page.locator('[data-testid="mindmap-ink-eraser"]').click()
  await page.locator('[data-testid="ink-size-trigger-eraser"]').click()
  const eraserSlider = page.locator('[data-testid="ink-size-slider-eraser"]')
  await eraserSlider.focus()
  await page.keyboard.press('End')
  await page.waitForTimeout(200)
  const firstPath = await page.locator('[data-testid="mindmap-ink-svg"] path').first().boundingBox()
  if (firstPath) {
    const cx = firstPath.x + firstPath.width / 2
    const cy = firstPath.y + firstPath.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let step = 1; step <= 6; step += 1) await page.mouse.move(cx + step * 4, cy + step * 2, { steps: 1 })
    await page.mouse.up()
    await page.waitForTimeout(600)
  }
  if ((await inkCount()) !== 1) problems.push(`橡皮后应剩 1 笔：${await inkCount()}`)

  if (process.env.SHOT) {
    await page.screenshot({ path: '/tmp/pdfnote-canvas-ink.png' })
  }

  const inkLeft = await inkCount()
  await browser.close()
  console.log(JSON.stringify({ problems, step: 'canvas-ink', rows, secondInk, assigned, inkLeft }, null, 2))
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
  // 顶栏格子数量会随工作区增加；按文案定位，别用索引（0.34.0 加「卡片盒」后索引整体错位）。
  const nav = page.locator('.app-segment')
  if (await nav.count() >= 4) {
    await page.locator('.app-segment', { hasText: '资料库' }).click()
    await page.waitForTimeout(700)
    await page.locator('.app-segment', { hasText: '脑图' }).click()
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
  // 顶栏格子数量会随工作区增加；按文案定位，别用索引（0.34.0 加「卡片盒」后索引整体错位）。
  const nav = page.locator('.app-segment')
  if (await nav.count() >= 4) {
    await page.locator('.app-segment', { hasText: '资料库' }).click()
    await page.waitForTimeout(700)
    await page.locator('.app-segment', { hasText: '脑图' }).click()
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
    const initialCanvas = await picker.inputValue()
    if (initialCanvas !== 'book-canvas-b') {
      problems.push(`没有偏好时应打开本书最新的画布 book-canvas-b，实际 ${initialCanvas}`)
    }
    const initialNodes = await page.locator('.mindmap-node').count()
    if (initialNodes !== 1) {
      problems.push(`本书最新画布应只有 1 张卡片，实际 ${initialNodes}`)
    }
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
    const topButtons = page.locator('.app-segment')
    const topCount = await topButtons.count()
    if (topCount >= 4) {
      await page.locator('.app-segment', { hasText: '资料库' }).click()   // 关闭当前文档
      await page.waitForTimeout(800)
      await page.locator('.app-segment', { hasText: '脑图' }).click()     // 进入独立视图
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
