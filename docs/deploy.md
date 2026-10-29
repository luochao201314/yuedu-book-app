# 后端部署指南（悦读绘本 · 真实接口）

目标：把 `server/` 部署成一个 **公网 https 地址**，让手机 App / 安卓 APK 能调用**真实的 Azure 发音评测**与 **OCR.space 拍照识别**。

> 重要：Azure Key 和 OCR Key **永远只放在后端**，由后端代理调用，绝不下发到 App。App 里只填「后端地址」。

---

## 一、密钥填在哪里（再确认一次）

两个 Key 都填在**后端**，不是 App：

| 密钥 | 环境变量名 | 填写位置 |
|---|---|---|
| Azure 语音评测 Key | `AZURE_SPEECH_KEY` | 后端环境变量（Render 面板 / `.env` / 服务器 export） |
| Azure 区域 | `AZURE_SPEECH_REGION` | 同上，如 `eastasia` |
| OCR.space Key | `OCR_SPACE_KEY` | 同上 |

本地开发时：`cp server/.env.example server/.env` 然后填值（`.env` 已被 gitignore，不会入库）。
云端部署时：在平台控制台填入对应环境变量，不提交任何含密钥的文件。

---

## 二、方案 A：Render 一键部署（推荐，免费、自带 https）

仓库已包含 `render.yaml`，可「蓝图」式一键部署。**前提：上一步已将代码推到 GitHub（`yuedu-book-app` 仓库有内容）。**

### 逐屏操作步骤

**第 1 步：注册 / 登录 Render**
1. 打开 https://render.com
2. 点右上角 **「Get Started」** 或 **「Sign In」**
3. 选 **「Sign in with GitHub」**（用你 GitHub 账号 `luochao201314` 授权，和 GitHub Desktop 同一个账号，不用再注册）

**第 2 步：用 Blueprint 连接仓库（关键：选 Blueprint 不是 Web Service）**
1. 登录后进入 Dashboard，右上角点 **「New」** → 选 **「Blueprint」**（⚠️ 不要选 Web Service；选 Blueprint 才会自动读取仓库里的 `render.yaml`）
2. 首次会让你 **Authorize GitHub**（授权 Render 访问你的仓库），点授权
3. 授权后 Render 列出你的仓库，找到并选 **`yuedu-book-app`**
4. Render 解析 `render.yaml`，会显示一个待创建的服务：**`yuedu-book-backend`**（已自动带好：rootDir=server、startCommand=npm start、plan=free、region=singapore、healthCheck=/api/health）

**第 3 步：填写密钥环境变量**
在「Environment Variables / 环境变量」区域，Render 会列出从 `render.yaml` 读到的变量：
- `NODE_VERSION` = `18`（自动，不用动）
- `AZURE_SPEECH_REGION` = `eastasia`（自动；**只有你 Azure 资源建在别的区域才改**，如 `eastus`）
- `AZURE_SPEECH_KEY` 标记为 `sync: false` → 点它右侧的 **「Add secret value」/ 输入框**，粘贴你的 **Azure Key1**
- `OCR_SPACE_KEY` 标记为 `sync: false` → 同样点输入框，粘贴你的 **OCR.space Key**

> 这两个 key 填在 Render 的环境变量里，**不会进代码仓库**，安全。

**第 4 步：创建并等待部署**
1. 页面底部点 **「Apply」**（或 **「Create」**）
2. 进入服务页，看到 **「Deploy in progress…」**，下方日志滚动；等出现 `Server running` 类提示、状态变 **「Live」**（通常 1~3 分钟）
3. 如果部署失败，看日志报错（最常见是环境变量名拼错），改完点 **「Manual Deploy → Deploy latest commit」** 重来

**第 5 步：拿到你的 https 地址**
1. 服务页**顶部**会显示一行 URL，形如：
   ```
   https://yuedu-book-backend.onrender.com
   ```
   （也可能叫 `https://yuedu-book-xxx.onrender.com`，以你页面显示的为准）
2. 点一下这个链接能打开后端首页（显示 App 的 PWA 页面）即说明部署成功。

**第 6 步：验证后端健康检查**
浏览器访问：
```
https://<你的地址>/api/health
```
返回（已填密钥）：
```json
{ "ok": true, "azure": true, "ocr": true }
```
若 `azure:false` / `ocr:false`，说明对应密钥没填对 → 回 Render 服务页 **Environment** 标签补填，再 **Manual Deploy** 一次。

### 把地址填回 App（启用真实接口）
1. 打开 App（安卓 APK 或 PWA 安装版）→ 底部 **「我的 👤」**
2. 点 **「🔗 后端地址（真实接口）」**
3. 粘贴 `https://yuedu-book-backend.onrender.com`（**必须 https、结尾不要斜杠**）
4. 保存 → 状态从 🟡 离线演示 变 **🟢 真实（已连接）**
5. 之后跟走真实 Azure 评分、拍照走真实 OCR.space；未配密钥自动降级模拟。

> 免费档特性：闲置会自动休眠，第一次访问可能慢 20~40 秒（冷启动），之后正常。
> 想常驻不休眠：升级付费档，或改用「方案 C 自有服务器」。

---

## 三、方案 B：Railway 部署

1. 打开 https://railway.app → 用 GitHub 登录。
2. **New Project** → **Deploy from GitHub repo** → 选本仓库。
3. 在 Project 里 **Settings → Networking** 勾选「This is a web server」，并指定：
   - Root Directory：`server`
   - Start Command：`npm start`
4. **Variables** 中添加：`AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION=eastasia`、`OCR_SPACE_KEY`。
5. 部署后 Railway 会分配一个 `https://xxx.up.railway.app` 域名（也可绑定自定义域名）。

---

## 四、方案 C：自有服务器（如阿里云/腾讯云轻量应用服务器）

适合长期使用、不想受免费档休眠限制：

1. 服务器装 Node 18+：`curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt install -y nodejs`
2. 拉取代码：`git clone <你的仓库> && cd 项目/server`
3. 装依赖（本项目零依赖，可跳过）并准备环境变量：
   ```bash
   cp .env.example .env
   # 编辑 .env 填入 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION / OCR_SPACE_KEY
   ```
4. 用进程管理器常驻（二选一）：
   - PM2：`npm i -g pm2 && pm2 start server.js --name yuedu`
   - 或直接 `node server.js &`
5. 用 nginx 反代 + 免费证书（Let's Encrypt）暴露 https：
   ```nginx
   server {
     listen 443 ssl;
     server_name your.domain.com;
     ssl_certificate     /path/fullchain.pem;
     ssl_certificate_key /path/privkey.pem;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
     }
   }
   ```
6. 得到 `https://your.domain.com` 填入 App。

---

## 五、把地址填回 App，启用真实接口

1. 打开 App（安卓 APK 或 PWA 安装版）→ 底部 **「我的 👤」**。
2. 点 **「🔗 后端地址（真实接口）」**。
3. 粘贴部署得到的地址，例如 `https://yuedu-book-backend.onrender.com`（**必须是 https，结尾不要斜杠**）。
4. 保存 → 状态从 🟡 离线演示 变 **🟢 真实（已连接）**。
5. 之后：
   - 「跟读」走真实 Azure 发音评测（逐词绿/黄/红 + 纠错）；
   - 「拍照录入」走真实 OCR.space 识别；
   - 未配置密钥时自动降级为模拟，不影响使用。

---

## 六、验证部署是否成功

部署后直接访问：
```
https://<你的地址>/api/health
```
返回示例（已填密钥）：
```json
{ "ok": true, "azure": true, "ocr": true }
```
若 `azure:false` 或 `ocr:false`，说明对应密钥没填对，回到平台环境变量补填并重新部署。

也可在 App 里点「🌐 同步公版绘本」测试连通性：能拉到 5 本公版书即后端可达。

---

## 七、注意事项

- **https 必需**：手机浏览器 / 安卓 WebView 会拦截 http 后端，务必用 https 地址。
- **CORS 已开放**：`server.js` 对 `/api/` 全部开放跨域，App 跨域调用无需额外配置。
- **免费额度**：Azure F0 每月 5 音频小时；OCR.space 免费档 25,000 次/月。超量后后端自动降级为模拟并提示，不会崩溃。
- **APK 本身已就绪**：安卓安装包走 `.github/workflows/build-apk.yml` 云端打包，与后端部署互不依赖；APK 装好后用本指南的地址启用真实接口即可。
- **版权**：牛津树/红火箭/神奇校车等受版权保护，不能抓取；公版书走 Gutenberg，受版权书走用户拍照录入自有书。
