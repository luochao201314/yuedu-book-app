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

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => resolve(b)); req.on('error', reject);
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
      const gr = await fetch(target);
      const text = await gr.text();
      return send(res, 200, { text });
    } catch (e) { return send(res, 502, { error: 'gutenberg fetch failed', msg: String(e) }); }
  }

  // 发音评测（代理 Azure Pronunciation Assessment）
  if (u.pathname === '/api/score' && req.method === 'POST') {
    let text, audio;
    try { const j = JSON.parse(await readBody(req)); text = j.text; audio = j.audio; }
    catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (!process.env.AZURE_SPEECH_KEY) {
      return send(res, 200, { mock: true, score: 0, words: [], fixes: ['未配置 AZURE_SPEECH_KEY，已降级为模拟评分（见 README）'] });
    }
    try {
      const region = process.env.AZURE_SPEECH_REGION || 'eastasia';
      const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;
      const buf = Buffer.from(audio, 'base64');
      const ar = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          'Pronunciation-Assessment': JSON.stringify({ GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive' })
        },
        body: buf
      });
      // 防御：Azure 返回非 JSON（如 400 Bad Request 文本）时，ar.json() 会抛 SyntaxError。
      // 先读文本、判 content-type，异常时降级为友好提示而非 502。
      const ct = ar.headers.get('content-type') || '';
      const raw = await ar.text();
      if (!ar.ok || !ct.includes('json')) {
        return send(res, 200, { mock: true, score: 0, words: [], fixes: ['Azure 返回错误：' + raw.slice(0, 120)] });
      }
      const j = JSON.parse(raw);
      const nb = (j.NBest && j.NBest[0]) || {};
      const pa = nb.PronunciationAssessment || {};
      const words = (nb.Words || []).map(w => ({ w: (w.Word || '').toLowerCase(), score: Math.round((w.PronunciationAssessment && w.PronunciationAssessment.AccuracyScore) || 0) }));
      const fixes = words.filter(o => o.score < 75).map(o => `「${o.w}」发音再练练`);
      return send(res, 200, { score: Math.round(pa.AccuracyScore || pa.ComprehensiveScore || 0), words, fixes, detail: pa });
    } catch (e) { return send(res, 502, { error: 'azure failed', msg: String(e) }); }
  }

  // OCR（代理 OCR.space）
  if (u.pathname === '/api/ocr' && req.method === 'POST') {
    let image, language;
    try { const j = JSON.parse(await readBody(req)); image = j.image; language = j.language || 'eng'; }
    catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (!process.env.OCR_SPACE_KEY) {
      return send(res, 200, { mock: true, text: '（未配置 OCR_SPACE_KEY，已降级为模拟识别）', tags: ['L1', '识别结果'] });
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
      const oj = await or.json();
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
