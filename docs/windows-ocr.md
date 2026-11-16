# Windows OCR 引擎选型评估

评估版本：0.49.0（macOS-only）
目标版本：0.50.0 起支持 Windows
结论：**macOS 继续独占 Apple Vision；Windows 首选系统内置 WinRT OCR，暂不引入 ONNX。**

## 结论速览

| 方案 | 分发体积 | 中文印刷体 | 单页耗时 | 外部依赖 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Windows.Media.Ocr（WinRT） | **0** | 中（印刷体可用，低质扫描偏弱） | 30–80ms | 系统中文语言包 | **首选** |
| PaddleOCR / RapidOCR（ONNX） | +30–50MB | 高 | 100–400ms | onnxruntime | 备选，暂缓 |
| 微信 OCR（WeChatOCR.exe / wxocr.dll） | 0 | 很高 | 快 | 用户须装微信 | 排除 |
| Tesseract | +60MB+ | 低 | 中 | — | 排除（0.8.0 已移除） |
| 云端 OCR | 0 | 很高 | 500ms+ | 网络 | 排除（违反离线红线） |

一句话理由：WinRT OCR 与 Apple Vision 在架构上是同构的——**系统自带、零分发、本地推理、毫秒级**。项目在 0.8.0 已经用「移除 Tesseract、只留系统引擎」证明过这条路线可行，不该在 Windows 上退回打包模型。

## 一、现有实现的事实约束

改造必须守住这些既有契约，否则文字层、缓存、备份三条链路会同时出问题。

| 事实 | 位置 | 对选型的影响 |
| --- | --- | --- |
| 引擎只在 Rust 侧，前端只有 `ocr_image` / `ocr_page_lines` 两个命令 | `src-tauri/src/ocr.rs`、`commands.rs:134,142` | 换引擎不影响前端交互，改一个文件即可 |
| 坐标契约：**归一化 0..1、左上原点**，`OcrLinePayload { text, x, y, w, h, confidence }` | `ocr.rs:12` | 任何新引擎都必须把像素坐标除以宽高 |
| `confidence` 前端不参与逻辑，只在解析时 `?? 0` 兜底 | `pageText.ts:98` | WinRT 不返回置信度**不阻塞**，填 0 即可 |
| 输入图：屏幕 canvas → 长边缩到 1600 → JPEG 0.9 → data URL | `PdfPage.tsx:275-287`、`renderPageImage()` | 这是质量的真实上限，比引擎选择更影响结果 |
| 缓存三级：内存 LRU 64 页 → SQLite `page_ocr(engine)` → 引擎；全局并发 2 | `pageText.ts:111-150` | 引擎名要写进 `engine` 列 |
| `page_ocr` 是派生表，无外键，merge 导入跳过、overwrite 恢复 | `docs/ocr.md:39` | 跨平台导入不会带进别的引擎的缓存（overwrite 会带） |
| 前端跑在 WebView2（Chromium），pdf.js 用 legacy 构建 | `tauri.conf.json` | legacy 构建在 Chromium 上向下兼容，无需切换 |

关键推论：**`ocr.rs` 是整个 Windows 适配的唯一硬耦合点**。`rightkit-ocr` 已经用 `cfg(target_os = "macos")` 隔离好，其余 crate（`image`、`rusqlite`、`tauri`）都是跨平台的。

## 二、候选方案逐项评估

### 2.1 Windows.Media.Ocr（WinRT）—— 首选

系统组件，Win10 1803 起提供，中文版 Windows 默认带 `zh-Hans` OCR。

**优点**
- 零分发体积、零模型管理，与 Vision 同构
- 极快：1600px 印刷体页面 30–80ms，比 Vision 快（Vision 在密集页要 1–3 秒）
- 返回行 + 词级 `BoundingRect`，足够重建文字层
- 纯 Rust 调用（`windows` crate），不需要 C++ 工具链或额外 dll
- 与 Tauri 的 Windows 构建天然兼容

**缺点与风险**

| 风险 | 缓解 |
| --- | --- |
| 中文质量弱于 Vision，低质量扫描/拍照更明显 | 先提高输入分辨率 + 分块（见第四节），实测后再决定是否上 ONNX |
| 非中文系统没有 `zh-Hans` OCR 语言包 | 用静态方法 `OcrEngine.IsLanguageSupported(Language)` 探测（比枚举 `AvailableRecognizerLanguages()` 属性更直接），缺失时给明确的安装引导（设置 → 时间和语言 → 语言 → 中文(简体) → 语言功能 → 光学字符识别） |
| 不返回 confidence | 契约允许填 0；质量兜底靠既有的 `looksLikeMathFormula()` 与「识别为空则建图像摘录卡」 |
| `OcrEngine` 是 COM 对象，未初始化 apartment 直接报 `CO_E_NOTINITIALIZED` | 命令入口处 `windows::core::initialize_mta()` 幂等调用一次 |
| `MaxImageDimension` 上限（属性，通常 10000px） | 输入已被 1600 限制，天然满足 |

### 2.2 PaddleOCR / RapidOCR（ONNX Runtime）—— 备选

**优点**：中文质量最好，PP-OCRv5 mobile 对扫描件、繁体、竖排都明显强于系统 OCR；模型 Apache-2.0 可商用；行为跨平台一致（同一套代码 macOS 也能跑，便于对照）。

**代价**
- 体积：det ~4.7MB + rec ~10MB + 字典，加 onnxruntime 动态库 15–30MB，**app 从 22MiB 涨到 55–70MiB**，DMG 翻倍。项目对体积一贯敏感（0.8.0 刚删掉 63MB 的 Tesseract 模型），这与既有取舍冲突。
- 工程量：DB 检测后处理（框解码 + 透视变换）+ CTC 解码 + 文本行排序，Rust 侧 400–600 行，还要处理模型加载失败、dll 缺失的分发问题。**至少是 WinRT 方案的 10 倍工作量。**
- 生态：`ort` 成熟，但 PaddleOCR 的 Rust 封装（`paddleocr` / `rapidocr` 类 crate）质量参差，大概率要自己写前后处理。

**判定**：不在第一版引入。等 WinRT 的真实样本评测结果出来再决定。

### 2.3 微信 OCR —— 排除

技术上一流（就是上一个问题里分析的那套常驻引擎），但对本项目不可用：

- 依赖用户本机安装微信，且路径随版本漂移（`WeChatOCR.exe` 3.x → `wxocr.dll` 4.0，目录名含 build 号）
- 需要 `mmmojo.dll` 与之通信，等于调用第三方闭源组件的未公开接口
- 分发与商用存在明确法务风险，属于「能跑但不能发」的范畴
- 无法保证跨版本稳定，用户升级微信就可能失效

仅可作为开发期**质量对照基线**（用它对同一批样本打分，衡量 WinRT 差多少），不进产品。

### 2.4 Tesseract —— 排除

中文准确率明显低于另外三种，且 0.8.0 刚刚移除（`chi_sim` + `eng` 离线模型 63MB），回退等于把删掉的包袱重新背上。

### 2.5 云端 OCR —— 排除

与项目红线正面冲突：`docs/ocr.md` 明确「OCR 文本、行坐标与摘录图都保存在本地数据库，不会上传到任何服务」。现有的 `reqwest` 通道是给「AI 解析」用的可选能力，不能挪用为 OCR 后端。

## 三、抽象层改造

现在 `ocr.rs` 用 `#[cfg(target_os)]` 在函数体内分支，加第二个平台会变成嵌套的 cfg 迷宫。改成「一个 trait + 每平台一个实现」：

```rust
// src-tauri/src/ocr/mod.rs
pub struct OcrLinePayload { /* 结构不变，保持前端契约 */ }

pub(crate) trait OcrEngine {
    /// 返回归一化 0..1、左上原点的行几何。
    fn recognize_lines(&self, image: &image::RgbImage) -> Result<Vec<OcrLinePayload>, String>;
    /// 写进 page_ocr.engine 的稳定标识，例如 "apple-vision" / "winrt-zh-hans"。
    fn engine_id(&self) -> &'static str;
    /// 引擎是否可用（缺语言包 / 缺模型时返回原因）。
    fn availability(&self) -> Result<(), String>;
}

#[cfg(target_os = "macos")] mod macos;   // rightkit-ocr::vision
#[cfg(target_os = "windows")] mod winrt; // Windows.Media.Ocr

pub fn engine() -> &'static dyn OcrEngine { /* 各平台返回单例 */ }
```

配套改动：
- `recognize_image` / `recognize_lines` 改成 `engine().recognize_lines(&decode_image(..)?)`，`decode_image` 移出 `cfg` 变公共（`image` crate 本就跨平台）。
- `OcrLinePayload` 增加 **`engine` 字段**（或新增 `engine_id` 命令），让前端把真实引擎名写进 `page_ocr.engine`，不再硬编码 `'apple-vision'`（`pageText.ts:143`）。
- `#[cfg(not(any(macos, windows)))]` 保留「不支持的平台」分支。

新文件结构：

```
src-tauri/src/ocr/
  mod.rs        # trait + payload + decode_image + 分发
  macos.rs      # rightkit_ocr::vision::recognize
  winrt.rs      # Windows.Media.Ocr
```

## 四、WinRT 实现要点（踩坑清单）

```toml
[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.6x", features = [
  "Foundation", "Globalization", "Graphics_Imaging",
  "Media_Ocr", "Security_Cryptography", "Storage_Streams",
] }
```

1. **COM apartment**：进程内首次调用前 `windows::core::initialize_mta()`（等价 `CoInitializeEx(None, COINIT_MULTITHREADED)`），否则 `TryCreateFromLanguage` 直接 `CO_E_NOTINITIALIZED`。
2. **语言选择**：先用 `OcrEngine::IsLanguageSupported(&Language::CreateLanguage(&h("zh-Hans-CN"))?)` 判断，再 `TryCreateFromLanguage`；失败退回 `TryCreateFromUserProfileLanguages()`；两者都失败时返回可读错误（提示装语言包），**不要静默降级成英文引擎**——那会把中文识别成乱码写进卡片，比报错更糟。
3. **行框要自己 union**：`OcrLine` 没有 `BoundingRect`，只有 `Words()`；行框 = 所有 `OcrWord::BoundingRect()` 的并集。直接用首词或末词的框会让文字层宽度错位。
4. **坐标换算**：WinRT 给的是像素、左上原点；除以 `bitmap.PixelWidth/PixelHeight` 就是契约要的归一化值。注意 `Rect` 的字段是 f32。
5. **位图格式**：`SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, w, h)` + `CryptographicBuffer::CreateFromByteArray(&bytes)` 填 `IBuffer`。`image` crate 的 `RgbImage` 要手动转 BGRA8（每像素补 alpha=255）。
6. **无置信度**：`confidence` 填 `0.0`。前端已兜底，不要伪造 0.99。
7. **倾斜页**：`OcrResult::TextAngle()` 可拿到整页角度，先记录，暂不参与渲染（Vision 路径也没有）。
8. **线程**：`RecognizeAsync(...).get()` 是阻塞的；`ocr_page_lines` 已经是 `#[tauri::command(async)]`，跑在异步命令池，不会卡 UI。保持这个签名别改成同步命令。

## 五、质量补救（先做这三件事，再谈 ONNX）

Windows 上「识别不准」的第一嫌疑不是引擎，而是**输入图太糊**：

1. **提高 OCR 输入分辨率**。当前 `renderPageImage()` 长边锁 1600（≈137 DPI），中文 10pt 正文只有约 19px 高，处在 WinRT 的识别边缘。提到 **2400 长边（≈205 DPI）**，代价是 JPEG 编码与 IPC 传输各约 2 倍，但整页 OCR 一页只做一次。实测若仍不够，可到 3000。
2. **换 PNG 或提高 JPEG 质量**。扫描件的 JPEG 0.9 振铃会在笔画交界处制造伪影，WinRT 对这类噪声比 Vision 敏感。整页 OCR 一页一次，用 PNG 的额外体积可以接受。
3. **分块识别**。把整页按 2×2 切开分别识别，再按块偏移合并坐标。小图在 WinRT 上的字高更充分，密集排版页提升明显。缺点是要处理跨块断行（按 y 中心聚类合并）。

这三项都在前端 + Rust 预处理层完成，不引入新依赖，**做完再评分**。如果 2400px + PNG + 分块后仍与 Vision 差一档，再走 ONNX。

## 六、顺手要修的三个既有问题

这三个在 macOS 上已经存在，Windows 会放大它们。

### 6.1 `engine` 列写了不读

`ensurePageLines` 硬编码写入 `'apple-vision'`，而读取时（`pageText.ts:130`）只校验 JSON 结构，不比较 engine。后果：把 Mac 的备份 overwrite 到 Windows 后，Windows 会沿用 Vision 的行坐标。坐标是归一化的，**不会错位**，但用户无法通过「重新识别」改善那些 Vision 也没识别好的页。建议：读缓存时比对当前引擎 id，不匹配则后台重识别并覆盖，UI 不阻塞。

### 6.2 OCR 输入依赖当前 zoom

`renderPageImage()` 取的是**屏幕 canvas 的当前像素尺寸**再缩到 1600。若用户在 50% 缩放下打开扫描页，canvas 可能只有 1000px 宽，`Math.min(1, 1600/1000)` 不生效，OCR 输入就是 1000px（≈86 DPI），**而结果按 `(documentId, page)` 永久缓存**。Windows 上 `devicePixelRatio` 常见 1.0–1.25（Mac Retina 是 2.0），同样缩放下分辨率再低一半，这个问题会更明显。

修法：整页 OCR 不走屏幕 canvas，而是临时用固定 viewport（`page.getViewport({ scale: 2400 / maxDimension })`）离屏渲染一张，与用户缩放解耦。

### 6.3 `toDataURL` 在主线程 + base64 膨胀

`canvas.toDataURL('image/jpeg', 0.9)` 同步执行，2400px 页面约 80–200ms 卡主线程；base64 又让 IPC 载荷涨 33%。可改为 `canvas.toBlob()` → `arrayBuffer()`，Tauri 2 支持直接传 `Uint8Array`（`image_data: Vec<u8>`），Rust 侧省掉 base64 解码。这与上个问题的「随点随识别」是同一件事。

## 七、若最终必须上 ONNX

前提：第五节的补救全部做完，真实样本集上 WinRT 的中文准确率仍比 Vision 低 15% 以上。

执行要点：
- 模型选 **PP-OCRv5 mobile**（det+rec），int8 量化，总计 ~15MB
- 运行时用 `ort`（可静态链接 onnxruntime，避免分发 dll 问题）；`build` 加 `download-binaries` 特征
- 前后处理自己写：DB 后处理（阈值 0.3 → 轮廓 → unclip → 透视校正）+ CTC 贪心解码
- 分发策略：模型作为 Tauri `resources` 打包，启动时懒加载（首次 OCR 才 mmap），避免拖慢冷启动
- 体积预算：app 22MiB → 约 60MiB，需要重新评估 DMG 与用户下载体验

这一档的成本与 WinRT 不是一个量级，**没有评测数据前不要开工**。

## 八、验收

建立跨平台对照样本集（放 `test-fixtures/ocr/`，不进 dist）：

| 样本 | 说明 | 指标 |
| --- | --- | --- |
| `dense-cn.png` | 中文教材正文页，2400px | 字符准确率（CER）、行框 IoU |
| `scan-low.png` | 600dpi 扫描后降质、有噪点 | CER、空结果率 |
| `photo.png` | 手机拍书，透视畸变 | CER（预期最差，可接受） |
| `table.png` | 三线表 | 单元格文本是否串行 |
| `vertical.png` | 竖排古籍页 | 仅记录，不作门槛 |

流程：
1. Vision（当前基线）跑一遍，记录 CER 与耗时
2. WinRT 在 1600 / 2400 / 2400+分块 三档各跑一遍
3. 决策门槛：**CER 相对 Vision 退化 < 10% 且空结果率 < 5%** → 采用 WinRT 收工；否则进入 ONNX 评估

Rust 侧集成测试沿用现有写法（`ocr.rs:91` 的 `#[cfg(all(test, target_os))]`），改为两个平台各一组：

```rust
#[test] fn recognizes_chinese_line_and_geometry()  // 断言含「信息化」、坐标全在 0..1
#[test] fn reports_unavailable_when_language_missing()  // 断言返回可读错误而非乱码
```

## 九、实施顺序

| 步骤 | 内容 | 前置 |
| --- | --- | --- |
| 1 | 拆 `ocr.rs` 成 `ocr/` 模块 + trait，macOS 行为不变（纯重构） | 无 |
| 2 | `OcrLinePayload` 带 `engine` 字段，前端写真实 engine id，读缓存时校验 | 1 |
| 3 | 修 6.2 / 6.3（离屏固定分辨率 + toBlob 传二进制） | 1 |
| 4 | 实现 `winrt.rs`，用 6 个样本跑评测 | 3 |
| 5 | 语言包探测 + 设置页引导 | 4 |
| 6 | 达标则收工；不达标再评估 ONNX | 4 |

第 1–3 步在 macOS 上就能完成并验证（回归脚本 `STEP=textlayer`），不依赖 Windows 机器。真正需要 Windows 环境的只有第 4 步之后。
