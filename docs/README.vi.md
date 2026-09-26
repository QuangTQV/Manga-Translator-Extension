<h1 align="center">MangaTranslator Extension</h1>

<p align="center">
  Dịch manga trực tiếp trong trình duyệt bằng backend FastAPI cục bộ, chế độ tự động dịch, giao diện đa ngôn ngữ và Flux inpainting tùy chọn.
</p>

<p align="center">
  <a href="../README.md">English</a>
  ·
  <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-backend-009688">
  <img alt="Windows portable" src="https://img.shields.io/badge/Windows-portable-0078D4">
  <img alt="Release" src="https://img.shields.io/github/v/release/QuangTQV/Manga-Translator-Extension?label=release">
</p>

<p align="center">
  <a href="#showcase">Showcase</a>
  ·
  <a href="#tổng-quan">Tổng Quan</a>
  ·
  <a href="#tính-năng">Tính Năng</a>
  ·
  <a href="#tải-xuống">Tải Xuống</a>
  ·
  <a href="#bắt-đầu-nhanh">Bắt Đầu Nhanh</a>
  ·
  <a href="#cấu-hình">Cấu Hình</a>
  ·
  <a href="#flux-tùy-chọn">Flux Tùy Chọn</a>
  ·
  <a href="#web-app-không-cần-cài-extension">Web App</a>
</p>

<p align="center">
  <img src="assets/mangatranslator-hero.png" alt="MangaTranslator Extension banner" width="100%">
</p>

## Showcase

MangaTranslator Extension được tạo cho người đọc muốn đọc truyện liền mạch, không phải copy từng câu sang công cụ khác. Chỉ mở một chapter, quét trang, chọn ảnh cần dịch, và để LLM hoàn thành việc còn lại.

| Popup điều khiển | Trình quét trang |
| --- | --- |
| <img src="assets/popup-preview.png" alt="Popup MangaTranslator Extension" width="390"><br><br><img src="assets/popup-actions-preview.png" alt="Các nút trong popup: quét và dịch trang, chọn vùng chữ, xoá vùng chữ, tự động dịch" width="390"> | <img src="assets/scanner-preview.png" alt="Trinh quet trang MangaTranslator Extension" width="720"> |
| Ngôn ngữ nguồn/đích, CSDL truyện, chữ ngoài bubble và chất lượng xoá chữ. Header hiện trạng thái backend, nút **?** để hỏi trợ giúp và **⤢** để mở cửa sổ riêng. Bên dưới phần cài đặt là các nút quét trang, chọn vùng chữ, xoá vùng chữ và **Tự động dịch**. | Quét chapter, xem trước các trang đã phát hiện, chọn đúng ảnh cần dịch và dịch hàng loạt. |

### Kết Quả Dịch

| Trang gốc | Trang đã dịch |
| --- | --- |
| <img src="assets/manga-before.png" alt="Trang manga tiếng Nhật gốc" width="420"> | <img src="assets/manga-after.png" alt="Trang manga đã dịch và render lại vào ảnh" width="420"> |

- Sử dụng LLM của bạn: cấu hình provider, API key, model và endpoint mà bạn dùng.
- Đọc nhanh hơn với auto-translate: ảnh được dịch khi bạn cuộn trang, kèm dịch trước các trang sắp tới.
- Giữ cảm giác manga: chữ gốc được xóa và chữ dịch được render lại vào ảnh.
- Dịch cả ngoài bubble: hỗ trợ SFX, lời dẫn, caption và các đoạn chữ nằm ngoài bóng thoại.
- Nhẹ hơn theo mặc định: Flux Klein 4B là tùy chọn, nên người dùng thông thường không phải tải một gói quá nặng.

### Tự Động Dịch Khi Đọc

<img src="assets/auto-translate-preview.png" alt="Trình đọc manga đang tự động dịch: trang đầu đã dịch với một bóng thoại được phóng to kèm chữ gốc tiếng Nhật, trang sau vẫn đang dịch" width="560">

Bấm **Tự động dịch** trong popup (hoặc nhấn **Alt+Shift+A**, trên Mac là **⌘+Shift+A**) rồi cứ đọc bình thường. Trang được dịch khi hiện ra trên màn hình, kèm dịch trước vài trang phía sau, nên thường trang kế tiếp đã dịch xong trước khi bạn cuộn tới.

- **Nhãn xanh dương `•••`**: trang đang được dịch (trang bên dưới trong ảnh).
- **Nhãn xanh lá `MT`**: trang đã dịch xong. Trang lỗi 3 lần liên tiếp sẽ hiện nhãn đỏ; bấm vào để thử lại.
- **Rê chuột vào một bóng thoại** để phóng to, kèm chữ gốc bên dưới để đối chiếu bản dịch. Mỗi trang có nút chuyển qua lại giữa ảnh đã dịch và ảnh gốc.
- Khung **Auto MT** ở góc màn hình đếm số trang đã dịch; bấm **Dừng** để kết thúc.

Bật **Dịch trước** để dịch trang ngay khi tải xong thay vì đợi bạn cuộn tới gần (đọc nhanh hơn, tốn nhiều lượt gọi API hơn). Công tắc **Bật tiện ích** trên cùng popup tắt toàn bộ, nên không có request nào được gửi đi bất ngờ.

### CSDL Truyện Và Trợ Giúp

| CSDL truyện | Trợ giúp |
| --- | --- |
| <img src="assets/story-db-preview.png" alt="Tab CSDL truyện với sơ đồ quan hệ và danh sách nhân vật" width="390"> | <img src="assets/help-chat-preview.png" alt="Khung trợ giúp trả lời cách để bản dịch hay hơn" width="390"> |
| Lưu nhân vật, mối quan hệ và thuật ngữ dịch cố định của một truyện ở một chỗ, để tên và xưng hô nhất quán qua từng chương. Kéo nhân vật trên sơ đồ quan hệ, hoặc dùng **Nối** để nối hai nhân vật. | Bấm **?** trong popup và hỏi cách cài đặt một thứ gì đó. Câu trả lời đến từ chính LLM của bạn, dựa trên tài liệu của dự án. |

### Sửa Chỗ Auto-Translate Bỏ Sót

<img src="assets/manual-region-preview.png" alt="Công cụ vùng chữ thủ công dịch một hiệu ứng âm thanh chưa được dịch" width="560">

Auto-translate đã bỏ sót hiệu ứng âm thanh "ピンポーン". Bấm **✂ Chọn vùng chữ**, kéo khung quanh chỗ đó, chữ sẽ được đọc tự động. Tự gõ bản dịch hoặc bấm **Dịch bằng AI**, rồi **Áp dụng** để xoá chữ gốc và vẽ chữ mới vào trang. Với chữ cong hoặc chéo mà khung chữ nhật không tách gọn được, dùng **🩹 Xoá vùng chữ** để tô lên thay vào đó.

## Tổng Quan

MangaTranslator Extension là bộ extension + backend portable để dịch trang manga/comic. Extension trong trình duyệt quét ảnh trên tab hiện tại, gửi ảnh đến backend cục bộ, rồi thay hoặc hiển thị bản dịch đã render. Backend chạy trên máy của bạn, nên extension không cần gửi ảnh manga qua một máy chủ extension bên thứ ba.

Extension sử dụng LLM, API key, model và Base URL do bạn cung cấp. Bạn có thể kết nối Google, OpenAI, Anthropic, OpenRouter, DeepSeek, xAI, Z.ai, Moonshot AI hoặc bất kỳ endpoint OpenAI-compatible nào, sau đó giữ toàn bộ workflow dịch ngay trong trình duyệt.

Cài đặt mặc định giữ nhẹ: backend tự tải model (không Flux) trong lần dùng đầu tiên, còn Flux Klein 4B là tùy chọn, chỉ cài bằng `setup.bat` khi bạn cần inpainting nặng hơn cho chữ ngoài bubble.

## Tính Năng

| Khu vực | Chức năng |
| --- | --- |
| LLM của bạn | Sử dụng provider, API key, model và Base URL do người dùng cấu hình. |
| Xoay tua provider/key | Khi bị rate limit, tự động thử lần lượt các API key dự phòng cùng provider, rồi chuyển sang các provider dự phòng đã cấu hình. Kiểu xoay tua có thể cấu hình (tuần tự/ngẫu nhiên/round-robin); ở chế độ Ngẫu nhiên, mỗi key có thể đặt trọng số riêng để tăng tỉ lệ được chọn. Thời gian cooldown của key bị rate-limit sẽ dùng header `Retry-After` thật do provider trả về nếu có, thay vì đoán cố định — nhờ đó key được thử lại đúng thời điểm. Mỗi provider/model trong danh sách cũng có thể tự đặt riêng Mức độ suy luận, không set thì dùng mặc định theo cấu hình chung. |
| Test API Key | Nút "Test" cạnh mỗi API key (và "Test tất cả key" cho từng provider) gửi 1 request tối thiểu để kiểm tra key/model/URL đó có hoạt động không, không tốn 1 lượt dịch thật — nếu fail có thể xem đầy đủ lỗi từ provider. |
| Cache prompt | Phần system prompt dịch (giống hệt nhau ở mọi trang trong cùng 1 lượt quét/auto-translate) được cache phía server trên Anthropic qua `cache_control`, giảm tới ~90% chi phí input cho các trang sau. Provider tương thích OpenAI và Gemini đã tự động cache prompt đủ điều kiện, không cần cấu hình. |
| Trình quét trang | Tìm ảnh manga/comic trên trang hiện tại và cho phép chọn trang cần dịch. |
| Tự động dịch | Bấm **Tự động dịch** (hoặc nhấn **Alt+Shift+A**, trên Mac là **⌘+Shift+A**) rồi cứ đọc: trang được dịch khi hiện ra trên màn hình, kèm dịch trước vài trang phía sau. Khung **Auto MT** ở góc màn hình đếm số trang đã dịch và có nút **Dừng**. Tùy chọn **Dịch trước** bắt đầu dịch trang ngay khi tải xong. |
| Dịch bubble | Nhận diện bubble thoại, xóa chữ gốc, dịch và render chữ lại vào ảnh. |
| Di chuột phóng to | Di chuột vào 1 bubble đã dịch để xem bản crop phóng to sắc nét kèm chú thích là chữ gốc, giúp đối chiếu bản dịch nhanh chóng. Có nút chuyển qua lại giữa ảnh đã dịch và ảnh gốc cho từng trang. |
| Ghi chú truyện | Ghi chú riêng cho từng truyện (glossary, quan hệ nhân vật, văn phong) mà model luôn tuân theo; có nút "Suggest" để tự soạn nháp từ các trang đã quét. Khác với Chỉ dẫn chung cho LLM (áp dụng mọi truyện). |
| CSDL truyện (tùy chọn, cần đăng nhập) | Cơ sở dữ liệu nhân vật riêng cho từng truyện — nhân vật (tên/giới tính/vai trò/giọng điệu, kèm ảnh đại diện và tối đa 2 ảnh tham chiếu tùy chọn), mối quan hệ, thuật ngữ dịch cố định (mỗi thuật ngữ có thể đặt **Bắt buộc chính xác**: sau khi dịch, tự sửa cách viết của thuật ngữ và các biến thể bạn liệt kê thành đúng bản dịch — chỉ sửa được những gì AI thật sự viết ra, không sửa được một cách dịch khác mà bạn chưa liệt kê), và ghi chú diễn biến — đồng bộ theo tài khoản. **Chỉ áp dụng khi dịch nếu bật công tắc `Dùng CSDL truyện` ở tab `Translate` (mặc định tắt)** — chỉ chọn truyện ở tab `Story DB` thôi là chưa đủ. **Sơ đồ quan hệ** tương tác (kéo nhân vật, bấm để làm nổi bật, nút "Nối" để thêm quan hệ giữa hai nhân vật) giúp nhìn cả dàn nhân vật, vị trí được lưu lại. Ảnh tham chiếu chỉ gửi cho AI khi bạn bật "Gửi ảnh tham chiếu cho AI". Chỉnh sửa chưa lưu vẫn còn sau khi đóng popup — tự khôi phục lại lần sau, có nút bỏ nếu muốn làm lại từ đầu. Có Undo/Redo (Ctrl+Z / Ctrl+Shift+Z) để lùi/tiến qua các thay đổi. Vì truyện đang chọn là 1 cài đặt dùng chung cho mọi trang web (không theo từng trang), sẽ có banner cảnh báo nếu trang web hiện tại lần trước được dịch bằng truyện khác với truyện đang chọn — không tự đổi gì cả, chỉ nhắc bạn kiểm tra lại. Quản lý ở tab `Story DB`. |
| Cập nhật CSDL truyện từ mô tả | Trong tab Story DB, gõ điều vừa xảy ra trong truyện ("Chương 39, kẻ thù hoá ra là Hina, bạn thân thuở nhỏ của Akira, nên hai người chuyển sang xưng hô ta/ngươi") rồi bấm **✨ Cập nhật từ mô tả** — AI soạn sẵn thay đổi nhân vật/quan hệ và một ghi chú diễn biến để bạn xem lại; chưa lưu gì cho tới khi bấm Save story. Có thể bật **Tìm kiếm trên mạng cho truyện này** để AI tự tra cứu và bổ sung diễn biến đến đúng điểm mô tả của bạn — khác với Suggest Notes, cái này được phép có spoiler vì mục đích chính là theo dõi diễn biến. |
| Xuất/nhập Story DB | Nút Export/Import JSON ngay trong tab Story DB, để sao lưu 1 truyện hoặc đưa cho người dịch/edit khác mà không cần gõ lại. |
| Xưng hô tiếng Việt chính xác | Khi dịch sang tiếng Việt, tự động suy luận quan hệ từng cặp nhân vật (tuổi, giới tính, quan hệ gia đình, honorific như "onii-chan") để chọn đúng xưng hô (anh/em, tao/mày...) và giữ nhất quán suốt trang — không cần cấu hình gì. |
| Trí nhớ context | Tùy chọn: model tự viết 1 câu tóm tắt mỗi trang và dùng lại ở các trang sau trong cùng truyện, giữ nhân vật/sự kiện nhất quán mà rẻ hơn gửi kèm ảnh/chữ đầy đủ của trang trước. |
| Sửa bản dịch | Bấm vào 1 bubble đã dịch, mô tả chỗ sai để dịch lại đúng trang đó với hướng dẫn sửa áp riêng cho bubble đó. Để sửa cùng 1 lỗi lặp lại trên nhiều trang (vd tên nhân vật sai), chọn các trang đã dịch trong trình quét, mô tả 1 lần rồi áp dụng cho tất cả. |
| Di chuyển / xoá bong bóng | Máy khoanh sai vị trí, hoặc không nên có bong bóng ở đó? Mở popover Fix của bong bóng và bấm **Move** (kéo khung mới; chỗ cũ được khôi phục về tranh gốc) hoặc **Delete** (chỉ khôi phục tranh gốc). |
| Vùng chữ thủ công | Chưa ưng một chỗ, hoặc auto-detect bỏ sót? Bấm **✂ Chọn vùng chữ** trong popup rồi kéo khung quanh chữ bất kỳ trên trang: chữ được đọc tự động (OCR), sau đó bạn tự gõ bản dịch hoặc bấm **Dịch bằng AI** (áp dụng Story DB và chỉ dẫn của bạn). Chỗ đó được xóa chữ và vẽ lại bản dịch vào ảnh. Chọn lại đúng chỗ để sửa hoặc xóa; các khung được nhớ theo từng trang. Cần chạy backend bản mới nhất. |
| Bút tẩy | Với chữ raw/SFX mà hình chữ nhật không tách gọn được (SFX cong hoặc chéo, chữ dính vào nét vẽ nhân vật): bấm **🩹 Xoá vùng chữ** rồi tô lên bằng bút vẽ; chỗ đó được xóa và vá lại. Được nhớ theo từng trang như công cụ vùng chữ thủ công. |
| Chế độ tiết kiệm | Một công tắc để giảm chi phí API: ảnh chi tiết thấp, không gửi ngữ cảnh toàn trang/trang trước, không gửi ảnh tham chiếu Story DB, và thu nhỏ ảnh ngữ cảnh. Cài đặt của bạn được giữ nguyên và trở lại khi tắt. |
| Cài đặt font | Chọn font pack vẽ chữ đã dịch, và khoảng cỡ chữ nhỏ nhất/lớn nhất, ngay trong tab Translate — bỏ font pack của bạn (thư mục chứa file .ttf/.otf) vào `backend/fonts/` để thấy trong danh sách. Có thêm ô chỉnh độ nét chữ (supersampling) trong tab **Pro** mới, cùng các cài đặt nâng cao khác để riêng khỏi các tab chính. |
| Web app (không cần extension) | Dịch file ảnh có sẵn trên máy — không cần ảnh đó đã có trên trang web nào. Chạy backend rồi mở `http://localhost:7677/app` bằng trình duyệt bất kỳ, kéo file vào, dịch, xuất ZIP/CBZ. Cố tình tối giản (không có Story DB/xoay vòng key/công cụ thủ công) — cần đầy đủ tính năng thì dùng extension. |
| Xuất file | Tải PNG 1 trang đã dịch ngay trên overlay, hoặc xuất toàn bộ trang đã dịch trong trình quét thành 1 file ZIP chỉ với 1 lần bấm. |
| Xuất CBZ / PDF | Nút "Export CBZ" và "Export PDF" cạnh nút xuất ZIP — cùng các trang đó, nhưng đánh số theo thứ tự quét để lật đúng thứ tự (tên file của ZIP thường theo URL gốc, không phải lúc nào cũng đúng thứ tự đọc). |
| Đang dịch | Một dấu hiệu nhỏ động (3 chấm nhấp nhô) hiện ở trang nào đang thật sự được dịch, phân biệt với các trang còn đang chờ trong hàng đợi auto-translate. |
| Báo hiệu thử lại | Trang bị lỗi auto-translate 3 lần liên tiếp sẽ hiện badge đỏ nhỏ — bấm vào để thử lại ngay. |
| Chữ ngoài bubble | Xử lý SFX/lời dẫn ngoài bubble bằng cleanup nhẹ mặc định. |
| Xoá chữ bằng LaMa | Lựa chọn ở giữa cleanup OpenCV nhẹ và Flux: chọn **LaMa** ở mục *Chất lượng xoá chữ* (tab Translate) để dựng lại viền khung, screentone, nét gạch sau chỗ chữ bị xoá thay vì làm nhoè. ~200MB, tự tải lần đầu dùng, chạy CPU vài giây (nhanh hơn nếu có GPU). Công cụ Tẩy và Chọn vùng chữ cũng dùng LaMa khi bạn chọn nó. |
| Thông báo tải model lần đầu | Một số tính năng tải model ML ở lần dùng đầu tiên (LaMa ~0,2 GB, manga-ocr ~0,9 GB, PaddleOCR-VL ~1,9 GB). Khi việc dịch chậm, trang hiện thông báo "cài đặt lần đầu: đang tải …" thay vì treo mà không giải thích. |
| Flux tùy chọn | Cho phép người dùng nâng cao tải Flux Klein 4B để inpainting nặng hơn mà không làm nặng release mặc định. |
| Từ điển thay thế | Ở tab **Pro**: quy tắc `tìm => thay` cố định (hỗ trợ `/regex/`) cho những lỗi AI cứ dịch sai mãi. Quy tắc *Sau khi dịch* sửa mọi bản dịch trước khi vẽ lên ảnh — chính xác tuyệt đối, và áp dụng cả với trang đã cache mà không cần gọi AI lại. Quy tắc *Trước khi dịch* sửa văn bản gốc; chính xác trong công cụ Chọn vùng chữ, còn khi AI đọc thẳng ảnh trang thì được gửi cho AI như chỉ dẫn. |
| Tuỳ chọn kiểu chữ | Ở tab **Pro**: VIẾT HOA, căn trái/giữa/phải, màu chữ cố định và viền chữ (độ dày + màu) cho chữ trong bong bóng và vùng Chọn vùng chữ — các lựa chọn lettering quen thuộc của nhóm dịch. Chữ đậm/nghiêng từ AI vẫn được giữ. |
| Cách đọc chữ | Ô chọn ở tab `Translate`: để AI đọc ảnh từng bong bóng (mặc định), hoặc đọc chữ trên máy trước bằng manga-ocr / PaddleOCR-VL rồi chỉ gửi văn bản cho AI — rẻ hơn, chạy được với model chỉ có chữ, và làm từ điển "trước khi dịch" hoạt động chính xác. |
| LLM chạy local | Dịch hoàn toàn offline, không tốn phí API bằng Ollama hoặc LM Studio (model nhìn được ảnh, hoặc model chữ bất kỳ kèm OCR local) qua provider `OpenAI-Compatible` — xem [LLM Chạy Local](#llm-chạy-local-ollama--lm-studio). |
| Chatbot hỗ trợ | Bấm nút **?** ở header popup để hỏi về cách cài đặt, cấu hình hoặc sử dụng extension — được trả lời bởi chính LLM bạn đã cấu hình, dựa trên tài liệu thật của dự án (không phải FAQ dựng sẵn, và không miễn phí — tốn API key/quota của bạn như mọi tính năng AI khác). Lịch sử chat được lưu lại trên máy qua các lần mở popup; có thể xoá bất cứ lúc nào. |
| Popup có thể resize | Kéo góc dưới-phải của popup để đổi kích cỡ (thường hoạt động tốt — đôi khi Chrome tự đo lại kích cỡ popup và có thể "cãi" lại việc kéo), hoặc bấm **⤢** ở header để mở cùng giao diện đó trong 1 cửa sổ bình thường, resize tự do. |
| Provider | Google, OpenAI, Anthropic, xAI, DeepSeek, Z.ai, Moonshot AI, OpenRouter và endpoint OpenAI-compatible. |
| Ngôn ngữ UI | Tiếng Anh mặc định, kèm tiếng Việt, tiếng Trung, tiếng Nhật và tiếng Hàn. |
| Ngôn ngữ dịch | Ô nguồn/đích gợi ý sẵn khoảng 58 ngôn ngữ (Nhật, Hàn, Trung, Tây Ban Nha, Pháp, Ả Rập...) qua autocomplete, hoặc gõ tự do bất kỳ ngôn ngữ nào — backend không giới hạn danh sách. |
| Backend portable | Dùng `start-backend.bat`, `backend/main.py` và runtime `backend/runtime/python.exe` nếu có. |

## Tải Xuống

Release mới nhất:

```text
https://github.com/QuangTQV/Manga-Translator-Extension/releases/latest
```

Các asset của release:

| Asset | Mục đích |
| --- | --- |
| `manga-translator-extension-dist-*.zip` | Extension đã build. Giải nén và load thư mục `dist/` trong Chrome/Edge. |
| `manga-translator-models-no-flux-*.zip` | Tùy chọn. Model backend tải sẵn (không Flux) để khỏi chờ tải khi dùng lần đầu — giải nén vào root project để khôi phục `backend/models/`. Bỏ qua bước này thì backend vẫn tự tải đúng model đó khi bạn dịch trang đầu tiên. |
| Source code (zip / tar.gz) | Toàn bộ repo tại tag của release đó, giống hệt clone. |

Giải nén model (tùy chọn — thay đúng tên file của release bạn đã tải):

```powershell
Expand-Archive .\manga-translator-models-no-flux-*.zip -DestinationPath .
```

## Bắt Đầu Nhanh

1. Tải source hoặc clone repository.

```powershell
git clone https://github.com/QuangTQV/Manga-Translator-Extension.git
cd Manga-Translator-Extension
```

2. Cài đặt backend (chỉ cần làm 1 lần).

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -e .
cd ..
```

Tùy chọn: tải `manga-translator-models-no-flux-*.zip` từ [release mới nhất](#tải-xuống) rồi giải nén vào root project để khôi phục `backend/models/` trước — nếu bỏ qua, backend sẽ tự tải đúng model đó khi bạn dịch trang đầu tiên.

3. Khởi động backend.

```powershell
.\start-backend.bat
```

Backend sẽ lắng nghe tại:

```text
http://localhost:7677
```

4. Load extension trình duyệt.

```powershell
cd extension
npm install
npm run build
```

Sau đó mở Chrome hoặc Edge:

```text
chrome://extensions/
```

Bật Developer mode, chọn Load unpacked và chọn `extension/dist/`.

## Cấu Hình

Mở popup extension và dùng các tab:

| Tab | Tùy chọn |
| --- | --- |
| `Translate` | Ngôn ngữ nguồn, ngôn ngữ đích, công tắc `Dùng CSDL truyện` (mặc định tắt — cần bật thì dữ liệu ở tab Story DB mới thực sự áp dụng khi dịch), bật/tắt chữ ngoài bubble, Previous-page context, Trí nhớ context, Ghi chú truyện (có nút "Suggest" để soạn nháp). |
| `LLM Config` | Provider, Base URL, model, API key (+ key dự phòng và provider dự phòng tùy chọn, thử lần lượt khi bị rate limit), temperature, Top P, Top K, ngữ cảnh toàn trang, Chỉ dẫn chung cho LLM. |
| `Config` | Ngôn ngữ giao diện extension và backend URL. |
| `Account` | Đăng nhập bằng email hoặc Google để dùng các tính năng tùy chọn theo tài khoản (CSDL truyện); cũng là nơi người dùng backend hosted tập trung xem gói/mức dùng. |
| `Story DB` | Tùy chọn, cần đăng nhập ở tab `Account`. CSDL nhân vật, mối quan hệ, thuật ngữ, và ghi chú diễn biến cho từng truyện, đồng bộ theo tài khoản. |
| `Pro` | Các tuỳ chọn nâng cao tách khỏi tab chính: độ nét chữ (supersampling), kiểu chữ (viết hoa, căn lề, màu chữ, viền) và từ điển thay thế trước/sau khi dịch. |

Backend URL mặc định:

```text
http://localhost:7677
```

Provider key có thể nhập trong popup hoặc truyền qua biến môi trường:

```text
GOOGLE_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

## LLM Chạy Local (Ollama / LM Studio)

Dịch offline, không tốn phí API bằng cách trỏ provider `OpenAI-Compatible` tới model chạy trên chính máy bạn.

**Mặc định cần model nhìn được ảnh (vision).** AI đọc chữ thẳng từ ảnh trang, nên model chỉ có chữ (Llama, Qwen 2.5 thường...) không có gì để dịch. Ví dụ model nhìn được ảnh: Qwen2.5-VL (`qwen2.5vl:7b` trong Ollama), Gemma 3 (`gemma3:12b`), hoặc model nào LM Studio đánh dấu là vision.

**Model chỉ có chữ vẫn dùng được** nếu đặt tab `Translate` → **Cách đọc chữ** thành `manga-ocr` (chỉ tiếng Nhật) hoặc `PaddleOCR-VL`: chữ được đọc ngay trên máy trước, rồi chỉ gửi văn bản cho model. Cách này cũng rẻ và nhẹ hơn cho GPU local, đổi lại AI không còn nhìn thấy ảnh bong bóng.

**Ollama**

1. Cài [Ollama](https://ollama.com), rồi tải model: `ollama pull qwen2.5vl:7b` (server tự chạy ở cổng 11434).
2. Popup → `LLM Config`: Provider `OpenAI-Compatible`, Base URL `http://localhost:11434/v1`, Model `qwen2.5vl:7b`, API key: gõ chữ bất kỳ như `ollama` (ô này không được để trống; Ollama bỏ qua nó).
3. Bấm **Test** cạnh key, rồi dịch như bình thường.

**LM Studio**

1. Tải một model vision trong [LM Studio](https://lmstudio.ai), vào tab Developer và bật local server (cổng 1234).
2. Popup → `LLM Config`: Provider `OpenAI-Compatible`, Base URL `http://localhost:1234/v1`, Model: tên model LM Studio hiển thị, API key: chữ bất kỳ như `lm-studio`.

**Cần biết**

- Base URL do **backend** gọi, không phải trình duyệt. Nếu backend chạy trong Docker, dùng `http://host.docker.internal:11434/v1`; nếu model chạy ở máy khác, dùng địa chỉ LAN của máy đó (với Ollama, chạy kèm `OLLAMA_HOST=0.0.0.0`).
- Mỗi trang gửi nhiều ảnh cùng lúc. Context mặc định của Ollama có thể quá nhỏ, biểu hiện là bản dịch bị thiếu hoặc lộn xộn — chạy với context lớn hơn, ví dụ `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`. Bật **Economy mode** cũng giúp (ít ảnh hơn, ảnh nhỏ hơn).
- Model local 7-12B kém rõ rệt so với model cloud lớn khi gặp chữ nhỏ hoặc chữ cách điệu, và mỗi trang có thể mất vài chục giây nếu không có GPU mạnh. Nếu model nhỏ làm hỏng định dạng trả lời đánh số (bong bóng báo lỗi dịch), thử model lớn hơn hoặc giảm temperature.
- Mọi tính năng khác (Story DB, từ điển thay thế, kiểu chữ, công cụ thủ công) hoạt động y hệt với model local.

## Flux Tùy Chọn

Flux không đi kèm release thường vì tăng dung lượng thêm vài GB. Chế độ chữ ngoài bubble mặc định dùng cleanup nhẹ và không cần Flux.

Cài Flux Klein 4B khi cần:

```powershell
.\setup.bat
```

Chọn:

```text
2. Download optional Flux Klein 4B model
```

Script sẽ tải vào:

```text
backend/models/flux/
```

Chỉ dùng Flux khi bạn cấu hình outside-text inpainting sang một mode Flux như `flux_klein_4b`. Với đa số người dùng, mặc định `auto` nhẹ hơn và nhanh hơn.

**Ở giữa: LaMa.** *Chất lượng xoá chữ → LaMa* không cần GPU và không cần cài thủ công: model ~200MB ([bản TorchScript của big-lama](https://huggingface.co/JosephCatrambone/big-lama-torchscript), Apache-2.0) tự tải vào `backend/models/lama/` lần đầu dùng và chạy CPU vài giây mỗi vùng. Dựng lại viền khung và screentone tốt hơn hẳn cleanup mặc định, dù không bằng Flux với vùng tranh lớn.

**Không có GPU? Chạy Flux trên GPU từ xa.** Mục *Inpainting quality* trong popup còn có `Flux Klein 4B (remote)` và `Flux Klein 9B (remote)`: chạy `backend/flux_worker.py` trên GPU free của Kaggle (hoặc máy có GPU khác), mở tunnel `cloudflared` rồi dán URL vào popup — máy bạn không phải cài gì nặng. Nên bảo vệ worker bằng `--token` / `FLUX_WORKER_TOKEN` và điền cùng giá trị vào ô Token trong popup. Nếu worker chết hoặc từ chối token, trang vẫn được dịch (chữ ngoài bubble giữ nguyên), có toast cảnh báo lý do, và backend tạm ngừng gọi worker chết khoảng 60 giây. Hướng dẫn từng bước: [HUONG-DAN-CHAY.md](HUONG-DAN-CHAY.md#8-tuỳ-chọn-chạy-flux-từ-xa-trên-gpu-free-của-kaggle).

## Web App (không cần cài extension)

Với file ảnh có sẵn trên máy (ảnh scan chưa từng đăng lên trang web nào — extension chỉ dịch được thẻ `<img>` đã có sẵn trên một trang đang mở): chạy backend như bình thường, rồi mở **`http://localhost:7677/app`** bằng trình duyệt bất kỳ. Kéo file vào (hoặc chọn file), điền provider/key/ngôn ngữ ở sidebar (lưu ngay trong trình duyệt đó), bấm **Translate All**, rồi **Export ZIP** hoặc **Export CBZ**.

Trang này cố tình tối giản — không có Story DB, không xoay vòng key, không có công cụ khoanh vùng/bút tẩy/font — cần đầy đủ thì dùng extension. Nó gọi thẳng vào cùng backend local qua `fetch()`, không cần chạy gì thêm ngoài backend.

## Quy Trình Sử Dụng

1. Chạy backend bằng `start-backend.bat`.
2. Mở chapter manga/comic trong Chrome hoặc Edge.
3. Bấm biểu tượng MangaTranslator.
4. Chọn ngôn ngữ nguồn và đích.
5. Bấm Scan & Translate Page để chọn ảnh thủ công, hoặc Auto-translate để dịch khi cuộn.
6. Kiểm tra ảnh đã dịch trên trang.

Lời khuyên: Khi gặp các web có lazy-load khiến extension không quét được toàn bộ trang truyện cùng lúc, hãy scan và dịch trước 4-5 trang truyện, sau đó bật Auto-MT để có trải nghiệm đọc mượt mà nhất.

## Cấu Trúc Dự Án

```text
manga-translator-extension/
  backend/                         Backend FastAPI và tích hợp MangaTranslator
  backend/main.py                  Điểm vào backend
  backend/core/                    Nhận diện, cleanup, dịch, render
  backend/models/                  Model khôi phục từ release assets
  backend/pipeline/                Wrapper quanh core pipeline
  extension/                       Browser extension Manifest V3
  extension/src/background/        Service worker và request tới backend
  extension/src/content-script/    Trình quét trang và overlay tự động dịch
  extension/src/popup/             Giao diện popup
  extension/src/shared/            Types, constants, i18n
  docs/                            API docs và README đa ngôn ngữ
  setup.bat                        Trợ lý setup tùy chọn, gồm tải Flux
  start-backend.bat                Launcher backend
```

## Phát Triển

Build extension:

```powershell
cd extension
npm install
npm run build
```

Compile-check backend:

```powershell
cd ..\backend
python -m py_compile pipeline\wrapper.py
```

Kiểm tra health backend:

```powershell
Invoke-RestMethod http://localhost:7677/health
```

## Đóng Gói Release

Không commit runtime, model, cache hoặc build output. Các đường dẫn này được ignore có chủ đích:

```text
backend/runtime/
backend/models/
extension/dist/
extension/node_modules/
release-assets/
```

Hãy dùng GitHub Releases cho runtime/model archives. GitHub chặn file trên 100 MB trong Git history thường, và archive runtime lớn nên được chia nhỏ để mỗi release asset nằm dưới giới hạn của GitHub.

## FAQ

**Q: Chất lượng dịch thuật thì sao?**

A: Chất lượng dịch dựa trên model LLM mà bạn sử dụng. Model càng tốt thì câu dịch thường tự nhiên hơn, hiểu ngữ cảnh tốt hơn và ít dịch sai hơn.

**Q: Một số trang dịch không có bubble thì bị hiện khung nền trắng/đen, phải làm sao?**

A: Hãy sử dụng model Flux Klein 4B tùy chọn để cải thiện chất lượng inpainting cho chữ ngoài bubble, SFX, lời dẫn và nền ảnh phức tạp.

**Q: Vì sao popup báo Backend Offline?**

A: Chạy `.\start-backend.bat`, chờ backend khởi động xong, rồi kiểm tra `http://localhost:7677/health`. Đồng thời kiểm tra Backend URL trong tab `Config` có đúng server local của bạn không.

**Q: Vì sao một số ảnh manga không được tìm thấy?**

A: Hãy chờ trang reader load xong rồi chạy Scan & Translate Page lại. Nếu website chỉ lazy-load ảnh khi cuộn, hãy cuộn qua chapter một lần hoặc dùng Auto-collect trong scanner.

**Q: Tôi đã tạo Story DB và chọn truyện rồi nhưng bản dịch không thấy áp dụng, vì sao?**

A: Hãy bật công tắc `Dùng CSDL truyện` ở tab `Translate` — chỉ chọn truyện ở tab `Story DB` thôi thì chưa áp dụng, cố tình thiết kế vậy để bạn vẫn dịch được 1 trang lẻ mà không cần Story DB kể cả khi đang chọn sẵn 1 truyện.

**Q: Tôi không hiểu cách cấu hình cái gì đó — có hỗ trợ trong extension không?**

A: Bấm nút **?** ở header popup để hỏi trực tiếp. Câu trả lời do chính LLM bạn cấu hình trả lời, dựa trên tài liệu thật của dự án chứ không phải kịch bản dựng sẵn — nên sẽ tốn 1 chút API quota của bạn, giống mọi tính năng AI khác ở đây.

## Khắc Phục Sự Cố

| Lỗi | Cách xử lý |
| --- | --- |
| Popup báo backend offline | Chạy `.\start-backend.bat` và kiểm tra `http://localhost:7677/health`. |
| Extension không kết nối được | Kiểm tra backend URL trong tab `Config`. |
| Không tìm thấy ảnh | Chờ trang manga load xong rồi chạy Scan & Translate Page lại. |
| Lỗi model/provider | Kiểm tra API key, Base URL, model name và provider đã chọn. |
| Tải Flux thất bại | Chạy lại `setup.bat`, kiểm tra dung lượng ổ đĩa và kết nối mạng. |
| `pip install -e .` lỗi trong `backend/` | Kiểm tra Python 3.10+ và đã kích hoạt virtual environment trước khi cài. |

## Bảo Mật

Không commit API key, backend URL riêng, cache sinh ra, model artifact, `node_modules`, `dist` hoặc toàn bộ Python runtime. Giữ secrets trong popup extension hoặc biến môi trường.

## Giấy Phép

Bản portable này chứa code phát triển từ MangaTranslator. Hãy giữ đúng yêu cầu license upstream khi phân phối lại.
