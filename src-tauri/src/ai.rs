use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};

/// 可选视觉模型配置。未配置时应用完全离线：不发起任何识别请求。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
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
        .timeout(Duration::from_secs(120))
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
            },
        )
        .unwrap();
        assert_eq!(saved.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(saved.model, "qwen2.5vl:7b");
        assert_eq!(saved.api_key, "test-key");
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
        };
        assert_eq!(settings.endpoint(), "https://example.com/v1/chat/completions");
    }

    #[test]
    fn save_rejects_invalid_base_url() {
        let (directory, state) = test_state();
        let error = save_settings(
            &state,
            AiSettings { base_url: "127.0.0.1:11434".into(), model: "m".into(), api_key: String::new() },
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
    fn mock_server(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
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
            let request = String::from_utf8_lossy(&data).to_string();
            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            request
        });
        (format!("http://{address}/v1"), handle)
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
            AiSettings { base_url, model: "mock-vl".into(), api_key: "k".into() },
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
            AiSettings { base_url, model: "missing-model".into(), api_key: String::new() },
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
