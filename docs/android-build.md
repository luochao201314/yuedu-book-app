# 悦读绘本 · 安卓安装包（APK）构建与接入说明

## 一、出包方式（两条，随便挑）

| 方式 | 命令 | 耗时 | 说明 |
|---|---|---|---|
| **本地一键出包**（推荐） | `powershell -File tools\build-apk.ps1` | 约 20 秒 | 产物在 `release/yuedu-1.0.0.apk`，改完代码立刻拿到包 |
| 云端 GitHub Actions | push 到 main | 约 3 分钟 | 在 Actions 页面下载 Artifacts |

本地出包不需要装 Android Studio / Gradle，只要一份**便携工具链**：

```
C:\Users\luoch\.android-build\
├─ jdk-17.0.20.1+1\          # Temurin JDK 17
├─ android-14\               # build-tools 34.0.0（aapt2 / d8 / zipalign / apksigner）
└─ sdk\android-34\android.jar
```

`tools/build-apk.ps1` 会自动探测这个目录（也认 `$env:ANDROID_BUILD_HOME`），找不到才报错。
脚本流程：`build-www.js` 生成单文件前端 → 拷进 assets → `aapt2 compile/link` → `javac`（bootclasspath 带 `core-lambda-stubs.jar`）→ `d8` → 塞 `classes.dex` → `zipalign` → `apksigner`（debug 自签名，可直接安装）。

> 本工程是纯 WebView 壳、零第三方依赖，所以不用 Gradle / AGP 也能出包；`android/*.gradle` 只是给云端流水线或以后接 Android Studio 用的。

---

## 二、App 结构

- **Web 前端**（`app/`）：自包含 PWA，含领读(TTS)、跟读录音、评分纠错、拍照 OCR、成长记录，离线演示模式默认可用。
- **Android 工程**（`android/`）：`WebView` 加载 `assets/index.html`，通过 `@JavascriptInterface` 桥接系统能力（TTS / 录音 / 选文件 / 唤起网盘 / 系统浏览器）。
- **GitHub Actions**（`.github/workflows/build-apk.yml`）：云端再出一份包，作为备份渠道。

---

## 二、立刻可用的「安装版」（无需等打包）

`app/` 已是 **PWA**：用支持 PWA 的浏览器（Chrome / Edge）打开并选择「安装应用 / 添加到主屏幕」，即可在安卓桌面生成一个**全屏、像原生 App 一样**的图标。

本地验证 PWA：
```bash
cd server
node server.js            # 打开 http://localhost:3000
```
用 Chrome 访问 → 地址栏会出现「安装」图标，装到手机后即为独立 App。

---

## 四、云端出包（备用渠道）

### 1. 把整个仓库推到 GitHub
```bash
git init
git add .
git commit -m "悦读绘本 Android 工程"
gh repo create yuedu-book --private --source=. --push   # 或手动在 github.com 建仓库后 push
```

### 2. 触发打包
- 方式 A（推荐）：GitHub 仓库 → **Actions** → 选 `Build Android APK` → **Run workflow**。
- 方式 B：push 到 `main`/`master` 分支会自动触发（工作流已配置）。

### 3. 下载安装
- 跑完后进入该次运行 → **Artifacts** → `yuedu-book-apk` → 下载 `.apk`。
- 手机允许「未知来源」安装，点开 APK 即可安装。debug 签名的 APK **可直接安装与分发测试**。
- 若要上架应用商店，再自行生成 release keystore 并改 `android/app/build.gradle` 的 `signingConfig`。

---

## 五、APK 里的功能与「真实接口」开关

| 功能 | APK 默认行为 | 启用真实接口 |
|---|---|---|
| 领读 TTS | ✅ 端侧真实朗读（离线） | — |
| 跟读录音 | ✅ 真实录音(WAV 16k) | — |
| 发音评分/纠错 | 🟡 模拟演示 | 在「我的 → 后端地址」填入你部署的服务器(https)，返回 Azure 评测结果 |
| 拍照 OCR | 🟡 模拟演示 | 同上，返回 OCR.space 结果 |
| 公版绘本同步 | 需后端 | 同上 |

> 后端地址填的是你自己的 `server/`（`node server.js`，已接 Azure/OCR.space，密钥只在服务端）。部署到公网 https 域名后，在 App 内填入该地址即可启用真实评分与 OCR。

---

## 六、申请密钥（需你本人操作，见 api-readme.md）
- **Azure 发音评测 F0**：免费 5 音频小时/月，绑定信用卡不扣费。
- **OCR.space 免费档**：邮箱注册，25,000 次/月，无需信用卡。
- **Project Gutenberg**：公版资源，无需密钥。

填入 `server/.env` 后重启 `node server.js`，把该服务的公网 https 地址填进 App「后端地址」即可。

---

## 七、目录结构
```
app/                         # PWA 前端（也是 APK 内打包的资源）
  index.html  manifest.webmanifest  sw.js  icons/
android/                     # Android Studio 工程（手写，可导入 AS）
  app/src/main/java/.../MainActivity.java
  app/src/main/assets/www/   # 由工作流从 app/ 复制
  app/build.gradle  settings.gradle  build.gradle
server/                      # 后端代理（Azure/OCR.space 密钥在此）
.github/workflows/build-apk.yml
docs/android-build.md  docs/api-readme.md  docs/free-apis.html
```

## 八、已知约束
- 本机无 Android SDK，APK 由云端构建；我无法在此预览真机安装效果，但工程与流水线均为标准配置。
- 跟读麦克风依赖 `https` 安全上下文，`WebViewAssetLoader` 已满足；若部分老旧 WebView 内核不支持 `getUserMedia`，可改用端侧原生录音桥接（后续迭代）。
- 牛津树/红火箭/神奇校车受版权保护，示例数据仅演示；正式上线请用公版或用户拍照录入自有书。
