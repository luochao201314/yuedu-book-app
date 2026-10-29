# 悦读绘本 · 接口申请与接入说明

按「最优组合」接入：领读=端侧 TTS（原型已用浏览器原生，免费）｜ 拍照 OCR=云端 OCR.space（原生 App 用 ML Kit 端侧）｜ 跟读评分=Azure 发音评测 F0 ｜ 公版资源=Project Gutenberg（免费）。

## 一、申请密钥（需你本人操作）

### 1. Azure 语音评测（发音评分）— 免费 F0
1. 打开 https://portal.azure.com ，用微软账号登录（**免费层需绑定信用卡，但 F0 不扣费**）。
2. 顶部搜索 **"Speech"** → 创建 **Speech** 资源（选 **F0 免费档**）。
3. 资源创建后，左侧 **Keys and Endpoint** 复制 **Key1** 和 **Region**（如 `eastasia`）。
4. 把 Key 和 Region 填入 `server/.env` 的 `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`。
> 额度：F0 每月 **5 音频小时**，长期有效。返回逐词/音素准确度，可定位到具体单词。

### 2. OCR.space（拍照录入，可选云端路径）— 免费档
1. 打开 https://ocr.space/ 注册（**邮箱即可，无需信用卡**）。
2. 注册后在控制台获取 **API Key**。
3. 填入 `server/.env` 的 `OCR_SPACE_KEY`。
> 额度：免费档 **25,000 次/月**，单文件 ≤1MB。原生 App 推荐用 **Google ML Kit 端侧 OCR**（完全免费、无需密钥、可离线），本 Web 原型用 OCR.space 作为可演示的云端路径。

### 3. Project Gutenberg（公版资源）— 无需密钥
- 已在 `server/books.json` 内置 5 本真实公版书（彼得兔、爱丽丝、绿野仙踪、伊索寓言、格林童话），书目与正文直链免费、公版，可直接用。

## 二、配置与启动

```bash
cd server
cp .env.example .env      # 然后编辑 .env 填入上面申请的密钥
node server.js            # 需要 Node 18+（用到全局 fetch）
```

启动后打开 **http://localhost:3000** 即可使用原型。
- 顶部会显示连接状态：🟢 已连接真实接口 / 🟡 演示模式（未配置密钥，使用模拟评分/OCR）。
- **未配置密钥时自动降级**：评分、OCR 走模拟逻辑，原型功能照常可演示。

## 三、密钥安全
- 所有云端密钥只放在**服务端 `.env`**，由 `server.js` 代理转发，**绝不下发到前端/App 包**，防止反编译盗刷。
- `.env` 已被 `.gitignore` 风格管理，请勿提交到公开仓库。

## 四、原生 App 落地提示
- **iOS/Android 领读**：用端侧 `AVSpeechSynthesizer` / `TextToSpeech`，免费离线。
- **拍照 OCR**：用 **Google ML Kit Text Recognition**（端侧、免费、无密钥），无需走本服务端 OCR 代理。
- **跟读评分**：原生端用 Azure **Speech SDK** 直接调用发音评测（密钥仍走你自己的后端代理签名）。

## 五、验证清单
- [ ] `node server.js` 启动无报错
- [ ] 浏览器打开 http://localhost:3000，状态为 🟢（配置密钥后）
- [ ] 绘本库点「🌐 同步公版绘本」能看到 5 本公版书
- [ ] 进入公版书能拉取 Gutenberg 正文并分句
- [ ] 跟读录音后返回真实分数与逐词纠错
- [ ] 拍照录入返回真实 OCR 文字
