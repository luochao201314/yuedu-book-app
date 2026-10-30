# 悦读绘本 · 英语跟读（Android）

给小学生练英语分级阅读的**本地优先** App：听外教朗读 → 跟读录音 → 发音评分与逐词纠错 → 成长记录与薄弱点。支持拍照批量录入/导入本地书籍。

- 安装包：`release/yuedu-1.0.0.apk`（约 0.12 MB，无第三方 SDK，`tools/build-apk.ps1` 生成）
- SHA256：`772767060B886A89637EFF243124A8CD098EE5857D50E7D09791C24C459FC4FC`（重新出包会变）
- 最低系统：Android 7.0（API 24），目标 API 34，竖屏
- 后端：`https://yuedu-book-backend.onrender.com`（可在 App「我的」里改）
- 线上状态：评分 / OCR / 古登堡代理均已实测通过（评分示例：`score 98 / fluency 100 / completeness 100`，逐词分正常）

---

## 一、已实现功能

| 模块 | 说明 |
|---|---|
| 绘本库 | 内置 10 本公版经典（彼得兔 / 三只小猪 / 伊索寓言 / 爱丽丝 / 绿野仙踪 / 快乐王子 / 秘密花园…），按 L1–L4 分级；支持搜索、进度条、打卡 |
| 同步公版 | 调 `GET /api/books` 拉古登堡书单；正文走后端 `/api/gutenberg` 代理（失败再退原生 `Android.httpGet()`）并自动分句 |
| 领读 | 云端 Azure 神经 TTS（`POST /api/tts`，Aria 女声），失败自动退系统 TTS；可调语速、可 0.62x 慢速逐句 |
| 跟读评分 | 16kHz 单声道 PCM 录音 → WAV → `POST /api/score`（Azure）；句分 + 等级词（Excellent!/Wonderful!/Great!…）+ 逐词染色（绿/黄/红波浪线）+ 纠错提示 + 完整度判断；可回放、重录、重试 |
| 评分播报 | 等级词 mp3 进阅读页就后台预取并缓存本机，出分后 5ms 内出声，不再等网络 |
| 拍照录入 | 相册**多选**（最多 8 张）或逐页拍照 → 逐页 `POST /api/ocr` → 自动清噪（页码/页眉页脚/乱码/断词连字符）→ 多页合并成**一本**并命名 → 按页保存，可删除 |
| 导入书籍 | `txt / md / html / epub / pdf`：epub 原生解包抽正文，pdf 用 PdfRenderer 逐页渲染成图再 OCR（最多 20 页），导入后与拍照录入一致 |
| 成长 | 连续打卡、读完绘本、跟读句数、平均分、近 7 天柱状图、薄弱词 Top8（点词发音）、最近跟读、9 枚成就徽章 |
| 数据 | 全部存本机（localStorage）；支持一键导出 JSON、清空 |
| 体验 | 微信级动效、底部导航、底部弹层、录音浮条、Toast、震动反馈、返回键接管 |

**OCR 清噪规则**（`app/src/js/ui.js`）：删掉纯数字 / 罗马数字 / `Page 12` / `第 3 页` 之类页码行；删掉全大写短标题行（多为页眉）；多页合并时删掉「每页第一行、最后一行」里跨页重复的页眉页脚；还原连字符断词（`exam-\nple` → `example`）；统一弯引号、去掉项目符号；丢弃符号占比过高的乱码行。分句按「行 + 句末标点」，只有「行尾无标点且下一行小写开头」才拼成一句，避免标题被并进正文。

## 二、目录结构

```
yuedu-book-app/
├─ app/
│  ├─ src/                      # 前端源码（无需框架/打包器）
│  │  ├─ index.html
│  │  ├─ css/app.css
│  │  └─ js/{data,core,ui,app}.js
│  └─ index.html                # 构建产物：单文件前端（后端 GET / 返回的就是它）
├─ android/
│  ├─ build.gradle              # AGP 8.4
│  ├─ settings.gradle
│  ├─ gradle.properties
│  └─ app/
│     ├─ build.gradle           # namespace/applicationId = com.yuedu.reading
│     └─ src/main/
│        ├─ AndroidManifest.xml
│        ├─ java/com/yuedu/reading/MainActivity.java   # WebView + 录音 + TTS + 相机 + Bridge
│        ├─ res/mipmap-*/       # 图标
│        └─ assets/index.html   # 构建产物（不入库，出包时从 app/index.html 拷入）
├─ server/                      # Node 后端（Render 部署），接口见 docs/backend-api.md
├─ tools/
│  ├─ build-www.js              # app/src → app/index.html
│  ├─ serve.js                  # 本地预览 node tools/serve.js → :5173
│  ├─ build-apk.ps1             # aapt2 + javac + d8 + zipalign + apksigner（不依赖 Gradle）
│  ├─ mock-azure.js             # 本地 mock Azure 发音评测，验证 /api/score 契约
│  └─ gen-icon.py               # 生成各密度图标（Pillow）
├─ docs/backend-api.md
├─ .github/workflows/build-apk.yml   # 云端 Gradle 出包（debug 签名，装即可用）
├─ archive/v1/                  # 旧版 Web + Android 原型工程（仅存档，不参与构建）
└─ release/                     # 出包目录（*.apk / *.jks 不入库）
```

## 三、本地预览（不用装安卓）

```bash
node tools/build-www.js
node tools/serve.js        # 打开 http://localhost:5173
```

浏览器里可完整体验绘本库/阅读/成长/我的；录音走 `getUserMedia`，相机走文件选择，评分与 OCR 走真实后端。
浏览器预览版只支持导入 txt / md / html（epub、pdf 依赖原生解析，需用 APK）。

## 四、重新出包

工具链已装在本机（Windows）：

- JDK 17：`C:\Users\luoch\AppData\Local\Temp\opencode\android\jdk`
- Android SDK：`C:\Users\luoch\AppData\Local\Temp\opencode\android\sdk`（build-tools 34.0.0 / platform 34）

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1
# 输出 release/yuedu-1.0.0.apk
```

脚本会先跑 `node tools/build-www.js` 生成 `app/index.html`，再拷进 `android/app/src/main/assets/index.html`，所以改完 `app/src` 直接出包即可。
脚本里的 SDK/JDK 路径写死在文件顶部，换机器改 `$sdk` / `$jdk`。

也可以完全不用本地工具链：推送到 `main` 后 GitHub Actions 会用 Gradle 8.6 + AGP 8.4 出包（产物在 Actions 的 Artifacts 里），那条流水线还会校验 `app/index.html` 与 `app/src` 是否一致。

签名：本地脚本用自签证书 `release/yuedu.jks`（口令 `yuedu2026`，别名 `yuedu`，不入库）；CI 用 Gradle 自动生成的 debug 签名。
**两把钥匙签出来的包装在同一台手机上会互相冲突**，换包前先卸载；正式分发前请固定用自己的 keystore 并妥善备份，否则后续无法覆盖升级。

## 五、装机

1. 把 `release/yuedu-1.0.0.apk` 发到手机（微信/QQ/数据线均可）。
2. 点击安装，允许「安装未知来源应用」。
3. 首次跟读时允许「麦克风」；首次拍照时系统会弹相机/相册选择。
4. 打开后默认连你的后端；「我的 → 后端服务」可改地址并检测。

> 若提示"解析包损坏"，多半是传输过程被改写过，重新用数据线/网盘下载原文件。

## 六、数据与隐私

- 成长数据、我的绘本、设置全部在本机，不上传服务器。
- 录音只在内存中转成 base64 发给评分接口，不落盘、不本地留存。
- 拍的照片 / 导入的 pdf 页压缩后发给 OCR 接口，App 不保存原图；txt/epub 的正文解析全在本机完成。
- 换机/清理数据前用「我的 → 导出成长记录」复制 JSON 备份。

## 七、内容版权（重要）

- 内置 10 本均为 **公有领域（Public Domain）** 作品，正文可自由使用，中文提示为本项目自撰。
- 古登堡同步的书同样来自公有领域。
- 「我的绘本」是用户自己拍照录入的私人内容，只存本机。
- **未内置**牛津树、红火箭、神奇校车等商业分级读物。这几套受版权保护，"收集资源"进 App 属于侵权，应用商店会下架。若已获授权，把资源按 `data.js` 的结构导进来即可。

## 八、已修问题与已知限制

1. **评分接口 502 —— 已修复并线上验证**
   原因有两个，都在服务端 `server/server.js`：
   - `Pronunciation-Assessment` 头必须传 **base64(JSON)**，原来直接传了 `JSON.stringify(...)` 原文 → Azure 返回纯文本 `Bad Request` → 再 `JSON.parse` 就报 `Unexpected token B`；
   - 配置里缺 **`ReferenceText`**（要评的那句），Azure 必定拒绝。
   另外 `Granularity` 从 `Word` 改成 `Phoneme`，否则部分资源只返回句分、逐词分全是 0。
   现在线上实测：`POST /api/score` 返回 200，`score:98 / fluency:100 / completeness:100`，逐词分正常（the 80、quick 100…）。App 侧仍保留兜底：失败时提示原因 + 保留录音 + 可重试；后端返回 `mock` 时判定为「未配置密钥」而不是给假分。

2. **OCR 契约**
   后端要求 `image` 字段带 `data:image/jpeg;base64,` 前缀，纯 base64 会返回空文本。App 已自动补前缀，线上实测识别正确。

3. **古登堡正文**
   gutenberg.org 不返回 CORS 头，浏览器直连必失败。App 现在优先走后端 `/api/gutenberg?url=` 代理，失败再退到原生 `Android.httpGet()`，最后才直连。实测线上能取到正文并自动分句（爱丽丝 24 句）。

4. **读错句子的提示**
   Azure 会给 `completeness`（完整度）。完整度 < 60% 时 App 不再逐个单词标红，而是提示「没对上句子，先听领读」——避免孩子读到别的句子时被满屏红词误导。

## 九、下一步建议

- 加账号与多学员（一个家长多个孩子）、云端同步；
- 老师/机构端：班级、作业、学情报表；
- 上架前补：隐私政策、儿童个人信息保护规则、软著、内容审核、应用商店素材。
