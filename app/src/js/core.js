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
    _wake: { at: 0, ok: null, busy: false, task: null },
    /**
     * 唤醒后端。Render 免费实例 15 分钟没请求就会休眠，冷启动要 30–60s。
     * 前台切换时先打一枪 /api/health，用户点「跟读」时后端已经醒了。
     * 10 分钟内确认过就不重复请求。
     */
    wake(force) {
      const base = Api.base();
      if (!base) return Promise.resolve(false);
      const w = Api._wake;
      if (!force && w.ok === true && Date.now() - w.at < 10 * 60 * 1000) return Promise.resolve(true);
      if (w.task) return w.task;
      const t0 = Date.now();
      w.task = fetch(base + '/api/health', { cache: 'no-store' })
        .then((r) => r.ok)
        .catch(() => false)
        .then((ok) => {
          w.ok = ok;
          w.at = Date.now();
          w.busy = false;
          w.task = null;
          try {
            if (APP.state) APP.state.backendAwake = ok;
            APP.backendMs = Date.now() - t0;
          } catch (e) {}
          return ok;
        });
      w.busy = true;
      return w.task;
    },
    /** 冷启动兜底：第一次超时/断网时唤醒再重试一次 */
    async retryAfterWake(fn) {
      try {
        return await fn();
      } catch (e) {
        const cold = e && (e.code === 'timeout' || !e.status);
        if (!cold) throw e;
        const ok = await Api.wake(true);
        if (!ok) throw e;
        return await fn();
      }
    },
    books() {
      return Api.req('/api/books', { cache: 'no-store' }, 30000);
    },
    async score(text, wavB64) {
      const send = () =>
        Api.req('/api/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, audio: wavB64 }),
        }, 90000);
      const data = await Api.retryAfterWake(send);
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
      const send = () =>
        Api.req('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: img, language: lang || 'eng' }),
        }, 90000);
      const data = await Api.retryAfterWake(send);
      if (data && data.mock) {
        const err = new Error('后端未配置 OCR 密钥');
        err.status = 200;
        err.data = data;
        throw err;
      }
      return data;
    },
    /** 音频转写：把一段 16k 单声道 WAV 变成英文文稿 */
    async asr(audioB64, lang) {
      const send = () =>
        Api.req('/api/asr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: audioB64, language: lang || 'en-US' }),
        }, 60000);
      const data = await Api.retryAfterWake(send);
      if (data && data.mock) {
        const err = new Error('后端未配置语音转写密钥');
        err.status = 200;
        err.data = data;
        throw err;
      }
      return data;
    },
    /* ---- 网盘（百度网盘） ---- */
    panConfig() {
      return Api.req('/api/pan/config', { cache: 'no-store' }, 30000);
    },
    panAuth(state) {
      return Api.req('/api/pan/baidu/auth?state=' + encodeURIComponent(state), { cache: 'no-store' }, 30000);
    },
    panSession(state) {
      return Api.req('/api/pan/baidu/session?state=' + encodeURIComponent(state), { cache: 'no-store' }, 30000);
    },
    panList(state, dir) {
      const q = '/api/pan/baidu/list?state=' + encodeURIComponent(state) + '&dir=' + encodeURIComponent(dir || '/');
      return Api.req(q, { cache: 'no-store' }, 45000);
    },
    panStreamUrl(state, fsId) {
      return Api.base() + '/api/pan/baidu/stream?state=' + encodeURIComponent(state) + '&fs_id=' + encodeURIComponent(fsId);
    },
    /** 单词音标（IPA）：后端代理 dictionaryapi.dev，结果本机缓存 */
    async ipa(word) {
      const w = String(word || '').toLowerCase().replace(/[^a-z'\-]/g, '');
      if (!w) return { word: '', ipa: '' };
      const cache = Store.get('yq.ipa.v1', {}) || {};
      if (cache[w]) return cache[w];
      let out = { word: w, ipa: '' };
      const base = Api.base();
      if (!base) return out;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(base + '/api/ipa?word=' + encodeURIComponent(w), { signal: ctrl.signal });
        if (r.ok) {
          const j = await r.json();
          out = { word: w, ipa: (j && j.ipa) || '' };
        }
      } catch (e) {
      } finally {
        clearTimeout(timer);
      }
      if (out.ipa) {
        cache[w] = out;
        try {
          const keys = Object.keys(cache);
          if (keys.length > 500) delete cache[keys[0]];
          Store.set('yq.ipa.v1', cache);
        } catch (e) {}
      }
      return out;
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
    onPhotos: null,
    onBookFile: null,
    onAudio: null,
    onError: null,
    onAutoStop: null,
    onResume: null,
    onPanApp: null,
  };
  let photoBuf = {};
  let photoTotal = 0;
  let photoGot = 0;
  window.Native = {
    onPermission(ok) {
      if (Native.onPermission) Native.onPermission(!!ok);
    },
    onPhoto(b64) {
      if (Native.onPhoto) Native.onPhoto(b64);
    },
    onPhotos(json) {
      let arr = [];
      try { arr = JSON.parse(String(json || '[]')); } catch (e) { arr = []; }
      if (Native.onPhotos) Native.onPhotos(Array.isArray(arr) ? arr : []);
    },
    /** 原生逐张回传（大图一次传送会被 WebView 截断），凑齐 n 张再回调 */
    onPhotoItem(json) {
      let o = null;
      try { o = JSON.parse(String(json || '{}')); } catch (e) { o = null; }
      if (!o || typeof o.i !== 'number' || typeof o.b !== 'string') return;
      if (!photoTotal) {
        photoTotal = o.n || 1;
        photoBuf = {};
        photoGot = 0;
      }
      if (!photoBuf[o.i]) {
        photoBuf[o.i] = o.b;
        photoGot++;
        if (Native.onPhotoProgress) {
          try { Native.onPhotoProgress(photoGot, photoTotal); } catch (e) {}
        }
      }
      if (photoGot >= photoTotal) {
        const arr = [];
        for (let i = 0; i < photoTotal; i++) if (photoBuf[i]) arr.push(photoBuf[i]);
        photoBuf = {};
        photoTotal = 0;
        photoGot = 0;
        if (Native.onPhotos) Native.onPhotos(arr);
      }
    },
    onBookFile(json) {
      let obj = null;
      try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { obj = null; }
      if (Native.onBookFile) Native.onBookFile(obj);
    },
    onAudio(json) {
      let obj = null;
      try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { obj = null; }
      if (obj && obj.error) { toast(obj.error); return; }
      if (Native.onAudio) Native.onAudio(obj);
      else if (obj && obj.b64) {
        // 用户从别的 App 分享音频进来（百度网盘长按→分享→悦读绘本），没有待处理的 picker 回调
        try {
          const bytes = new Uint8Array(b64ToBuf(obj.b64));
          const blob = new Blob([bytes], { type: obj.mime || 'audio/mpeg' });
          if (APP.ui && APP.ui.openAudioFromShare) {
            APP.ui.openAudioFromShare({ blob: blob, name: obj.name || '网盘音频' });
          }
        } catch (e) {}
      }
    },
    onPanApp(via) {
      if (Native.onPanApp) Native.onPanApp(via);
    },
    onError(msg) {
      if (Native.onError) Native.onError(msg);
    },
    onAutoStop() {
      if (Native.onAutoStop) Native.onAutoStop();
    },
    onResume() {
      if (Native.onResume) Native.onResume();
    },
  };

  /* ---------------- 领读 TTS ---------------- */
  const TTS = {
    speaking: false,
    voicesReady: false,
    _audio: null,        // 云端音频播放元素
    _gen: 0,             // 代际令牌：用于打断“正在路上”的云端朗读
    _cloud: { ok: null, at: 0 }, // 云端可用性缓存，避免每次点击都白等
    _cache: new Map(),   // 合成结果缓存：key → blob url（同一句第二次点直接秒播）
    _cacheMax: 80,
    _waitTip: 0,
    _ckey(text, speed, isZh) {
      return (isZh ? 'zh' : 'en') + '|' + speed + '|' + String(text).slice(0, 300);
    },
    _cachePut(key, b64) {
      try {
        const bin = b64ToBuf(b64);
        const url = URL.createObjectURL(new Blob([new Uint8Array(bin)], { type: 'audio/mpeg' }));
        // 超上限先淘汰最早的，并释放 objectURL，避免内存一直涨
        if (this._cache.size >= this._cacheMax) {
          const first = this._cache.keys().next().value;
          const old = this._cache.get(first);
          if (old) { try { URL.revokeObjectURL(old); } catch (e) {} }
          this._cache.delete(first);
        }
        this._cache.set(key, url);
        return url;
      } catch (e) {
        return null;
      }
    },
    _playUrl(url) {
      this._stopAudio();
      const el = new Audio(url);
      this._audio = el;
      this.speaking = true;
      const done = () => {
        if (this._audio === el) { this._audio = null; this.speaking = false; }
      };
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      const p = el.play();
      if (p && p.catch) {
        p.catch(() => {
          done();
          // WebView 偶发拦截自动播放时，退回设备朗读，别让人以为坏了
          if (this._lastText) this._native(this._lastText, this._lastSpeed || 1, {}, this._lastZh);
        });
      }
    },
    speak(text, rate, opts) {
      const o = opts || {};
      const speed = Math.max(0.5, Math.min(1.4, rate || Store.settings().rate));
      const isZh = /[一-鿿]/.test(text);
      this._lastSpeed = speed;
      this._lastZh = isZh;
      this._lastText = text;
      const token = ++this._gen; // 本次朗读的令牌
      // 命中缓存 → 同步立刻播，零等待
      const key = this._ckey(text, speed, isZh);
      const hit = this._cache.get(key);
      if (hit) {
        this._playUrl(hit);
        return true;
      }
      // 优先云端神经网络朗读（更自然、不机械）；失败/未配置再退回设备原生 TTS
      this._speakCloud(text, speed, isZh, token).then((used) => {
        if (token === this._gen && !used) this._native(text, speed, o, isZh);
      });
      return true;
    },
    async _speakCloud(text, speed, isZh, token) {
      // 失败后 90 秒内跳过云端（Render 冷启动期间反复白等没意义），但不影响已缓存句子
      if (this._cloud.ok === false && Date.now() - this._cloud.at < 90000) return false;
      try {
        const base = Api.base();
        if (!base) return false;
        const lang = isZh ? 'zh-CN' : 'en-US';
        // 冷启动乐观一点：从没成功过给 30s，成功过给 12s
        const tmo = this._cloud.ok === true ? 12000 : 30000;
        // 超过 1.5s 还没回来，提示一次，避免用户以为点了没反应
        clearTimeout(this._waitTip);
        this._waitTip = setTimeout(() => {
          if (token === this._gen) toast('正在准备自然语音…', 1600);
        }, 1500);
        let r = null;
        try {
          r = await Api.req('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, lang: lang, rate: Math.round(speed * 100) / 100 }),
          }, tmo);
        } catch (e) {
          // 超时多半是冷启动：先踢一下 /api/health 把实例叫醒，下次点击就能命中
          if (e && e.code === 'timeout') Api.wake(true);
          throw e;
        } finally {
          clearTimeout(this._waitTip);
        }
        if (token !== this._gen) return false; // 已被新朗读/停止打断，丢弃
        if (!r || r.mock || !r.audio) {
          this._cloud = { ok: false, at: Date.now() };
          // 只提示一次，避免每次点领读都弹；让人知道为什么退回机械音
          if (r && r.note && !this._noteShown) {
            this._noteShown = true;
            toast('云端朗读不可用，已改用设备朗读：' + r.note, 3200);
          }
          return false;
        }
        this._cloud.ok = true;
        const key = this._ckey(text, speed, isZh);
        const url = this._cachePut(key, r.audio);
        if (!url) return false;
        this._playUrl(url);
        return true;
      } catch (e) {
        this._cloud = { ok: false, at: Date.now() };
        return false;
      }
    },
    /** 后台预取：进阅读页时把当前页句子先合成好，点领读就是秒出自然音 */
    prefetch(texts, rate) {
      const base = Api.base();
      if (!base || !texts || !texts.length) return;
      if (this._cloud.ok === false && Date.now() - this._cloud.at < 90000) return;
      if (this._prefetching) return;
      this._prefetching = true;
      const queue = texts.slice(0, 12);
      const step = () => {
        const t = queue.shift();
        if (!t) { this._prefetching = false; return; }
        const isZh = /[一-鿿]/.test(t);
        const speed = Math.max(0.5, Math.min(1.4, rate || 1));
        const key = this._ckey(t, speed, isZh);
        if (this._cache.has(key)) return step();
        Api.req('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: t, lang: isZh ? 'zh-CN' : 'en-US', rate: Math.round(speed * 100) / 100 }),
        }, 30000).then((r) => {
          if (r && !r.mock && r.audio) {
            this._cloud.ok = true;
            this._cachePut(key, r.audio);
          }
        }).catch(() => {}).then(() => setTimeout(step, 120));
      };
      step();
    },
    _stopAudio() {
      this.speaking = false;
      if (this._audio) {
        try { this._audio.pause(); this._audio.currentTime = 0; } catch (e) {}
        this._audio = null;
      }
    },
    /* ---- 真人音频领读：播放录音里的一句话（音频绘本） ---- */
    _clip: null,
    _clipTimer: 0,
    playClip(src, start, end, rate) {
      this.stop(); // 先停掉一切正在播的声音，避免叠音
      if (!src) return false;
      const rate2 = Math.max(0.5, Math.min(1.5, Number(rate) || 1));
      const from = Math.max(0, Number(start) || 0);
      const span = Math.max(0.25, (Number(end) || from + 1) - from);
      const el = new Audio();
      el.preload = 'auto';
      el.src = src;
      this._clip = el;
      let started = false;
      const begin = () => {
        if (started || this._clip !== el) return;
        started = true;
        try {
          if (from > 0) el.currentTime = from;
          el.playbackRate = rate2;
          el.play().catch(() => {});
        } catch (e) {}
        clearTimeout(this._clipTimer);
        // 兜底：到点强制停，防止个别内核不触发 ended
        this._clipTimer = setTimeout(() => {
          if (this._clip === el) this._stopClip();
        }, (span / rate2) * 1000 + 600);
      };
      el.addEventListener('loadedmetadata', begin);
      el.addEventListener('canplay', begin);
      el.addEventListener('ended', () => { if (this._clip === el) this._stopClip(); });
      el.addEventListener('error', () => { if (this._clip === el) this._stopClip(); });
      return true;
    },
    _stopClip() {
      clearTimeout(this._clipTimer);
      this._clipTimer = 0;
      const el = this._clip;
      this._clip = null;
      if (el) {
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
      }
    },
    _native(text, speed, o, isZh) {
      if (Native.available()) {
        try {
          // 只传 2 个参数，与 Java 桥 speak(String,float) 严格匹配
          Android.speak(text, speed);
          return;
        } catch (e) {}
      }
      if (!('speechSynthesis' in window)) {
        toast('当前设备不支持朗读');
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = isZh ? 'zh-CN' : 'en-US';
        u.rate = speed;
        u.pitch = o.pitch || 1.05;
        const vs = window.speechSynthesis.getVoices() || [];
        const pick = isZh
          ? vs.find((v) => /zh|chinese|中文|普通话/i.test(v.lang + v.name)) || null
          : vs.find((v) => /en[-_]US/i.test(v.lang) && /samantha|zira|aria|jenny|female|google us/i.test(v.name)) ||
            vs.find((v) => /en[-_]US/i.test(v.lang)) ||
            vs.find((v) => /^en/i.test(v.lang));
        if (pick) u.voice = pick;
        window.speechSynthesis.speak(u);
      } catch (e) {
        toast('朗读失败');
      }
    },
    speakWord(w) {
      TTS.stop(); // 打断正在播的评分播报/领读，避免叠音
      TTS.speak(w, 0.7);
    },
    stop() {
      this._gen++; // 让任何在途的云端朗读作废
      this._sayGen++; // 评分播报队列也一并作废
      this._sayQueue = [];
      this._sayPlaying = false;
      this._stopAudio();
      this._stopClip();
      if (Native.available()) {
        try {
          Android.stopSpeak();
        } catch (e) {}
      }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    warm() {
      if (this._cloud.ok === false && Date.now() - this._cloud.at < 60000) return;
      const base = Api.base();
      if (!base) return;
      // 唤醒云端朗读路由（尤其 Render 免费实例冷启动），不影响结果
      fetch(base + '/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello.', lang: 'en-US', rate: 1 }),
      }).catch(() => {});
    },

    /* ---- 评分等级词：预取短音频，评完立刻播，不用等网络 ---- */
    _praise: null,   // word -> base64 mp3
    _praiseBusy: false,
    grade(score) {
      const s = Number(score) || 0;
      if (s >= 95) return 'Excellent!';
      if (s >= 90) return 'Wonderful!';
      if (s >= 85) return 'Great!';
      if (s >= 78) return 'Good job!';
      if (s >= 70) return 'Nice try!';
      return 'Keep going!';
    },
    _praiseKey: 'yd_praise_v1',
    _loadPraise() {
      if (this._praise) return this._praise;
      this._praise = {};
      try {
        const raw = Store.getRaw ? Store.getRaw(this._praiseKey) : localStorage.getItem(this._praiseKey);
        if (raw) this._praise = JSON.parse(raw) || {};
      } catch (e) {
        this._praise = {};
      }
      return this._praise;
    },
    prefetchPraise() {
      if (this._praiseBusy) return;
      if (this._cloud.ok === false && Date.now() - this._cloud.at < 20000) return;
      if (!Api.base()) return;
      const words = ['Excellent!', 'Wonderful!', 'Great!', 'Good job!', 'Nice try!', 'Keep going!'];
      const cache = this._loadPraise();
      const todo = words.filter((w) => !cache[w]);
      if (!todo.length) return;
      this._praiseBusy = true;
      const self = this;
      (async () => {
        let changed = false;
        for (const w of todo) {
          try {
            const r = await Api.req('/api/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: w, lang: 'en-US', rate: 0.95 }),
            }, 15000);
            if (r && r.audio) {
              self._loadPraise()[w] = r.audio;
              changed = true;
              // 每拿一条就落盘，评到一半也能立刻出声
              try {
                const json = JSON.stringify(self._loadPraise());
                if (json.length < 400000) {
                  if (Store.setRaw) Store.setRaw(self._praiseKey, json);
                  else localStorage.setItem(self._praiseKey, json);
                }
              } catch (e) {}
            } else if (r && r.mock) {
              break; // 云端不可用，别再逐个试
            }
          } catch (e) {
            break;
          }
        }
        self._praiseBusy = false;
      })();
    },
    /* ---- 评分播报：等级词秒出 + 分数/薄弱词续播 ---- */
    _sayGen: 0,
    _sayQueue: [],
    _sayPlaying: false,
    _numEn(n) {
      const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
      const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
      const v = Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      if (v < 20) return ones[v];
      if (v === 100) return 'one hundred';
      const t = Math.floor(v / 10), o = v % 10;
      return tens[t] + (o ? '-' + ones[o] : '');
    },
    /** "Ninety-six. Practice: apple, water." —— 精炼、无中文长句 */
    scoreLine(score, weak) {
      const list = (weak || []).map((w) => String(w || '').trim()).filter(Boolean).slice(0, 3);
      let t = this._numEn(score) + '.';
      if (list.length) t += ' Practice: ' + list.join(', ') + '.';
      return t;
    },
    _say(list) {
      this._sayGen++;
      this._stopAudio();
      this._sayQueue = (list || []).filter(Boolean).slice();
      this._sayPlaying = false;
      if (this._sayQueue.length) this._sayNext();
    },
    _sayNext() {
      const b64 = this._sayQueue.shift();
      this._sayPlaying = false;
      if (!b64) return;
      const gen = this._sayGen;
      this._sayPlaying = true;
      let el;
      try {
        el = new Audio('data:audio/mpeg;base64,' + b64);
      } catch (e) {
        return;
      }
      this._audio = el;
      const next = () => {
        if (gen === this._sayGen) this._sayNext();
      };
      el.onended = next;
      el.onerror = next;
      el.play().catch(next);
    },
    _queuePush(b64) {
      if (!b64) return;
      this._sayQueue.push(b64);
      if (!this._sayPlaying) this._sayNext();
    },
    /** 取「分数 + 薄弱词」这一句的音频（缓存 / 云端合成），失败返回 null */
    async _fetchLine(text) {
      const cache = this._loadPraise();
      const k = 's:' + text;
      if (cache[k]) return cache[k];
      try {
        const r = await Api.req('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, lang: 'en-US', rate: 0.98 }),
        }, 15000);
        if (r && r.audio) {
          const c = this._loadPraise();
          c[k] = r.audio;
          // 只留最近 8 条，避免 localStorage 爆
          const keys = Object.keys(c).filter((x) => x.indexOf('s:') === 0);
          while (keys.length > 8) delete c[keys.shift()];
          try {
            const json = JSON.stringify(c);
            if (json.length < 600000) {
              if (Store.setRaw) Store.setRaw(this._praiseKey, json);
              else localStorage.setItem(this._praiseKey, json);
            }
          } catch (e) {}
          return r.audio;
        }
      } catch (e) {}
      return null;
    },
    /**
     * 评分播报：
     * 1) 等级词（缓存命中）立刻出声
     * 2) 紧接着 "Ninety-six. Practice: apple, water."（有缓存直接接，没有就现合成后接）
     */
    speakPraise(score, weak) {
      const grade = this.grade(score);
      const line = this.scoreLine(score, weak);
      const cache = this._loadPraise();
      const gClip = cache[grade];
      const lClip = cache['s:' + line];

      if (gClip && lClip) {
        this._say([gClip, lClip]);
        return grade;
      }
      if (gClip) this._say([gClip]);
      else {
        this._say([]);
        this._native(grade, 1, {}, false);
        this.prefetchPraise();
      }
      const gen = this._sayGen;
      const push = (b64) => {
        if (!b64 || gen !== this._sayGen) return;
        this._queuePush(b64);
      };
      if (lClip) {
        if (gClip) this._queuePush(lClip);
        else setTimeout(() => push(lClip), 1200); // 系统 TTS 读等级词约 1 秒
      } else {
        this._fetchLine(line).then((b64) => {
          if (!b64) return;
          if (gClip) push(b64);
          else setTimeout(() => push(b64), 1200);
        });
      }
      return grade;
    },
  };

  /* ---------------- 音频仓库（IndexedDB，存本地音频文件） ---------------- */
  const Idb = {
    _p: null,
    open() {
      if (this._p) return this._p;
      this._p = new Promise((resolve, reject) => {
        try {
          if (!window.indexedDB) throw new Error('设备不支持本地音频存储');
          const rq = indexedDB.open('yq.audio.v1', 1);
          rq.onupgradeneeded = () => {
            const db = rq.result;
            if (db.objectStoreNames.indexOf('files') < 0) db.createObjectStore('files');
          };
          rq.onsuccess = () => resolve(rq.result);
          rq.onerror = () => reject(rq.error || new Error('打开本地音频库失败'));
        } catch (e) {
          reject(e);
        }
      });
      return this._p;
    },
    _run(mode, fn) {
      return this.open().then(
        (db) =>
          new Promise((resolve, reject) => {
            let req;
            const t = db.transaction('files', mode);
            try {
              req = fn(t.objectStore('files'));
            } catch (e) {
              return reject(e);
            }
            t.oncomplete = () => resolve(req ? req.result : undefined);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
          })
      );
    },
    put(key, blob) {
      return this._run('readwrite', (st) => st.put(blob, key));
    },
    get(key) {
      return this._run('readonly', (st) => st.get(key));
    },
    del(key) {
      return this._run('readwrite', (st) => st.delete(key));
    },
  };

  /* ---------------- 音频绘本：音频 → 文稿 ---------------- */
  const AudioBook = {
    MAX_SECONDS: 480,   // 单次最多 8 分钟（手机内存有限）
    SEG_MAX: 12,        // 单段最长 12s
    SEG_GAP: 0.32,      // 静音超过 0.32s 断开
    _urls: {},          // 本地音频 key → objectURL

    round: (n) => Math.round(Number(n) * 100) / 100,

    /** 取音频二进制：远程链接走后端代理（绕 CORS / 防盗链），本地直接用 Blob */
    async fetchBuffer(source) {
      if (source && source.blob) return source.blob.arrayBuffer();
      const url = String((source && source.url) || '');
      if (!url) throw new Error('没有音频地址');
      const base = Api.base();
      const target = /^blob:|^data:/.test(url) || (base && url.indexOf(base) === 0)
        ? url
        : base + '/api/audio/proxy?url=' + encodeURIComponent(url);
      const r = await fetch(target);
      if (!r.ok) throw new Error('音频下载失败（' + r.status + '），检查链接是否可访问');
      return r.arrayBuffer();
    },

    async decode(buf) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前设备不支持音频解码');
      const ac = new AC();
      try {
        const ab = await new Promise((resolve, reject) => {
          let p;
          try {
            p = ac.decodeAudioData(buf, resolve, reject);
          } catch (e) {
            return reject(e);
          }
          if (p && p.then) p.then(resolve, reject);
        });
        if (!ab || !ab.length) throw new Error('音频解码为空');
        return ab;
      } finally {
        try { ac.close(); } catch (e) {}
      }
    },

    mono(buffer) {
      const ch = buffer.numberOfChannels || 1;
      const n = buffer.length;
      const out = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += d[i] / ch;
      }
      return out;
    },

    /** 按能量找静音，切成人声片段（每段 ≤ SEG_MAX 秒） */
    segment(mono, rate) {
      const frame = Math.max(1, Math.round(rate * 0.02)); // 20ms 一帧
      const frames = Math.floor(mono.length / frame);
      if (!frames) return [];
      const rms = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const off = i * frame;
        let s = 0;
        for (let k = 0; k < frame; k++) s += mono[off + k] * mono[off + k];
        rms[i] = Math.sqrt(s / frame);
      }
      const sorted = Array.prototype.slice.call(rms).sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
      const thr = Math.max(0.006, floor * 3);
      const segs = [];
      let start = -1;
      let lastVoice = -1;
      for (let i = 0; i < frames; i++) {
        const t = i * 0.02;
        if (rms[i] > thr) {
          if (start < 0) start = t;
          lastVoice = t;
          if (t - start > this.SEG_MAX) {
            segs.push([start, lastVoice]);
            start = -1;
          }
        } else if (start >= 0 && t - lastVoice > this.SEG_GAP) {
          if (lastVoice - start >= 0.35) segs.push([start, lastVoice + 0.12]);
          start = -1;
        }
      }
      if (start >= 0 && lastVoice - start >= 0.35) segs.push([start, lastVoice + 0.12]);
      return segs;
    },

    /** 截取一段并重采样成 16k / 单声道 / 16bit WAV（Azure 短音频接口要求） */
    wav16k(mono, rate, start, end) {
      const outRate = 16000;
      const s0 = Math.max(0, Math.floor(start * rate));
      const s1 = Math.min(mono.length, Math.ceil(end * rate));
      const n = Math.max(1, s1 - s0);
      const ratio = rate / outRate;
      const outLen = Math.max(1, Math.floor(n / ratio));
      const pcm = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = s0 + i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(mono.length - 1, i0 + 1);
        const frac = pos - i0;
        let v = mono[i0] * (1 - frac) + mono[i1] * frac;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      return pcmToWav(pcm, outRate);
    },

    cleanText(t) {
      return String(t || '')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–—.,;:]+/, '')
        .trim();
    },

    splitSent(text) {
      return String(text || '')
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && /[A-Za-z]{2}/.test(s));
    },

    /**
     * 主流程：音频 → 逐段转写 → 带时间戳的句子
     * source: { blob } 或 { url }
     * 返回 { sentences:[{en, a:[开始,结束]}], duration, segments }
     */
    async transcribe(source, onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : function () {};
      report(0.02, '正在读取音频…');
      const buf = await this.fetchBuffer(source);
      report(0.1, '正在解码音频…');
      const ab = await this.decode(buf);
      const dur = ab.duration || 0;
      if (!dur) throw new Error('音频时长为 0，文件可能损坏');
      if (dur > this.MAX_SECONDS + 8) {
        throw new Error('音频约 ' + Math.round(dur / 60) + ' 分钟，超过单次 ' + Math.round(this.MAX_SECONDS / 60) + ' 分钟上限，请先剪一小段');
      }
      const limit = Math.min(dur, this.MAX_SECONDS);
      const mono = this.mono(ab);
      const rate = ab.sampleRate;
      report(0.18, '正在切分语音…');
      let segs = this.segment(mono, rate)
        .map((s) => [s[0], Math.min(s[1], limit)])
        .filter((s) => s[1] - s[0] >= 0.35);
      if (!segs.length) throw new Error('没检测到人声，换个音频试试');
      if (segs.length > 160) segs = segs.slice(0, 160);

      const out = [];
      let failed = 0;
      for (let i = 0; i < segs.length; i++) {
        const a = segs[i][0];
        const b = segs[i][1];
        report(0.2 + 0.78 * (i / segs.length), '正在转写 ' + (i + 1) + '/' + segs.length + ' 段…');
        let text = '';
        try {
          const r = await Api.asr(bufToB64(this.wav16k(mono, rate, a, b)), 'en-US');
          text = (r && r.text) || '';
        } catch (e) {
          failed++;
          if (failed >= 3 && !out.length) throw e; // 连续失败且一句没成功，直接报错
          continue;
        }
        text = this.cleanText(text);
        if (!text) continue;
        const parts = this.splitSent(text);
        if (parts.length <= 1) {
          out.push({ en: text, a: [this.round(a), this.round(b)] });
        } else {
          // 一段里有多句：按字符数比例分配时间
          const total = parts.reduce((n, p) => n + p.length, 0) || 1;
          let cursor = a;
          parts.forEach((p) => {
            const span = (b - a) * (p.length / total);
            out.push({ en: p, a: [this.round(cursor), this.round(cursor + span)] });
            cursor += span;
          });
        }
      }
      report(1, '转写完成');
      if (!out.length) throw new Error('没有识别出英文内容，确认这是一段英语音频');
      return { sentences: out, duration: dur, segments: segs.length };
    },

    /** 取一本书的音频播放地址（本地音频从 IndexedDB 转成 blob URL 并缓存） */
    async srcOf(book) {
      const a = book && book.audio;
      if (!a) return '';
      if (a.kind === 'url') return a.url || '';
      if (a.kind === 'idb') {
        if (this._urls[a.key]) return this._urls[a.key];
        try {
          const blob = await Idb.get(a.key);
          if (!blob) return '';
          const url = URL.createObjectURL(blob);
          this._urls[a.key] = url;
          return url;
        } catch (e) {
          return '';
        }
      }
      return '';
    },

    async saveLocal(key, blob) {
      await Idb.put(key, blob);
      return { kind: 'idb', key: key, name: blob.name || '' };
    },

    async removeLocal(key) {
      if (this._urls[key]) {
        try { URL.revokeObjectURL(this._urls[key]); } catch (e) {}
        delete this._urls[key];
      }
      try { await Idb.del(key); } catch (e) {}
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
    _vad: null,
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
        // 静音检测（VAD）：说话开始后，若持续静音 1.2s 或总时长超 15s，自动停录
        Rec._vad = { start: Date.now(), sil: 0, has: false };
        node.onaudioprocess = (ev) => {
          const d = ev.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(d));
          let sum = 0;
          for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
          const rms = Math.sqrt(sum / d.length);
          const now = Date.now();
          if (rms > 0.01) {
            Rec._vad.has = true;
            Rec._vad.sil = 0;
          } else if (Rec._vad.has) {
            if (!Rec._vad.sil) Rec._vad.sil = now;
            if (now - Rec._vad.sil > 1500 && now - Rec._vad.start > 800) {
              if (Rec.onAutoStop) Rec.onAutoStop();
            }
          }
          if (now - Rec._vad.start > 15000) {
            if (Rec.onAutoStop) Rec.onAutoStop();
          }
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

  /* ---------------- 多选图片（批量录入） ---------------- */
  function pickPhotos() {
    return new Promise((resolve, reject) => {
      if (Native.available()) {
        Native.onPhotos = (arr) => {
          Native.onPhotoProgress = null;
          resolve(Array.isArray(arr) ? arr : []);
        };
        try {
          Android.pickImages();
        } catch (e) {
          reject(e);
        }
        return;
      }
      const input = $('#filePick');
      input.value = '';
      input.removeAttribute('capture');
      input.setAttribute('multiple', 'multiple');
      input.onchange = async () => {
        const files = Array.from(input.files || []).slice(0, 20);
        input.removeAttribute('multiple');
        if (!files.length) return resolve([]);
        try {
          const out = [];
          for (const f of files) out.push(await fileToB64(f, 1280));
          resolve(out);
        } catch (e) {
          reject(e);
        }
      };
      input.click();
    });
  }

  function fileToB64(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, (max || 1400) / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.82).split(',')[1]);
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = url;
    });
  }

  /* ---------------- 导入本地书籍（txt / md / html / epub / pdf） ---------------- */
  function pickBookFile() {
    return new Promise((resolve, reject) => {
      if (Native.available()) {
        Native.onBookFile = (obj) => resolve(obj || null);
        try {
          Android.pickBookFile();
        } catch (e) {
          reject(e);
        }
        return;
      }
      const input = $('#filePick');
      input.value = '';
      input.removeAttribute('capture');
      input.removeAttribute('multiple');
      input.accept = '.txt,.md,.markdown,.html,.htm,.epub,.pdf,text/plain';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        input.accept = 'image/*';
        if (!f) return resolve(null);
        const lower = f.name.toLowerCase();
        if (/\.(txt|md|markdown|html?)$/.test(lower)) {
          resolve({ kind: 'text', name: f.name, text: await f.text() });
        } else {
          resolve({ error: '浏览器预览版只支持 txt / md / html；epub、pdf 请用 APK' });
        }
      };
      input.click();
    });
  }

  /* ---------------- 唤起网盘 App / 系统浏览器 ---------------- */
  function openPanApp() {
    if (!Native.available()) {
      window.open('https://pan.baidu.com', '_blank');
      return false;
    }
    try {
      Android.openPanApp();
      return true;
    } catch (e) {
      toast('打不开百度网盘');
      return false;
    }
  }

  /** 外部链接优先交给系统浏览器（WebView 内没有登录态，授权页会反复要求登录） */
  function openExternal(url) {
    if (!url) return;
    if (Native.available()) {
      try {
        Android.openUrl(url);
        return;
      } catch (e) {}
    }
    const w = window.open(url, '_blank');
    if (!w) location.href = url;
  }

  /* ---------------- 选择本地音频 ---------------- */
  function pickAudioFile() {
    return new Promise((resolve, reject) => {
      if (Native.available()) {
        Native.onAudio = (obj) => {
          Native.onAudio = null;
          if (obj && obj.error) return reject(new Error(obj.error));
          if (!obj || !obj.b64) return resolve(null);
          try {
            const bytes = new Uint8Array(b64ToBuf(obj.b64));
            resolve({ name: obj.name || 'audio', blob: new Blob([bytes], { type: obj.mime || 'audio/mpeg' }) });
          } catch (e) {
            reject(new Error('读取音频失败'));
          }
        };
        try {
          Android.pickAudio();
        } catch (e) {
          Native.onAudio = null;
          reject(e);
        }
        return;
      }
      const input = $('#filePick');
      input.value = '';
      input.removeAttribute('capture');
      input.removeAttribute('multiple');
      const oldAccept = input.getAttribute('accept') || 'image/*';
      input.accept = 'audio/*';
      input.onchange = () => {
        input.accept = oldAccept;
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        if (f.size > 40 * 1024 * 1024) return reject(new Error('音频超过 40MB，请先剪短一些'));
        resolve({ name: f.name, blob: f });
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
  APP.Idb = Idb;
  APP.AudioBook = AudioBook;
  APP.pickPhoto = pickPhoto;
  APP.pickPhotos = pickPhotos;
  APP.pickBookFile = pickBookFile;
  APP.pickAudioFile = pickAudioFile;
  APP.openPanApp = openPanApp;
  APP.openExternal = openExternal;
  APP.fileToB64 = fileToB64;
  APP.normalizeScore = normalizeScore;
  APP.books = { all: allBooks, byId: bookById, sentenceAt: sentenceAt, count: sentenceCount, progress: bookProgress };
  APP.stats = stats;
  APP.audio = { bufToB64: bufToB64, b64ToBuf: b64ToBuf, pcmToWav: pcmToWav };
})();
