#[cfg(target_os = "macos")]
use base64::Engine;
use serde::Serialize;

/// One recognized line with a normalized, top-left-origin bounding box.
///
/// Apple Vision returns a rect for every observation. Keeping the geometry is
/// what lets the web layer rebuild an invisible, selectable text layer over a
/// scanned page: without it a click can only ever trigger a fresh OCR request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLinePayload {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub confidence: f32,
}

#[cfg(target_os = "macos")]
fn decode_image(image_data: &str) -> Result<image::RgbImage, String> {
    let payload = image_data
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(image_data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("OCR 图像解码失败: {error}"))?;
    image::load_from_memory(&bytes)
        .map(|image| image.to_rgb8())
        .map_err(|error| format!("OCR 图像读取失败: {error}"))
}

/// Decode a browser data URL and run Apple Vision (macOS native OCR).
///
/// PDFNote is macOS-only, so there is deliberately no second engine: a Vision
/// failure is surfaced to the user instead of silently degrading to a less
/// accurate backend or writing garbage into a card.
pub fn recognize_image(image_data: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let image = decode_image(&image_data)?;
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

/// Recognize a whole page and return each line together with its position.
///
/// Coordinates are normalized 0..1 relative to the decoded image, origin at the
/// top-left — the same space PDFNote uses for card bounding boxes. The frontend
/// caches this once per page and uses it for instant text selection.
pub fn recognize_lines(image_data: String) -> Result<Vec<OcrLinePayload>, String> {
    #[cfg(target_os = "macos")]
    {
        let image = decode_image(&image_data)?;
        let lines = rightkit_ocr::vision::recognize(&image)?;
        Ok(lines
            .into_iter()
            .map(|line| OcrLinePayload {
                text: line.text,
                x: line.rect.x,
                y: line.rect.y,
                width: line.rect.width,
                height: line.rect.height,
                confidence: line.confidence.unwrap_or(0.0),
            })
            .collect())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = image_data;
        Err("OCR 仅支持 macOS（Apple Vision）".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use base64::Engine;

    fn data_url(path: &str) -> String {
        let bytes = std::fs::read(path).unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    #[ignore = "requires OCR_TEST_IMAGE and macOS Vision"]
    fn native_vision_recognizes_chinese_data_url() {
        let path = std::env::var("OCR_TEST_IMAGE").expect("OCR_TEST_IMAGE is required");
        let text = super::recognize_image(data_url(&path)).unwrap();
        assert!(text.contains("信息化"), "unexpected OCR output: {text}");
    }

    #[test]
    #[ignore = "requires OCR_PAGE_TEST_IMAGE and macOS Vision"]
    fn native_vision_returns_line_geometry() {
        let path = std::env::var("OCR_PAGE_TEST_IMAGE").expect("OCR_PAGE_TEST_IMAGE is required");
        let started = std::time::Instant::now();
        let lines = super::recognize_lines(data_url(&path)).unwrap();
        println!("recognized {} lines in {:?}", lines.len(), started.elapsed());
        for line in &lines {
            println!(
                "  [{:.3}, {:.3}, {:.3}, {:.3}] conf={:.2} {}",
                line.x, line.y, line.width, line.height, line.confidence, line.text
            );
        }
        assert!(lines.len() >= 2, "expected multiple lines, got {lines:?}");
        assert!(lines.iter().all(|line| line.width > 0.0
            && line.height > 0.0
            && line.x >= 0.0
            && line.y >= 0.0
            && line.x + line.width <= 1.001
            && line.y + line.height <= 1.001));
    }
}
