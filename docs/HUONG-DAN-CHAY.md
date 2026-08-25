# Hướng Dẫn Chạy MangaTranslator Extension (tự chạy trên máy của bạn)

Hướng dẫn này tập trung vào **cách cài đặt và chạy** dự án trên máy bạn (đã kiểm chứng trên macOS). Xem [README.vi.md](README.vi.md) nếu muốn đọc giới thiệu đầy đủ về tính năng.

## 1. Yêu cầu

- macOS (khuyến nghị Apple Silicon để tận dụng tăng tốc GPU qua MPS)
- Python 3.10 trở lên
- Node.js + npm
- Trình duyệt Chrome hoặc Edge

## 2. Cài đặt backend (chỉ làm 1 lần)

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -e .
```

Lần cài đầu tiên sẽ tải khá nhiều package nặng (torch, ultralytics, transformers, diffusers...) — có thể mất vài phút và vài GB dung lượng, tuỳ tốc độ mạng.

## 3. Chạy backend

```bash
cd backend
./.venv/bin/python main.py
```

Backend chạy ở `http://localhost:7677`. **Lần chạy đầu tiên** sẽ tự tải các model AI cần thiết (model phát hiện bong bóng thoại YOLO, manga-ocr, upscaler...) trực tiếp từ Hugging Face — cần có internet, mất khoảng 1-2 phút. Các lần chạy sau sẽ nhanh hơn nhiều vì model đã được cache trong `backend/models/`.

Kiểm tra backend đã sẵn sàng: mở `http://localhost:7677/health` trên trình duyệt, hoặc chạy:

```bash
curl http://localhost:7677/health
```

Kết quả mong đợi: `{"status":"ok", ...}`.

## 4. Build extension

```bash
cd extension
npm install
npm run build
```

Kết quả build nằm ở `extension/dist/`.

## 5. Load extension vào Chrome/Edge

1. Mở `chrome://extensions/` (dán thẳng vào thanh địa chỉ).
2. Bật **Developer mode** (công tắc góc trên bên phải).
3. Bấm nút **Load unpacked** vừa hiện ra, chọn thư mục `extension/dist/`.

## 6. Cấu hình LLM

Bấm icon extension trên thanh công cụ → tab **LLM Config**:

- **Provider**: chọn nhà cung cấp bạn dùng — Google, OpenAI, Azure OpenAI, Anthropic, xAI, DeepSeek, Z.ai, Moonshot AI, OpenRouter, hoặc endpoint tương thích OpenAI.
- **Base URL** / **Model**: tuỳ provider — riêng **Azure OpenAI** hỗ trợ cả 2 kiểu:
  - Kiểu deployment cổ điển: dán URL dạng `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=...`
  - Kiểu Azure AI Foundry v1: dán URL dạng `https://<resource>.services.ai.azure.com/api/projects/<project>/openai/v1/responses`
  - Extension tự nhận diện kiểu URL và tự tách đúng deployment/api-version, bạn không cần tự cắt.
- **API Key**: key thật của provider.
- **Reasoning Effort** (tuỳ chọn, chỉ áp dụng với model có khả năng suy luận như GPT-5/dòng o, Gemini 3, Claude 4.x): hạ xuống **Minimal** hoặc **Low** nếu thấy dịch chậm — model reasoning mặc định có thể mất 45-85 giây/trang, hạ mức này giúp nhanh hơn đáng kể (đánh đổi: kém "cẩn thận" hơn một chút).
- Bấm **Save LLM Settings**.

Thay vì nhập key trong popup, bạn cũng có thể set biến môi trường trước khi chạy backend, ví dụ:

```bash
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
export AZURE_OPENAI_API_KEY="..."
export GOOGLE_API_KEY="..."
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
```

## 7. Dùng thử

Mở một trang truyện → bấm icon extension → chọn ngôn ngữ Source/Target ở tab **Translate** → bấm:

- **Scan & Translate Page**: quét và cho bạn chọn thủ công ảnh cần dịch.
- **Auto-translate**: tự động dịch khi bạn cuộn trang.

Tab **Translate** còn có 2 tuỳ chọn:

- **Outside text**: nhận diện và dịch cả SFX/lời dẫn/caption nằm ngoài bong bóng thoại.
- **Pre-translate** (mặc định tắt): dịch trang ngay khi vừa tải xong thay vì đợi bạn cuộn tới gần — hữu ích khi hay bị chậm lúc mới sang chương mới. Giới hạn cứng tối đa 15 trang dịch cùng lúc để tránh tốn quá nhiều lượt gọi API.

## Xử lý sự cố thường gặp

| Vấn đề | Cách xử lý |
| --- | --- |
| Popup báo "Backend Offline" | Kiểm tra backend đang chạy (`./.venv/bin/python main.py`) và Backend URL ở tab Config khớp `http://localhost:7677`. |
| Không tìm thấy ảnh trên trang | Đợi trang tải xong hẳn rồi quét lại — một số site lazy-load ảnh khi cuộn. |
| Lỗi provider/model | Kiểm tra lại API key, Base URL, tên model/deployment. |
| Dịch chậm (nhiều chục giây/trang) | Hạ **Reasoning Effort** xuống Minimal/Low, hoặc đổi sang model không-reasoning (vd `gpt-4o-mini`) thay vì model dòng GPT-5/o-series. |
| Sang chương mới bị chậm hơn hẳn | Bật **Pre-translate** ở tab Translate. |

## Dừng / chạy lại backend

```bash
# Tìm tiến trình đang chạy
ps aux | grep main.py

# Dừng (thay <PID> bằng số tiến trình tìm được ở trên)
kill <PID>

# Chạy lại
cd backend && ./.venv/bin/python main.py
```
