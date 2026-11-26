//! 极简 PDF 写入器：把手写本页面（JPEG）按 A4 逐页嵌入。
//!
//! 不引入 printpdf 之类的大依赖：只需要「每页一张图」这一种结构，
//! 手写 PDF 语法（Catalog / Pages / Page / XObject + xref）比适配一个库更可控，
//! 也避免为新依赖增加编译时间与体积。

pub struct PdfImagePage {
    pub width: u32,
    pub height: u32,
    /// JPEG 原始字节（DCTDecode 可直接嵌入，不需要重新编码）。
    pub jpeg: Vec<u8>,
}

const A4_WIDTH: f64 = 595.28;
const A4_HEIGHT: f64 = 841.89;

/// 拼出完整 PDF 字节。页序就是传入顺序。
pub fn build_pdf(pages: &[PdfImagePage]) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("没有可导出的页面".into());
    }
    for page in pages {
        if page.width == 0 || page.height == 0 {
            return Err("页面尺寸不合法".into());
        }
        if page.jpeg.len() < 4 || page.jpeg[0..2] != [0xFF, 0xD8] {
            return Err("页面图片不是 JPEG".into());
        }
    }

    let page_count = pages.len();
    // 1 = Catalog，2 = Pages，之后每页 3 个对象：Page / Contents / Image。
    let object_count = 2 + page_count * 3;
    let mut out: Vec<u8> = Vec::with_capacity(page_count * 120_000);
    let mut offsets: Vec<usize> = vec![0; object_count + 1];

    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let begin_object = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, number: usize, body: &str| {
        offsets[number] = out.len();
        out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
    };

    begin_object(&mut out, &mut offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>");

    let kids: Vec<String> = (0..page_count).map(|index| format!("{} 0 R", 3 + index * 3)).collect();
    begin_object(
        &mut out,
        &mut offsets,
        2,
        &format!("<< /Type /Pages /Kids [{}] /Count {page_count} >>", kids.join(" ")),
    );

    for (index, page) in pages.iter().enumerate() {
        let page_number = 3 + index * 3;
        let content_number = page_number + 1;
        let image_number = page_number + 2;

        begin_object(
            &mut out,
            &mut offsets,
            page_number,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {A4_WIDTH} {A4_HEIGHT}] \
                 /Resources << /XObject << /Im0 {image_number} 0 R >> >> \
                 /Contents {content_number} 0 R >>"
            ),
        );

        let content = format!("q {A4_WIDTH} 0 0 {A4_HEIGHT} 0 0 cm /Im0 Do Q");
        begin_object(
            &mut out,
            &mut offsets,
            content_number,
            &format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        );

        // 图片流是二进制：单独写 header / 数据 / endstream，Length 用原始字节数。
        offsets[image_number] = out.len();
        out.extend_from_slice(
            format!(
                "{image_number} 0 obj\n<< /Type /XObject /Subtype /Image /Width {} /Height {} \
                 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
                page.width,
                page.height,
                page.jpeg.len()
            )
            .as_bytes(),
        );
        out.extend_from_slice(&page.jpeg);
        out.extend_from_slice(b"\nendstream\nendobj\n");
    }

    let xref_offset = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", object_count + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for number in 1..=object_count {
        out.extend_from_slice(format!("{:010} 00000 n \n", offsets[number]).as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            object_count + 1
        )
        .as_bytes(),
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{build_pdf, PdfImagePage};

    /// 1×1 白色 JPEG，够通过 JPEG 头校验与结构测试。
    const TINY_JPEG: &[u8] = &[
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00,
        0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
        0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B,
        0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
        0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30, 0x31,
        0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF,
        0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00,
        0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x09, 0xFF, 0xC4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xDA, 0x00, 0x08, 0x01,
        0x01, 0x00, 0x00, 0x3F, 0x00, 0x2A, 0x9F, 0xFF, 0xD9,
    ];

    fn page() -> PdfImagePage {
        PdfImagePage { width: 1, height: 1, jpeg: TINY_JPEG.to_vec() }
    }

    #[test]
    fn builds_pages_and_valid_xref() {
        let bytes = build_pdf(&[page(), page()]).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.contains("/Count 2"));
        assert_eq!(text.matches("/Type /Page ").count(), 2);
        assert_eq!(text.matches("/Subtype /Image").count(), 2);
        assert!(text.trim_end().ends_with("%%EOF"));

        // xref 里的偏移按字节算，测试也必须用字节切片（PDF 里含二进制 JPEG）。
        let marker = b"xref\n0 ";
        let xref_start = bytes.windows(marker.len()).position(|window| window == marker).unwrap() + marker.len();
        let header_end = xref_start + bytes[xref_start..].iter().position(|byte| *byte == b'\n').unwrap();
        let total: usize = std::str::from_utf8(&bytes[xref_start..header_end]).unwrap().trim().parse().unwrap();
        assert_eq!(total, 2 + 2 * 3 + 1);
        // 每条 20 字节："0000000000 65535 f \n"，第一行是 free entry。
        let entries_start = header_end + 1 + 20;
        for number in 1..total {
            let entry = &bytes[entries_start + (number - 1) * 20..entries_start + (number - 1) * 20 + 10];
            let offset: usize = std::str::from_utf8(entry).unwrap().parse().unwrap();
            let prefix = format!("{number} 0 obj");
            assert!(bytes[offset..].starts_with(prefix.as_bytes()), "对象 {number} 偏移不对");
        }
    }

    #[test]
    fn rejects_empty_and_non_jpeg() {
        assert!(build_pdf(&[]).is_err());
        assert!(build_pdf(&[PdfImagePage { width: 1, height: 1, jpeg: b"not-jpeg".to_vec() }]).is_err());
        assert!(build_pdf(&[PdfImagePage { width: 0, height: 1, jpeg: TINY_JPEG.to_vec() }]).is_err());
    }
}
