# 后端接口说明 / 评分接口修复指南

App 端只依赖 4 个接口。前端已按这份契约实现（`www/js/core.js` 的 `Api`）。

---

## 一、修复记录（2026-10-29，已上线验证）

**修复前**
```
GET  /api/health  → 200 {"ok":true,"azure":true,"ocr":true}
GET  /api/books   → 200 古登堡书单
POST /api/ocr     → 200（image 需带 data URL 前缀）
POST /api/score   → 502 {"error":"azure failed","msg":"SyntaxError: Unexpected token B in JSON at position 0"}
```

**根因（两处，都在 `server/server.js`）**

1. `Pronunciation-Assessment` 头必须是 **base64(JSON)**，原代码直接传了 `JSON.stringify(...)` 原文。
   Azure 收到非法头 → 返回纯文本 `Bad Request` → 再 `JSON.parse` 纯文本 → `Unexpected token B in JSON at position 0`。这就是那个 502 的全部来源。
2. 配置里缺 **`ReferenceText`**（要评的那句话）。Azure 发音评测必填，缺了同样 400。

**修复后（线上实测，音频为 16k 单声道 WAV）**

```
POST /api/score 200
{"score":98,"fluency":100,"completeness":100,
 "recognized":"The quick brown fox jumps over the lazy dog.",
 "words":[{"w":"the","score":80},{"w":"quick","score":100}, ...],"fixes":[]}
```

**额外踩到的一个坑：`Granularity` 要用 `Phoneme`**

最初按文档把 `Granularity` 写成 `Word`，响应里 `PronScore` 正常（98），但 `Words[].PronunciationAssessment.AccuracyScore` **全是 0**，前端会把整句画成红色（假标注）。
改成 `Phoneme`（官方样例的用法）后逐词分正常返回。服务端同时做了两层保护：

- 逐词分字段多路兜底：`PronunciationAssessment.AccuracyScore` → `AccuracyScore` → `Score` → 音素分平均；
- 若整句逐词分仍然全为 0，则**丢弃 word 列表**只给句分，彻底避免假标注。

**顺带修掉的**

- 音频改为 `Buffer.from(audio,'base64')` 以二进制 PUSH 给 Azure（原来是发字符串）；
- `Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000`；
- 增加 body/音频/`RIFF` 头校验、`RecognitionStatus` 处理、`AZURE_SPEECH_ENDPOINT` 覆盖（便于本地 mock）、Azure 非 JSON 响应单独报错；
- 缺 `AZURE_SPEECH_KEY` 时返回 `{mock:true}`，App 会判定为「未配置密钥」而不是把假分数当真实成绩。

> 仍建议保留一条排查纪律：在 `JSON.parse` 之前先看 `res.status` 和原始文本，一眼就能分辨 401/400 与网关页。

---

## 一·附、原始故障排查记录（存档）

```
GET  /api/health  → 200 {"ok":true,"azure":true,"ocr":true}
GET  /api/books   → 200 古登堡书单
POST /api/ocr     → 200（image 带 data URL 前缀时正常返回文字；纯 base64 返回空）
POST /api/score   → 502 {"error":"azure failed","msg":"SyntaxError: Unexpected token B in JSON at position 0"}
```

**结论：评分链路是后端 bug，不是 App 传参问题。** 证据：

- 用真实 16kHz / 16bit / 单声道英文 WAV（SAPI 合成）请求，仍然 502；
- 试过 `audio` 纯 base64、`data:audio/wav;base64,` 前缀、`wav`、`audioBase64`、加 `format/sampleRate` 字段，全部 502；
- 错误信息是 **JSON.parse 拿到了非 JSON**，且首字符是 `B` —— 典型的 Azure 网关返回纯文本 `Bad Request`。

最常见的三种成因（按概率排序）：

1. **把 base64 字符串直接当 body 发给了 Azure**（没有 `Buffer.from(audio,'base64')`）。Azure 收到的不是 WAV 二进制，返回 400 → 代码 `JSON.parse` 纯文本 → `Unexpected token B`。
2. **Content-Type 不完整**：必须是 `audio/wav; codecs=audio/pcm; samplerate=16000`，只写 `audio/wav` 有时会被拒。
3. **region / key 不匹配或 endpoint 拼错**（例如把 `stt.speech.microsoft.com` 写成 `cognitiveservices.azure.com`），请求被网关挡掉，返回纯文本。

> 排查建议：在 `JSON.parse` 前先 `console.log(res.status, await res.text())`，把 Azure 的原始响应打出来，一眼就能看出是 401/400 还是网关页。

---

## 二、接口契约

### GET /api/health
```json
{ "ok": true, "azure": true, "ocr": true }
```

### GET /api/books
```json
[{ "id": 11, "title": "爱丽丝梦游仙境", "titleEn": "Alice's Adventures in Wonderland",
   "author": "Lewis Carroll", "level": "L4", "url": "https://www.gutenberg.org/files/11/11-0.txt",
   "intro": "Alice was beginning to get very tired..." }]
```

### POST /api/ocr
请求：
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ...", "language": "eng" }
```
> `image` 必须带 `data:image/...;base64,` 前缀（实测纯 base64 返回空文本）。

响应：
```json
{ "text": "The rabbit ran into the garden.\nIt was a sunny morning." }
```

### POST /api/score
请求：
```json
{ "text": "The rabbit ran into the garden.", "audio": "<16k 单声道 WAV 的 base64>" }
```
响应（线上实测结构）：
```json
{
  "score": 98,
  "words": [{ "w": "the", "score": 80 }, { "w": "quick", "score": 100 }],
  "fixes": [],
  "fluency": 100,
  "completeness": 100,
  "recognized": "The quick brown fox jumps over the lazy dog."
}
```
App 端做了宽松归一化，也兼容 `PronScore / AccuracyScore / NBest[0].Words` 等 Azure 原生字段，但建议直接返回上面的结构。
`completeness` 用于判断"这遍读的是不是这句"：低于 60% 时 App 只提示重读，不逐词标红。
未配置密钥时返回 `{ "mock": true, ... }`，App 会当成失败处理，不会给假分。

### GET /api/gutenberg?url=<gutenberg 正文直链>
```json
{ "text": "*** START OF THE PROJECT GUTENBERG EBOOK ..." }
```
仅允许 `gutenberg.org` / `archive.org` 域名（防 SSRF）。App 取正文优先走这个代理，绕开浏览器 CORS。

---

## 三、可直接替换的参考实现（Node / Express）

```js
const express = require('express');
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION || 'eastus';

app.get('/api/health', (req, res) => res.json({ ok: true, azure: !!KEY, ocr: true }));

app.post('/api/score', async (req, res) => {
  const { text, audio } = req.body || {};
  if (!text || !audio) return res.status(400).json({ error: 'text and audio required' });

  // 关键 1：base64 -> Buffer（反过来就是 502 的根源）
  const wav = Buffer.from(audio, 'base64');
  if (wav.length < 1000) return res.status(400).json({ error: 'audio too short' });

  const cfg = Buffer.from(JSON.stringify({
    ReferenceText: text,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    EnableMiscue: true
  })).toString('base64');

  const url = `https://${REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
              `?language=en-US&format=detailed`;

  let r, raw;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        // 关键 2：Content-Type 要带 codecs 与采样率
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': cfg,
        'Accept': 'application/json'
      },
      body: wav                       // 关键 3：发二进制，不发 base64
    });
    raw = await r.text();
  } catch (e) {
    return res.status(502).json({ error: 'azure unreachable', msg: e.message });
  }

  if (!r.ok) {
    // 关键 4：先看原文再决定，不要把非 JSON 直接 JSON.parse
    console.error('azure', r.status, raw.slice(0, 500));
    return res.status(502).json({ error: 'azure failed', status: r.status, msg: raw.slice(0, 300) });
  }

  let data;
  try { data = JSON.parse(raw); }
  catch (e) { return res.status(502).json({ error: 'azure bad json', msg: raw.slice(0, 300) }); }

  const nb = (data.NBest && data.NBest[0]) || {};
  const words = (nb.Words || []).map(w => ({
    w: (w.Word || '').toLowerCase(),
    score: Math.round((w.PronunciationAssessment && w.PronunciationAssessment.AccuracyScore) || 0)
  })).filter(w => w.w);

  const score = Math.round(nb.PronScore != null ? nb.PronScore
              : nb.AccuracyScore != null ? nb.AccuracyScore
              : words.reduce((a, b) => a + b.score, 0) / Math.max(1, words.length));

  // 逐词分全 0 说明上游没给，宁可只给句分也不要画全红
  const wordList = words.length && words.every(w => w.score === 0) ? [] : words;

  const fixes = wordList.filter(w => w.score < 70).slice(0, 3)
    .map(w => `「${w.w}」发音再练练，注意元音和重音`);

  res.json({
    score,
    words: wordList,
    fixes,
    fluency: nb.FluencyScore != null ? Math.round(nb.FluencyScore) : null,
    completeness: nb.CompletenessScore != null ? Math.round(nb.CompletenessScore) : null,
    recognized: nb.Display || data.DisplayText || ''
  });
});

app.listen(process.env.PORT || 3000);
```

### 自测

```bash
# 1) 健康
curl https://<你的域名>/api/health

# 2) 评分（用 16k 单声道 WAV）
B64=$(base64 -w0 test16k.wav)
curl -X POST https://<你的域名>/api/score \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"The rabbit ran into the garden.\",\"audio\":\"$B64\"}"

# 3) OCR（注意 data URL 前缀）
curl -X POST https://<你的域名>/api/ocr \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"data:image/jpeg;base64,$(base64 -w0 page.jpg)\",\"language\":\"eng\"}"
```

期望评分响应：`{"score":86,"words":[{"w":"the","score":95},...],"fixes":[...]}`

---

## 四、部署注意事项

- **密钥只放服务端**，不要打进 APK（APK 可被反编译，密钥会泄露并被刷爆额度）。
- Render 免费实例会休眠，首次请求 30–60 秒；App 端评分超时 90 秒、健康检查 45 秒，已做冷启动提示。
- 录音时长限制 20 秒/句（App 端自动停止），JSON 体积 < 8MB，`express.json({limit:'12mb'})` 足够。
- 若换用腾讯云/讯飞评测，只需保持上面的**响应结构**不变，App 无需改动。

---

## 五、App 端可配置项

| 位置 | 作用 |
|---|---|
| 我的 → 后端服务 | 改 `backend`，保存后立即生效；点「保存并检测」走 `/api/health` |
| 我的 → 朗读设置 | 语速 0.6–1.2x、中文提示开关、录音后自动评分开关 |
| 我的 → 数据 | 导出 JSON / 清空本机 |

> 健康检查只能证明服务活着，不能证明评分可用；真实结果以跟读时返回为准（UI 已按此措辞）。
