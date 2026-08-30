<h1 align="center">MangaTranslator Extension</h1>

<p align="center">
  使用本地 FastAPI 后端、批量页面扫描器、自动翻译模式、多语言界面和可选 Flux inpainting，在浏览器中直接翻译漫画页面。
</p>

<p align="center">
  <a href="../README.md">English</a>
  ·
  <a href="README.vi.md">Tiếng Việt</a>
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
  <a href="#概览">概览</a>
  ·
  <a href="#功能">功能</a>
  ·
  <a href="#下载">下载</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#配置">配置</a>
  ·
  <a href="#可选-flux">可选 Flux</a>
</p>

<p align="center">
  <img src="assets/mangatranslator-hero.png" alt="MangaTranslator Extension banner" width="100%">
</p>

## Showcase

MangaTranslator Extension 面向想要连续阅读漫画的用户，而不是把文字复制到另一个工具里。打开章节，扫描页面，选择要翻译的图片，然后让你自己的 LLM 翻译对白并把结果重新渲染回漫画图片。

| Popup 控制面板 | 页面扫描器 |
| --- | --- |
| <img src="assets/popup-preview.png" alt="MangaTranslator Extension popup" width="390"> | <img src="assets/scanner-preview.png" alt="MangaTranslator Extension page scanner" width="720"> |
| 配置源语言/目标语言、气泡外文字识别、后端状态，并一键启动自动翻译。 | 扫描章节、预览检测到的页面、只选择需要翻译的图片并批量翻译。 |

### 翻译效果

| 原始页面 | 翻译后页面 |
| --- | --- |
| <img src="assets/manga-before.png" alt="Original Japanese manga page" width="420"> | <img src="assets/manga-after.png" alt="Translated manga page rendered back into the image" width="420"> |

- 使用你自己的 LLM：配置你信任的 provider、API key、model 和 endpoint。
- 自动翻译更省时间：滚动阅读时自动翻译，并提前处理后面的页面。
- 保留漫画观感：清除原文后把译文重新排版进图片。
- 不只翻译气泡：也可处理 SFX、旁白、标题和气泡外文字。
- 默认更轻量：Flux Klein 4B 是可选组件，普通用户不必下载过大的默认包。

## 概览

MangaTranslator Extension 是一个 portable 的浏览器扩展 + 后端栈，用于翻译漫画和 Comic 页面。浏览器扩展会扫描当前页面中的图片，将图片发送到本地后端，然后替换或预览渲染后的翻译结果。后端在你的电脑上运行，因此扩展不需要把漫画图片发送到第三方扩展服务器。

Extension 使用你提供的 LLM、API key、model 和 Base URL。你可以连接 Google、OpenAI、Anthropic、OpenRouter、DeepSeek、xAI、Z.ai、Moonshot AI 或任何 OpenAI-compatible endpoint，然后把漫画翻译流程保留在浏览器中。

默认安装保持轻量：backend 会在首次使用时自动下载（非 Flux）模型，Flux Klein 4B 是可选组件，只有在需要更强的气泡外文字 inpainting 时才通过 `setup.bat` 安装。

## 功能

| 模块 | 功能 |
| --- | --- |
| 自带 LLM | 使用用户配置的 provider、API key、model 和 Base URL。 |
| Provider/密钥轮换 | 遇到限流时自动依次尝试同一 provider 的备用密钥，再切换到已配置的备用 provider。轮换顺序可配置（轮询/随机/顺序）；随机模式下每个密钥可设置权重以提高被选中的概率。被限流密钥的冷却时间会优先使用 provider 返回的真实 `Retry-After` 响应头（如果有），而不是固定猜测值，从而在正确的时间重试。列表中每个 provider/model 也可单独覆盖推理强度，不设置则使用通用设置。 |
| 测试 API Key | 每个 API key 旁的"测试"按钮（以及每个 provider 的"测试全部密钥"）会发送一个最小请求，确认该 key/model/URL 是否真的可用，不消耗实际翻译额度——测试失败时可查看 provider 返回的完整错误信息。 |
| Prompt 缓存 | 翻译用的 system prompt 在同一批次/自动翻译过程中每页完全相同，通过 `cache_control` 在 Anthropic 端缓存，可将后续每页的输入成本降低约 90%。OpenAI 兼容和 Gemini provider 已自动缓存符合条件的 prompt，无需配置。 |
| 页面扫描器 | 在当前页面查找 manga/comic 图片，并让你选择要翻译的页面。 |
| 自动翻译 | 监听当前阅读页，在滚动时自动翻译图片。 |
| 气泡翻译 | 检测对话气泡，清除原文，翻译并把文字重新渲染回图片。 |
| 悬停放大 | 将鼠标悬停在已翻译的气泡上，可查看清晰放大的裁剪图，并以原文作为说明文字，方便对照译文。每页都有一个按钮可在译文和原图之间切换。 |
| 故事笔记 | 针对当前作品的专属说明（术语表、人物关系、语气），模型会始终遵循；可点击"Suggest"根据已扫描页面自动生成草稿。与适用于所有作品的"LLM 通用指令"不同。 |
| 越南语人称代词准确度 | 输出越南语时，自动推理每对说话者的关系（年龄、性别、家庭关系、"onii-chan"等敬称）以选择正确的人称代词（anh/em、tao/mày 等），并在全页保持一致——无需任何配置。 |
| 上下文记忆 | 可选：模型为每页写一句摘要，并在同一作品的后续页面中复用，以更低成本保持人物/剧情一致（无需发送完整的前页图片/文字）。 |
| 修正翻译 | 点击已翻译的气泡并描述问题所在，即可只重新翻译该页并把修正应用到那个气泡上。如果同一个错误（例如人物名字）在多页反复出现，可在扫描器中选中已翻译的这些页面，只描述一次即可应用到所有页面。 |
| 导出 | 在悬浮层上把单页翻译结果下载为 PNG，或在扫描器中一键将所有已翻译页面导出为 ZIP。 |
| 翻译进度 | 一个小的动态标记会显示当前正在实际翻译中的页面，与仍在自动翻译队列中等待的页面区分开来。 |
| 重试提示 | 某页连续 3 次自动翻译失败后，会显示一个小红色徽标——点击即可立即重试。 |
| 气泡外文字 | 默认使用轻量 cleanup 处理 SFX/旁白等气泡外文字。 |
| 可选 Flux | 高级用户可下载 Flux Klein 4B 获得更重的 inpainting，而不增加默认 release 体积。 |
| Provider 支持 | Google、OpenAI、Anthropic、xAI、DeepSeek、Z.ai、Moonshot AI、OpenRouter 和 OpenAI-compatible endpoint。 |
| UI 语言 | 默认英语，另有越南语、中文、日语和韩语。 |
| 翻译语言 | 源/目标语言输入框通过自动完成提供约 58 种建议语言（日语、韩语、中文、西班牙语、法语、阿拉伯语……），也可直接输入任意语言名称——后端没有语言限制列表。 |
| Portable 后端 | 使用 `start-backend.bat`、`backend/main.py` 和可选的 `backend/runtime/python.exe`。 |

## 下载

最新 release：

```text
https://github.com/QuangTQV/Manga-Translator-Extension/releases/latest
```

Release assets：

| Asset | 用途 |
| --- | --- |
| `manga-translator-extension-dist-*.zip` | 已构建的浏览器扩展。解压后在 Chrome/Edge 中加载 `dist/`。 |
| `manga-translator-models-no-flux-*.zip` | 可选。预先下载好的 backend 模型（不含 Flux），省去首次使用时的等待——解压到项目根目录以恢复 `backend/models/`。跳过此步骤，backend 会在你翻译第一页时自动下载相同的模型。 |
| Source code (zip / tar.gz) | 该 release tag 对应的完整仓库，等同于直接 clone。 |

解压模型（可选——请替换成你下载的 release 实际文件名）：

```powershell
Expand-Archive .\manga-translator-models-no-flux-*.zip -DestinationPath .
```

## 快速开始

1. 下载源码或 clone repository。

```powershell
git clone https://github.com/QuangTQV/Manga-Translator-Extension.git
cd Manga-Translator-Extension
```

2. 设置 backend（只需一次）。

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -e .
cd ..
```

可选：从[最新 release](#下载)下载 `manga-translator-models-no-flux-*.zip` 并解压到项目根目录，提前恢复 `backend/models/`——跳过此步骤，backend 会在你翻译第一页时自动下载相同的模型。

3. 启动后端。

```powershell
.\start-backend.bat
```

后端默认监听：

```text
http://localhost:7677
```

4. 加载浏览器扩展。

```powershell
cd extension
npm install
npm run build
```

然后打开 Chrome 或 Edge：

```text
chrome://extensions/
```

启用 Developer mode，选择 Load unpacked，然后选择 `extension/dist/`。

## 配置

打开扩展弹窗并使用三个标签页：

| Tab | 选项 |
| --- | --- |
| `Translate` | 源语言、目标语言、气泡外文字开关、Previous-page context、上下文记忆、故事笔记（可点击"Suggest"生成草稿）。 |
| `LLM Config` | Provider、Base URL、model、API key（+ 可选的备用密钥和备用 provider，限流时按顺序尝试）、temperature、Top P、Top K、整页上下文、LLM 通用指令。 |
| `Config` | 扩展 UI 语言和 backend URL。 |

默认 backend URL：

```text
http://localhost:7677
```

Provider key 可以在弹窗中输入，也可以通过环境变量提供：

```text
GOOGLE_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

## 可选 Flux

Flux 不包含在常规 release 中，因为它会增加数 GB 体积。默认气泡外文字模式使用轻量 cleanup，不需要 Flux。

按需安装 Flux Klein 4B：

```powershell
.\setup.bat
```

选择：

```text
2. Download optional Flux Klein 4B model
```

脚本会下载到：

```text
backend/models/flux/
```

只有在你明确把 outside-text inpainting 配置为 Flux 模式（例如 `flux_klein_4b`）时才使用 Flux。对大多数用户来说，默认 `auto` 更轻、更快。

## 使用流程

1. 使用 `start-backend.bat` 启动后端。
2. 在 Chrome 或 Edge 中打开 manga/comic chapter。
3. 点击 MangaTranslator 扩展图标。
4. 选择源语言和目标语言。
5. 点击 Scan & Translate Page 手动选择图片，或点击 Auto-translate 在滚动时自动翻译。
6. 在页面上查看已翻译图片。

建议：遇到使用 lazy-load、导致扩展无法一次扫描完整章节的网站时，先扫描并翻译接下来的 4-5 页，然后开启 Auto-MT，以获得最流畅的阅读体验。

## 项目结构

```text
manga-translator-extension/
  backend/                         FastAPI 后端和 MangaTranslator 集成
  backend/main.py                  后端入口
  backend/core/                    检测、清理、翻译、渲染
  backend/models/                  从 release assets 恢复的模型文件
  backend/pipeline/                core pipeline 的 wrapper
  extension/                       Manifest V3 浏览器扩展
  extension/src/background/        Service worker 和后端请求
  extension/src/content-script/    页面扫描器和自动翻译 overlay
  extension/src/popup/             弹窗 UI
  extension/src/shared/            Types、constants、i18n
  docs/                            API 文档和多语言 README
  setup.bat                        可选 setup helper，包括 Flux 下载
  start-backend.bat                后端启动器
```

## 开发

构建扩展：

```powershell
cd extension
npm install
npm run build
```

编译检查后端文件：

```powershell
cd ..\backend
python -m py_compile pipeline\wrapper.py
```

检查后端 health：

```powershell
Invoke-RestMethod http://localhost:7677/health
```

## Release 打包

不要提交生成的 runtime、models、cache 或扩展构建输出。以下路径是有意忽略的：

```text
backend/runtime/
backend/models/
extension/dist/
extension/node_modules/
release-assets/
```

请使用 GitHub Releases 分发 runtime/model archives。GitHub 会阻止普通 Git 历史中的 100 MB 以上文件，大型 runtime archive 也应该拆分，确保每个 release asset 低于 GitHub 的 release asset 限制。

## FAQ

**Q: 翻译质量怎么样？**

A: 翻译质量取决于你使用的 LLM model。更强的模型通常会有更自然的表达、更好的上下文理解和更少的误译。

**Q: 有些没有气泡的页面翻译后出现白色/黑色背景框，怎么办？**

A: 请使用可选的 Flux Klein 4B model，以改善气泡外文字、SFX、旁白和复杂背景的 inpainting 效果。

**Q: 为什么 popup 显示 Backend Offline？**

A: 运行 `.\start-backend.bat`，等待后端启动完成，然后检查 `http://localhost:7677/health`。同时确认 `Config` 标签页中的 Backend URL 指向你的本地服务器。

**Q: 为什么有些漫画图片没有被检测到？**

A: 等 reader 页面完全加载后，再运行 Scan & Translate Page。如果网站只在滚动时 lazy-load 图片，请先滚动浏览章节，或在 scanner 中使用 Auto-collect。

## 故障排查

| 问题 | 解决方法 |
| --- | --- |
| 弹窗显示 backend offline | 运行 `.\start-backend.bat` 并确认 `http://localhost:7677/health`。 |
| 扩展无法连接 | 检查 `Config` 标签页中的 backend URL。 |
| 找不到图片 | 等漫画页面完全加载后，再运行 Scan & Translate Page。 |
| 模型/provider 错误 | 检查 API key、Base URL、model name 和 provider 选择。 |
| Flux 下载失败 | 重新运行 `setup.bat`，检查磁盘空间和网络连接。 |
| `backend/` 目录下 `pip install -e .` 失败 | 确认 Python 版本为 3.10+，且已在安装前激活虚拟环境。 |

## 安全

不要提交 API key、私有 backend URL、生成的 cache、model artifact、`node_modules`、`dist` 或完整 Python runtime。请将 secrets 保存在扩展弹窗或环境变量中。

## License

此 portable build 包含源自 MangaTranslator 的代码。重新分发时请保留 upstream license 要求。
