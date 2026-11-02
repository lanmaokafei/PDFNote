#[cfg(target_os = "macos")]
use base64::Engine;

/// Decode a browser data URL and run Apple Vision (macOS native OCR).
///
/// PDFNote is macOS-only, so there is deliberately no second engine: a Vision
/// failure is surfaced to the user instead of silently degrading to a less
/// accurate backend or writing garbage into a card.
pub fn recognize_image(image_data: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
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
        // VNRecognizeTextRequest, accurate level, revision 3, automatic language
        // detection (so Chinese and Latin text both work). See rightkit-ocr.
        let lines = rightkit_ocr::vision::recognize(&image)?;
        Ok(lines
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = image_data;
        Err("OCR 仅支持 macOS（Apple Vision）".into())
    }
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
