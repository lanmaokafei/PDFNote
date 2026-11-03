use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::{Duration, Instant}};

/// 可选视觉模型配置。未配置时应用完全离线：不发起任何识别请求。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    /// 单次识别的总等待上限（秒）。部分网关会在自己的 90 秒上限处先返回 504，
    /// 因此这里只控制本地最多等多久，不保证服务端会等这么久。
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

pub const MIN_TIMEOUT_SECS: u64 = 30;
pub const MAX_TIMEOUT_SECS: u64 = 300;
fn default_timeout_secs() -> u64 {
    120
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            timeout_secs: default_timeout_secs(),
        }
    }
}

impl AiSettings {
    pub fn configured(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    /// 允许用户填 `http://127.0.0.1:11434/v1`，也允许直接填完整接口地址。
    fn endpoint(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{base}/chat/completions")
        }
    }
}

fn settings_path(state: &AppState) -> PathBuf {
    state.data_dir.join("settings.json")
}

pub fn load_settings(state: &AppState) -> Result<AiSettings, String> {
    let path = settings_path(state);
    if !path.exists() {
        return Ok(AiSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|error| format!("读取设置失败: {error}"))?;
    if raw.trim().is_empty() {
        return Ok(AiSettings::default());
    }
    serde_json::from_str::<AiSettings>(&raw).map_err(|error| format!("设置文件损坏: {error}"))
}

pub fn save_settings(state: &AppState, mut settings: AiSettings) -> Result<AiSettings, String> {
    settings.base_url = settings.base_url.trim().trim_end_matches('/').to_string();
    settings.model = settings.model.trim().to_string();
    settings.api_key = settings.api_key.trim().to_string();
    if !settings.base_url.is_empty()
        && !(settings.base_url.starts_with("http://") || settings.base_url.starts_with("https://"))
    {
        return Err("Base URL 必须以 http:// 或 https:// 开头".into());
    }
    if settings.base_url.chars().count() > 500 || settings.model.chars().count() > 200 {
        return Err("Base URL 或模型名过长".into());
    }
    if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&settings.timeout_secs) {
        return Err(format!(
            "超时时间需要在 {MIN_TIMEOUT_SECS}–{MAX_TIMEOUT_SECS} 秒之间"
        ));
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path(state), json).map_err(|error| format!("保存设置失败: {error}"))?;
    Ok(settings)
}

/// 按识别场景选择提示词。输出一律要求是可直接写入卡片的纯文本。
fn prompt_for(mode: &str) -> Result<&'static str, String> {
    match mode {
        "formula" => Ok(
            "你是数学公式识别器。把图片中的公式转成 LaTeX，只输出 LaTeX 本身。\
不要解释，不要前后缀，不要代码围栏。多行公式用 aligned 环境。中文用 \\text{} 包裹。\
若图片里没有公式，只输出图片中的文字本身。",
        ),
        "table" => Ok(
            "识别图片中的表格并输出 Markdown 表格；如同时包含公式，公式用 $$...$$ 包裹。\
只输出结果本身，不要解释，不要代码围栏。",
        ),
        "general" => Ok(
            "识别图片中的内容并输出 Markdown：正文用普通段落，公式用 $$...$$，表格用 Markdown 表格。\
只输出结果本身，不要解释，不要代码围栏。",
        ),
        other => Err(format!("不支持的识别模式: {other}")),
    }
}

/// 去掉模型常见的代码围栏包装，避免写进卡片的摘录带着 ```latex。
pub fn clean_model_output(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_fence = if trimmed.starts_with("```") {
        let body = trimmed
            .split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or(trimmed);
        body.strip_suffix("```").unwrap_or(body)
    } else {
        trimmed
    };
    without_fence.trim().to_string()
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f32,
    max_tokens: u32,
    stream: bool,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: MessageContent,
}

#[derive(Serialize)]
#[serde(untagged)]
enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlPayload },
}

#[derive(Serialize)]
struct ImageUrlPayload {
    url: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    #[serde(default)]
    content: String,
}

fn decode_image(image_data: &str) -> Result<String, String> {
    use base64::Engine;
    let payload = image_data
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(image_data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("选区图像解码失败: {error}"))?;
    if bytes.is_empty() {
        return Err("选区图像为空".into());
    }
    if bytes.len() > 12_000_000 {
        return Err("选区图像过大，请缩小选区后重试".into());
    }
    // 重新编码，保证发给模型的是合法 data URL（前端可能给 JPEG 或 PNG）。
    let mime = if image_data.starts_with("data:image/png") { "image/png" } else { "image/jpeg" };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 连通性测试结果，供设置面板直接展示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    /// 往返耗时（毫秒）。
    pub latency_ms: u64,
    /// 服务报告的模型列表；退化到 chat 探测时为空。
    pub models: Vec<String>,
    /// 配置的模型是否出现在服务列表里（无法枚举时为 true）。
    pub model_found: bool,
    /// 实际探测方式：`models` 或 `chat`。
    pub via: String,
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    #[serde(default)]
    id: String,
}

fn models_endpoint(settings: &AiSettings) -> String {
    let base = settings.base_url.trim().trim_end_matches('/');
    if let Some(stripped) = base.strip_suffix("/chat/completions") {
        format!("{stripped}/models")
    } else {
        format!("{base}/models")
    }
}

/// 用当前输入框里的配置探测服务是否可用，不做任何持久化。
///
/// 先请求 `GET /models` 验证地址与鉴权，同时校验模型名是否存在；
/// 若服务不实现该接口（部分自建网关返回 404/405），退化到一次最小 chat 请求。
pub async fn test_connection(settings: AiSettings) -> Result<AiTestResult, String> {
    if !settings.configured() {
        return Err("请先填写 Base URL 与模型名".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法初始化测试客户端: {error}"))?;
    let started = std::time::Instant::now();

    let mut request = client.get(models_endpoint(&settings));
    if !settings.api_key.is_empty() {
        request = request.bearer_auth(&settings.api_key);
    }
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            let body = response.text().await.unwrap_or_default();
            let parsed: ModelsResponse =
                serde_json::from_str(&body).unwrap_or(ModelsResponse { data: Vec::new() });
            let models: Vec<String> = parsed
                .data
                .into_iter()
                .map(|entry| entry.id)
                .filter(|id| !id.is_empty())
                .collect();
            let model_found = models.is_empty() || models.iter().any(|id| id == &settings.model);
            Ok(AiTestResult {
                latency_ms: started.elapsed().as_millis() as u64,
                models,
                model_found,
                via: "models".into(),
            })
        }
        Ok(response) => {
            let status = response.status();
            if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
                return probe_with_chat(&client, &settings, started).await;
            }
            let snippet: String = response.text().await.unwrap_or_default().chars().take(160).collect();
            Err(format!("服务返回 {status}（{snippet}）。请检查 Base URL 与 API Key。"))
        }
        Err(error) => Err(connect_error(&error, &settings.base_url)),
    }
}

/// 退化探测：发一条最小消息，只要能拿到 2xx 就说明地址、鉴权与模型名都可用。
async fn probe_with_chat(
    client: &reqwest::Client,
    settings: &AiSettings,
    started: std::time::Instant,
) -> Result<AiTestResult, String> {
    let request = ChatRequest {
        model: &settings.model,
        messages: vec![ChatMessage {
            role: "user",
            content: MessageContent::Text("ping".into()),
        }],
        temperature: 0.0,
        max_tokens: 1,
        stream: false,
    };
    let mut builder = client.post(settings.endpoint()).json(&request);
    if !settings.api_key.is_empty() {
        builder = builder.bearer_auth(&settings.api_key);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| connect_error(&error, &settings.base_url))?;
    if !response.status().is_success() {
        let status = response.status();
        let snippet: String = response.text().await.unwrap_or_default().chars().take(160).collect();
        return Err(format!(
            "模型服务返回 {status}（{snippet}）。请确认模型名「{}」已就绪。",
            settings.model
        ));
    }
    Ok(AiTestResult {
        latency_ms: started.elapsed().as_millis() as u64,
        models: Vec::new(),
        model_found: true,
        via: "chat".into(),
    })
}

fn connect_error(error: &reqwest::Error, base_url: &str) -> String {
    if error.is_timeout() {
        "连接超时（20 秒），服务可能未启动或网络不可达。".to_string()
    } else if error.is_connect() {
        format!("无法连接 {base_url}。请确认本机模型已启动，或检查 Base URL。")
    } else {
        format!("请求失败: {error}")
    }
}

/// 调用 OpenAI 兼容的 chat/completions 接口识别选区内容。
///
/// 这是应用里唯一的网络出口，且只在用户显式配置模型后才会触发；
/// 未配置时直接返回错误，调用方保留原图摘录。
pub async fn recognize_selection(
    state: &AppState,
    image_data: String,
    mode: String,
) -> Result<String, String> {
    let settings = load_settings(state)?;
    if !settings.configured() {
        return Err("尚未配置识别模型：请在设置中填写 Base URL 与模型名".into());
    }
    let prompt = prompt_for(&mode)?;
    let image_url = decode_image(&image_data)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(settings.timeout_secs))
        .build()
        .map_err(|error| format!("无法初始化识别客户端: {error}"))?;

    let request = ChatRequest {
        model: &settings.model,
        messages: vec![
            ChatMessage { role: "system", content: MessageContent::Text(prompt.into()) },
            ChatMessage {
                role: "user",
                content: MessageContent::Parts(vec![
                    ContentPart::Text { text: "识别这张图片。".into() },
                    ContentPart::ImageUrl { image_url: ImageUrlPayload { url: image_url } },
                ]),
            },
        ],
        temperature: 0.0,
        max_tokens: 1500,
        stream: false,
    };

    let mut builder = client.post(settings.endpoint()).json(&request);
    if !settings.api_key.is_empty() {
        builder = builder.bearer_auth(&settings.api_key);
    }
    let response = builder.send().await.map_err(|error| {
        if error.is_timeout() {
            "识别请求超时（120 秒）。本机模型可能仍在加载，或选区过大。".to_string()
        } else if error.is_connect() {
            format!(
                "无法连接识别服务（{}）。请确认本机模型已启动，或检查 Base URL 与网络。",
                settings.base_url
            )
        } else {
            format!("识别请求失败: {error}")
        }
    })?;

    let status = response.status();
    let body = response.text().await.map_err(|error| format!("读取响应失败: {error}"))?;
    if !status.is_success() {
        // 网关常在自己的上限（如 90 秒）先返回 504，但会把异步任务号给我们。
        // 这时任务仍在服务端执行，按任务号轮询即可拿到结果，而不是直接失败。
        if let Some(task_no) = extract_task_no(&body) {
            return poll_task(&client, &settings, &task_no).await.map_err(|error| {
                format!("识别服务返回 {status}，任务 {task_no} 仍在服务端执行；自动查询结果失败：{error}")
            });
        }
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("识别服务返回 {status}: {snippet}"));
    }
    let parsed: ChatResponse =
        serde_json::from_str(&body).map_err(|error| format!("无法解析响应: {error}"))?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .unwrap_or_default();
    let cleaned = clean_model_output(&content);
    if cleaned.is_empty() {
        return Err("识别服务返回了空内容".into());
    }
    Ok(cleaned)
}

/// 从错误响应里提取异步任务号。
///
/// 有的网关给出结构化字段（`task_no` / `task_id`），有的只写在提示文本里
/// （“等待模型响应超时（90s），任务 20261103-3158 仍在执行…”），两种都要认。
pub fn extract_task_no(body: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        for key in ["task_no", "task_id", "taskId", "taskNo"] {
            if let Some(id) = find_string_field(&value, key) {
                if id.len() >= 6 {
                    return Some(id);
                }
            }
        }
    }
    extract_identifier_after(body, "任务 ")
        .or_else(|| extract_identifier_after(body, "/tasks/"))
        .or_else(|| extract_identifier_after(body, "task_no="))
}

/// 取标记之后连续出现的字母数字/连字符，长度至少 6，避免误抓普通词。
fn extract_identifier_after(text: &str, marker: &str) -> Option<String> {
    let mut search = text;
    while let Some(index) = search.find(marker) {
        let rest = &search[index + marker.len()..];
        let candidate: String = rest
            .trim_start()
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .collect();
        let meaningful = candidate.chars().any(|ch| ch.is_ascii_alphanumeric());
        if candidate.len() >= 6 && meaningful && candidate != "task_no" {
            return Some(candidate);
        }
        search = rest;
    }
    None
}

fn find_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(text)) = map.get(key) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            map.values().find_map(|child| find_string_field(child, key))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|child| find_string_field(child, key)),
        _ => None,
    }
}

enum TaskState {
    Done(String),
    Failed(String),
    Pending,
    Unknown,
}

fn extract_task_text(body: &str) -> TaskState {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return TaskState::Unknown;
    };
    let status = find_string_field(&value, "status")
        .unwrap_or_default()
        .to_lowercase();
    match status.as_str() {
        "failed" | "error" | "cancelled" | "canceled" => {
            let message = find_string_field(&value, "message")
                .or_else(|| find_string_field(&value, "error"))
                .unwrap_or_else(|| "任务执行失败".into());
            TaskState::Failed(message)
        }
        "succeeded" | "success" | "completed" | "done" | "finished" => {
            for key in ["content", "text", "result", "output", "markdown"] {
                if let Some(text) = find_string_field(&value, key) {
                    let cleaned = clean_model_output(&text);
                    if !cleaned.is_empty() {
                        return TaskState::Done(cleaned);
                    }
                }
            }
            TaskState::Unknown
        }
        _ => TaskState::Pending,
    }
}

/// 轮询 `{base}/tasks/{task_no}` 直到完成或超过本地等待上限。
async fn poll_task(
    client: &reqwest::Client,
    settings: &AiSettings,
    task_no: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/tasks/{}",
        settings.base_url.trim_end_matches('/'),
        task_no
    );
    let deadline = Instant::now() + Duration::from_secs(settings.timeout_secs);
    let mut last_state = "任务尚未完成".to_string();
    loop {
        if Instant::now() >= deadline {
            return Err(format!(
                "等待 {} 秒后仍未完成（{last_state}）",
                settings.timeout_secs
            ));
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut request = client.get(&url);
        if !settings.api_key.is_empty() {
            request = request.bearer_auth(&settings.api_key);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                last_state = connect_error(&error, &settings.base_url);
                continue;
            }
        };
        if !response.status().is_success() {
            last_state = format!("查询接口返回 {}", response.status());
            continue;
        }
        let body = response.text().await.unwrap_or_default();
        match extract_task_text(&body) {
            TaskState::Done(text) => return Ok(text),
            TaskState::Failed(message) => return Err(message),
            TaskState::Pending => last_state = "任务仍在执行".into(),
            TaskState::Unknown => last_state = "查询结果无法解析".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    #[test]
    fn settings_roundtrip_and_defaults() {
        let (directory, state) = test_state();
        assert_eq!(load_settings(&state).unwrap(), AiSettings::default());

        let saved = save_settings(
            &state,
            AiSettings {
                base_url: "  http://127.0.0.1:11434/v1/  ".into(),
                model: " qwen2.5vl:7b ".into(),
                api_key: " test-key ".into(),
                timeout_secs: 180,
            },
        )
        .unwrap();
        assert_eq!(saved.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(saved.model, "qwen2.5vl:7b");
        assert_eq!(saved.api_key, "test-key");
        assert_eq!(saved.timeout_secs, 180);
        assert!(saved.configured());
        assert_eq!(saved.endpoint(), "http://127.0.0.1:11434/v1/chat/completions");

        let loaded = load_settings(&state).unwrap();
        assert_eq!(loaded, saved);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn full_endpoint_is_not_doubled() {
        let settings = AiSettings {
            base_url: "https://example.com/v1/chat/completions".into(),
            model: "m".into(),
            api_key: String::new(),
            timeout_secs: 120,
        };
        assert_eq!(settings.endpoint(), "https://example.com/v1/chat/completions");
    }

    #[test]
    fn save_rejects_invalid_base_url() {
        let (directory, state) = test_state();
        let error = save_settings(
            &state,
            AiSettings { base_url: "127.0.0.1:11434".into(), model: "m".into(), api_key: String::new(), timeout_secs: 120 },
        )
        .unwrap_err();
        assert!(error.contains("http://"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn clean_output_strips_code_fences() {
        assert_eq!(clean_model_output("```latex\nE = mc^2\n```"), "E = mc^2");
        assert_eq!(clean_model_output("```\n\\frac{a}{b}\n```"), "\\frac{a}{b}");
        assert_eq!(clean_model_output("  纯文本  "), "纯文本");
    }

    #[test]
    fn prompts_exist_for_known_modes() {
        assert!(prompt_for("formula").unwrap().contains("LaTeX"));
        assert!(prompt_for("table").unwrap().contains("Markdown"));
        assert!(prompt_for("general").unwrap().contains("Markdown"));
        assert!(prompt_for("unknown").is_err());
    }

    #[test]
    fn unconfigured_settings_never_issue_requests() {
        let (directory, state) = test_state();
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let error = runtime
            .block_on(recognize_selection(
                &state,
                "data:image/jpeg;base64,QUJD".into(),
                "formula".into(),
            ))
            .unwrap_err();
        assert!(error.contains("尚未配置"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn decode_accepts_bare_base64_and_rebuilds_data_url() {
        // "ABC" 的 base64
        let url = decode_image("QUJD").unwrap();
        assert_eq!(url, "data:image/jpeg;base64,QUJD");
        let png = decode_image("data:image/png;base64,QUJD").unwrap();
        assert!(png.starts_with("data:image/png;base64,"));
        assert!(decode_image("").is_err());
    }

    /// 起一个只回应一次的最小 HTTP 服务，验证真实请求、响应解析与围栏清理。
    fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
        use std::io::Read;
        // 请求体是 chunked 或分多次到达，必须按 Content-Length 读满。
        let mut data: Vec<u8> = Vec::new();
        loop {
            let mut chunk = [0_u8; 4096];
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..read]);
            if let Some(position) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&data[..position]).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= position + 4 + length {
                    break;
                }
            }
        }
        data
    }

    fn write_http_response(stream: &mut std::net::TcpStream, status: u16, body: &str) {
        use std::io::Write;
        let response = format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
    }

    fn mock_server(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let data = read_http_request(&mut stream);
            write_http_response(&mut stream, status, body);
            String::from_utf8_lossy(&data).to_string()
        });
        (format!("http://{address}/v1"), handle)
    }

    /// 依次回应多个请求，用于验证“网关超时 → 轮询任务”的完整链路。
    fn mock_server_sequence(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let data = read_http_request(&mut stream);
                requests.push(String::from_utf8_lossy(&data).to_string());
                write_http_response(&mut stream, status, body);
            }
            requests
        });
        (format!("http://{address}/v1"), handle)
    }

    #[test]
    fn test_connection_reports_models_and_latency() {
        let (base_url, server) = mock_server(
            200,
            r#"{"data":[{"id":"mock-vl"},{"id":"other-model"}]}"#,
        );
        let settings = AiSettings { base_url, model: "mock-vl".into(), api_key: String::new(), timeout_secs: 120 };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime.block_on(test_connection(settings)).unwrap();
        assert_eq!(result.via, "models");
        assert!(result.model_found);
        assert_eq!(result.models, vec!["mock-vl", "other-model"]);

        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models"), "unexpected request: {request}");
    }

    #[test]
    fn test_connection_flags_missing_model() {
        let (base_url, server) = mock_server(200, r#"{"data":[{"id":"other-model"}]}"#);
        let settings = AiSettings { base_url, model: "missing-vl".into(), api_key: String::new(), timeout_secs: 120 };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime.block_on(test_connection(settings)).unwrap();
        assert!(!result.model_found, "模型名不在列表时应标记为未找到");
        let _ = server.join();
    }

    #[test]
    fn test_connection_surfaces_server_errors() {
        let (base_url, server) = mock_server(500, r#"{"error":"boom"}"#);
        let settings = AiSettings { base_url, model: "mock-vl".into(), api_key: String::new(), timeout_secs: 120 };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let error = runtime.block_on(test_connection(settings)).unwrap_err();
        assert!(error.contains("服务返回"), "unexpected error: {error}");
        let _ = server.join();
    }

    #[test]
    fn test_connection_requires_configuration() {
        let settings = AiSettings::default();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let error = runtime.block_on(test_connection(settings)).unwrap_err();
        assert!(error.contains("请先填写"));
    }

    #[test]
    fn extract_task_no_handles_gateway_message_text() {
        // 用户实际遇到的 504 响应：任务号只出现在 message 文本里。
        let body = r#"{"error":{"message":"等待模型响应超时（90s），任务 20261103-3158 仍在执行，可稍后经 /api/v1/tasks/{task_no} 查询结果","type":"api_error","code":"upstream_timeout","param":null}}"#;
        assert_eq!(extract_task_no(body).as_deref(), Some("20261103-3158"));

        let structured = r#"{"error":{"task_no":"abc123def"}}"#;
        assert_eq!(extract_task_no(structured).as_deref(), Some("abc123def"));

        assert_eq!(extract_task_no(r#"{"error":"model not found"}"#), None);
        assert_eq!(extract_task_no("plain text"), None);
    }

    #[test]
    fn extract_task_text_reads_status_and_result() {
        match extract_task_text(r#"{"status":"succeeded","result":"E = mc^2"}"#) {
            TaskState::Done(text) => assert_eq!(text, "E = mc^2"),
            _ => panic!("expected done"),
        }
        match extract_task_text(r#"{"status":"running"}"#) {
            TaskState::Pending => {}
            _ => panic!("expected pending"),
        }
        match extract_task_text(r#"{"status":"failed","message":"boom"}"#) {
            TaskState::Failed(message) => assert_eq!(message, "boom"),
            _ => panic!("expected failed"),
        }
        assert!(matches!(extract_task_text("not json"), TaskState::Unknown));
    }

    #[test]
    fn recognize_polls_async_task_after_gateway_timeout() {
        let timeout_body = r#"{"error":{"message":"等待模型响应超时（90s），任务 20261103-3158 仍在执行，可稍后经 /api/v1/tasks/{task_no} 查询结果","type":"api_error","code":"upstream_timeout","param":null}}"#;
        let (base_url, server) = mock_server_sequence(vec![
            (504, timeout_body),
            (200, r#"{"status":"succeeded","result":"```latex\nE = mc^2\n```"}"#),
        ]);
        let (directory, state) = test_state();
        save_settings(
            &state,
            AiSettings {
                base_url,
                model: "mock-vl".into(),
                api_key: "k".into(),
                timeout_secs: 30,
            },
        )
        .unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime
            .block_on(recognize_selection(
                &state,
                "data:image/jpeg;base64,QUJD".into(),
                "formula".into(),
            ))
            .unwrap();
        assert_eq!(result, "E = mc^2", "网关超时后应通过任务号拿到结果");

        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("GET /v1/tasks/20261103-3158"), "unexpected poll: {}", requests[1]);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn recognize_sends_image_and_cleans_response() {
        let (base_url, server) = mock_server(
            200,
            r#"{"choices":[{"message":{"content":"```latex\nE = mc^2\n```"}}]}"#,
        );
        let (directory, state) = test_state();
        save_settings(
            &state,
            AiSettings { base_url, model: "mock-vl".into(), api_key: "k".into(), timeout_secs: 120 },
        )
        .unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime
            .block_on(recognize_selection(
                &state,
                "data:image/jpeg;base64,QUJD".into(),
                "formula".into(),
            ))
            .unwrap();
        assert_eq!(result, "E = mc^2");

        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"));
        assert!(request.contains("authorization: Bearer k"));
        assert!(request.contains("\"model\":\"mock-vl\""));
        assert!(request.contains("data:image/jpeg;base64,QUJD"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn recognize_surfaces_http_errors() {
        let (base_url, server) = mock_server(500, r#"{"error":"model not found"}"#);
        let (directory, state) = test_state();
        save_settings(
            &state,
            AiSettings { base_url, model: "missing-model".into(), api_key: String::new(), timeout_secs: 120 },
        )
        .unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let error = runtime
            .block_on(recognize_selection(
                &state,
                "data:image/jpeg;base64,QUJD".into(),
                "table".into(),
            ))
            .unwrap_err();
        assert!(error.contains("识别服务返回"), "unexpected error: {error}");
        let _ = server.join();
        let _ = fs::remove_dir_all(&directory);
    }
}
