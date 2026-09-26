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

Mỗi khi code extension được cập nhật (chạy lại `npm run build`), quay lại `chrome://extensions/` và bấm nút **reload (biểu tượng ⟳)** trên thẻ MangaTranslator để nạp bản mới — không cần Load unpacked lại từ đầu.

## 6. Cấu hình LLM

Bấm icon extension trên thanh công cụ → tab **LLM Config**:

- **Provider**: chọn nhà cung cấp bạn dùng — Google, OpenAI, Azure OpenAI, Anthropic, xAI, DeepSeek, Z.ai, Moonshot AI, OpenRouter, hoặc endpoint tương thích OpenAI.
- **Base URL** / **Model**: tuỳ provider — riêng **Azure OpenAI** hỗ trợ cả 2 kiểu:
  - Kiểu deployment cổ điển: dán URL dạng `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=...`
  - Kiểu Azure AI Foundry v1: dán URL dạng `https://<resource>.services.ai.azure.com/api/projects/<project>/openai/v1/responses`
  - Extension tự nhận diện kiểu URL và tự tách đúng deployment/api-version, bạn không cần tự cắt.
- **API Key**: key thật của provider.
- **Backup API Keys** (tuỳ chọn): mỗi dòng 1 key dự phòng, cùng provider/model với key chính ở trên — được thử lần lượt nếu key chính bị rate limit. Nhập key trùng nhau (kể cả trùng với key chính) sẽ có cảnh báo màu đỏ ngay dưới ô.
- **Fallback Providers** (tuỳ chọn): bấm "+ Add fallback provider" để thêm provider dự phòng (mỗi cái có provider/model/API key/base URL riêng) — chỉ được dùng đến khi key chính và toàn bộ Backup API Keys ở trên đều đã bị rate limit, thử lần lượt theo đúng thứ tự trong danh sách.
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

### Dùng LLM chạy trên máy (Ollama / LM Studio) — miễn phí, offline

Mặc định cần model **nhìn được ảnh** (vd. `qwen2.5vl:7b`, `gemma3:12b`). Nếu chỉ có model chữ, đặt tab **Translate** → **Cách đọc chữ** thành `manga-ocr` (chỉ tiếng Nhật) hoặc `PaddleOCR-VL` — chữ được đọc trên máy trước rồi chỉ gửi văn bản cho model.

```bash
# Ollama: cài từ https://ollama.com rồi
ollama pull qwen2.5vl:7b
OLLAMA_CONTEXT_LENGTH=16384 ollama serve   # context lớn để chứa nhiều ảnh/trang (nếu Ollama chưa tự chạy)
```

Trong tab **LLM Config**: Provider `OpenAI-Compatible`, Base URL `http://localhost:11434/v1` (LM Studio: `http://localhost:1234/v1`, bật server ở tab Developer), Model = tên model, **API Key: gõ chữ bất kỳ** như `ollama` (ô không được trống, server local bỏ qua nó) → bấm **Test**.

Lưu ý: Base URL do backend gọi — backend chạy trong Docker thì dùng `http://host.docker.internal:11434/v1`. Model 7-12B chạy local chậm hơn và kém hơn model cloud với chữ nhỏ/cách điệu; bật **Economy mode** để giảm số/kích cỡ ảnh gửi đi. Chi tiết: [README.vi.md](README.vi.md#llm-chạy-local-ollama--lm-studio).

## 7. Dùng thử

Mở popup extension, việc đầu tiên nhìn thấy là công tắc **Extension Enabled** ở trên cùng — đây là công tắc tổng, tắt đi thì đảm bảo **không có yêu cầu dịch nào được gửi đi** (không tốn API, không tự dịch ngoài ý muốn) bất kể bạn bấm gì bên dưới. Mặc định luôn bật; chỉ tắt khi thật sự muốn chắc chắn extension không hoạt động.

Mở một trang truyện → bấm icon extension → chọn ngôn ngữ Source/Target ở tab **Translate** (Source có tuỳ chọn **Auto-detect** nếu không chắc ngôn ngữ gốc là gì) → bấm:

- **Scan & Translate Page**: quét và cho bạn chọn thủ công ảnh cần dịch.
- **Auto-translate**: tự động dịch khi bạn cuộn trang.
- **Clear translated cache** (chữ nhỏ dưới cùng): xoá cache ảnh đã dịch lưu trên máy — dùng khi muốn dịch lại từ đầu hoặc thấy máy chậm/tốn ổ đĩa do cache tích luỹ lâu ngày.

Tab **Translate** còn có các tuỳ chọn:

- **Outside text**: nhận diện và dịch cả SFX/lời dẫn/caption nằm ngoài bong bóng thoại. Khi bật, hiện thêm ô **Inpainting quality** để chọn thuật toán xoá chữ nền: `Auto` (nhanh, OpenCV, mặc định) / `Flux Klein 4B (local GPU)` / `Flux Klein 4B (remote)` (chạy trên GPU máy khác — xem mục 8 bên dưới) / `None`.
- **Pre-translate** (mặc định tắt): dịch trang ngay khi vừa tải xong thay vì đợi bạn cuộn tới gần — hữu ích khi hay bị chậm lúc mới sang chương mới. Giới hạn cứng tối đa 15 trang dịch cùng lúc để tránh tốn quá nhiều lượt gọi API.
- **Previous-page context** (mặc định tắt): gửi kèm chữ đã dịch ở vài trang trước để giữ tên nhân vật/xưng hô nhất quán qua các trang — đổi lại tốn thêm token và chậm hơn một chút.
- **Context Memory** (mặc định tắt): model tự viết 1 câu tóm tắt mỗi trang và dùng lại ở các trang sau trong cùng truyện để nhân vật/sự kiện nhất quán — rẻ hơn Previous-page context vì không gửi kèm ảnh/toàn bộ chữ trang trước, chỉ vài câu tóm tắt ngắn.
- **Story Notes** (tuỳ chọn): ghi chú riêng cho truyện đang dịch — glossary tên riêng, văn phong mong muốn, quan hệ nhân vật cố định. Bấm nút **Suggest** để model tự soạn nháp dựa trên các trang đã quét trong Scanner, rồi bạn chỉnh sửa lại cho đúng.

- **Economy mode / Chế độ tiết kiệm** (mặc định tắt): giảm chi phí API bằng một công tắc — gửi ảnh chi tiết thấp, không gửi ngữ cảnh toàn trang và trang trước, không gửi ảnh tham chiếu Story DB, và thu nhỏ ảnh ngữ cảnh. Cài đặt riêng của bạn không bị ghi đè, tắt đi là trở lại như cũ. Context Memory vẫn giữ nguyên nếu bạn đang bật.
- **✂ Chọn vùng chữ**: nút ở tab Translate để tự khoanh một chỗ chữ. Bấm nút → popup đóng lại → kéo khung quanh chữ trên trang (Esc để huỷ) → chữ được đọc tự động → gõ bản dịch, hoặc bấm **Dịch bằng AI** → **Áp dụng**. Muốn sửa/xoá thì kéo khung lại đúng chỗ đó. Các vùng được nhớ theo từng trang và vẽ lại khi bạn dùng extension trên trang đó lần nữa (trang có địa chỉ ảnh dạng `blob:` chỉ nhớ trong phiên). Cần chạy backend bản mới nhất (có `/region/*`) — nhớ khởi động lại backend sau khi cập nhật.

Tab **LLM Config** còn có:

- **Image Detail**: `Auto` để provider tự quyết, `Low` nhanh/rẻ hơn nhưng dễ bỏ sót chữ nhỏ, `High` chính xác nhất nhưng chậm/tốn nhất.
- **Full Page Context** (mặc định bật): gửi kèm cả ảnh trang, không chỉ từng bong bóng cắt riêng — giúp model thấy được tranh vẽ/quan hệ nhân vật để dịch đúng ngữ cảnh hơn (vd chọn đúng xưng hô), đổi lại tốn thêm token mỗi lần dịch.
- **General LLM Instructions** (tuỳ chọn): chỉ dẫn chung áp dụng cho *mọi* truyện, không riêng truyện đang dịch — vd quy tắc văn phong/hành vi cố định bạn luôn muốn. Khác với Story Notes (riêng theo từng truyện, ở tab Translate).

## 8. (Tuỳ chọn) Chạy Flux từ xa trên GPU free của Kaggle

Flux Klein 4B cho kết quả xoá chữ nền sạch hơn hẳn so với `Auto` (OpenCV), nhưng cần GPU khá mạnh. Nếu máy bạn không có GPU tốt, có thể chạy Flux trên GPU free của Kaggle rồi mở tunnel để backend trên máy bạn gọi sang — không cần cài Flux hay tải model gì trên máy chính.

Đây là cùng một ý tưởng "chạy model AI nặng trên GPU free của Kaggle, tunnel ra ngoài bằng cloudflared" đã dùng cho ComfyUI ở dự án Manga-Creator, áp dụng cho worker `backend/flux_worker.py` của dự án này.

1. Vào [kaggle.com](https://kaggle.com) → Code → New Notebook → Settings bên phải → Accelerator → chọn **GPU T4 x2** (hoặc P100). Dùng **Interactive session** (không dùng "Save & Run All / Commit" — chế độ đó tự tắt máy sau khi chạy xong, không giữ server sống).

2. Trong 1 cell, clone repo và cài backend (giống hệt bước 2 ở trên, nhưng chạy trên Kaggle):

```bash
!git clone https://github.com/QuangTQV/Manga-Translator-Extension.git
%cd Manga-Translator-Extension/backend
!pip install -e . -q
```

3. Chạy worker (cell riêng — cell này sẽ chạy mãi, giữ server sống):

```bash
!python flux_worker.py --port 8189 --variant 4b
```

Lần đầu chạy sẽ tự tải model Flux Klein 4B, có thể mất vài phút.

4. Mở 1 cell/notebook khác (song song, không phải cùng cell đang chạy server ở bước 3) để mở tunnel bằng `cloudflared` (không cần tài khoản):

```python
import subprocess, time

subprocess.run(["wget", "-q", "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", "-O", "cloudflared"])
subprocess.run(["chmod", "+x", "cloudflared"])

tunnel = subprocess.Popen(
    ["./cloudflared", "tunnel", "--url", "http://localhost:8189"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
for _ in range(60):
    line = tunnel.stdout.readline()
    print(line, end="")
    if "trycloudflare.com" in line:
        break
    time.sleep(0.5)
```

Copy URL dạng `https://xxxx-xx-xx-xxx-xx.trycloudflare.com` in ra.

5. Trong extension: tab **Translate** → bật **Outside text** → **Inpainting quality** chọn `Flux Klein 4B (remote)` → dán URL cloudflared vừa lấy vào ô **Base URL** → bấm **Test Connection** (phải thấy dấu ✓) → **Save**.

Lưu ý:

- Kaggle interactive session tự tắt sau một khoảng không hoạt động, và có giới hạn giờ GPU/tuần theo tài khoản — mỗi lần notebook restart, URL cloudflared **đổi mới hoàn toàn**, phải dán lại vào popup.
- Nếu worker không phản hồi (session hết hạn, tunnel chết), MangaTranslator sẽ tự bỏ qua và **giữ nguyên chữ gốc ở vùng đó** thay vì báo lỗi cả trang dịch — không cần lo request bị treo.
- **Bảo vệ worker bằng token (khuyên dùng):** URL trycloudflare là công khai, ai biết URL đều dùng được GPU của bạn. Chạy worker với `--token mat_khau_dai` (hoặc `FLUX_WORKER_TOKEN=...`) rồi điền cùng giá trị vào ô **Token** trong popup; token gửi qua header `X-Flux-Worker-Token`, sai/thiếu token thì worker trả 401 (kể cả `/health`, nên Test Connection sẽ báo ✗).
- **Cảnh báo khi worker lỗi:** nếu worker không tới được hoặc từ chối token, trang vẫn dịch bình thường nhưng extension hiện toast cảnh báo (tối đa 1 lần/phút). Sau 2 lần lỗi liên tiếp, backend tạm ngừng gọi worker đó 60 giây (kết nối chờ tối đa 5 giây) để không bị treo từng vùng chữ — sau 60 giây nó thử lại tự động.
- Chỉ phù hợp dùng cá nhân/test; Kaggle không cam kết SLA cho server chạy liên tục.
- Muốn dùng **Flux Klein 9B** (chất lượng cao hơn, nặng hơn): chạy worker với `--variant 9b --hf-token hf_xxx` (model 9B là gated trên Hugging Face, cần token đã được cấp quyền; hoặc set biến môi trường `HF_TOKEN`), rồi chọn `Flux Klein 9B (remote)` trong popup. 9B cần nhiều VRAM hơn 4B nên GPU T4 free của Kaggle có thể không đủ.
- Có thể chạy `flux_worker.py` ngay trên máy bạn (không qua Kaggle) để test trước khi lên Kaggle thật — chỉ cần trỏ URL remote về `http://127.0.0.1:8189`.

## 9. (Tuỳ chọn) Đăng nhập & CSDL truyện (Story DB)

Tính năng CSDL truyện — nhân vật (tên/giới tính/vai trò/giọng điệu), mối quan hệ, thuật ngữ dịch cố định, ghi chú diễn biến, giữ riêng theo từng truyện — là **tuỳ chọn và cần đăng nhập**. Khác với mọi thứ ở trên, phần này cần thêm một database Postgres chạy cùng backend.

1. Chạy Postgres cục bộ bằng Docker (chỉ cần làm 1 lần, container giữ dữ liệu lâu dài):

```bash
cd backend
docker compose up -d
```

2. Set biến môi trường trước khi chạy backend:

```bash
export MT_DATABASE_URL="postgresql+psycopg2://manga_translator:manga_translator@localhost:5432/manga_translator"
```

3. Chạy lại backend (`./.venv/bin/python main.py`) như bình thường. **Không cần bật `MT_REQUIRE_AUTH`** — đăng nhập ở đây chỉ để dùng CSDL truyện, không bắt buộc cả backend phải yêu cầu tài khoản cho mọi yêu cầu dịch.
4. Mở popup → tab **Account** → đăng nhập bằng email (nút Register) hoặc Google.
5. Sang tab **Story DB** → bấm **+ Create** để tạo 1 truyện → nhập nhân vật/mối quan hệ/thuật ngữ/ghi chú diễn biến → bấm **Save story**. Truyện đang chọn sẽ tự động được dùng khi bạn dịch trang.
6. Phía trên danh sách nhân vật có **Sơ đồ quan hệ**: kéo nhân vật để sắp xếp (vị trí được lưu khi bấm **Save story**), bấm một nhân vật để làm nổi bật quan hệ của họ, bấm **🔗 Connect** rồi bấm hai nhân vật để tạo quan hệ, bấm nhãn trên đường nối để sửa. Mỗi nhân vật có thể có **ảnh đại diện** (👤, chỉ để nhìn) và tối đa 2 **ảnh tham chiếu** (🖼, character sheet). Ảnh tham chiếu chỉ được gửi cho AI khi bạn bật công tắc **Gửi ảnh tham chiếu cho AI** (tốn thêm token, cần OCR bằng LLM).
7. Ngay phía trên danh sách nhân vật còn có ô **Cập nhật từ diễn biến mới**: gõ mô tả điều vừa xảy ra trong truyện (vd: "Chương 39, kẻ thù hoá ra là Hina, bạn thân thuở nhỏ của Akira, nên hai người chuyển sang xưng hô ta/ngươi thay vì tớ/cậu") rồi bấm **✨ Update from description** — AI tự soạn sẵn nhân vật/mối quan hệ mới hoặc cần sửa, và một ghi chú diễn biến, ngay trong form để bạn xem lại. Chưa lưu gì cả cho tới khi bạn tự bấm **Save story**. Bật thêm công tắc **Tìm kiếm trên mạng cho truyện này** nếu muốn AI tự tra cứu (dùng tên truyện ở ô "Story name" phía trên) và bổ sung diễn biến đến đúng điểm bạn mô tả — khác với Suggest Notes (luôn tránh spoiler), tính năng này được phép tiết lộ nội dung vì mục đích chính là theo dõi diễn biến truyện.

## 10. (Tuỳ chọn) Live AI — log input/output của mọi lệnh gọi AI

Công cụ debug: ghi lại prompt gửi đi và response nhận về của mọi lệnh gọi tới LLM (mọi provider, mọi tính năng dịch/suggest/test key). Mặc định tắt, không ảnh hưởng gì nếu không bật.

```bash
export MT_LIVE_AI_LOG_ENABLED=true
```

Xem các lệnh gọi gần nhất qua API (không cần đăng nhập nếu chưa bật `MT_REQUIRE_AUTH`):

```bash
curl http://localhost:7677/admin/live-ai-log
```

Log cũng được ghi ra file `backend/logs/live_ai.jsonl` — không lưu ảnh (chỉ ghi số lượng ảnh + KB ước tính), chỉ lưu phần text.

## 11. (Tuỳ chọn) Web App — dịch file ảnh có sẵn trên máy, không cần extension

Dùng khi bạn có sẵn file ảnh (raw scan chưa từng đăng lên trang web nào) và muốn dịch trực tiếp, không cần mở trang web nào chứa ảnh đó cả — extension chỉ dịch được ảnh đã có sẵn trong 1 trang web đang mở.

1. Chạy backend như bình thường (`./.venv/bin/python main.py`).
2. Mở trình duyệt bất kỳ, vào `http://localhost:7677/app`.
3. Điền Provider / Model / API Key / ngôn ngữ nguồn-đích ở cột bên trái (lưu ngay trong trình duyệt đó, tách biệt với settings của extension).
4. Kéo-thả file ảnh vào khung, hoặc bấm vào khung để chọn file.
5. Bấm **Translate All**.
6. Bấm **Export ZIP** hoặc **Export CBZ** để tải kết quả về.

Trang này cố tình tối giản — không có Story DB, không xoay vòng nhiều key, không có công cụ khoanh vùng/bút tẩy/chỉnh font. Cần đầy đủ tính năng thì dùng extension như hướng dẫn ở trên.

## Xử lý sự cố thường gặp

| Vấn đề | Cách xử lý |
| --- | --- |
| Popup báo "Backend Offline" | Kiểm tra backend đang chạy (`./.venv/bin/python main.py`) và Backend URL ở tab Config khớp `http://localhost:7677`. |
| Không tìm thấy ảnh trên trang | Đợi trang tải xong hẳn rồi quét lại — một số site lazy-load ảnh khi cuộn. |
| Lỗi provider/model | Kiểm tra lại API key, Base URL, tên model/deployment. |
| Dịch chậm (nhiều chục giây/trang) | Hạ **Reasoning Effort** xuống Minimal/Low, hoặc đổi sang model không-reasoning (vd `gpt-4o-mini`) thay vì model dòng GPT-5/o-series. |
| Sang chương mới bị chậm hơn hẳn | Bật **Pre-translate** ở tab Translate. |
| Bấm dịch mà không thấy gì xảy ra | Kiểm tra công tắc **Extension Enabled** ở đầu popup có đang tắt không. |

## Dừng / chạy lại backend

```bash
# Tìm tiến trình đang chạy
ps aux | grep main.py

# Dừng (thay <PID> bằng số tiến trình tìm được ở trên)
kill <PID>

# Chạy lại
cd backend && ./.venv/bin/python main.py
```
