/**
 * 悦读绘本 · 后端代理服务（零依赖，仅用 Node 内置模块）
 * 作用：把 Azure 发音评测 / OCR.space 的密钥藏在服务端，前端只调本服务。
 * 启动：node server.js  → 打开 http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- 极简 .env 加载（无需 npm 依赖）----
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* 没有 .env 也能跑（降级为模拟） */ }

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'app');
const BOOKS = path.join(__dirname, 'books.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const MAX_BODY = 16 * 1024 * 1024;   // 16MB（约 12MB 音频 base64）
const MAX_AUDIO = 12 * 1024 * 1024;

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  // 后端健康/密钥状态（不暴露密钥本身）
  if (u.pathname === '/api/health') {
    return send(res, 200, { ok: true, azure: !!process.env.AZURE_SPEECH_KEY, ocr: !!process.env.OCR_SPACE_KEY });
  }

  // 公版绘本书目（Project Gutenberg，无需密钥）
  if (u.pathname === '/api/books') {
    try { return send(res, 200, JSON.parse(fs.readFileSync(BOOKS, 'utf8'))); }
    catch (e) { return send(res, 500, { error: 'books.json missing' }); }
  }

  // 公版绘本正文代理：gutenberg.org 无 CORS 头，浏览器直连会失败，故由后端代理转发。
  // 仅允许 gutenberg/archive 域名，避免被当作开放代理（SSRF）。
  if (u.pathname === '/api/gutenberg' && req.method === 'GET') {
    const target = u.searchParams.get('url') || '';
    const okHost = /^https:\/\/(www\.)?gutenberg\.org\//.test(target) || /^https:\/\/(www\.)?archive\.org\//.test(target);
    if (!okHost) return send(res, 400, { error: 'only gutenberg/archive urls allowed' });
    try {
      const gr = await fetch(target, { redirect: 'follow' });
      if (!gr.ok) return send(res, 502, { error: 'gutenberg fetch failed', status: gr.status });
      const text = await gr.text();
      return send(res, 200, { text: text.slice(0, 2000000) });
    } catch (e) { return send(res, 502, { error: 'gutenberg fetch failed', msg: String(e) }); }
  }

  // 发音评测（代理 Azure Pronunciation Assessment）
  if (u.pathname === '/api/score' && req.method === 'POST') {
    let text, audio, language;
    try { const j = JSON.parse(await readBody(req)); text = j.text; audio = j.audio; language = j.language; }
    catch (e) { return send(res, 400, { error: 'bad json', msg: String(e.message || e) }); }

    text = typeof text === 'string' ? text.trim() : '';
    if (!text) return send(res, 400, { error: 'text required' });
    if (typeof audio !== 'string' || !audio) return send(res, 400, { error: 'audio required' });
    if (audio.length > MAX_AUDIO) return send(res, 413, { error: 'audio too large' });

    if (!process.env.AZURE_SPEECH_KEY) {
      return send(res, 200, {
        mock: true, score: 0, words: [],
        fixes: ['服务端未配置 AZURE_SPEECH_KEY，评分不可用（不是设备问题）']
      });
    }

    const buf = Buffer.from(audio, 'base64');
    if (buf.length < 2000) return send(res, 400, { error: 'audio too short', bytes: buf.length });
    const isWav = buf.slice(0, 4).toString('ascii') === 'RIFF';
    if (!isWav) return send(res, 400, { error: 'audio must be 16k mono PCM WAV' });

    try {
      const region = process.env.AZURE_SPEECH_REGION || 'eastasia';
      const endpoint = process.env.AZURE_SPEECH_ENDPOINT ||
        `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
      const url = `${endpoint}?language=${encodeURIComponent(language || 'en-US')}&format=detailed`;

      // Azure 要求该头为 base64(JSON)，且 ReferenceText 必填（缺了必 400）。
      // Granularity 用 Phoneme：官方样例路径，必定返回逐词分（用 Word 时部分资源只回 0）。
      const paCfg = Buffer.from(JSON.stringify({
        ReferenceText: text,
        GradingSystem: 'HundredMark',
        Granularity: 'Phoneme',
        Dimension: 'Comprehensive',
        EnableMiscue: true
      })).toString('base64');

      const ar = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          'Pronunciation-Assessment': paCfg,
          'Accept': 'application/json'
        },
        body: buf   // 必须发二进制，不能发 base64 字符串
      });

      const raw = await ar.text();
      if (!ar.ok) {
        console.error('[score] azure http', ar.status, raw.slice(0, 400));
        return send(res, 502, { error: 'azure failed', status: ar.status, msg: raw.slice(0, 300) });
      }
      let j;
      try { j = JSON.parse(raw); }
      catch (e) {
        console.error('[score] azure non-json', raw.slice(0, 400));
        return send(res, 502, { error: 'azure bad json', msg: raw.slice(0, 300) });
      }

      if (j.RecognitionStatus && j.RecognitionStatus !== 'Success') {
        return send(res, 422, { error: 'no speech detected', status: j.RecognitionStatus });
      }

      const nb = (j.NBest && j.NBest[0]) || {};
      const pa = nb.PronunciationAssessment || {};
      // 逐词分：不同 Granularity / API 版本下字段位置不同，逐个兜底
      let words = (nb.Words || []).map(w => {
        const wp = w.PronunciationAssessment || {};
        const raw = wp.AccuracyScore != null ? wp.AccuracyScore
          : w.AccuracyScore != null ? w.AccuracyScore
          : w.Score != null ? w.Score
          : w.PronScore != null ? w.PronScore
          : (w.Phonemes && w.Phonemes.length
              ? w.Phonemes.reduce((a, p) => a + ((p.PronunciationAssessment && p.PronunciationAssessment.AccuracyScore) || 0), 0) / w.Phonemes.length
              : null);
        return {
          w: (w.Word || '').toLowerCase(),
          score: raw == null ? 0 : Math.round(raw)
        };
      }).filter(w => w.w);

      // 全部为 0 说明上游没给逐词分，宁可只给句分也不要画出全红的假标注
      if (words.length && words.every(o => o.score === 0)) {
        console.warn('[score] word scores all zero, dropping word detail', raw.slice(0, 600));
        words = [];
      }

      const score = Math.round(
        nb.PronScore != null ? nb.PronScore :
        pa.PronScore != null ? pa.PronScore :
        nb.AccuracyScore != null ? nb.AccuracyScore :
        pa.AccuracyScore != null ? pa.AccuracyScore :
        (words.length ? words.reduce((a, b) => a + b.score, 0) / words.length : 0)
      );

      const fixes = words.filter(o => o.score < 75).slice(0, 3)
        .map(o => `「${o.w}」发音再练练，注意元音和重音`);

      return send(res, 200, {
        score,
        words,
        fixes,
        fluency: nb.FluencyScore != null ? Math.round(nb.FluencyScore) : null,
        completeness: nb.CompletenessScore != null ? Math.round(nb.CompletenessScore) : null,
        recognized: nb.Display || j.DisplayText || ''
      });
    } catch (e) {
      console.error('[score] error', e);
      return send(res, 502, { error: 'azure failed', msg: String(e.message || e) });
    }
  }

  // OCR（代理 OCR.space）
  if (u.pathname === '/api/ocr' && req.method === 'POST') {
    let image, language;
    try { const j = JSON.parse(await readBody(req)); image = j.image; language = j.language || 'eng'; }
    catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (!image) return send(res, 400, { error: 'image required' });
    if (!process.env.OCR_SPACE_KEY) {
      return send(res, 200, { mock: true, text: '', tags: ['未配置 OCR_SPACE_KEY'] });
    }
    try {
      // OCR.space 的 base64image 要求带 data:image/...;base64, 前缀；前端若只发纯 base64，这里自动补上
      const b64 = image.startsWith('data:') ? image : 'data:image/jpeg;base64,' + image;
      const params = new URLSearchParams({ apikey: process.env.OCR_SPACE_KEY, base64image: b64, language, OCREngine: '2', isOverlayRequired: 'false' });
      const or = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });
      const raw = await or.text();
      let oj;
      try { oj = JSON.parse(raw); }
      catch (e) { return send(res, 502, { error: 'ocr bad json', msg: raw.slice(0, 200) }); }

      if (oj.IsErroredOnProcessing) {
        return send(res, 502, { error: 'ocr failed', msg: (oj.ErrorMessage || []).join('; ').slice(0, 200) });
      }
      const text = (oj.ParsedResults && oj.ParsedResults[0] && oj.ParsedResults[0].ParsedText) || '';
      return send(res, 200, { text: text.trim(), tags: ['识别结果'] });
    } catch (e) { return send(res, 502, { error: 'ocr failed', msg: String(e) }); }
  }

  // 静态文件（同时托管 prototype，方便直接打开）
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp = path.join(PUBLIC, p);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  悦读绘本后端已启动 → http://localhost:${PORT}`);
  console.log(`  打开上面的地址即可使用原型（已接入真实接口）。`);
  console.log(`  未配置密钥时自动降级为模拟评分/OCR，原型仍可用。\n`);
});
