/* 核心：存储 / 接口 / 原生桥 / 语音与录音 */
(function () {
  const APP = (window.APP = window.APP || {});

  /* ---------------- 小工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const dayKey = (d) => {
    const x = d ? new Date(d) : new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  };
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1900);
  }
  function loading(on, text) {
    const el = $('#loading');
    if (!el) return;
    if (text) $('#loadingText').textContent = text;
    el.hidden = !on;
  }
  function buzz(ms) {
    try {
      if (window.Android && Android.vibrate) Android.vibrate(ms || 12);
      else if (navigator.vibrate) navigator.vibrate(ms || 12);
    } catch (e) {}
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 本地存储 ---------------- */
  const K = {
    settings: 'yq.settings.v2',
    mine: 'yq.mine.v2',
    sessions: 'yq.sessions.v2',
    progress: 'yq.progress.v2',
    remote: 'yq.remote.v2',
  };
  const Store = {
    get(k, d) {
      try {
        const raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : d;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        toast('本机存储空间不足，请清理数据');
      }
    },
    settings() {
      const s = Store.get(K.settings, {});
      return Object.assign(
        { name: '小宝', backend: 'https://yuedu-book-backend.onrender.com', rate: 0.9, zh: true, autoScore: true },
        s
      );
    },
    saveSettings(patch) {
      const s = Object.assign(Store.settings(), patch || {});
      Store.set(K.settings, s);
      return s;
    },
    mine() {
      return Store.get(K.mine, []);
    },
    addMine(book) {
      const list = Store.mine();
      list.unshift(book);
      Store.set(K.mine, list);
    },
    removeMine(id) {
      Store.set(K.mine, Store.mine().filter((b) => b.id !== id));
    },
    sessions() {
      return Store.get(K.sessions, []);
    },
    addSession(s) {
      const list = Store.sessions();
      list.push(s);
      if (list.length > 2000) list.splice(0, list.length - 2000);
      Store.set(K.sessions, list);
    },
    progress() {
      return Store.get(K.progress, {});
    },
    setProgress(key, val) {
      const p = Store.progress();
      p[key] = val;
      Store.set(K.progress, p);
    },
    remoteBooks() {
      return Store.get(K.remote, []);
    },
    setRemoteBooks(list) {
      Store.set(K.remote, list);
    },
    clearAll() {
      Object.keys(K).forEach((k) => localStorage.removeItem(K[k]));
    },
    size() {
      let n = 0;
      try {
        Object.keys(localStorage).forEach((k) => {
          if (k.indexOf('yq.') === 0) n += (localStorage.getItem(k) || '').length;
        });
      } catch (e) {}
      return n;
    },
  };

  /* ---------------- 书籍集合 ---------------- */
  function allBooks() {
    return window.SEED_BOOKS.concat(Store.mine()).concat(Store.remoteBooks());
  }
  function bookById(id) {
    return allBooks().filter((b) => b.id === id)[0] || null;
  }
  function sentenceAt(book, pi, si) {
    const p = book && book.pages[pi];
    return (p && p.sentences[si]) || null;
  }
  function sentenceCount(book) {
    return (book.pages || []).reduce((n, p) => n + (p.sentences || []).length, 0);
  }
  function bookProgress(book) {
    const pr = Store.progress();
    const total = sentenceCount(book);
    let done = 0,
      sum = 0,
      n = 0;
    (book.pages || []).forEach((pg, pi) =>
      (pg.sentences || []).forEach((s, si) => {
        const r = pr[book.id + '|' + pi + '|' + si];
        if (r && r.score >= 60) done++;
        if (r) {
          sum += r.score;
          n++;
        }
      })
    );
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0, avg: n ? Math.round(sum / n) : 0 };
  }

  /* ---------------- 后端接口 ---------------- */
  const Api = {
    base() {
      return (Store.settings().backend || '').replace(/\/+$/, '');
    },
    async req(path, opt, timeout) {
      const base = Api.base();
      if (!base) throw new Error('未配置后端地址');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout || 60000);
      try {
        const r = await fetch(base + path, Object.assign({}, opt, { signal: ctrl.signal }));
        const text = await r.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = { raw: text };
        }
        if (!r.ok) {
          const msg = (data && (data.msg || data.error || data.message)) || 'HTTP ' + r.status;
          const err = new Error(msg);
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      } catch (e) {
        if (e.name === 'AbortError') {
          const err = new Error('请求超时，后端可能正在冷启动');
          err.code = 'timeout';
          throw err;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    health() {
      return Api.req('/api/health', { cache: 'no-store' }, 45000);
    },
    books() {
      return Api.req('/api/books', { cache: 'no-store' }, 30000);
    },
    async score(text, wavB64) {
      const data = await Api.req('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, audio: wavB64 }),
      }, 90000);
      // 后端未配置密钥时会返回 mock，不能当真实评分
      if (data && data.mock) {
        const err = new Error('后端未配置语音评测密钥');
        err.status = 200;
        err.data = data;
        throw err;
      }
      return data;
    },
    async ocr(imgB64, lang) {
      const img = /^data:/.test(imgB64) ? imgB64 : 'data:image/jpeg;base64,' + imgB64;
      const data = await Api.req('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: img, language: lang || 'eng' }),
      }, 90000);
      if (data && data.mock) {
        const err = new Error('后端未配置 OCR 密钥');
        err.status = 200;
        err.data = data;
        throw err;
      }
      return data;
    },
  };

  /* 强健的评分结果归一化：兼容多种字段命名 */
  function normalizeScore(raw) {
    const j = raw || {};
    const pickNum = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    let score =
      pickNum(j.score) != null ? j.score :
      pickNum(j.PronScore) != null ? j.PronScore :
      pickNum(j.pronScore) != null ? j.pronScore :
      pickNum(j.accuracy) != null ? j.accuracy : null;

    let words = j.words || j.wordScores || j.word_scores || [];
    if (!Array.isArray(words) && j.NBest && j.NBest[0]) {
      words = (j.NBest[0].Words || []).map((w) => ({ w: w.Word, score: w.PronunciationAssessment && w.PronunciationAssessment.AccuracyScore }));
    }
    words = (Array.isArray(words) ? words : [])
      .map((w) => ({
        w: String(w.w || w.word || w.text || w.Word || '').trim(),
        score: Math.round(Number(w.score != null ? w.score : w.accuracy != null ? w.accuracy : 0) || 0),
      }))
      .filter((w) => w.w);

    if (score == null && words.length) {
      score = Math.round(words.reduce((a, b) => a + b.score, 0) / words.length);
    }
    score = Math.max(0, Math.min(100, Math.round(score == null ? 0 : score)));

    let fixes = j.fixes || j.errors || j.tips || [];
    if (!Array.isArray(fixes)) fixes = [];
    fixes = fixes
      .map((f) => (typeof f === 'string' ? f : f.msg || f.message || f.tip || f.correction || ''))
      .filter(Boolean);

    if (!fixes.length) {
      const low = words.filter((w) => w.score < 75).slice(0, 3);
      if (low.length) fixes = low.map((w) => '「' + w.w + '」再读一遍，注意元音和重音');
    }
    const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
    return {
      score: score,
      words: words,
      fixes: fixes,
      fluency: num(j.fluency),
      completeness: num(j.completeness),
      recognized: typeof j.recognized === 'string' ? j.recognized : '',
      raw: raw,
    };
  }

  /* ---------------- 音频工具 ---------------- */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  /* PCM Int16 -> WAV(单声道) */
  function pcmToWav(pcm, sampleRate) {
    const out = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(out);
    const w = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
    return out;
  }

  /* ---------------- 原生桥 ---------------- */
  const Native = {
    available() {
      return !!(window.Android && window.Android.isNative);
    },
    onPermission: null,
    onPhoto: null,
    onError: null,
  };
  window.Native = {
    onPermission(ok) {
      if (Native.onPermission) Native.onPermission(!!ok);
    },
    onPhoto(b64) {
      if (Native.onPhoto) Native.onPhoto(b64);
    },
    onError(msg) {
      if (Native.onError) Native.onError(msg);
    },
  };

  /* ---------------- 领读 TTS ---------------- */
  const TTS = {
    speaking: false,
    voicesReady: false,
    speak(text, rate, opts) {
      const o = opts || {};
      const speed = Math.max(0.5, Math.min(1.4, rate || Store.settings().rate));
      if (Native.available()) {
        try {
          Android.speak(text, speed, o.pitch || 1.0);
          return true;
        } catch (e) {}
      }
      if (!('speechSynthesis' in window)) {
        toast('当前设备不支持朗读');
        return false;
      }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        u.rate = speed;
        u.pitch = o.pitch || 1.05;
        const vs = window.speechSynthesis.getVoices() || [];
        const pick =
          vs.find((v) => /en[-_]US/i.test(v.lang) && /samantha|zira|aria|jenny|female|google us/i.test(v.name)) ||
          vs.find((v) => /en[-_]US/i.test(v.lang)) ||
          vs.find((v) => /^en/i.test(v.lang));
        if (pick) u.voice = pick;
        window.speechSynthesis.speak(u);
        return true;
      } catch (e) {
        toast('朗读失败');
        return false;
      }
    },
    speakWord(w) {
      TTS.speak(w, 0.75);
    },
    stop() {
      if (Native.available()) {
        try {
          Android.stopSpeak();
        } catch (e) {}
      }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
  };

  /* ---------------- 录音 ---------------- */
  const Rec = {
    mode: null,
    startedAt: 0,
    _ac: null,
    _stream: null,
    _node: null,
    _src: null,
    _chunks: [],
    _rate: 16000,
    _timer: null,
    _maxTimer: null,
    onTick: null,
    onAutoStop: null,
    isRecording() {
      return Rec.mode != null;
    },
    async start() {
      if (Rec.isRecording()) await Rec.stop();
      if (Native.available()) {
        const ok = await Rec._ensurePerm();
        if (!ok) throw new Error('permission');
        Android.recordStart();
        Rec.mode = 'native';
      } else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC();
        const src = ac.createMediaStreamSource(stream);
        const node = ac.createScriptProcessor(4096, 1, 1);
        const chunks = [];
        node.onaudioprocess = (ev) => {
          chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
        };
        src.connect(node);
        node.connect(ac.destination);
        Rec._ac = ac;
        Rec._stream = stream;
        Rec._node = node;
        Rec._src = src;
        Rec._chunks = chunks;
        Rec._rate = ac.sampleRate;
        Rec.mode = 'web';
      }
      Rec.startedAt = Date.now();
      if (Rec.onTick) Rec.onTick(0);
      Rec._timer = setInterval(() => {
        const sec = (Date.now() - Rec.startedAt) / 1000;
        if (Rec.onTick) Rec.onTick(sec);
        if (sec >= 20) Rec.stop();
      }, 100);
      return true;
    },
    _ensurePerm() {
      return new Promise((resolve) => {
        let has = false;
        try {
          has = Android.hasAudioPermission();
        } catch (e) {}
        if (has) return resolve(true);
        Native.onPermission = (ok) => resolve(ok);
        try {
          Android.requestAudioPermission();
        } catch (e) {
          resolve(false);
        }
        setTimeout(() => resolve(false), 30000);
      });
    },
    _stopWeb() {
      const chunks = Rec._chunks;
      const rate = Rec._rate;
      const dur = (Date.now() - Rec.startedAt) / 1000;
      try {
        Rec._node.disconnect();
        Rec._src.disconnect();
        Rec._stream.getTracks().forEach((t) => t.stop());
        Rec._ac.close();
      } catch (e) {}
      let len = 0;
      chunks.forEach((c) => (len += c.length));
      const pcm = new Int16Array(len);
      let off = 0;
      chunks.forEach((c) => {
        for (let i = 0; i < c.length; i++) {
          let s = Math.max(-1, Math.min(1, c[i]));
          pcm[off++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
      });
      return { wav: pcmToWav(pcm, rate), dur: dur };
    },
    async stop() {
      if (!Rec.isRecording()) return null;
      clearInterval(Rec._timer);
      const mode = Rec.mode;
      Rec.mode = null;
      if (mode === 'native') {
        const b64 = Android.recordStop();
        const dur = (Date.now() - Rec.startedAt) / 1000;
        return { wavB64: b64, dur: dur };
      }
      const res = Rec._stopWeb();
      return { wavB64: bufToB64(res.wav), dur: res.dur };
    },
    cancel() {
      if (!Rec.isRecording()) return;
      clearInterval(Rec._timer);
      if (Rec.mode === 'native') {
        try {
          Android.recordCancel();
        } catch (e) {}
      } else {
        Rec._stopWeb();
      }
      Rec.mode = null;
    },
  };

  /* ---------------- 拍照 ---------------- */
  function pickPhoto(mode) {
    return new Promise((resolve, reject) => {
      if (Native.available()) {
        Native.onPhoto = (b64) => resolve(b64 || null);
        try {
          if (mode === 'camera') Android.takePhoto();
          else Android.pickImage();
        } catch (e) {
          reject(e);
        }
        return;
      }
      const input = $('#filePick');
      input.value = '';
      if (mode === 'camera') input.setAttribute('capture', 'environment');
      else input.removeAttribute('capture');
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        const img = new Image();
        const url = URL.createObjectURL(f);
        img.onload = () => {
          URL.revokeObjectURL(url);
          const max = 1400;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale);
          cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.82).split(',')[1]);
        };
        img.onerror = () => reject(new Error('图片读取失败'));
        img.src = url;
      };
      input.click();
    });
  }

  /* ---------------- 统计 ---------------- */
  function stats() {
    const ss = Store.sessions();
    const books = allBooks();
    const byDay = {};
    const weakMap = {};
    const doneBooks = {};

    ss.forEach((s) => {
      const d = s.day || dayKey(s.ts);
      byDay[d] = byDay[d] || { n: 0, sum: 0 };
      byDay[d].n++;
      byDay[d].sum += s.score;
      (s.words || []).forEach((w) => {
        if (!w || !w.w) return;
        const k = String(w.w).toLowerCase().replace(/[^a-z']/g, '');
        if (!k) return;
        if (w.score < 78) {
          weakMap[k] = weakMap[k] || { w: k, n: 0, worst: 100, last: 0 };
          weakMap[k].n++;
          weakMap[k].worst = Math.min(weakMap[k].worst, w.score);
          weakMap[k].last = Math.max(weakMap[k].last, s.ts || 0);
        }
      });
      if (s.bookId && s.score >= 60) doneBooks[s.bookId] = true;
    });

    // 连续打卡：从今天（或昨天）向前数
    const days = Object.keys(byDay).sort();
    let streak = 0;
    if (days.length) {
      const today = dayKey();
      const y = new Date();
      y.setDate(y.getDate() - 1);
      let cursor = byDay[today] ? new Date() : byDay[dayKey(y)] ? y : null;
      while (cursor) {
        if (!byDay[dayKey(cursor)]) break;
        streak++;
        cursor = new Date(cursor.getTime() - 86400000);
      }
    }

    // 近7天
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      const v = byDay[k];
      trend.push({ key: k, label: i === 0 ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][d.getDay()], avg: v ? Math.round(v.sum / v.n) : 0, n: v ? v.n : 0 });
    }

    const total = ss.length;
    const avg = total ? Math.round(ss.reduce((a, s) => a + s.score, 0) / total) : 0;

    // 读完的绘本：进度覆盖 >=80% 且均分 >=60
    let booksDone = 0;
    books.forEach((b) => {
      const p = bookProgress(b);
      if (p.total && p.done / p.total >= 0.8 && p.avg >= 60) booksDone++;
    });

    const weak = Object.keys(weakMap)
      .map((k) => weakMap[k])
      .sort((a, b) => b.n - a.n || a.worst - b.worst)
      .slice(0, 8);

    const mineCount = Store.mine().length;
    const great = ss.filter((s) => s.score >= 90).length;
    const perfect = ss.some((s) => s.score >= 96);
    const badges = [
      { id: 'first', icon: '🎉', name: '开口第一步', on: total >= 1 },
      { id: 's3', icon: '🔥', name: '连续 3 天', on: streak >= 3 },
      { id: 's7', icon: '🏅', name: '连续 7 天', on: streak >= 7 },
      { id: 'perfect', icon: '💎', name: '满分句', on: perfect },
      { id: 'b5', icon: '📚', name: '读完 5 本', on: booksDone >= 5 },
      { id: 'h100', icon: '🚀', name: '百句达成', on: total >= 100 },
      { id: 'great', icon: '🌟', name: '十句 90+', on: great >= 10 },
      { id: 'mine', icon: '📷', name: '自建绘本', on: mineCount >= 1 },
      { id: 'all', icon: '👑', name: '全库通关', on: booksDone >= books.length && books.length > 0 },
    ];

    return {
      total: total,
      avg: avg,
      streak: streak,
      trend: trend,
      weak: weak,
      booksDone: booksDone,
      badges: badges,
      badgeOn: badges.filter((b) => b.on).length,
      today: byDay[dayKey()] || { n: 0, sum: 0 },
      sessions: ss,
      great: great,
    };
  }

  APP.util = { $: $, $$: $$, esc: esc, toast: toast, loading: loading, buzz: buzz, sleep: sleep, dayKey: dayKey, pad: pad };
  APP.Store = Store;
  APP.Api = Api;
  APP.Native = Native;
  APP.TTS = TTS;
  APP.Rec = Rec;
  APP.pickPhoto = pickPhoto;
  APP.normalizeScore = normalizeScore;
  APP.books = { all: allBooks, byId: bookById, sentenceAt: sentenceAt, count: sentenceCount, progress: bookProgress };
  APP.stats = stats;
  APP.audio = { bufToB64: bufToB64, b64ToBuf: b64ToBuf, pcmToWav: pcmToWav };
})();
