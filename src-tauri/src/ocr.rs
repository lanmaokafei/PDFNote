use base64::Engine;

/// Decode a browser data URL and run the platform-native OCR backend.
pub fn recognize_image(image_data: String) -> Result<String, String> {
    let payload = image_data
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(image_data.as_str());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("OCR 图像解码失败: {error}"))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|error| format!("OCR 图像读取失败: {error}"))?
        .to_rgb8();

    #[cfg(target_os = "macos")]
    let lines = rightkit_ocr::vision::recognize(&image)?;
    #[cfg(windows)]
    let lines = rightkit_ocr::win_native::recognize(&image)?;
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = image;
        return Err("当前平台没有原生 OCR，使用 Tesseract 回退".into());
    }

    #[allow(unreachable_code)]
    Ok(lines
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    #[ignore = "requires OCR_TEST_IMAGE and macOS Vision"]
    fn native_vision_recognizes_chinese_data_url() {
        use base64::Engine;
        let path = std::env::var("OCR_TEST_IMAGE").expect("OCR_TEST_IMAGE is required");
        let bytes = std::fs::read(path).unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        let text = super::recognize_image(data_url).unwrap();
        assert!(text.contains("信息化"), "unexpected OCR output: {text}");
    }
}
