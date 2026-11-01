/**
 * 悦读绘本 · 后端代理服务（零依赖，仅用 Node 内置模块）
 * 作用：把 Azure 发音评测 / OCR.space 的密钥藏在服务端，前端只调本服务。
 * 启动：node server.js  → 打开 http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

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
const AUDIO_MAX = 40 * 1024 * 1024;  // 音频代理/网盘流上限 40MB
const ipaCache = new Map();          // 单词 → { at, data }
const panSessions = new Map();       // 网盘授权会话：state → { accessToken, refreshToken, expiresAt }

/* 只允许公网 http(s) 目标，挡住内网地址（避免被当成 SSRF 跳板） */
function isPrivateIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;
  if (s.indexOf(':') < 0) {
    const p = s.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !isFinite(n))) return true;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  const v = s.toLowerCase();
  return v === '::1' || v === '::' || v.indexOf('fc') === 0 || v.indexOf('fd') === 0 || v.indexOf('fe80') === 0;
}
async function assertPublicUrl(raw) {
  let t;
  try { t = new URL(raw); } catch (e) { throw new Error('地址格式不对'); }
  if (!/^https?:$/.test(t.protocol)) throw new Error('只支持 http / https 链接');
  let addrs = [];
  try { addrs = await dns.lookup(t.hostname, { all: true }); } catch (e) { throw new Error('域名解析失败'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('不允许访问内网地址');
  return t;
}

/* 透传音频（支持 Range，<audio> 拖动进度条才顺滑） */
async function streamAudio(res, req, target, extraHeaders) {
  const headers = Object.assign(
    { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
    extraHeaders || {}
  );
  if (req.headers.range) headers.Range = req.headers.range;
  const r = await fetch(target, { headers, redirect: 'follow' });
  const h = {};
  ['content-type', 'accept-ranges', 'content-range', 'content-length', 'etag', 'last-modified'].forEach((k) => {
    const v = r.headers.get(k);
    if (v) h[k] = v;
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > AUDIO_MAX) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '音频超过 40MB，请先用更短的片段' }));
  }
  h['Cache-Control'] = 'no-store';
  res.writeHead(r.status, h);
  res.end(buf);
}

/* 百度网盘：刷新 access_token */
async function panRefresh(sid) {
  const s = panSessions.get(sid);
  if (!s || !s.refreshToken) return null;
  if (!process.env.BAIDU_PAN_APPKEY || !process.env.BAIDU_PAN_SECRET) return null;
  const url = 'https://openapi.baidu.com/oauth/2.0/token?grant_type=refresh_token' +
    '&refresh_token=' + encodeURIComponent(s.refreshToken) +
    '&client_id=' + encodeURIComponent(process.env.BAIDU_PAN_APPKEY) +
    '&client_secret=' + encodeURIComponent(process.env.BAIDU_PAN_SECRET);
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => null);
  if (!j || !j.access_token) return null;
  s.accessToken = j.access_token;
  s.refreshToken = j.refresh_token || s.refreshToken;
  s.expiresAt = Date.now() + (Number(j.expires_in) || 0) * 1000;
  panSessions.set(sid, s);
  return s.accessToken;
}


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

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  // 后端健康/密钥状态（不暴露密钥本身）；ver 用来确认 Render 是否已部署最新代码
  if (u.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      azure: !!process.env.AZURE_SPEECH_KEY,
      tts: !!process.env.AZURE_SPEECH_KEY,
      asr: !!process.env.AZURE_SPEECH_KEY,
      ocr: !!process.env.OCR_SPACE_KEY,
      pan: !!(process.env.BAIDU_PAN_APPKEY && process.env.BAIDU_PAN_SECRET),
      ver: 7
    });
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

  // 云端神经网络朗读（代理 Azure 语音合成）。与发音评测共用 AZURE_SPEECH_KEY。
  // 返回 mp3(base64)；未配置密钥时返回 {mock:true}，前端自动退回设备原生 TTS。
  if (u.pathname === '/api/tts' && req.method === 'POST') {
    let text, lang, rate, voice;
    try { const j = JSON.parse(await readBody(req)); text = j.text; lang = j.lang || 'en-US'; rate = j.rate; voice = j.voice; }
    catch (e) { return send(res, 400, { error: 'bad json' }); }
    text = typeof text === 'string' ? text.trim() : '';
    if (!text) return send(res, 400, { error: 'text required' });
    if (text.length > 2000) return send(res, 400, { error: 'text too long' });

    if (!process.env.AZURE_SPEECH_KEY) {
      return send(res, 200, { mock: true, audio: '', note: '未配置 AZURE_SPEECH_KEY，无法使用云端朗读' });
    }
    try {
      const region = process.env.AZURE_SPEECH_REGION || 'eastasia';
      // AZURE_TTS_ENDPOINT 仅用于本地 mock 联调，线上不设
      const endpoint = process.env.AZURE_TTS_ENDPOINT ||
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const safeLang = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang) ? lang : 'en-US';
      const isZh = /^zh/i.test(safeLang);
      const safeVoice = typeof voice === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,16}){2,3}$/.test(voice)
        ? voice : '';
      const voiceName = safeVoice || (isZh ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural');
      const r2 = Math.max(0.5, Math.min(1.5, typeof rate === 'number' && isFinite(rate) ? rate : 1));
      // SSML 的 prosody rate 只接受百分比或相对数，"1x" 这种写法会被 Azure 判 400
      const pct = Math.round((r2 - 1) * 100);
      const prosody = pct === 0 ? '' : (pct > 0 ? '+' : '') + pct + '%';

      const buildSsml = (withProsody) => {
        const body = withProsody && prosody
          ? '<prosody rate="' + prosody + '">' + escapeXml(text) + '</prosody>'
          : escapeXml(text);
        return '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + safeLang + '">\n' +
          '  <voice name="' + voiceName + '">\n    ' + body + '\n  </voice>\n' +
          '</speak>';
      };

      const synth = async (ssml) => fetch(endpoint, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
          // Azure 合成接口要求带 User-Agent，缺了会直接 400
          'User-Agent': 'yuedu-book/1.0'
        },
        body: ssml
      });

      let tr = await synth(buildSsml(true));
      let errText = '';
      if (!tr.ok) {
        errText = (await tr.text()).slice(0, 300);
        console.error('[tts] azure http', tr.status, errText);
        // 第一层兜底：去掉 prosody 再试一次（语速参数最容易被判非法）
        tr = await synth(buildSsml(false));
        if (!tr.ok) {
          errText = (await tr.text()).slice(0, 300);
          console.error('[tts] azure retry http', tr.status, errText);
          // 任意异常都降级为 mock，让前端退回设备原生 TTS，避免卡顿
          return send(res, 200, {
            mock: true, audio: '',
            note: '云端朗读失败，已退回设备朗读',
            upstream: tr.status, detail: errText.slice(0, 160)
          });
        }
      }
      const buf = Buffer.from(await tr.arrayBuffer());
      if (!buf.length) {
        return send(res, 200, { mock: true, audio: '', note: '云端朗读返回空音频', upstream: tr.status });
      }
      return send(res, 200, { audio: buf.toString('base64'), format: 'mp3', voice: voiceName });
    } catch (e) {
      console.error('[tts] error', e);
      return send(res, 200, { mock: true, audio: '', note: '云端朗读异常，已退回设备朗读', detail: String(e).slice(0, 160) });
    }
  }

  // 单词音标（IPA）：代理 dictionaryapi.dev（免费、无密钥），命中缓存 24h / 未命中只缓存 5 分钟
  if (u.pathname === '/api/ipa' && req.method === 'GET') {
    const w = String(u.searchParams.get('word') || '').trim().toLowerCase().replace(/[^a-z'\-]/g, '').slice(0, 40);
    if (!w) return send(res, 400, { error: 'word required' });
    const hit = ipaCache.get(w);
    const ttl = hit && !hit.data.ipa ? 5 * 60 * 1000 : 24 * 3600 * 1000;
    if (hit && Date.now() - hit.at < ttl) return send(res, 200, hit.data);

    // 主源：dictionaryapi.dev；备用源：freedictionaryapi.com
    // 两个源在国内/共享出口 IP 下都会偶发 404 限流，所以各自重试一次，拿不到再换源
    const withRetry = async (fn, times) => {
      let lastErr = null;
      for (let i = 0; i < times; i++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          if (i + 1 < times) await new Promise((r) => setTimeout(r, 320));
        }
      }
      throw lastErr || new Error('upstream failed');
    };

    const getJson = async (url) => {
      const ir = await fetch(url, {
        headers: { 'User-Agent': 'yuedu-book/1.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (!ir.ok) {
        const err = new Error('upstream ' + ir.status);
        err.status = ir.status;
        throw err;
      }
      return ir.json();
    };

    const fromDictApi = () =>
      withRetry(async () => {
        const j = await getJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w));
        const e = Array.isArray(j) ? j[0] : null;
        const list = (e && e.phonetics) || [];
        let ipa = (e && e.phonetic) || '';
        if (!ipa) {
          const p = list.find((x) => x && x.text);
          ipa = p ? p.text : '';
        }
        const audio = ((list.find((x) => x && x.audio) || {}).audio) || '';
        if (!ipa) {
          const nf = new Error('empty');
          nf.status = 404;
          throw nf;
        }
        return { word: w, ipa: ipa, audio: audio || '' };
      }, 2);

    const fromFreeApi = () =>
      withRetry(async () => {
        const j = await getJson('https://freedictionaryapi.com/api/v1/entries/en/' + encodeURIComponent(w));
        const entries = (j && j.entries) || [];
        for (const e of entries) {
          const list = (e && e.pronunciations) || [];
          const p = list.find((x) => x && x.type === 'ipa' && x.text);
          if (p) return { word: w, ipa: p.text, audio: '' };
        }
        const nf = new Error('empty');
        nf.status = 404;
        throw nf;
      }, 2);

    let data = null;
    let allNotFound = true;
    for (const src of [fromDictApi, fromFreeApi]) {
      try {
        data = await src();
        break;
      } catch (e) {
        if (e.status !== 404) allNotFound = false;
      }
    }
    if (data && data.ipa) {
      ipaCache.set(w, { at: Date.now(), data });
      return send(res, 200, data);
    }
    if (allNotFound) {
      // 两个源都明确说没这个词：短缓存，避免一次抖动把词判死
      const miss = { word: w, ipa: '', note: 'not found' };
      ipaCache.set(w, { at: Date.now(), data: miss });
      return send(res, 200, miss);
    }
    // 上游抖动/超时：不缓存，下次点这个词还能再试
    return send(res, 200, { word: w, ipa: '', note: 'upstream' });
  }

  // ---------------- 语音转写（音频 → 文稿） ----------------
  // 前端把音频按静音切成 ≤12s 的 16k 单声道 WAV 片段逐段上传，这里返回该段的英文文本。
  // 与发音评测共用 AZURE_SPEECH_KEY。
  if (u.pathname === '/api/asr' && req.method === 'POST') {
    let audio, language;
    try { const j = JSON.parse(await readBody(req)); audio = j.audio; language = j.language; }
    catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (typeof audio !== 'string' || !audio) return send(res, 400, { error: 'audio required' });
    if (audio.length > MAX_AUDIO) return send(res, 413, { error: 'audio too large' });

    if (!process.env.AZURE_SPEECH_KEY) {
      return send(res, 200, { mock: true, text: '', words: [], note: '未配置 AZURE_SPEECH_KEY，无法转写' });
    }
    const buf = Buffer.from(audio, 'base64');
    if (buf.length < 1600) return send(res, 400, { error: 'audio too short', bytes: buf.length });
    if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return send(res, 400, { error: 'audio must be 16k mono PCM WAV' });

    try {
      const region = process.env.AZURE_SPEECH_REGION || 'eastasia';
      const lang = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(language || '') ? language : 'en-US';
      const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
        `?language=${encodeURIComponent(lang)}&format=detailed&profanity=masked`;
      const ar = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          'Accept': 'application/json'
        },
        body: buf
      });
      const raw = await ar.text();
      if (!ar.ok) {
        console.error('[asr] azure http', ar.status, raw.slice(0, 300));
        return send(res, 502, { error: 'asr failed', status: ar.status, msg: raw.slice(0, 200) });
      }
      let j;
      try { j = JSON.parse(raw); } catch (e) { return send(res, 502, { error: 'asr bad json' }); }
      if (j.RecognitionStatus && j.RecognitionStatus !== 'Success') {
        // 静音/噪声片段不算失败，返回空文本让前端跳过
        return send(res, 200, { text: '', words: [], status: j.RecognitionStatus });
      }
      const nb = (j.NBest && j.NBest[0]) || {};
      const words = (nb.Words || []).map((w) => ({
        w: w.Word || '',
        start: Math.round((Number(w.Offset) || 0) / 10000) / 1000,      // 100ns ticks → 秒
        end: Math.round(((Number(w.Offset) || 0) + (Number(w.Duration) || 0)) / 10000) / 1000
      })).filter((w) => w.w);
      const text = (nb.Display || j.DisplayText || words.map((w) => w.w).join(' ')).trim();
      return send(res, 200, { text, words, duration: Math.round((Number(j.Duration) || 0) / 10000) / 1000 });
    } catch (e) {
      console.error('[asr] error', e);
      return send(res, 502, { error: 'asr failed', msg: String(e.message || e) });
    }
  }

  // ---------------- 音频代理（绕过 CORS / 直链防盗链） ----------------
  if (u.pathname === '/api/audio/proxy' && req.method === 'GET') {
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) return send(res, 400, { error: 'url required' });
    try {
      await assertPublicUrl(target);
      return await streamAudio(res, req, target, { Referer: 'https://pan.baidu.com/' });
    } catch (e) {
      return send(res, 502, { error: 'audio proxy failed', msg: String(e.message || e) });
    }
  }

  // ---------------- 百度网盘（开放平台 OAuth） ----------------
  // 需要配置：BAIDU_PAN_APPKEY / BAIDU_PAN_SECRET，回调地址填 <后端域名>/api/pan/baidu/callback
  if (u.pathname === '/api/pan/config') {
    return send(res, 200, {
      baidu: !!(process.env.BAIDU_PAN_APPKEY && process.env.BAIDU_PAN_SECRET),
      note: process.env.BAIDU_PAN_APPKEY ? '' : '未配置百度网盘 AppKey/SecretKey'
    });
  }

  if (u.pathname === '/api/pan/baidu/auth') {
    const state = String(u.searchParams.get('state') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!state) return send(res, 400, { error: 'state required' });
    if (!process.env.BAIDU_PAN_APPKEY) return send(res, 200, { mock: true, note: '未配置百度网盘 AppKey' });
    const redirect = process.env.BAIDU_PAN_REDIRECT ||
      ('https://' + (req.headers.host || '') + '/api/pan/baidu/callback');
    const url = 'https://openapi.baidu.com/oauth/2.0/authorize?response_type=code' +
      '&client_id=' + encodeURIComponent(process.env.BAIDU_PAN_APPKEY) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&scope=basic,netdisk&display=page&state=' + encodeURIComponent(state);
    return send(res, 200, { url, redirect });
  }

  if (u.pathname === '/api/pan/baidu/callback') {
    const code = String(u.searchParams.get('code') || '');
    const state = String(u.searchParams.get('state') || '');
    const back = (msg, ok) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="font-family:-apple-system,sans-serif;padding:40px 24px;text-align:center;color:#22324a;background:#f6f8fb">' +
        '<div style="font-size:52px;margin-bottom:12px">' + (ok ? '✅' : '⚠️') + '</div>' +
        '<h2 style="margin:0 0 8px;font-size:19px">' + msg + '</h2>' +
        '<p style="color:#7a879b;font-size:14px;line-height:1.7">' + (ok ? '已授权成功，回到 App 即可挑选音频。' : '请回到 App 重新试一次。') + '</p>' +
        '<button onclick="history.back()" style="margin-top:10px;padding:12px 24px;border:none;border-radius:999px;background:#22324a;color:#fff;font-size:15px;font-weight:700">返回 App</button>' +
        '</body>');
    };
    if (!code || !state) return back('授权未完成', false);
    try {
      const redirect = process.env.BAIDU_PAN_REDIRECT ||
        ('https://' + (req.headers.host || '') + '/api/pan/baidu/callback');
      const tr = await fetch('https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code' +
        '&code=' + encodeURIComponent(code) +
        '&client_id=' + encodeURIComponent(process.env.BAIDU_PAN_APPKEY || '') +
        '&client_secret=' + encodeURIComponent(process.env.BAIDU_PAN_SECRET || '') +
        '&redirect_uri=' + encodeURIComponent(redirect), { signal: AbortSignal.timeout(15000) });
      const tj = await tr.json().catch(() => null);
      if (!tj || !tj.access_token) {
        console.error('[pan] token exchange failed', JSON.stringify(tj || {}).slice(0, 300));
        return back('换取授权失败', false);
      }
      panSessions.set(state, {
        accessToken: tj.access_token,
        refreshToken: tj.refresh_token || '',
        expiresAt: Date.now() + (Number(tj.expires_in) || 0) * 1000,
        at: Date.now()
      });
      return back('百度网盘已连接', true);
    } catch (e) {
      console.error('[pan] callback error', e);
      return back('授权出错：' + String(e.message || e).slice(0, 80), false);
    }
  }

  if (u.pathname === '/api/pan/baidu/session') {
    const state = String(u.searchParams.get('state') || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const s = panSessions.get(state);
    return send(res, 200, { ok: !!s, at: s ? s.at : 0 });
  }

  if (u.pathname === '/api/pan/baidu/list') {
    const state = String(u.searchParams.get('state') || '');
    const dir = String(u.searchParams.get('dir') || '/').slice(0, 300);
    const s = panSessions.get(state);
    if (!s) return send(res, 401, { error: 'need auth', msg: '网盘授权已失效，请重新连接' });
    const call = async (token) => {
      const q = 'https://pan.baidu.com/rest/2.0/xpan/file?method=list&order=name&start=0&limit=300' +
        '&dir=' + encodeURIComponent(dir) + '&access_token=' + encodeURIComponent(token);
      const r = await fetch(q, { headers: { 'User-Agent': 'pan.baidu.com' }, signal: AbortSignal.timeout(15000) });
      return r.json();
    };
    try {
      let j = await call(s.accessToken);
      if (j && (j.errno === -6 || j.errno === 111)) {   // token 过期 → 刷新一次
        const t = await panRefresh(state);
        if (t) j = await call(t);
      }
      if (!j || j.errno) return send(res, 502, { error: 'pan list failed', errno: j && j.errno, msg: (j && j.errmsg) || '' });
      const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|amr|mp4|m4b)$/i;
      const items = (j.list || []).map((f) => ({
        fs_id: String(f.fs_id),
        name: f.server_filename || '',
        path: f.path || '',
        size: f.size || 0,
        isdir: !!f.isdir,
        audio: AUDIO_EXT.test(f.server_filename || ''),
        time: f.server_mtime || 0
      }));
      return send(res, 200, { dir, items });
    } catch (e) {
      return send(res, 502, { error: 'pan list failed', msg: String(e.message || e) });
    }
  }

  if (u.pathname === '/api/pan/baidu/stream' && req.method === 'GET') {
    const state = String(u.searchParams.get('state') || '');
    const fsId = String(u.searchParams.get('fs_id') || '').replace(/[^0-9]/g, '');
    const s = panSessions.get(state);
    if (!s) return send(res, 401, { error: 'need auth' });
    if (!fsId) return send(res, 400, { error: 'fs_id required' });
    const dlinkOf = async (token) => {
      const q = 'https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=%5B' + fsId + '%5D' +
        '&access_token=' + encodeURIComponent(token);
      const r = await fetch(q, { headers: { 'User-Agent': 'pan.baidu.com' }, signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      return j && j.list && j.list[0] ? j.list[0].dlink : '';
    };
    try {
      let dlink = await dlinkOf(s.accessToken);
      if (!dlink) {
        const t = await panRefresh(state);
        if (t) dlink = await dlinkOf(t);
      }
      if (!dlink) return send(res, 502, { error: 'no dlink', msg: '拿不到下载直链，可能文件已移动或无权限' });
      const sep = dlink.indexOf('?') >= 0 ? '&' : '?';
      return await streamAudio(res, req, dlink + sep + 'access_token=' + encodeURIComponent(s.accessToken), {
        'User-Agent': 'pan.baidu.com'
      });
    } catch (e) {
      return send(res, 502, { error: 'pan stream failed', msg: String(e.message || e) });
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
