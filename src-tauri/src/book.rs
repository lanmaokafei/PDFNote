use crate::{ai, models::now, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const MODES: [&str; 4] = ["structure", "dictionary", "vocabulary", "questions"];
const MAX_CHUNK_CHARS: usize = 24_000;
const MAX_ITEMS_PER_CHUNK: usize = 24;
/// 读者可设置的拆分层级：默认 2 层，最深 5 层。
pub const DEFAULT_OUTLINE_DEPTH: u32 = 2;
pub const MAX_OUTLINE_DEPTH: u32 = 5;
/// 解析时的硬安全网，比读者上限多一层，防止模型输出失控。
const HARD_MAX_OUTLINE_DEPTH: u32 = 6;
const BASE_OUTLINE_NODES: usize = 80;

/// 缺省 2 层；越界直接报错，避免把无效值悄悄喂给模型。
fn normalize_depth(depth: Option<u32>) -> Result<u32, String> {
    let depth = depth.unwrap_or(DEFAULT_OUTLINE_DEPTH);
    if (1..=MAX_OUTLINE_DEPTH).contains(&depth) {
        Ok(depth)
    } else {
        Err(format!("拆分层级需在 1–{MAX_OUTLINE_DEPTH} 之间，当前为 {depth}"))
    }
}

/// 深层骨架自然需要更多节点：2 层 80 个，5 层 170 个。
fn max_outline_nodes(depth: u32) -> usize {
    BASE_OUTLINE_NODES + depth.saturating_sub(2) as usize * 30
}

fn default_outline_depth() -> u32 {
    DEFAULT_OUTLINE_DEPTH
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestPage {
    pub page: u32,
    pub text: String,
    /// 该页文字区域（归一化），用于让节点链回原文。
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestChunkInput {
    pub document_id: String,
    pub mode: String,
    pub chunk_index: u32,
    pub pages: Vec<DigestPage>,
    /// 读者选择的拆分层级：深层拆解需要阶段一就抽出名词与定义，缺省按 2 层。
    #[serde(default)]
    pub depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestItem {
    pub kind: String,
    pub title: String,
    pub excerpt: String,
    pub page: Option<u32>,
    /// 关键词别名（分号分隔），词典/生词模式用来喂标题链接。
    pub aliases: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkNote {
    pub chunk_index: u32,
    pub page_start: u32,
    pub page_end: u32,
    pub summary: String,
    pub items: Vec<DigestItem>,
    pub pages: Vec<DigestPage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineNode {
    pub title: String,
    pub excerpt: String,
    pub page: Option<u32>,
    pub aliases: String,
    pub children: Vec<OutlineNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookOutline {
    pub title: String,
    pub mode: String,
    /// 生成这份骨架时读者选择的层级深度；旧备份没有该字段时按 2 层处理。
    #[serde(default = "default_outline_depth")]
    pub depth: u32,
    pub nodes: Vec<OutlineNode>,
}

fn validate_mode(mode: &str) -> Result<(), String> {
    if MODES.contains(&mode) {
        Ok(())
    } else {
        Err(format!("不支持的拆书模式: {mode}"))
    }
}

/// 阶段一也随读者深度调整：深层拆解需要更多、更细的名词与定义作为素材。
fn system_prompt(mode: &str, depth: u32) -> String {
    let (base, base_limit): (&str, usize) = match mode {
        "dictionary" => (r#"你是学术文本的术语抽取器。

阅读给定页面文本，抽取其中的核心概念、术语、方法名、指标名。
只输出 JSON，不要解释、不要代码围栏：
{"summary":"这一块讲了什么，60 字以内","items":[{"kind":"术语","title":"概念名（不超过 20 字）","excerpt":"原文中的定义或关键句（不超过 200 字）","page":页码,"aliases":"别名1;别名2"}]}

规则：
- 每个条目必须能在原文找到依据，excerpt 尽量照抄原文。
- aliases 写同义说法、英文缩写、英文全称，用分号分隔；没有就留空字符串。
- page 必须是给定文本里出现过的页码。
- 最多 12 条，按重要性排序。"#, 12),
        "vocabulary" => (r#"你是英语学习助手。

从给定页面文本中抽取值得学习的英文单词或短语（学术词汇优先），按难度给出等级。
只输出 JSON，不要解释、不要代码围栏：
{"summary":"这一块的英文内容概要，60 字以内","items":[{"kind":"B2","title":"单词或短语","excerpt":"原文中出现该词的句子","page":页码,"aliases":"中文释义;词性"}]}

规则：
- kind 用 CEFR 等级：A2 / B1 / B2 / C1 / C2。
- 跳过专有名词、人名、纯数字、过于基础的词（the、and 等）。
- excerpt 必须来自原文，保留原句。
- 最多 15 条，优先 C1/B2 的学术词。"#, 15),
        "questions" => (r#"你是出题老师，把教材内容转成问题驱动的学习骨架。

为给定页面文本生成可以自我检测的问题，答案取自原文。
只输出 JSON，不要解释、不要代码围栏：
{"summary":"这一块讲了什么，60 字以内","items":[{"kind":"问题","title":"一个具体的问题（不超过 40 字）","excerpt":"原文中的答案（不超过 250 字）","page":页码,"aliases":""}]}

规则：
- 问题要能独立回答，避免「这一节讲了什么」这类空泛问法。
- 优先考概念、机制、条件、对比、易错点。
- excerpt 必须是能回答该问题的原文片段，尽量照抄。
- 最多 12 条。"#, 12),
        _ => (r#"你是论文/教材的结构分析器，把厚书拆成可学的骨架。

阅读给定页面文本，抽取其中的结构性内容（论文按 背景 / 方法 / 结果 / 讨论，教材按章节要点）。
只输出 JSON，不要解释、不要代码围栏：
{"summary":"这一块讲了什么，80 字以内","items":[{"kind":"背景","title":"要点标题（不超过 24 字）","excerpt":"支撑该要点的原文（不超过 250 字）","page":页码,"aliases":""}]}

规则：
- kind 只能是：背景 / 方法 / 结果 / 讨论 / 定义 / 结论 / 要点 之一。
- 每个条目必须对应原文，不要编造。
- excerpt 尽量照抄原文，保留关键数据与条件。
- page 必须是给定文本里出现过的页码。
- 最多 10 条，按原文顺序。"#, 10),
    };

    let limit = (base_limit + depth.saturating_sub(2) as usize * 4).min(MAX_ITEMS_PER_CHUNK);
    let mut prompt = base.replace(
        &format!("最多 {base_limit} 条"),
        &format!("最多 {limit} 条"),
    );
    if depth >= 3 {
        prompt.push_str(&format!(
            "\n- 读者将按 {depth} 层拆书：请额外抽取要点下的具体名词、术语、参数及其定义；excerpt 保留能支撑解释的原文句子，不要只给结论。"
        ));
    }
    prompt
}

fn chunk_user_prompt(mode: &str, pages: &[DigestPage], depth: u32) -> String {
    let body = pages
        .iter()
        .map(|page| format!("【第 {} 页】\n{}", page.page, page.text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mode_hint = match mode {
        "dictionary" => "请抽取术语与核心概念。",
        "vocabulary" => "请抽取值得学习的英文词汇。",
        "questions" => "请转成问题与答案。",
        _ => "请按 背景 / 方法 / 结果 / 讨论（或章节要点）抽取结构。",
    };
    format!(
        "{mode_hint}\n拆分层级：{depth} 层。\n页码范围：{}-{}。\n\n{body}",
        pages.first().map(|page| page.page).unwrap_or(0),
        pages.last().map(|page| page.page).unwrap_or(0)
    )
}

/// 从模型输出里尽力找出 JSON 对象（容忍围栏、前后解释）。
fn extract_json(raw: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(raw.trim()) {
        return Some(value);
    }
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&raw[start..=end]).ok()
}

fn text_field(value: &Value, key: &str, limit: usize) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(limit)
        .collect()
}

fn parse_items(value: &Value, page_start: u32, page_end: u32) -> Vec<DigestItem> {
    let Some(items) = value.get("items").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let title = text_field(item, "title", 80);
            if title.is_empty() {
                return None;
            }
            let page = item
                .get("page")
                .and_then(|value| value.as_u64())
                .map(|page| page as u32)
                .filter(|page| (page_start..=page_end).contains(page));
            Some(DigestItem {
                kind: text_field(item, "kind", 16),
                title,
                excerpt: text_field(item, "excerpt", 600),
                page,
                aliases: text_field(item, "aliases", 200),
            })
        })
        .take(MAX_ITEMS_PER_CHUNK)
        .collect()
}

fn save_chunk(state: &AppState, input: &DigestChunkInput, note: &ChunkNote) -> Result<(), String> {
    let connection = state.db()?;
    let timestamp = now();
    connection
        .execute(
            "INSERT INTO book_analysis (
                document_id, mode, chunk_index, page_start, page_end, summary,
                items_json, pages_json, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            ON CONFLICT(document_id, mode, chunk_index) DO UPDATE SET
                page_start = excluded.page_start,
                page_end = excluded.page_end,
                summary = excluded.summary,
                items_json = excluded.items_json,
                pages_json = excluded.pages_json,
                updated_at = excluded.updated_at",
            params![
                input.document_id,
                input.mode,
                input.chunk_index,
                note.page_start,
                note.page_end,
                note.summary,
                serde_json::to_string(&note.items).map_err(|error| error.to_string())?,
                serde_json::to_string(&input.pages).map_err(|error| error.to_string())?,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn document_exists(connection: &Connection, document_id: &str) -> Result<bool, String> {
    let found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM documents WHERE id = ?1",
            params![document_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(found.is_some())
}

/// 阶段一：分析一块文本，返回并保存该块的笔记。
pub async fn analyze_chunk(state: &AppState, input: DigestChunkInput) -> Result<ChunkNote, String> {
    validate_mode(&input.mode)?;
    let depth = normalize_depth(input.depth)?;
    if input.pages.is_empty() {
        return Err("这一块没有页面".into());
    }
    {
        let connection = state.db()?;
        if !document_exists(&connection, &input.document_id)? {
            return Err("文档不存在".into());
        }
    }
    let page_start = input.pages.iter().map(|page| page.page).min().unwrap_or(0);
    let page_end = input.pages.iter().map(|page| page.page).max().unwrap_or(0);
    let total: usize = input.pages.iter().map(|page| page.text.chars().count()).sum();
    if total == 0 {
        return Err("这一块没有可读文本（可能是扫描页且未生成文字层）".into());
    }
    if total > MAX_CHUNK_CHARS {
        return Err(format!("分块过大（{total} 字），请减少每块页数"));
    }

    let system = system_prompt(&input.mode, depth);
    let raw = ai::complete_text(
        state,
        &system,
        &chunk_user_prompt(&input.mode, &input.pages, depth),
        2000,
    )
    .await?;

    let value = extract_json(&raw).ok_or_else(|| {
        format!(
            "模型没有返回可解析的 JSON。原始输出片段：{}",
            raw.chars().take(200).collect::<String>()
        )
    })?;
    let note = ChunkNote {
        chunk_index: input.chunk_index,
        page_start,
        page_end,
        summary: text_field(&value, "summary", 240),
        items: parse_items(&value, page_start, page_end),
        pages: input.pages.clone(),
    };
    if note.items.is_empty() && note.summary.is_empty() {
        return Err("这一块没有抽取到有效内容，可尝试调大每块页数或换模式".into());
    }
    save_chunk(state, &input, &note)?;
    Ok(note)
}

/// 已完成的块（用于中断后继续）。
pub fn list_notes(state: &AppState, document_id: String, mode: String) -> Result<Vec<ChunkNote>, String> {
    validate_mode(&mode)?;
    let connection = state.db()?;
    let mut statement = connection
        .prepare(
            "SELECT chunk_index, page_start, page_end, summary, items_json, pages_json
             FROM book_analysis WHERE document_id = ?1 AND mode = ?2 ORDER BY chunk_index ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![document_id, mode], |row| {
            let items_json: String = row.get(4)?;
            let pages_json: String = row.get(5)?;
            Ok(ChunkNote {
                chunk_index: row.get(0)?,
                page_start: row.get(1)?,
                page_end: row.get(2)?,
                summary: row.get(3)?,
                items: serde_json::from_str(&items_json).unwrap_or_default(),
                pages: serde_json::from_str(&pages_json).unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|error| error.to_string())?);
    }
    Ok(notes)
}

/// 每层的语义：一章书往往「章 → 小节 → 名词 → 解释」，四种姿态各有不同的拆法。
fn layer_hints(mode: &str) -> &'static [&'static str; 5] {
    match mode {
        "dictionary" => &[
            "学科领域 / 概念族",
            "上位概念（把术语按家族归并）",
            "具体术语 / 方法名 / 指标名",
            "定义原文、英文全称、缩写、别名（excerpt 用原文）",
            "易混术语辨析 / 使用场景 / 出现章节",
        ],
        "vocabulary" => &[
            "CEFR 等级（A2 / B1 / B2 / C1 / C2）",
            "主题 / 词族",
            "单词或短语",
            "释义、词性、原句（excerpt 保留原句）",
            "常见搭配 / 派生词 / 近义辨析",
        ],
        "questions" => &[
            "主题 / 章节",
            "小节 / 知识块",
            "具体问题（可自测、不空泛）",
            "答案要点（excerpt 用原文）",
            "追问、变式题、易错点",
        ],
        _ => &[
            "章 / 主题（论文用 背景 / 方法 / 结果 / 讨论，教材用章节名）",
            "小节 / 关键要点，标题尽量写成能自我提问的形式",
            "该要点下的核心名词、概念、方法名、步骤",
            "名词的定义、成立条件、公式含义或举例（excerpt 用原文）",
            "更细的参数、边界条件、反例、易错点",
        ],
    }
}

/// 生成「恰好 N 层」的 JSON 示例，避免模型照抄两层就收工。
fn outline_example(depth: u32) -> String {
    fn node(level: u32, max: u32) -> String {
        let children = if level < max {
            format!("\"children\":[{}]", node(level + 1, max))
        } else {
            "\"children\":[]".to_string()
        };
        format!(
            "{{\"title\":\"第{level}层标题\",\"excerpt\":\"笔记里的原文摘录\",\"page\":3,\"aliases\":\"\",{children}}}"
        )
    }
    format!("{{\"title\":\"书名\",\"nodes\":[{}]}}", node(1, depth))
}

fn synthesis_prompt(mode: &str, depth: u32, max_nodes: usize) -> String {
    let role = match mode {
        "dictionary" => "你把术语笔记整理成一棵「概念词典」树。领域下面有概念族，概念族里有术语，术语下面还有定义与辨析。",
        "vocabulary" => "你把英文词汇笔记整理成一棵「生词树」。等级 → 词族 → 单词 → 释义与原句 → 搭配。",
        "questions" => "你把问题笔记整理成一棵「题目树」。主题 → 小节 → 问题 → 答案要点 → 追问。",
        _ => "你把分块笔记整理成「问题驱动」的学习骨架。一章书会分成多个小节，每个小节里有若干名词，名词又各有定义与解释。",
    };
    let mut layers = String::new();
    for (index, hint) in layer_hints(mode).iter().take(depth as usize).enumerate() {
        layers.push_str(&format!("- 第 {} 层：{hint}\n", index + 1));
    }
    let mode_rule = match mode {
        "dictionary" => "- aliases 保留英文、缩写与同义说法，用分号分隔，写进术语节点。",
        "vocabulary" => "- 单词节点的 aliases 写中文释义与词性，excerpt 保留原句。",
        "questions" => "- 问题节点的标题必须是问句，答案放 excerpt。",
        _ => "- 一级节点 3–7 个，沿用原文的结构（论文 背景 / 方法 / 结果 / 讨论，教材按章节）。",
    };
    let excerpt_rule = if depth >= 3 {
        "- 第 3 层及以下的 excerpt 必须来自分块笔记中的摘录原文，不要改写、不要杜撰。"
    } else {
        "- excerpt 必须来自分块笔记中的摘录原文，不要改写、不要杜撰。"
    };
    let stop_rule = if depth >= 3 {
        "浅层节点不要提前收尾，不能只给两层。"
    } else {
        "浅层节点不要提前收尾。"
    };
    format!(
        "{role}\n\n只输出 JSON，不要解释、不要代码围栏。下面是 {depth} 层的结构示例（children 逐层递归）：\n{}\n\n规则：\n{layers}- 必须生成恰好 {depth} 层：最深层节点的 children 为 []，{stop_rule}\n- 每个非叶节点尽量 2–5 个子节点；笔记内容不足时宁可少给子节点，也不要编造层级。\n{excerpt_rule}\n- 每个节点尽量带 page（只能用笔记里出现过的页码）；纯分组节点可为 null。\n- 节点标题不超过 24 字，总节点数不超过 {max_nodes}。\n{mode_rule}",
        outline_example(depth)
    )
}

/// 阶段二：把所有块的笔记汇总成层级骨架，深度由读者设置（默认 2 层）。
pub async fn synthesize(
    state: &AppState,
    document_id: String,
    mode: String,
    depth: Option<u32>,
) -> Result<BookOutline, String> {
    validate_mode(&mode)?;
    let depth = normalize_depth(depth)?;
    let max_nodes = max_outline_nodes(depth);
    let notes = list_notes(state, document_id.clone(), mode.clone())?;
    if notes.is_empty() {
        return Err("还没有任何分块笔记，请先分析文档".into());
    }
    let title: String = {
        let connection = state.db()?;
        connection
            .query_row(
                "SELECT title FROM documents WHERE id = ?1",
                params![document_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| "拆书结果".to_string())
    };

    // 控制提示词体积：每块带摘要 + 若干条笔记；层数越深，越需要更多条目和摘录原文，
    // 否则模型没有素材生成第 3/4 层的「名词解释」。
    let item_limit = 8 + depth.saturating_sub(2) as usize * 4;
    let excerpt_chars = if depth >= 3 { 160 } else { 0 };
    let digest = notes
        .iter()
        .map(|note| {
            let items = note
                .items
                .iter()
                .take(item_limit)
                .map(|item| {
                    let mut line = format!(
                        "- [{}] {}（第 {} 页）",
                        if item.kind.is_empty() { "要点" } else { &item.kind },
                        item.title,
                        item.page.map(|page| page.to_string()).unwrap_or_else(|| "?".into())
                    );
                    if excerpt_chars > 0 && !item.excerpt.is_empty() {
                        let excerpt: String = item.excerpt.chars().take(excerpt_chars).collect();
                        line.push_str(&format!("：{excerpt}"));
                    }
                    if !item.aliases.is_empty() {
                        let aliases: String = item.aliases.chars().take(40).collect();
                        line.push_str(&format!("｜别名 {aliases}"));
                    }
                    line
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("第 {}-{} 页：{}\n{}", note.page_start, note.page_end, note.summary, items)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let digest_limit = 20_000 + depth.saturating_sub(2) as usize * 4_000;
    let digest: String = digest.chars().take(digest_limit).collect();

    let system = synthesis_prompt(&mode, depth, max_nodes);
    let max_tokens = (4000 + depth.saturating_sub(2) * 1200).min(8000);
    let user = format!(
        "书名：{title}\n目标层级：{depth} 层（必须生成恰好 {depth} 层）\n\n分块笔记：\n{digest}"
    );
    let raw = ai::complete_text(state, &system, &user, max_tokens).await?;
    let value = extract_json(&raw)
        .ok_or_else(|| format!("模型没有返回可解析的 JSON。片段：{}", raw.chars().take(200).collect::<String>()))?;
    let mut count = 0_usize;
    let nodes = parse_outline_nodes(&value, 1, depth, max_nodes, &mut count);
    if nodes.is_empty() {
        return Err("汇总没有产出任何节点".into());
    }
    let outline = BookOutline {
        title: text_field(&value, "title", 80),
        mode: mode.clone(),
        depth,
        nodes,
    };
    {
        let connection = state.db()?;
        connection
            .execute(
                "INSERT INTO book_outline (document_id, mode, outline_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(document_id, mode) DO UPDATE SET
                    outline_json = excluded.outline_json, updated_at = excluded.updated_at",
                params![
                    document_id,
                    mode,
                    serde_json::to_string(&outline).map_err(|error| error.to_string())?,
                    now(),
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(outline)
}

fn parse_outline_nodes(
    value: &Value,
    depth: u32,
    max_depth: u32,
    max_nodes: usize,
    count: &mut usize,
) -> Vec<OutlineNode> {
    if depth > max_depth.min(HARD_MAX_OUTLINE_DEPTH) {
        return Vec::new();
    }
    // 根对象用 nodes，子节点用 children。
    let Some(nodes) = value
        .get("nodes")
        .or_else(|| value.get("children"))
        .and_then(|item| item.as_array())
    else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for node in nodes {
        if *count >= max_nodes {
            break;
        }
        let title = text_field(node, "title", 80);
        if title.is_empty() {
            continue;
        }
        *count += 1;
        result.push(OutlineNode {
            title,
            excerpt: text_field(node, "excerpt", 800),
            page: node
                .get("page")
                .and_then(|value| value.as_u64())
                .map(|page| page as u32)
                .filter(|page| *page > 0),
            aliases: text_field(node, "aliases", 200),
            children: parse_outline_nodes(node, depth + 1, max_depth, max_nodes, count),
        });
    }
    result
}

pub fn load_outline(state: &AppState, document_id: String, mode: String) -> Result<BookOutline, String> {
    let connection = state.db()?;
    let raw: Option<String> = connection
        .query_row(
            "SELECT outline_json FROM book_outline WHERE document_id = ?1 AND mode = ?2",
            params![document_id, mode],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let raw = raw.ok_or_else(|| "还没有生成骨架，请先汇总".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("骨架数据损坏: {error}"))
}

/// 骨架里的分组节点常常没有 page（按 CEFR 等级、按主题分组），
/// 从子树里借一个页码，保证每张拆书卡片都带来源、都能点击跳回原文。
fn effective_page(node: &OutlineNode) -> Option<u32> {
    node.page.or_else(|| node.children.iter().find_map(effective_page))
}

/// 阶段二之后：把骨架写成卡片与脑图节点（同一事务）。
pub fn apply_outline(state: &AppState, document_id: String, mode: String) -> Result<u32, String> {
    let outline = load_outline(state, document_id.clone(), mode)?;
    let mut connection = state.db()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    let mut created = 0_u32;
    let mut next_y = 0.0_f64;
    for node in &outline.nodes {
        place_node(
            &transaction,
            node,
            None,
            0,
            &document_id,
            &timestamp,
            &mut created,
            &mut next_y,
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(created)
}

#[allow(clippy::too_many_arguments)]
fn place_node(
    connection: &Connection,
    node: &OutlineNode,
    parent_id: Option<&str>,
    depth: u32,
    document_id: &str,
    timestamp: &str,
    created: &mut u32,
    next_y: &mut f64,
) -> Result<Option<(String, f64)>, String> {
    // 同文档同标题已存在时复用：重复点「写入脑图」不会翻倍。
    let existing: Option<(String, f64)> = connection
        .query_row(
            "SELECT c.id, COALESCE(l.y, 0) FROM cards c
             LEFT JOIN mindmap_layout l ON l.card_id = c.id AND l.canvas_id = 'main'
             WHERE c.document_id IS ?1 AND c.question = ?2 LIMIT 1",
            params![document_id, node.title],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    if let Some((id, y)) = existing {
        // 已存在也继续补子节点，避免中途失败后只应用了一半。
        for child in &node.children {
            place_node(
                connection,
                child,
                Some(&id),
                depth + 1,
                document_id,
                timestamp,
                created,
                next_y,
            )?;
        }
        return Ok(Some((id, y)));
    }

    let id = Uuid::new_v4().to_string();
    // 分组节点没有页码时继承子树页码；不建标注，bbox 只用于来源定位。
    let source_page = effective_page(node);
    let bbox = source_page.map(|_| [0.06_f64, 0.06, 0.88, 0.88]);
    connection
        .execute(
            "INSERT INTO cards (
                id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height,
                excerpt, user_note, question, parent_id, sort_order, collapsed,
                due, review_state, created_at, updated_at,
                surface_pdf, surface_mindmap, surface_review, link_aliases
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?10, 0, 0, ?11, 'new', ?11, ?11, 0, 1, 1, ?12)",
            params![
                id,
                source_page.map(|_| document_id),
                source_page,
                bbox.map(|value| value[0]),
                bbox.map(|value| value[1]),
                bbox.map(|value| value[2]),
                bbox.map(|value| value[3]),
                node.excerpt,
                node.title,
                parent_id,
                timestamp,
                node.aliases,
            ],
        )
        .map_err(|error| error.to_string())?;

    // 父卡片要先落库，子节点才能引用 parent_id。
    let mut child_positions = Vec::new();
    for child in &node.children {
        if let Some(position) = place_node(
            connection,
            child,
            Some(&id),
            depth + 1,
            document_id,
            timestamp,
            created,
            next_y,
        )? {
            child_positions.push(position);
        }
    }

    let y = if child_positions.is_empty() {
        let value = *next_y;
        *next_y += 150.0;
        value
    } else {
        child_positions.iter().map(|(_, y)| *y).sum::<f64>() / child_positions.len() as f64
    };
    let x = depth as f64 * 320.0;
    connection
        .execute(
            "INSERT INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
             VALUES (?1, 'main', ?2, ?3, ?4)",
            params![id, x, y, timestamp],
        )
        .map_err(|error| error.to_string())?;
    *created += 1;
    Ok(Some((id, y)))
}

/// 重新分析前清掉某个模式的中间产物（不动已生成的卡片）。
pub fn clear(state: &AppState, document_id: String, mode: String) -> Result<(), String> {
    validate_mode(&mode)?;
    let connection = state.db()?;
    connection
        .execute(
            "DELETE FROM book_analysis WHERE document_id = ?1 AND mode = ?2",
            params![document_id, mode],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM book_outline WHERE document_id = ?1 AND mode = ?2",
            params![document_id, mode],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    fn seed(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO documents (
                    id, title, stored_path, original_path, content_hash, file_size,
                    page_count, file_status, last_page, created_at, updated_at
                ) VALUES ('doc1', '测试教材', 'pdfs/a.pdf', NULL, 'hash', 100, 20, 'ready', 1,
                    '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn parses_model_json_with_fences_and_noise() {
        let raw = "好的，结果如下：\n```json\n{\"summary\":\"讲熵\",\"items\":[{\"kind\":\"定义\",\"title\":\"信息熵\",\"excerpt\":\"H=-Σp log p\",\"page\":3,\"aliases\":\"entropy\"}]}\n```\n希望有帮助";
        let value = extract_json(raw).unwrap();
        assert_eq!(text_field(&value, "summary", 240), "讲熵");
        let items = parse_items(&value, 1, 5);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "信息熵");
        assert_eq!(items[0].page, Some(3));
    }

    #[test]
    fn rejects_pages_outside_the_chunk() {
        let value = serde_json::json!({
            "items": [
                { "title": "页内", "page": 4 },
                { "title": "页外", "page": 99 }
            ]
        });
        let items = parse_items(&value, 1, 10);
        assert_eq!(items[0].page, Some(4));
        assert_eq!(items[1].page, None, "超出页码范围的引用应被丢弃");
    }

    #[test]
    fn applies_outline_into_cards_and_layout() {
        let (directory, state) = test_state();
        {
            let connection = state.db().unwrap();
            seed(&connection);
            let outline = BookOutline {
                title: "测试教材".into(),
                mode: "structure".into(),
                depth: 2,
                nodes: vec![OutlineNode {
                    title: "背景".into(),
                    excerpt: "研究背景".into(),
                    page: Some(3),
                    aliases: String::new(),
                    children: vec![OutlineNode {
                        title: "为什么需要熵".into(),
                        excerpt: "不确定性需要度量".into(),
                        page: Some(3),
                        aliases: "entropy".into(),
                        children: vec![],
                    }],
                }],
            };
            connection
                .execute(
                    "INSERT INTO book_outline (document_id, mode, outline_json, updated_at)
                     VALUES ('doc1', 'structure', ?1, '2026-11-04T00:00:00.000Z')",
                    params![serde_json::to_string(&outline).unwrap()],
                )
                .unwrap();
        }

        let created = apply_outline(&state, "doc1".into(), "structure".into()).unwrap();
        assert_eq!(created, 2);
        // 重复应用不翻倍
        let again = apply_outline(&state, "doc1".into(), "structure".into()).unwrap();
        assert_eq!(again, 0);

        let connection = state.db().unwrap();
        let cards: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cards, 2);
        let layouts: i64 = connection
            .query_row("SELECT COUNT(*) FROM mindmap_layout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(layouts, 2);
        let child_page: i64 = connection
            .query_row(
                "SELECT page FROM cards WHERE question = '为什么需要熵'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(child_page, 3);
        let annotations: i64 = connection
            .query_row("SELECT COUNT(*) FROM annotations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(annotations, 0, "拆书节点不应在 PDF 上生成整页高亮");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn grouped_node_inherits_child_page_as_source() {
        let (directory, state) = test_state();
        {
            let connection = state.db().unwrap();
            seed(&connection);
            let outline = BookOutline {
                title: "词汇表".into(),
                mode: "vocabulary".into(),
                depth: 2,
                nodes: vec![OutlineNode {
                    title: "B2".into(),
                    excerpt: String::new(),
                    page: None,
                    aliases: String::new(),
                    children: vec![OutlineNode {
                        title: "entropy".into(),
                        excerpt: "Entropy measures uncertainty.".into(),
                        page: Some(7),
                        aliases: "熵".into(),
                        children: vec![],
                    }],
                }],
            };
            connection
                .execute(
                    "INSERT INTO book_outline (document_id, mode, outline_json, updated_at)
                     VALUES ('doc1', 'vocabulary', ?1, '2026-11-04T00:00:00.000Z')",
                    params![serde_json::to_string(&outline).unwrap()],
                )
                .unwrap();
        }

        let created = apply_outline(&state, "doc1".into(), "vocabulary".into()).unwrap();
        assert_eq!(created, 2);
        let connection = state.db().unwrap();
        let (page, doc): (i64, Option<String>) = connection
            .query_row(
                "SELECT page, document_id FROM cards WHERE question = 'B2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(page, 7, "分组节点应继承子节点页码");
        assert_eq!(doc.as_deref(), Some("doc1"), "分组节点应带来源文档");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn reader_depth_controls_outline_truncation() {
        let value = serde_json::json!({
            "nodes": [{
                "title": "L1",
                "children": [{
                    "title": "L2",
                    "children": [{ "title": "L3", "children": [{ "title": "L4", "children": [{ "title": "L5" }] }] }]
                }]
            }]
        });
        let mut shallow = 0;
        let nodes = parse_outline_nodes(&value, 1, 2, max_outline_nodes(2), &mut shallow);
        assert_eq!(shallow, 2, "默认 2 层只保留两层");
        assert!(nodes[0].children[0].children.is_empty());

        let mut deep = 0;
        let nodes = parse_outline_nodes(&value, 1, 4, max_outline_nodes(4), &mut deep);
        assert_eq!(deep, 4, "4 层设置保留四层");
        assert!(nodes[0].children[0].children[0].children[0].children.is_empty());

        let mut runaway = 0;
        parse_outline_nodes(&value, 1, 9, 999, &mut runaway);
        assert_eq!(runaway, 5, "解析仍有硬安全网，不受非法 depth 影响");
    }

    #[test]
    fn normalizes_reader_depth_and_node_budget() {
        assert_eq!(normalize_depth(None).unwrap(), 2);
        assert_eq!(normalize_depth(Some(1)).unwrap(), 1);
        assert_eq!(normalize_depth(Some(5)).unwrap(), 5);
        assert!(normalize_depth(Some(0)).is_err());
        assert!(normalize_depth(Some(6)).is_err());
        assert!(max_outline_nodes(4) > max_outline_nodes(2));
    }

    #[test]
    fn synthesis_prompt_matches_requested_depth() {
        let shallow = synthesis_prompt("structure", 2, max_outline_nodes(2));
        assert!(shallow.contains("恰好 2 层"));
        assert!(!shallow.contains("第 3 层"));

        let deep = synthesis_prompt("structure", 4, max_outline_nodes(4));
        assert!(deep.contains("恰好 4 层"));
        assert!(deep.contains("第 4 层"));
        assert!(deep.contains("名词的定义"));
        assert!(deep.contains("第 3 层及以下"));

        let dictionary = synthesis_prompt("dictionary", 5, max_outline_nodes(5));
        assert!(dictionary.contains("第 5 层"));
        assert!(dictionary.contains("易混术语辨析"));

        // 示例本身必须恰好嵌套到目标层数（空数组也含 "children":[ 前缀）。
        let example = outline_example(4);
        assert_eq!(example.matches("\"children\":[").count(), 4);
        assert_eq!(example.matches("\"children\":[]").count(), 1);
        assert_eq!(outline_example(2).matches("\"children\":[").count(), 2);
    }

    #[test]
    fn chunk_prompt_extracts_more_detail_for_deep_digests() {
        let shallow = system_prompt("structure", 2);
        assert!(shallow.contains("最多 10 条"));
        assert!(!shallow.contains("读者将按"));

        let deep = system_prompt("structure", 4);
        assert!(deep.contains("最多 18 条"));
        assert!(deep.contains("读者将按 4 层拆书"));
        assert!(deep.contains("具体名词"));
        assert!(!deep.contains("最多 10 条"));

        let vocabulary = system_prompt("vocabulary", 5);
        assert!(vocabulary.contains("最多 24 条"), "条目上限不得超过硬上限");

        let page = DigestPage { page: 3, text: "熵".into(), bbox: None };
        assert!(chunk_user_prompt("structure", &[page], 4).contains("拆分层级：4 层"));
    }

    #[test]
    fn old_outline_json_defaults_to_two_layers() {
        let raw = r#"{"title":"旧骨架","mode":"structure","nodes":[]}"#;
        let outline: BookOutline = serde_json::from_str(raw).unwrap();
        assert_eq!(outline.depth, 2);
    }

    #[test]
    fn applies_four_level_outline_with_parent_chain() {
        let (directory, state) = test_state();
        {
            let connection = state.db().unwrap();
            seed(&connection);
            let mut node = OutlineNode {
                title: "解释".into(),
                excerpt: "H=-Σp log p".into(),
                page: Some(3),
                aliases: String::new(),
                children: vec![],
            };
            for title in ["名词", "小节", "背景"] {
                node = OutlineNode {
                    title: title.into(),
                    excerpt: "要点原文".into(),
                    page: Some(3),
                    aliases: String::new(),
                    children: vec![node],
                };
            }
            let outline = BookOutline {
                title: "测试教材".into(),
                mode: "structure".into(),
                depth: 4,
                nodes: vec![node],
            };
            connection
                .execute(
                    "INSERT INTO book_outline (document_id, mode, outline_json, updated_at)
                     VALUES ('doc1', 'structure', ?1, '2026-11-04T00:00:00.000Z')",
                    params![serde_json::to_string(&outline).unwrap()],
                )
                .unwrap();
        }

        let created = apply_outline(&state, "doc1".into(), "structure".into()).unwrap();
        assert_eq!(created, 4, "4 层骨架应写出 4 张卡片");
        let connection = state.db().unwrap();
        let xs: Vec<f64> = {
            let mut statement = connection
                .prepare("SELECT x FROM mindmap_layout ORDER BY x ASC")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(|value| value.unwrap())
                .collect()
        };
        assert_eq!(xs, vec![0.0, 320.0, 640.0, 960.0], "每层横向错开一列");
        let parents: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards WHERE parent_id IS NOT NULL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(parents, 3, "四层结构应形成三条父子边");
        let sourced: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards WHERE page = 3", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sourced, 4, "每张卡片都要能回跳原文");
        drop(connection);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
