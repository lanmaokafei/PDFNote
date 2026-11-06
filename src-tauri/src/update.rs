//! 在线检测 GitHub Releases 并升级安装包。
//!
//! 联网仅发生在两种用户可感知的场景：启动后的自动检查、设置里的手动检查。
//! 下载到本地后先校验 SHA-256，再由用户点击「立即升级」打开 DMG 安装器（拖入
//! Applications 覆盖安装）。除检查/下载外不发起任何请求，离线时静默失败。

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// GitHub Releases 的 latest 接口（不含 draft / prerelease）。
pub const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/lanmaokafei/PDFNote/releases/latest";
/// 下载进度事件名，前端用 `listen` 接收。
pub const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";

/// 一次检查的结果。`update_available` 为 false 时下载字段为空串。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_notes: String,
    pub release_url: String,
    pub download_url: String,
    pub download_size: u64,
    pub checksum_url: String,
}

/// 下载进度事件负载。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GithubAsset {
    pub(crate) name: String,
    pub(crate) browser_download_url: String,
    pub(crate) size: u64,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

/// 当前应用版本（与 package.json / tauri.conf.json / Cargo.toml 保持同步）。
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 解析 `X.Y.Z` / `vX.Y.Z[-预发布]` 为可比较元组。
///
/// 同数字时正式版（无预发布后缀）大于预发布版，如 `0.32.0 > 0.32.0-beta.1`。
pub fn parse_version(text: &str) -> Option<(u64, u64, u64, bool)> {
    let trimmed = text.trim().trim_start_matches(['v', 'V']);
    let (numbers, prerelease) = match trimmed.split_once(['-', '+']) {
        Some((numbers, suffix)) => (numbers, !suffix.trim().is_empty()),
        None => (trimmed, false),
    };
    let parts: Vec<&str> = numbers.split('.').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let major = parts[0].parse::<u64>().ok()?;
    let minor = parts[1].parse::<u64>().ok()?;
    let patch = parts
        .get(2)
        .map(|value| value.parse::<u64>().ok())
        .unwrap_or(Some(0))?;
    Some((major, minor, patch, !prerelease))
}

/// 比较两个版本号；无法解析时返回 `None`。
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let left = parse_version(a)?;
    let right = parse_version(b)?;
    Some(left.cmp(&right))
}

/// 从资产列表挑出 DMG 与配套 `.sha256`。
///
/// 优先 `aarch64.dmg`（与发布脚本的命名一致），否则退回任意 `.dmg`；
/// 校验文件必须与 DMG 同名加 `.sha256` 后缀。
pub(crate) fn pick_assets(assets: &[GithubAsset]) -> (Option<&GithubAsset>, Option<&GithubAsset>) {
    let mut dmg: Option<&GithubAsset> = None;
    for asset in assets {
        if !asset.name.ends_with(".dmg") {
            continue;
        }
        // aarch64 优先（与发布脚本命名一致），同架构保持先到者。
        let preferred = match dmg {
            None => true,
            Some(current) => {
                asset.name.contains("aarch64") && !current.name.contains("aarch64")
            }
        };
        if preferred {
            dmg = Some(asset);
        }
    }
    let checksum = dmg.and_then(|chosen| {
        let expected = format!("{}.sha256", chosen.name);
        assets.iter().find(|asset| asset.name == expected)
    });
    (dmg, checksum)
}

/// 把 GitHub 的 release JSON 转成 `UpdateInfo`。
pub fn parse_release(json: &str, current_version: &str) -> Result<UpdateInfo, String> {
    let release: GithubRelease = serde_json::from_str(json)
        .map_err(|error| format!("无法解析 GitHub Release 响应: {error}"))?;
    let latest_version = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let ordering = compare_versions(&latest_version, current_version)
        .ok_or_else(|| format!("无法解析版本号：latest {} / current {current_version}", release.tag_name))?;
    let update_available = ordering == Ordering::Greater;
    let (dmg, checksum) = pick_assets(&release.assets);
    if !update_available {
        return Ok(UpdateInfo {
            update_available: false,
            current_version: current_version.to_string(),
            latest_version,
            release_notes: release.body.unwrap_or_default(),
            release_url: release.html_url.unwrap_or_default(),
            download_url: String::new(),
            download_size: 0,
            checksum_url: String::new(),
        });
    }
    let dmg = dmg.ok_or_else(|| format!("Release {latest_version} 缺少 DMG 安装包，无法升级"))?;
    let checksum = checksum.ok_or_else(|| {
        format!("Release {latest_version} 缺少 {0}.sha256 校验文件，已拒绝下载", dmg.name)
    })?;
    Ok(UpdateInfo {
        update_available: true,
        current_version: current_version.to_string(),
        latest_version,
        release_notes: release.body.unwrap_or_default(),
        release_url: release.html_url.unwrap_or_default(),
        download_url: dmg.browser_download_url.clone(),
        download_size: dmg.size,
        checksum_url: checksum.browser_download_url.clone(),
    })
}

/// 解析 sha256sum 风格文本（`<hex>[  文件名]`）里的十六进制摘要。
pub fn parse_checksum(text: &str) -> Result<String, String> {
    let token = text
        .split_whitespace()
        .next()
        .ok_or("SHA-256 校验文件为空")?;
    if token.len() != 64 || !token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("SHA-256 校验文件格式不正确：{token}"));
    }
    Ok(token.to_ascii_lowercase())
}

fn http_client(total_timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(total_timeout)
        .build()
        .map_err(|error| format!("无法初始化网络客户端: {error}"))
}

/// 检查 GitHub Releases 是否有比当前更新的正式版。
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let client = http_client(Duration::from_secs(30))?;
    let response = client
        .get(RELEASES_LATEST_URL)
        .header("User-Agent", "pdfnote-update-check")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "检查更新超时（30 秒），请检查网络后重试".to_string()
            } else if error.is_connect() {
                "无法连接 GitHub Releases，请检查网络后重试".to_string()
            } else {
                format!("检查更新失败: {error}")
            }
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let snippet: String = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(160)
            .collect();
        return Err(format!("GitHub Releases 返回 {status}（{snippet}）"));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取更新信息失败: {error}"))?;
    parse_release(&body, current_version())
}

/// 下载 DMG 到 `data_dir/updates/`，全程发进度事件，完成后校验 SHA-256。
///
/// 旧安装包（`.dmg`/`.sha256`/`.part`）在开始前清理，避免堆积。
pub async fn download_update(
    app: &tauri::AppHandle,
    state: &AppState,
    info: &UpdateInfo,
) -> Result<String, String> {
    if !info.update_available {
        return Err("当前已是最新版本，无需下载".into());
    }
    if info.download_url.is_empty() || info.checksum_url.is_empty() {
        return Err("更新信息缺少下载地址，请重新检查更新".into());
    }
    let file_name = info
        .download_url
        .rsplit('/')
        .next()
        .filter(|value| value.ends_with(".dmg"))
        .ok_or("下载地址不是 DMG 文件")?;
    let updates_dir = state.data_dir.join("updates");
    fs::create_dir_all(&updates_dir).map_err(|error| format!("无法创建 updates 目录: {error}"))?;
    if let Ok(entries) = fs::read_dir(&updates_dir) {
        for entry in entries.filter_map(|entry| entry.ok()) {
            let path = entry.path();
            let stale = path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| matches!(value, "dmg" | "sha256" | "part"))
                .unwrap_or(false);
            if stale {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let target = updates_dir.join(file_name);
    let part_path = updates_dir.join(format!("{file_name}.part"));
    let client = http_client(Duration::from_secs(600))?;
    let mut response = client
        .get(&info.download_url)
        .header("User-Agent", "pdfnote-update-check")
        .send()
        .await
        .map_err(|error| format!("下载失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("下载失败: {error}"))?;
    let total = response.content_length().unwrap_or(info.download_size);
    let mut file = fs::File::create(&part_path).map_err(|error| format!("无法写入安装包: {error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| format!("下载中断: {error}"))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|error| format!("写入安装包失败: {error}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(100) {
            let _ = app.emit(
                UPDATE_PROGRESS_EVENT,
                DownloadProgress { downloaded, total },
            );
            last_emit = Instant::now();
        }
    }
    drop(file);
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        DownloadProgress {
            downloaded,
            total: if total > 0 { total } else { downloaded },
        },
    );

    // 校验通过前用 .part 后缀，避免半截文件被当成安装包。
    let expected = fetch_checksum(&client, &info.checksum_url).await?;
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(&expected) {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "SHA-256 校验失败（期望 {expected}，实际 {actual}），安装包已删除，请重试"
        ));
    }
    fs::rename(&part_path, &target).map_err(|error| format!("保存安装包失败: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

async fn fetch_checksum(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let text = client
        .get(url)
        .header("User-Agent", "pdfnote-update-check")
        .send()
        .await
        .map_err(|error| format!("获取 SHA-256 校验文件失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("获取 SHA-256 校验文件失败: {error}"))?
        .text()
        .await
        .map_err(|error| format!("读取 SHA-256 校验文件失败: {error}"))?;
    parse_checksum(&text)
}

/// 打开已下载的 DMG 安装器（macOS 挂载后由用户拖入 Applications）。
pub fn open_installer(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.is_file() {
        return Err("安装包不存在，请重新下载".into());
    }
    if target.extension().and_then(|value| value.to_str()) != Some("dmg") {
        return Err("只能打开 .dmg 安装包".into());
    }
    std::process::Command::new("open")
        .arg(target)
        .spawn()
        .map_err(|error| format!("打开安装器失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_compares_versions() {
        assert_eq!(parse_version("0.31.0"), Some((0, 31, 0, true)));
        assert_eq!(parse_version("v0.32.0"), Some((0, 32, 0, true)));
        assert_eq!(parse_version("V1.2"), Some((1, 2, 0, true)));
        assert_eq!(parse_version("0.32.0-beta.1"), Some((0, 32, 0, false)));
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("1.2.3.4"), None);

        assert_eq!(compare_versions("0.32.0", "0.31.0"), Some(Ordering::Greater));
        assert_eq!(compare_versions("v0.31.0", "0.31.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.10.0", "0.9.0"), Some(Ordering::Greater));
        assert_eq!(
            compare_versions("0.32.0-beta.1", "0.32.0"),
            Some(Ordering::Less)
        );
        assert_eq!(compare_versions("bad", "0.31.0"), None);
    }

    #[test]
    fn prefers_aarch64_dmg_with_matching_checksum() {
        let assets = vec![
            GithubAsset {
                name: "PDFNote_0.32.0_x64.dmg".into(),
                browser_download_url: "https://example/x64.dmg".into(),
                size: 1,
            },
            GithubAsset {
                name: "PDFNote_0.32.0_aarch64.dmg".into(),
                browser_download_url: "https://example/arm.dmg".into(),
                size: 2,
            },
            GithubAsset {
                name: "PDFNote_0.32.0_aarch64.dmg.sha256".into(),
                browser_download_url: "https://example/arm.dmg.sha256".into(),
                size: 3,
            },
        ];
        let (dmg, checksum) = pick_assets(&assets);
        assert_eq!(dmg.unwrap().name, "PDFNote_0.32.0_aarch64.dmg");
        assert_eq!(
            checksum.unwrap().name,
            "PDFNote_0.32.0_aarch64.dmg.sha256"
        );
    }

    #[test]
    fn falls_back_to_any_dmg_but_requires_checksum() {
        let only_dmg = vec![GithubAsset {
            name: "PDFNote_0.32.0.dmg".into(),
            browser_download_url: "https://example/a.dmg".into(),
            size: 1,
        }];
        let (dmg, checksum) = pick_assets(&only_dmg);
        assert!(dmg.is_some());
        assert!(checksum.is_none());
    }

    #[test]
    fn parses_release_json_into_update_info() {
        let json = r#"{
            "tag_name": "v0.32.0",
            "body": "更新说明\n- 在线升级",
            "html_url": "https://github.com/lanmaokafei/PDFNote/releases/tag/v0.32.0",
            "assets": [
                {"name": "PDFNote_0.32.0_aarch64.dmg", "browser_download_url": "https://example/arm.dmg", "size": 11434796},
                {"name": "PDFNote_0.32.0_aarch64.dmg.sha256", "browser_download_url": "https://example/arm.dmg.sha256", "size": 101}
            ]
        }"#;
        let info = parse_release(json, "0.31.0").unwrap();
        assert!(info.update_available);
        assert_eq!(info.latest_version, "0.32.0");
        assert_eq!(info.current_version, "0.31.0");
        assert_eq!(info.download_url, "https://example/arm.dmg");
        assert_eq!(info.download_size, 11434796);
        assert_eq!(info.checksum_url, "https://example/arm.dmg.sha256");
        assert!(info.release_notes.contains("在线升级"));
    }

    #[test]
    fn reports_up_to_date_without_download_fields() {
        let json = r#"{
            "tag_name": "v0.31.0",
            "body": "",
            "html_url": "https://example/tag",
            "assets": []
        }"#;
        let info = parse_release(json, "0.31.0").unwrap();
        assert!(!info.update_available);
        assert_eq!(info.download_url, "");
        assert_eq!(info.checksum_url, "");
        assert_eq!(info.release_url, "https://example/tag");
    }

    #[test]
    fn rejects_release_missing_dmg_or_checksum() {
        let no_dmg = r#"{"tag_name": "v0.32.0", "assets": []}"#;
        let error = parse_release(no_dmg, "0.31.0").unwrap_err();
        assert!(error.contains("缺少 DMG"));

        let no_checksum = r#"{
            "tag_name": "v0.32.0",
            "assets": [
                {"name": "PDFNote_0.32.0_aarch64.dmg", "browser_download_url": "https://example/arm.dmg", "size": 1}
            ]
        }"#;
        let error = parse_release(no_checksum, "0.31.0").unwrap_err();
        assert!(error.contains("sha256"));
    }

    #[test]
    fn parses_checksum_lines() {
        let digest = "f6b0c654f41c6a4b9d78b1b8f2b0e26c1a22862cdb9c1f0a4e52b39c1f8a7b6c";
        assert_eq!(
            parse_checksum(&format!("{digest}  PDFNote_0.32.0_aarch64.dmg\n")).unwrap(),
            digest
        );
        assert_eq!(parse_checksum(&digest.to_uppercase()).unwrap(), digest);
        assert!(parse_checksum("   ").unwrap_err().contains("为空"));
        assert!(parse_checksum("abc").unwrap_err().contains("格式不正确"));
    }

    #[test]
    fn verifies_file_digest_roundtrip() {
        let directory = std::env::temp_dir().join(format!("pdfnote-update-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("sample.dmg");
        fs::write(&path, b"PDFNote").unwrap();
        let mut hasher = Sha256::new();
        hasher.update(b"PDFNote");
        let expected = hex::encode(hasher.finalize());
        let mut check = Sha256::new();
        check.update(fs::read(&path).unwrap());
        assert_eq!(hex::encode(check.finalize()), expected);
        assert_eq!(parse_checksum(&format!("{expected}\n")).unwrap(), expected);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn open_installer_rejects_missing_or_non_dmg() {
        let directory = std::env::temp_dir().join(format!("pdfnote-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        assert!(open_installer(&directory.join("missing.dmg").to_string_lossy())
            .unwrap_err()
            .contains("不存在"));
        let txt = directory.join("note.txt");
        fs::write(&txt, "x").unwrap();
        assert!(open_installer(&txt.to_string_lossy())
            .unwrap_err()
            .contains(".dmg"));
        let _ = fs::remove_dir_all(&directory);
    }
}
