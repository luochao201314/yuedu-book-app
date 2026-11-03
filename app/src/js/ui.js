/* 界面渲染与交互 */
(function () {
  const APP = window.APP;
  const { $, $$, esc, toast, loading, buzz, dayKey } = APP.util;
  const Store = APP.Store, Api = APP.Api, TTS = APP.TTS, Rec = APP.Rec, Books = APP.books;

  const state = (APP.state = { view: 'library', book: null, filter: '全部', q: '', zh: Store.settings().zh, scoring: {} });

  const LEVELS = ['全部', 'L1', 'L2', 'L3', 'L4', '我的'];
  const DAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

  function shade(hex, amt) {
    const c = String(hex || '#7C8FB5').replace('#', '');
    const n = parseInt(c, 16) || 0x7c8fb5;
    const r = Math.max(0, Math.min(255, (n >> 16) + (amt || -30)));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + (amt || -30)));
    const b = Math.max(0, Math.min(255, (n & 255) + (amt || -30)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* ================= 单词：可点、发音、音标 ================= */
  function wordsHtml(text) {
    return String(text || '')
      .split(/([A-Za-z][A-Za-z'’\-]*)/)
      .map((part) => {
        if (!part) return '';
        if (/^[A-Za-z][A-Za-z'’\-]*$/.test(part)) {
          const w = esc(part);
          return '<span class="tw" data-w="' + w + '">' + w + '</span>';
        }
        return esc(part);
      })
      .join('');
  }

  let ipaGen = 0;
  let ipaTimer = 0;
  function sayWord(word) {
    const w = String(word || '').trim().replace(/[^A-Za-z'’\-]/g, '');
    if (!w) return;
    TTS.speakWord(w);
    showIpa(w);
  }
  async function showIpa(w) {
    const bar = $('#ipaBar');
    if (!bar) return;
    const gen = ++ipaGen;
    clearTimeout(ipaTimer);
    $('#ipaWord').textContent = w;
    $('#ipaText').textContent = '…';
    bar.hidden = false;
    requestAnimationFrame(() => bar.classList.add('show'));
    let r = null;
    try {
      r = await Api.ipa(w);
    } catch (e) {}
    if (gen !== ipaGen) return;
    $('#ipaText').textContent = r && r.ipa ? r.ipa : '音标暂缺';
    ipaTimer = setTimeout(() => {
      bar.classList.remove('show');
      setTimeout(() => {
        if (!bar.classList.contains('show')) bar.hidden = true;
      }, 240);
    }, 3400);
  }

  /* ================= 评分庆祝浮层 ================= */
  const TIERS = [
    { min: 95, key: 'excellent', badge: '🏆', pieces: 26 },
    { min: 90, key: 'wonderful', badge: '🎉', pieces: 22 },
    { min: 85, key: 'great', badge: '⭐', pieces: 16 },
    { min: 78, key: 'good', badge: '👍', pieces: 10 },
    { min: 70, key: 'nice', badge: '💪', pieces: 8 },
    { min: 0, key: 'keep', badge: '🌱', pieces: 6 },
  ];
  function tierOf(score) {
    const s = Number(score) || 0;
    for (let i = 0; i < TIERS.length; i++) if (s >= TIERS[i].min) return TIERS[i];
    return TIERS[TIERS.length - 1];
  }
  function confettiHtml(n) {
    const colors = ['#FFD25A', '#FF8A65', '#7ED0A0', '#7AA8F7', '#C79BF2', '#FFB3C7'];
    let out = '';
    for (let i = 0; i < n; i++) {
      const x = Math.round((Math.random() * 2 - 1) * 120);
      const dy = 140 + Math.round(Math.random() * 90);
      const r = Math.round(Math.random() * 900 - 450);
      const d = Math.round(Math.random() * 220);
      out +=
        '<i style="--x:' + x + 'px;--y:' + dy + 'px;--r:' + r + 'deg;--d:' + d + 'ms;background:' +
        colors[i % colors.length] + '"></i>';
    }
    return out;
  }

  let celeTimer = 0;
  function celebrate(res, ctx) {
    const t = tierOf(res.score);
    const grade = TTS.grade(res.score);
    const weak = (res.words || [])
      .filter((w) => w.score < 75)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
    let el = $('#cele');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cele';
      document.body.appendChild(el);
    }
    clearTimeout(celeTimer);
    el.className = 'cele tier-' + t.key;
    el.innerHTML =
      '<div class="cele-mask"></div>' +
      '<div class="cele-card">' +
      '<div class="cele-rays"></div>' +
      '<div class="cele-confetti">' + confettiHtml(t.pieces) + '</div>' +
      '<div class="cele-badge">' + t.badge + '</div>' +
      '<div class="cele-score"><b>0</b><i>分</i></div>' +
      '<div class="cele-grade">' + esc(grade) + '</div>' +
      (weak.length
        ? '<div class="cele-weak"><span>再练这几个词</span>' +
          weak
            .map((w) => '<button class="cele-w" data-w="' + esc(w.w) + '">' + esc(w.w) + '</button>')
            .join('') +
          '</div>'
        : '<div class="cele-weak ok">这一句很稳，继续下一句</div>') +
      '<div class="cele-actions">' +
      '<button class="btn ghost" id="celeRetry">再读一次</button>' +
      '<button class="btn primary" id="celeOk">继续</button>' +
      '</div>' +
      '</div>';
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));

    const numEl = $('.cele-score b', el);
    const dur = 640;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      numEl.textContent = Math.round((Number(res.score) || 0) * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    $$('.cele-w', el).forEach((b) => b.addEventListener('click', () => sayWord(b.dataset.w)));
    $('#celeOk', el).onclick = closeCele;
    $('#celeRetry', el).onclick = () => {
      closeCele();
      if (ctx && ctx.card) startFollow(ctx.card, ctx.text, ctx.key);
    };
    $('.cele-mask', el).onclick = closeCele;
    celeTimer = setTimeout(closeCele, weak.length ? 5600 : 4000);
  }

  function closeCele() {
    clearTimeout(celeTimer);
    const el = $('#cele');
    if (!el || el.hidden) return;
    el.classList.remove('show');
    setTimeout(() => {
      if (!el.classList.contains('show')) el.hidden = true;
    }, 260);
  }

  /* ================= 绘本库 ================= */
  function greeting() {
    const h = new Date().getHours();
    return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  }

  function renderLibrary() {
    const s = Store.settings();
    $('#greet').textContent = greeting() + '，' + s.name;
    $('#avatarBtn').textContent = s.name || '小宝';

    const st = APP.stats();
    $('#streakNum').textContent = st.streak;
    $('#heroSub').textContent = st.today.n
      ? '今天已跟读 ' + st.today.n + ' 句，继续加油'
      : '今天还没读，开口读一句就算打卡';

    // chips
    const chips = $('#levelChips');
    chips.innerHTML = LEVELS.map(
      (lv) => '<button class="chip' + (state.filter === lv ? ' on' : '') + '" data-lv="' + lv + '">' + lv + '</button>'
    ).join('');
    $$('.chip', chips).forEach((c) =>
      c.addEventListener('click', () => {
        state.filter = c.dataset.lv;
        renderLibrary();
      })
    );

    // list
    let list = Books.all();
    if (state.filter === '我的') list = list.filter((b) => b.source === 'mine');
    else if (state.filter !== '全部') list = list.filter((b) => b.level === state.filter);
    if (state.q) {
      const q = state.q.toLowerCase();
      list = list.filter((b) => (b.title + ' ' + (b.titleEn || '') + ' ' + (b.series || '')).toLowerCase().indexOf(q) >= 0);
    }
    $('#bookCount').textContent = list.length + ' 本';
    $('#libEmpty').hidden = list.length > 0;

    const grid = $('#bookGrid');
    grid.innerHTML = list
      .map((b) => {
        const p = Books.progress(b);
        return (
          '<div class="book" data-id="' + b.id + '">' +
          '<div class="cover" style="background:linear-gradient(135deg,' + (b.color || '#7C8FB5') + ',' + shade(b.color, -34) + ')">' +
          '<span class="lvl">' + esc(b.level) + '</span>' +
          '<span class="pct">' + (p.pct >= 100 ? '✓ 读完' : p.pct + '%') + '</span>' +
          '<span>' + (b.emoji || '📖') + '</span>' +
          '<span class="prog"><i style="width:' + p.pct + '%"></i></span>' +
          '</div>' +
          '<div class="book-name">' + esc(b.title) + '</div>' +
          '<div class="book-series">' + (b.source === 'mine' ? '<i class="dot-own"></i>' : '') + esc(b.series || '') + '</div>' +
          '</div>'
        );
      })
      .join('');

    $$('.book', grid).forEach((el) => {
      el.addEventListener('click', () => APP.ui.openReader(el.dataset.id));
    });
  }

  /* ================= 阅读 ================= */
  async function openReader(id) {
    const b = Books.byId(id);
    if (!b) return toast('绘本不存在');
    state.book = b;
    if (b.remote && b.pages.length <= 1 && !b._loaded) {
      loading(true, '正在取公版正文…');
      try {
        await loadRemote(b);
      } catch (e) {
        toast('正文加载失败，先读开头一句');
      }
      loading(false);
    }
    state.zh = Store.settings().zh;
    renderReader();
    APP.go('reader');
    TTS.warm(); // 预热云端朗读路由，降低首次领读的等待
    TTS.prefetchPraise(); // 提前缓存等级词音频，评完分立刻出声
  }

  /* 正文获取优先级：后端代理（无 CORS 限制）→ 原生 httpGet → 直连 */
  async function fetchBody(b) {
    try {
      const j = await Api.req('/api/gutenberg?url=' + encodeURIComponent(b.gutenberg), { cache: 'no-store' }, 60000);
      if (j && typeof j.text === 'string' && j.text.length > 200) return j.text;
    } catch (e) {}
    if (APP.Native.available()) {
      try {
        const t = Android.httpGet(b.gutenberg);
        if (t && t.length > 200) return t;
      } catch (e) {}
    }
    try {
      const r = await fetch(b.gutenberg, { cache: 'force-cache' });
      if (r.ok) {
        const t = await r.text();
        if (t && t.length > 200) return t;
      }
    } catch (e) {}
    throw new Error('fetch failed');
  }

  async function loadRemote(b) {
    const t0 = await fetchBody(b);
    let t = t0;
    const m = t.search(/START OF (THE|THIS) PROJECT GUTENBERG/i);
    if (m > 0) t = t.slice(m);
    const e = t.search(/END OF (THE|THIS) PROJECT GUTENBERG/i);
    if (e > 0) t = t.slice(0, e);
    t = t.replace(/\r/g, ' ').replace(/\n+/g, ' ');
    const parts = t
      .split(/(?<=[.!?])\s+/)
      .map((x) => x.trim().replace(/^["'“”]+|["'“”]+$/g, ''))
      .filter((x) => x.length > 18 && x.length < 160 && /[A-Za-z]{3}/.test(x) && !/gutenberg|chapter|copyright/i.test(x));
    const uniq = [];
    parts.forEach((p) => {
      if (uniq.indexOf(p) < 0 && uniq.length < 24) uniq.push(p);
    });
    if (!uniq.length) throw new Error('empty');
    b.pages = [{ sentences: uniq.map((en) => ({ en: en, zh: '' })) }];
    b._loaded = true;
    // 缓存正文，避免重复下载
    const cache = Store.get('yq.body.v2', {});
    cache[b.id] = b.pages;
    Store.set('yq.body.v2', cache);
  }

  function updateReaderBar() {
    const b = state.book;
    if (!b) return;
    const pr = Books.progress(b);
    $('#readerBar').style.width = Math.min(100, pr.pct) + '%';
  }

  /** 播放某一句话对应的原声片段（音频绘本）；取不到音频时退回合成朗读 */
  async function playSentence(b, s, rate) {
    let src = b._src;
    if (!src) {
      src = await APP.AudioBook.srcOf(b);
      if (!src) {
        toast('原声读取失败，先用合成朗读');
        TTS.speak(s.en, Store.settings().rate);
        return;
      }
      b._src = src;
    }
    if (!TTS.playClip(src, s.a[0], s.a[1], rate)) TTS.speak(s.en, Store.settings().rate);
  }

  function renderReader() {
    const b = state.book;
    if (!b) return;
    const cache = Store.get('yq.body.v2', {});
    if (!b._loaded && cache[b.id]) {
      b.pages = cache[b.id];
      b._loaded = true;
    }
    $('#readerName').textContent = b.title;
    $('#readerMeta').textContent = [b.titleEn, b.series, b.level].filter(Boolean).join(' · ') + (b.audio ? ' · 🎧 原声' : '');
    $('#readerZh').style.opacity = state.zh ? 1 : 0.45;
    $('#readerZh').textContent = state.zh ? '中' : '中';
    $('#readerDel').hidden = b.source !== 'mine';

    const list = $('#sentenceList');
    const pr = Books.progress(b);
    let n = 0;
    list.innerHTML = (b.pages || [])
      .map((pg, pi) =>
        (pg.sentences || [])
          .map((s, si) => {
            n++;
            const key = b.id + '|' + pi + '|' + si;
            const rec = Store.progress()[key];
            return (
              '<div class="sentence' + (rec ? ' done' : '') + '" data-key="' + key + '" data-pi="' + pi + '" data-si="' + si + '">' +
              '<div class="idx">' + String(n).padStart(2, '0') + '</div>' +
              '<div class="en">' + wordsHtml(s.en) + '</div>' +
              (state.zh && s.zh ? '<div class="zh">' + esc(s.zh) + '</div>' : '') +
              '<div class="actions">' +
              '<button class="btn lead" data-act="lead">🔊 领读</button>' +
              '<button class="btn follow" data-act="follow">🎤 跟读</button>' +
              '<button class="btn slow" data-act="slow" aria-label="慢读">🐢 慢读</button>' +
              '<span class="score-pill" hidden></span>' +
              '</div>' +
              '<div class="words" hidden></div>' +
              '<div class="fix" hidden></div>' +
              '<div class="rec-row" hidden></div>' +
              '</div>'
            );
          })
          .join('')
      )
      .join('');

    if (pr.pct >= 100) $('#readerBar').style.width = '100%';
    else $('#readerBar').style.width = pr.pct + '%';

    // 后台预取当前页的自然语音：用户点「领读」时直接秒出，不用等合成
    const firstPage = (b.pages || [])[0];
    if (firstPage && firstPage.sentences) {
      const rate = Store.settings().rate;
      const texts = firstPage.sentences.filter((s) => !(s.a && b.audio)).map((s) => s.en);
      if (texts.length) TTS.prefetch(texts, rate);
    }

    $$('.sentence', list).forEach((card) => {
      const pi = Number(card.dataset.pi), si = Number(card.dataset.si);
      const key = card.dataset.key;
      const saved = Store.progress()[key];
      if (saved) paintScore(card, saved, false);
      card.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-act]');
        const bw = ev.target.closest('.tw, .w');
        if (bw) {
          sayWord(bw.dataset.w || bw.textContent.trim());
          return;
        }
        if (!btn) return;
        const act = btn.dataset.act;
        const s = Books.sentenceAt(b, pi, si);
        if (!s) return;
        if (act === 'lead' || act === 'slow') {
          if (s.a && b.audio) playSentence(b, s, act === 'slow' ? 0.75 : 1);
          else TTS.speak(s.en, act === 'slow' ? 0.62 : Store.settings().rate);
        }
        if (act === 'follow') startFollow(card, s.en, key);
      });
    });

    renderReaderFoot();
  }

  function renderReaderFoot() {
    const b = state.book;
    if (!b) return;
    const pr = Books.progress(b);
    const total = Books.count(b);
    $('#readerFoot').innerHTML =
      '<div class="foot-row">' +
      '<div class="foot-stat"><b>' + pr.done + '/' + total + '</b>已读句子</div>' +
      '<div class="foot-stat"><b>' + (pr.avg || '–') + '</b>本书均分</div>' +
      '<button class="btn primary foot-btn" id="nextUnread">下一句未读</button>' +
      '</div>';
    const btn = $('#nextUnread');
    if (btn)
      btn.addEventListener('click', () => {
        const pr2 = Store.progress();
        const next = $$('.sentence').find((c) => !pr2[c.dataset.key]);
        if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else toast('这本已经全部读过啦 🎉');
      });
  }

  function paintScore(card, res, animate) {
    const pill = $('.score-pill', card);
    const wordsEl = $('.words', card);
    const fixEl = $('.fix', card);
    const grade = TTS.grade(res.score);
    pill.hidden = false;
    pill.className = 'score-pill' + (res.score >= 85 ? '' : res.score >= 70 ? ' mid' : ' low');
    pill.innerHTML =
      '<b>' + res.score + ' 分</b>' +
      '<span class="grade">' + esc(grade) + '</span>';
    if (res.words && res.words.length) {
      wordsEl.hidden = false;
      wordsEl.innerHTML = res.words
        .map((w) => '<span class="w ' + (w.score >= 88 ? 'good' : w.score >= 72 ? 'mid' : 'bad') + '">' + esc(w.w) + '</span>')
        .join(' ');
    }
    if (res.completeness != null && res.completeness < 60) {
      // 完整度低说明这遍读的和句子差得多，纠错单词意义不大，直接提示重读
      fixEl.hidden = false;
      fixEl.innerHTML =
        '🔍 <b>没对上句子</b> 完整度 ' + res.completeness + '%，先点「领读」听一遍，再跟着一句一句读。';
    } else if (res.fixes && res.fixes.length) {
      fixEl.hidden = false;
      fixEl.innerHTML = '🔧 <b>纠错</b> ' + res.fixes.slice(0, 3).map(esc).join('；');
    } else {
      fixEl.hidden = true;
    }
    card.classList.add('done');
    if (animate) {
      card.animate(
        [{ transform: 'scale(.99)' }, { transform: 'scale(1.01)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: 'ease-out' }
      );
    }
  }

  /* ---------- 录音与评分 ---------- */
  let recCtx = null;
  async function startFollow(card, text, key) {
    // 点击跟读：先立即停止领读发音（原生 TTS / 云端音频 / Web Speech 一并打断），避免重叠
    TTS.stop();
    if (Rec.isRecording()) {
      await stopFollow();
      return;
    }
    const settings = Store.settings();
    recCtx = { card: card, text: text, key: key, b64: null, dur: 0 };
    try {
      await Rec.start();
    } catch (e) {
      recCtx = null;
      if (String(e.message) === 'permission') toast('请在系统设置里允许麦克风权限');
      else toast('无法使用麦克风：' + (e.message || '设备不支持'));
      return;
    }
    buzz(10);
    $('#recBar').classList.add('show');
    Rec.onTick = (sec) => {
      $('#recTime').textContent = sec.toFixed(1) + 's';
    };
    // 说完后自动停录并评分（无需手动点停止）。
    // Android 原生侧由 Java 静音检测触发 window.Native.onAutoStop()，
    // 因此必须同时挂接 Native.onAutoStop（原生路径）与 Rec.onAutoStop（Web 路径）。
    const autoStop = () => {
      if (Rec.isRecording()) stopFollow();
    };
    Rec.onAutoStop = autoStop;
    Native.onAutoStop = autoStop;
    // 录音期间按钮变为停止
    const btn = $('[data-act="follow"]', card);
    if (btn) {
      btn.textContent = '⏹ 停止';
      btn.classList.add('btn-recording');
    }
  }

  async function stopFollow() {
    if (!Rec.isRecording()) return;
    clearInterval(Rec._timer);
    Rec.onAutoStop = null;
    Native.onAutoStop = null;
    const ctx = recCtx;
    recCtx = null;
    $('#recBar').classList.remove('show');
    $('#recTime').textContent = '0.0s';
    const btn = ctx && $('[data-act="follow"]', ctx.card);
    if (btn) {
      btn.textContent = '🎤 跟读';
      btn.classList.remove('btn-recording');
    }
    let out = null;
    try {
      out = await Rec.stop();
    } catch (e) {
      return toast('录音失败');
    }
    if (!out || !out.wavB64) return;
    if (out.dur < 0.6) return toast('太短了，再读一次吧');
    ctx.b64 = out.wavB64;
    ctx.dur = out.dur;
    if (Store.settings().autoScore) await scoreCtx(ctx);
    else showRecRow(ctx);
  }

  function showRecRow(ctx) {
    const row = $('.rec-row', ctx.card);
    row.hidden = false;
    row.innerHTML =
      '<button class="play-mini" data-play>▶️ 回放 ' + ctx.dur.toFixed(1) + 's</button>' +
      '<button class="btn follow" data-score style="padding:6px 12px;min-height:34px;font-size:12.5px">评分</button>' +
      '<button class="play-mini" data-retry>重录</button>';
    $('[data-play]', row).onclick = () => playB64(ctx.b64);
    $('[data-score]', row).onclick = () => scoreCtx(ctx);
    $('[data-retry]', row).onclick = () => startFollow(ctx.card, ctx.text, ctx.key);
  }

  function playB64(b64) {
    try {
      const a = new Audio('data:audio/wav;base64,' + b64);
      a.play();
    } catch (e) {
      toast('无法播放录音');
    }
  }

  async function scoreCtx(ctx) {
    if (state.scoring[ctx.key]) return;
    state.scoring[ctx.key] = true;
    loading(true, '正在评分…');
    try {
      const raw = await Api.score(ctx.text, ctx.b64);
      const res = APP.normalizeScore(raw);
      if (!res.words.length && !res.score) throw new Error('评分结果为空');
      Store.setProgress(ctx.key, res);
      const b = state.book;
      const parts = ctx.key.split('|');
      Store.addSession({
        ts: Date.now(),
        day: dayKey(),
        bookId: b.id,
        bookTitle: b.title,
        pi: Number(parts[1]),
        si: Number(parts[2]),
        en: ctx.text,
        score: res.score,
        words: res.words,
        fixes: res.fixes,
        completeness: res.completeness,
        fluency: res.fluency,
        dur: Math.round(ctx.dur * 10) / 10,
      });
      paintScore(ctx.card, res, true);
      // 播报：等级词（缓存秒出）+ 分数 + 薄弱词（精炼英文）
      const weakWords = (res.words || [])
        .filter((w) => w.score < 75)
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .map((w) => w.w);
      TTS.speakPraise(res.score, weakWords);
      celebrate(res, ctx);
      showRecRow(ctx);
      renderReaderFoot();
      updateReaderBar();
      buzz(14);
    } catch (e) {
      const row = $('.rec-row', ctx.card);
      row.hidden = false;
      const friendly = e.code === 'timeout'
        ? '评分超时，后端可能正在冷启动'
        : e.status === 422
          ? '没听到清楚的声音，再读一次'
          : e.status === 200
            ? (e.message || '后端未配置语音评测')
            : e.status
              ? '评分服务异常（后端 ' + e.status + '）'
              : '网络不可用，评分失败';
      row.innerHTML =
        '<span class="score-err">' + esc(friendly) + '</span>' +
        '<button class="btn ghost" data-retry style="padding:6px 12px;min-height:34px;font-size:12.5px">重试</button>';
      $('[data-retry]', row).onclick = () => scoreCtx(ctx);
      toast('录音已保留，可点重试');
    } finally {
      loading(false);
      delete state.scoring[ctx.key];
    }
  }

  /* ================= 成长 ================= */
  function renderGrowth() {
    const st = APP.stats();
    $('#stBooks').textContent = st.booksDone;
    $('#stSent').textContent = st.total;
    $('#stAvg').textContent = st.total ? st.avg : '–';
    $('#growthPill').textContent = st.streak >= 7 ? '🔥 自律达人' : st.streak >= 3 ? '🌿 坚持中' : '🌱 新手';

    const max = Math.max.apply(null, st.trend.map((t) => t.avg).concat([60]));
    $('#trendChart').innerHTML = st.trend
      .map(
        (t, i) =>
          '<div class="bar' + (i === 6 ? ' today' : '') + '">' +
          '<div class="v">' + (t.n ? t.avg : '') + '</div>' +
          '<div class="track"><div class="fill" style="height:' + (t.n ? Math.max(8, (t.avg / max) * 100) : 0) + '%"></div></div>' +
          '<div class="d">' + t.label + '</div>' +
          '</div>'
      )
      .join('');
    $('#trendHint').textContent = '本周 ' + st.trend.reduce((a, t) => a + t.n, 0) + ' 句';

    if (!st.weak.length) {
      $('#weakList').innerHTML = '<div class="empty">多读几句，这里会列出你最容易读错的词</div>';
    } else {
      const top = Math.max.apply(null, st.weak.map((w) => w.n));
      $('#weakList').innerHTML = st.weak
        .map(
          (w) =>
            '<div class="weak-item" data-w="' + esc(w.w) + '">' +
            '<div class="weak-word">' + esc(w.w) + '<span class="sp">🔊</span></div>' +
            '<div class="weak-bar"><i style="width:' + Math.max(12, (w.n / top) * 100) + '%"></i></div>' +
            '<div class="weak-times">错 ' + w.n + ' 次</div>' +
            '</div>'
        )
        .join('');
      $$('#weakList .weak-item').forEach((el) =>
        el.addEventListener('click', () => TTS.speak(el.dataset.w, 0.7))
      );
    }

    const recent = st.sessions.slice().reverse().slice(0, 6);
    $('#recentList').innerHTML = recent.length
      ? recent
          .map((s) => {
            const d = new Date(s.ts);
            const cls = s.score >= 85 ? '' : s.score >= 70 ? 'mid' : 'bad';
            return (
              '<div class="rec-item">' +
              '<div class="t"><b>' + esc(s.bookTitle || '绘本') + '</b><span>' + esc(s.en || '') + '</span></div>' +
              '<div class="s ' + cls + '">' + s.score + '</div>' +
              '</div>'
            );
          })
          .join('')
      : '<div class="empty">还没有跟读记录</div>';

    $('#badgeCount').textContent = st.badgeOn + '/' + st.badges.length;
    $('#badgeGrid').innerHTML = st.badges
      .map((b) => '<div class="badge' + (b.on ? ' on' : '') + '"><span class="bi">' + b.icon + '</span><span class="bn">' + b.name + '</span></div>')
      .join('');
  }

  /* ================= 我的 ================= */
  function renderMe() {
    const s = Store.settings();
    $('#meName').value = s.name || '小宝';
    $('#meAvatar').textContent = (s.name || '宝').slice(0, 1);
    $('#apiBase').value = s.backend || '';
    $('#rate').value = s.rate;
    $('#rateVal').textContent = Number(s.rate).toFixed(2).replace(/0$/, '') + 'x';
    $('#zhSwitch').classList.toggle('on', !!s.zh);
    $('#autoScore').classList.toggle('on', !!s.autoScore);
    $('#dataSize').textContent = Math.round(Store.size() / 1024) + ' KB';
    $('#apiNote').textContent = '评分：' + (s.backend ? 'Azure 发音评测（经你的后端）' : '未配置，无法评分');
    if (!APP.health) testApi(true);
  }

  async function testApi(silent) {
    const el = $('#apiStatus');
    const note = $('#apiNote');
    el.className = 'status';
    el.textContent = '检测中…';
    try {
      const h = await Api.health();
      APP.health = h;
      el.className = 'status ok';
      el.textContent = '已连接';
      note.className = 'note';
      note.textContent = '服务存活 · 语音评测' + (h.azure ? '已配置' : '未配置') +
        ' · 音频转写' + (h.asr ? '可用' : '不可用') +
        ' · 网盘' + (h.pan ? '已配置' : '未配置') +
        ' · OCR' + (h.ocr ? '已配置' : '未配置') +
        '（健康检查不等于评分可用，跟读时以实际结果为准）';
    } catch (e) {
      APP.health = null;
      el.className = 'status bad';
      el.textContent = '未连接';
      note.className = 'note err';
      note.textContent = '无法连接：' + (e.message || '网络错误') + '。后端在 Render 免费实例上，首次访问需唤醒 30-60 秒。';
      if (!silent) toast('连接失败');
    }
  }

  /* ================= 拍照录入（支持多张合并成一本） ================= */
  const MAX_OCR_PAGES = 20;   // 与原生 MAX_PICK_IMAGES、PDF 导入上限保持一致
  let ocrImgs = [];        // 已选图片 base64
  let ocrPages = [];       // 每张图识别出的文字（按页）
  let ocrEdited = false;   // 用户是否手改过文本框

  function openOCR() {
    ocrImgs = [];
    ocrPages = [];
    ocrEdited = false;
    const body = $('#sheetBody');
    body.innerHTML =
      '<h3>📷 拍照录入绘本</h3>' +
      '<div class="desc">可以一次拍/选多页，也能分几次追加，识别后合成同一本绘本，再起个名字。图片只在本机与你的后端之间传输，不会保存。' +
      '<br><span class="muted">单本最多 ' + MAX_OCR_PAGES + ' 页；照片里的页码、页眉页脚会自动过滤。</span></div>' +
      '<div class="sheet-actions" style="margin-bottom:8px">' +
      '<button class="btn ghost" id="btnCamera">📷 拍一页</button>' +
      '<button class="btn ghost" id="btnGallery">🖼 相册多选</button>' +
      '</div>' +
      '<div class="thumb-grid" id="ocrThumbs"></div>' +
      '<label class="field" style="border:none"><span>书名</span><input id="ocrTitle" class="input" placeholder="给这本书起个名字" /></label>' +
      '<textarea id="ocrText" class="ocr-text" placeholder="识别结果会出现在这里，可以手动修改（每行/每句都会被拆成跟读句）"></textarea>' +
      '<div class="muted" id="ocrState" style="margin:-6px 0 10px"></div>' +
      '<div class="sheet-actions">' +
      '<button class="btn ghost" id="ocrCancel">取消</button>' +
      '<button class="btn ghost" id="ocrRun">开始识别</button>' +
      '<button class="btn primary" id="ocrSave" disabled>存成一本绘本</button>' +
      '</div>';
    $('#sheetMask').classList.add('show');
    $('#ocrTitle').value = defaultMineTitle();
    $('#ocrText').addEventListener('input', () => {
      ocrEdited = true;
      $('#ocrSave').disabled = !$('#ocrText').value.trim();
    });
    $('#ocrCancel').onclick = closeSheet;

    const drawThumbs = () => {
      $('#ocrThumbs').innerHTML = ocrImgs
        .map(
          (b64, i) =>
            '<div class="thumb"><img src="data:image/jpeg;base64,' + b64 + '" alt="" />' +
            '<button class="thumb-x" data-i="' + i + '" aria-label="移除">×</button>' +
            '<span class="thumb-i">' + (i + 1) + '</span></div>'
        )
        .join('');
      $$('#ocrThumbs .thumb-x').forEach((b) =>
        b.addEventListener('click', () => {
          ocrImgs.splice(Number(b.dataset.i), 1);
          ocrPages = [];
          drawThumbs();
          updateOcrState();
        })
      );
      updateOcrState();
    };
    const updateOcrState = () => {
      const n = ocrImgs.length;
      $('#ocrRun').disabled = !n;
      $('#ocrRun').textContent = n ? '开始识别（' + n + ' 页）' : '开始识别';
      if (!n) $('#ocrState').textContent = '还没有图片，先拍一页或从相册多选（可多次追加）';
      else if (!ocrPages.length) $('#ocrState').textContent = '已选 ' + n + '/' + MAX_OCR_PAGES + ' 页，可以继续追加，或点『开始识别』';
      else $('#ocrState').textContent = '已识别 ' + n + ' 页，可修改文字后保存';
    };

    const addImgs = (arr) => {
      let dropped = 0;
      arr.forEach((b64) => {
        if (!b64) return;
        if (ocrImgs.length < MAX_OCR_PAGES) ocrImgs.push(b64);
        else dropped++;
      });
      if (dropped) toast('一本最多 ' + MAX_OCR_PAGES + ' 页，已忽略多出的 ' + dropped + ' 张');
      ocrPages = [];
      drawThumbs();
    };

    $('#btnCamera').onclick = async () => {
      try {
        const b64 = await APP.pickPhoto('camera');
        if (b64) addImgs([b64]);
      } catch (e) {
        toast('打开相机失败');
      }
    };
    $('#btnGallery').onclick = async () => {
      try {
        // 20 张要解码十几秒，把进度打到面板上，别让人以为卡死
        APP.Native.onPhotoProgress = (got, total) => {
          $('#ocrState').textContent = '正在读取照片 ' + got + '/' + total + '…';
        };
        const arr = await APP.pickPhotos();
        APP.Native.onPhotoProgress = null;
        if (arr && arr.length) addImgs(arr);
        else updateOcrState();
      } catch (e) {
        APP.Native.onPhotoProgress = null;
        toast('打开相册失败');
      }
    };

    $('#ocrRun').onclick = async () => {
      if (!ocrImgs.length) return;
      loading(true, '识别文字中…');
      const texts = [];
      try {
        for (let i = 0; i < ocrImgs.length; i++) {
          $('#ocrState').textContent = '正在识别第 ' + (i + 1) + '/' + ocrImgs.length + ' 页…';
          try {
            const raw = await Api.ocr(ocrImgs[i], 'eng');
            texts.push(pickOcrText(raw));
          } catch (e) {
            texts.push('');
          }
        }
        ocrPages = texts.map((t) => cleanOcrText(t));
        // 多页去重页眉页脚（同一行在多页重复出现）
        if (ocrPages.length > 1) ocrPages = dedupeRunningLines(ocrPages);
        const merged = ocrPages.filter((t) => t.trim()).join('\n\n');
        if (!ocrEdited || !$('#ocrText').value.trim()) $('#ocrText').value = merged;
        $('#ocrSave').disabled = !$('#ocrText').value.trim();
        const hit = ocrPages.filter((t) => t.trim()).length;
        $('#ocrState').textContent = hit
          ? '识别完成：' + hit + '/' + ocrPages.length + ' 页有文字，可修改后保存'
          : '没有识别到英文，试试更清晰的照片或手动输入';
        if (!hit) toast('未识别到文字，试试更清晰的照片');
      } finally {
        loading(false);
      }
    };

    $('#ocrSave').onclick = () => {
      const text = $('#ocrText').value.trim();
      if (!text) return toast('还没有文字');
      // 没改过就用分页结构；改过就整体重新分句
      let pages;
      if (ocrEdited || ocrPages.filter((t) => t.trim()).length < 2) {
        const sentences = splitSentences(text);
        if (!sentences.length) return toast('至少需要一句完整的英文');
        pages = [{ sentences: sentences.map((en) => ({ en: en, zh: '' })) }];
      } else {
        pages = ocrPages
          .map((t) => ({ sentences: splitSentences(t).map((en) => ({ en: en, zh: '' })) }))
          .filter((p) => p.sentences.length);
        if (!pages.length) {
          const sentences = splitSentences(text);
          if (!sentences.length) return toast('至少需要一句完整的英文');
          pages = [{ sentences: sentences.map((en) => ({ en: en, zh: '' })) }];
        }
      }
      const book = {
        id: 'mine-' + Date.now(),
        title: ($('#ocrTitle').value || '我的绘本').trim(),
        titleEn: '',
        series: '我的绘本',
        level: '我的',
        source: 'mine',
        color: '#7C8FB5',
        emoji: '📷',
        pages: pages,
      };
      Store.addMine(book);
      closeSheet();
      toast('已存成《' + book.title + '》，共 ' + pages.reduce((a, p) => a + p.sentences.length, 0) + ' 句');
      APP.go('library');
      renderLibrary();
    };

    drawThumbs();
  }

  function defaultMineTitle() {
    const n = Store.mine().length + 1;
    return '我的绘本 ' + n;
  }

  /* 清理 OCR 噪点：页码、页眉页脚、符号乱码、断词连字符 */
  function cleanOcrText(text) {
    if (!text) return '';
    let s = String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
      // 连字符断词：exam-\nple → example
      .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, '$1$2')
      // 常见 OCR 误识别
      .replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/\u2013|\u2014/g, '-')
      .replace(/[|¦]/g, ' ')
      .replace(/[•·●○◆◇★☆]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ');

    const lines = s.split('\n').map((l) => l.replace(/^[ \t]+|[ \t]+$/g, ''));
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { out.push(''); continue; }
      if (isPageNumberLine(line)) continue;
      if (isHeaderLine(line)) continue;
      if (isGarbageLine(line)) continue;
      out.push(line);
    }
    let res = out.join('\n').replace(/\n{3,}/g, '\n\n');
    // 行内多余空格清理：标点前空格、单词间多空格
    res = res.replace(/[ \t]+([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
    return res.trim();
  }

  function isPageNumberLine(line) {
    const t = line.trim();
    if (!t || t.length > 32) return false;
    // 纯数字：12 / - 12 - / 12 of 30 / 12/30
    if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t)) return true;
    if (/^\d{1,4}\s*(\/|of)\s*\d{1,4}$/i.test(t)) return true;
    // Page 12 / p.12 / PAGE TWELVE
    if (/^(page|p|pg)\.?\s*\d{1,4}$/i.test(t)) return true;
    // 罗马数字页码
    if (/^(?=[ivxlcdm]+$)i{1,3}|iv|vi{0,3}|ix|xi{0,3}$/i.test(t)) return true;
    // 汉字/中文页码
    if (/^第?\s*\d{1,4}\s*页$/.test(t)) return true;
    return false;
  }

  /** 全大写短行（如 BROWN BEAR / THE LITTLE RED HEN）多是页眉标题，跟读句里没有意义 */
  function isHeaderLine(line) {
    const t = line.trim();
    if (!t || t.length > 40) return false;
    if (/[.!?,;:"]/.test(t)) return false;
    if (/[a-z]/.test(t)) return false;
    const letters = (t.match(/[A-Z]/g) || []).length;
    const words = t.split(/\s+/).filter((w) => /[A-Z]/.test(w)).length;
    return letters >= 4 && words >= 2;
  }

  function isGarbageLine(line) {
    const t = line.trim();
    if (!t) return true;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const digits = (t.match(/\d/g) || []).length;
    const printable = (t.match(/[A-Za-z0-9\u4e00-\u9fff\s,.;:!?'"()\[\]\-]/g) || []).length;
    const ratio = printable / t.length;
    // 一行里几乎没有字母/汉字，且充满符号 → 丢掉
    if (letters + cjk === 0) return true;
    if (letters + cjk < 3 && digits > 0) return true;
    if (ratio < 0.6) return true;
    return false;
  }

  /** 多页时删除重复出现的页眉/页脚：只看每页第一行和最后一行，避免误删重复的正文句 */
  function dedupeRunningLines(pages) {
    const norm = (l) => l.trim().replace(/\d+/g, '#').toLowerCase();
    const linesOf = (p) =>
      String(p || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const count = {};
    pages.forEach((p) => {
      const ls = linesOf(p);
      if (!ls.length) return;
      const seen = new Set();
      [ls[0], ls[ls.length - 1]].forEach((l) => {
        const k = norm(l);
        if (k.length > 48 || seen.has(k)) return;
        seen.add(k);
        count[k] = (count[k] || 0) + 1;
      });
    });
    const limit = Math.max(2, Math.ceil(pages.length * 0.5));
    const drop = Object.keys(count).filter((k) => count[k] >= limit);
    if (!drop.length) return pages;
    const dropSet = new Set(drop);
    return pages.map((p) => {
      const ls = linesOf(p);
      if (ls.length < 2) return String(p || '').trim();
      const head = ls[0];
      const tail = ls[ls.length - 1];
      const body = ls.slice(1, ls.length - 1).filter((l) => !dropSet.has(norm(l)));
      const keepHead = dropSet.has(norm(head)) ? [] : [head];
      const keepTail = dropSet.has(norm(tail)) ? [] : [tail];
      return keepHead.concat(body, keepTail).join('\n');
    });
  }

  function pickOcrText(raw) {
    const j = raw || {};
    const cand = j.text || j.result || j.content || (j.data && (j.data.text || j.data.result)) || '';
    if (typeof cand === 'string' && cand.trim()) return cand.trim();
    if (Array.isArray(j.sentences)) return j.sentences.join('\n');
    if (Array.isArray(j.lines)) return j.lines.map((l) => (typeof l === 'string' ? l : l.text || '')).join('\n');
    if (Array.isArray(j.results)) return j.results.map((r) => r.text || '').join('\n');
    return '';
  }

  /** 按行 + 标点分句：行尾没标点且下一行是小写开头 → 视为同一句（OCR 换行断句） */
  function splitSentences(text, limit) {
    const lines = String(text)
      .replace(/\r/g, '\n')
      .replace(/[“”]/g, '"')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const blocks = [];
    let cur = '';
    lines.forEach((line) => {
      if (!cur) {
        cur = line;
        return;
      }
      const prevOpen = !/[.!?:;"]$/.test(cur);
      const nextLower = /^[a-z]/.test(line);
      if (prevOpen && nextLower) cur += ' ' + line;
      else {
        blocks.push(cur);
        cur = line;
      }
    });
    if (cur) blocks.push(cur);

    const out = [];
    blocks.forEach((b) => {
      String(b)
        .split(/(?<=[.!?])\s+(?=["']?[A-Z0-9])/)
        .forEach((s) => {
          const t = s.trim().replace(/^["']+|["']+$/g, '').replace(/\s{2,}/g, ' ');
          if (t.length > 3 && /[A-Za-z]{2}/.test(t)) out.push(t);
        });
    });
    return out.slice(0, limit || 40);
  }

  function closeSheet() {
    $('#sheetMask').classList.remove('show');
  }

  /* ================= 导入本地书籍（txt / md / html / epub / pdf） ================= */
  let importPages = null; // PDF 逐页识别结果（供分页保存）

  function openImport() {
    importPages = null;
    const body = $('#sheetBody');
    body.innerHTML =
      '<h3>📥 导入本地书籍</h3>' +
      '<div class="desc">支持 txt / md / html / epub / pdf。' +
      '<br><span class="muted">epub 自动抽取正文；pdf 逐页转图片再识别（最多 20 页）。导入后和拍照录入一样能跟读评分。</span></div>' +
      '<div class="sheet-actions" style="margin-bottom:8px">' +
      '<button class="btn ghost" id="importPick">📂 选择文件</button>' +
      '</div>' +
      '<div class="muted" id="importState" style="margin:-2px 0 10px">还没有选择文件</div>' +
      '<label class="field" style="border:none"><span>书名</span><input id="importTitle" class="input" placeholder="默认用文件名" /></label>' +
      '<textarea id="importText" class="ocr-text" placeholder="导入的文字会出现在这里，可以修改后再保存"></textarea>' +
      '<div class="sheet-actions">' +
      '<button class="btn ghost" id="importCancel">取消</button>' +
      '<button class="btn primary" id="importSave" disabled>存成一本绘本</button>' +
      '</div>';
    $('#sheetMask').classList.add('show');
    $('#importCancel').onclick = closeSheet;
    const setText = (t) => {
      $('#importText').value = t || '';
      $('#importSave').disabled = !(t || '').trim();
    };
    $('#importText').addEventListener('input', () => {
      importPages = null; // 手动改过就整体重新分句
      $('#importText').dataset.edited = '1';
      $('#importSave').disabled = !$('#importText').value.trim();
    });
    $('#importSave').onclick = () => saveImport();

    const run = async () => {
      let file;
      try {
        file = await APP.pickBookFile();
      } catch (e) {
        return toast('打开文件失败');
      }
      if (!file) return;
      if (file.error) return toast(file.error);
      const name = file.name || '未命名';
      $('#importTitle').value = titleFromFile(name);

      if (file.kind === 'pdf') {
        const pages = Array.isArray(file.pages) ? file.pages : [];
        if (!pages.length) return toast('这个 PDF 打不开或没有页面');
        const texts = [];
        loading(true, '转换 PDF 第 1 页…');
        try {
          for (let i = 0; i < pages.length; i++) {
            $('#importState').textContent = '正在识别 PDF 第 ' + (i + 1) + '/' + pages.length + ' 页…';
            loading(true, '识别 PDF 第 ' + (i + 1) + '/' + pages.length + ' 页…');
            try {
              const raw = await Api.ocr(pages[i], 'eng');
              texts.push(cleanOcrText(pickOcrText(raw)));
            } catch (e) {
              texts.push('');
            }
          }
        } finally {
          loading(false);
        }
        const deduped = dedupeRunningLines(texts);
        importPages = deduped.map((t) => splitSentences(t)).filter((arr) => arr.length);
        const merged = deduped.filter((t) => t.trim()).join('\n\n');
        setText(merged);
        const hit = deduped.filter((t) => t.trim()).length;
        $('#importState').textContent = hit
          ? 'PDF 共 ' + (file.total || pages.length) + ' 页，已识别 ' + hit + ' 页，可修改后保存'
          : 'PDF 没有识别出英文，扫描版太模糊的话换一本试试';
        if (!hit) toast('PDF 未识别到文字');
        return;
      }

      let text = String(file.text || '');
      if (/\.(html?|xhtml)$/i.test(name)) text = htmlToText(text);
      else text = String(text).replace(/\r\n?/g, '\n');
      text = cleanImportText(text);
      setText(text);
      const n = splitSentences(text, 4000).length;
      $('#importState').textContent = n
        ? '已读取《' + titleFromFile(name) + '》，约 ' + n + ' 句，可修改后保存'
        : '这个文件里没找到英文句子';
      if (!n) toast('文件里没有英文句子');
    };

    $('#importPick').onclick = run;
  }

  function titleFromFile(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    return base || defaultMineTitle();
  }

  /** 导入文本清理：去 BOM、压缩空行、去掉纯噪声行（保留原有分段） */
  function cleanImportText(text) {
    let s = String(text || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/\uFFFD/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/[ \t]{2,}/g, ' ');
    const lines = s.split('\n');
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) {
        out.push('');
        continue;
      }
      if (isPageNumberLine(t)) continue;
      out.push(t);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function htmlToText(html) {
    return String(html || '')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#x?[0-9a-f]+;/gi, ' ');
  }

  function saveImport() {
    const text = $('#importText').value.trim();
    if (!text) return toast('还没有文字');
    const usePaged = importPages && importPages.length && !$('#importText').dataset.edited;
    let pages;
    if (usePaged) {
      pages = importPages.slice(0, 24).map((arr) => ({
        sentences: arr.map((en) => ({ en: en, zh: '' })),
      }));
    } else {
      const sentences = splitSentences(text, 240);
      if (!sentences.length) return toast('至少需要一句完整的英文');
      pages = [];
      for (let i = 0; i < sentences.length; i += 12) {
        pages.push({
          sentences: sentences.slice(i, i + 12).map((en) => ({ en: en, zh: '' })),
        });
      }
    }
    if (!pages.length) return toast('至少需要一句完整的英文');
    const title = ($('#importTitle').value || '').trim() || defaultMineTitle();
    const book = {
      id: 'mine-' + Date.now(),
      title: title,
      titleEn: '',
      series: '导入书籍',
      level: '导入',
      source: 'mine',
      color: '#8FA88C',
      emoji: '📥',
      pages: pages,
    };
    Store.addMine(book);
    closeSheet();
    const total = pages.reduce((a, p) => a + p.sentences.length, 0);
    toast('已导入《' + title + '》，共 ' + total + ' 句');
    APP.go('library');
    renderLibrary();
  }

  /* ================= 音频绘本（音频 → 文稿 → 原声领读） ================= */
  let pickedAudio = null;   // { kind:'url'|'blob', url, blob, name }
  let audioSents = null;    // [{ en, a:[start,end] }]
  let audioRunning = false;

  function fmtSec(s) {
    const n = Math.max(0, Math.round(Number(s) || 0));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  function openAudio() {
    pickedAudio = null;
    audioSents = null;
    audioRunning = false;
    $('#sheetBody').innerHTML =
      '<h3>🎧 音频绘本</h3>' +
      '<div class="desc">有原版音频就用原声领读：先自动转成文稿，领读直接播这段录音，<b>跟读评分仍是原来的发音评测</b>。' +
      '<br><span class="muted">支持百度网盘、音频直链、手机里的音频文件；单次建议 5 分钟以内（最长 8 分钟）。' +
      '<br>💡 网盘最快的用法：在百度网盘 App 里长按音频 → <b>分享 → 悦读绘本</b>，音频会直接送进来。</span></div>' +
      '<div class="chips" id="audioTabs" style="margin-bottom:10px">' +
      '<button class="chip on" data-tab="url">音频链接</button>' +
      '<button class="chip" data-tab="pan">百度网盘</button>' +
      '<button class="chip" data-tab="local">本地文件</button>' +
      '</div>' +
      '<div id="audioPane" style="margin-bottom:6px"></div>' +
      '<label class="field" style="border:none"><span>书名</span><input id="audioTitle" class="input" style="text-align:left" placeholder="给这本书起个名字" /></label>' +
      '<div style="height:4px;background:#e7edf6;border-radius:3px;overflow:hidden;margin:6px 0 8px">' +
      '<i id="audioProg" style="display:block;height:100%;width:0;background:#5b8def;transition:width .25s"></i></div>' +
      '<div class="muted" id="audioState" style="margin:0 0 8px">还没有选择音频</div>' +
      '<textarea id="audioText" class="ocr-text" style="display:none" placeholder="转写结果会出现在这里"></textarea>' +
      '<div class="muted" id="audioTip" style="display:none;margin:-4px 0 8px">改过的句子会改回合成朗读（因为没有对应原声时间点）。</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn ghost" id="audioCancel">取消</button>' +
      '<button class="btn primary" id="audioRun" disabled>开始转写</button>' +
      '<button class="btn primary" id="audioSave" style="display:none">存成一本绘本</button>' +
      '</div>';
    $('#sheetMask').classList.add('show');
    $('#audioTitle').value = defaultMineTitle();
    $('#audioCancel').onclick = closeSheet;

    const pane = $('#audioPane');
    const setTab = (tab) => {
      $$('#audioTabs .chip').forEach((c) => c.classList.toggle('on', c.dataset.tab === tab));
      if (tab === 'url') renderUrlPane(pane);
      else if (tab === 'pan') renderPanPane(pane);
      else renderLocalPane(pane);
    };
    $$('#audioTabs .chip').forEach((c) => (c.onclick = () => setTab(c.dataset.tab)));
    setTab('url');

    $('#audioRun').onclick = runTranscribe;
    $('#audioText').addEventListener('input', () => {
      $('#audioSave').disabled = !$('#audioText').value.trim();
    });
    $('#audioSave').onclick = saveAudioBook;
  }

  /** 从别的 App 分享音频进来：直接打开面板并预选，用户点一下「开始转写」即可 */
  function openAudioFromShare(obj) {
    if (!obj || !obj.blob) return;
    const label = obj.name || '网盘音频';
    try {
      openAudio();
      chooseAudio({ kind: 'blob', blob: obj.blob }, label);
      const chip = $('#audioTabs .chip[data-tab="local"]');
      if (chip) chip.click();
      const st = $('#audioState');
      if (st) st.textContent = '已收到：' + label + '（来自网盘分享），点「开始转写」';
      toast('已收到音频：' + label);
    } catch (e) {
      toast('接收音频失败：' + (e.message || ''));
    }
  }

  function chooseAudio(src, label) {
    pickedAudio = src;
    const st = $('#audioState');
    if (st) st.textContent = '已选择：' + label + '，点「开始转写」';
    const run = $('#audioRun');
    if (run) run.disabled = false;
    const t = $('#audioTitle');
    if (t && !t.value.trim()) t.value = titleFromFile(label);
  }

  function renderUrlPane(pane) {
    pane.innerHTML =
      '<label class="field" style="border:none;padding-top:0"><span>音频地址</span>' +
      '<input id="audioUrl" class="input" style="text-align:left" placeholder="https://… .mp3" /></label>' +
      '<div class="muted" style="margin:-4px 0 8px">贴 mp3 / m4a / wav 直链即可；网盘分享页需要先在网盘里拿到直链，或改用「百度网盘」页。</div>' +
      '<div class="sheet-actions" style="margin-top:0">' +
      '<button class="btn ghost" id="audioTry">试听 10 秒</button>' +
      '<button class="btn ghost" id="audioUseUrl">用这个链接</button>' +
      '</div>';
    $('#audioUseUrl').onclick = () => {
      const v = ($('#audioUrl').value || '').trim();
      if (!/^https?:\/\//i.test(v)) return toast('请填写 http/https 开头的音频地址');
      chooseAudio({ kind: 'url', url: v }, v.split('/').pop().split('?')[0] || '音频');
    };
    $('#audioTry').onclick = async () => {
      const v = ($('#audioUrl').value || '').trim();
      if (!v) return toast('先填音频地址');
      const base = Api.base();
      const src = v.indexOf(base) === 0 ? v : base + '/api/audio/proxy?url=' + encodeURIComponent(v);
      TTS.playClip(src, 0, 10, 1);
      toast('试听中（10 秒）');
    };
  }

  function renderLocalPane(pane) {
    pane.innerHTML =
      '<div class="muted" style="margin:0 0 8px">从手机里选音频（mp3 / m4a / wav / aac），会存进 App 本地，离线也能听。</div>' +
      '<div class="sheet-actions" style="margin-top:0;flex-wrap:wrap;gap:8px">' +
      '<button class="btn ghost" id="audioPick">📂 选择音频文件</button>' +
      '<button class="btn ghost" id="audioFolder">📁 选择文件夹（批量）</button>' +
      '</div>' +
      '<div class="muted" style="margin:8px 0 0;font-size:12px">选文件夹可一次导入整个目录里的所有音频，每个会转写成一本绘本。</div>';
    $('#audioPick').onclick = async () => {
      try {
        const f = await APP.pickAudioFile();
        if (!f) return;
        chooseAudio({ kind: 'blob', blob: f.blob }, f.name || '本地音频');
      } catch (e) {
        toast(e.message || '打开文件失败');
      }
    };
    $('#audioFolder').onclick = () => {
      APP.pickFolder();
    };
  }

  /* ================= 文件夹批量导入音频绘本 ================= */
  function showFolderList(list) {
    if (!Array.isArray(list) || !list.length) {
      toast('这个文件夹里没找到音频文件');
      return;
    }
    $('#sheetBody').innerHTML =
      '<h3>📁 文件夹里的音频（' + list.length + ' 个）</h3>' +
      '<div class="desc">勾选要导入的音频，每个会转写成一本「音频绘本」（自动领读原声 + 跟读评分）。' +
      '<span class="muted">建议一次别太多，转写较慢、会消耗云端额度。</span></div>' +
      '<label class="field" style="border:none;padding:6px 0 2px"><input type="checkbox" id="folderAll" checked /> 全选</label>' +
      '<div id="folderList" style="max-height:44vh;overflow:auto;margin:4px 0 8px">' +
      list.map((f, i) =>
        '<label class="folder-row" style="display:flex;gap:8px;align-items:center;padding:8px 2px;border-bottom:1px solid var(--line)">' +
        '<input type="checkbox" class="fchk" data-i="' + i + '" checked />' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">' + esc(f.name || '音频') + '</span>' +
        '<span class="muted">' + (f.size ? (f.size / 1048576).toFixed(1) + 'MB' : '') + '</span>' +
        '</label>'
      ).join('') +
      '</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn ghost" id="folderCancel">取消</button>' +
      '<button class="btn primary" id="folderImport">导入选中</button>' +
      '</div>';
    $('#sheetMask').classList.add('show');
    $('#folderCancel').onclick = closeSheet;
    $('#folderAll').onchange = (e) => { $$('#folderList .fchk').forEach((c) => (c.checked = e.target.checked)); };
    $('#folderImport').onclick = () => {
      const idx = $$('#folderList .fchk').filter((c) => c.checked).map((c) => Number(c.dataset.i));
      if (!idx.length) return toast('先勾选要导入的音频');
      startFolderImport(list, idx);
    };
  }

  async function startFolderImport(list, idx) {
    closeSheet();
    const total = idx.length;
    const log = [];
    let ok = 0;
    showBatchSheet(total);
    for (let k = 0; k < total; k++) {
      const i = idx[k];
      const f = list[i];
      updateBatch(k, total, f.name, '读取中');
      let blob;
      try { blob = await APP.importFolderAudio(i); }
      catch (e) { log.push('✗ ' + (f.name || '音频') + '：' + (e.message || '读取失败')); updateBatch(k, total, f.name, '跳过'); continue; }
      if (!blob) { log.push('✗ ' + (f.name || '音频') + '：空文件或读取失败'); updateBatch(k, total, f.name, '跳过'); continue; }
      updateBatch(k, total, f.name, '转写中');
      let r;
      try {
        r = await APP.AudioBook.transcribe({ kind: 'blob', blob: blob.blob }, (p, msg) => updateBatch(k, total, f.name, msg, p));
      } catch (e) { log.push('✗ ' + (f.name || '音频') + '：' + (e.message || '转写失败')); updateBatch(k, total, f.name, '跳过'); continue; }
      try {
        const title = titleFromFile(f.name) || defaultMineTitle();
        const book = await makeAudioBook(title, { kind: 'blob', blob: blob.blob }, r.sentences);
        Store.addMine(book);
        ok++;
        log.push('✓ ' + (f.name || '音频') + '：' + r.sentences.length + ' 句');
      } catch (e) { log.push('✗ ' + (f.name || '音频') + '：保存失败'); }
      updateBatch(k + 1, total, '', '');
    }
    finishBatch(ok, total, log);
  }

  function showBatchSheet(total) {
    $('#sheetBody').innerHTML =
      '<h3>📥 批量导入音频绘本</h3>' +
      '<div id="batchCur" class="muted" style="margin:2px 0 8px">准备中…</div>' +
      '<div style="height:6px;background:#e7edf6;border-radius:3px;overflow:hidden;margin:6px 0 10px"><i id="batchBar" style="display:block;height:100%;width:0;background:#5b8def;transition:width .25s"></i></div>' +
      '<div id="batchLog" style="max-height:40vh;overflow:auto;font-size:12px;line-height:1.7"></div>' +
      '<div class="sheet-actions"><button class="btn ghost" id="batchClose" style="display:none">完成</button></div>';
    $('#sheetMask').classList.add('show');
    const bc = $('#batchClose');
    if (bc) bc.onclick = () => { closeSheet(); renderLibrary(); };
  }

  function updateBatch(k, total, name, msg, p) {
    const bar = $('#batchBar');
    if (bar) bar.style.width = Math.round((k / total) * 100) + '%';
    const cur = $('#batchCur');
    if (cur) cur.textContent = '进度 ' + k + '/' + total + (name ? '：' + name + (msg ? '（' + msg + '）' : '') : '');
  }

  function finishBatch(ok, total, log) {
    const body = $('#batchLog');
    if (body) body.innerHTML = '<div style="font-weight:700;margin:6px 0">' + ok + ' / ' + total + ' 本导入成功</div>' + log.map((l) => '<div>' + esc(l) + '</div>').join('');
    const bar = $('#batchBar');
    if (bar) bar.style.width = '100%';
    const bc = $('#batchClose');
    if (bc) bc.style.display = '';
    toast('导入完成：' + ok + '/' + total + ' 本');
  }

  async function makeAudioBook(title, source, sentences) {
    const book = {
      id: 'mine-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title: title,
      titleEn: '',
      series: '音频绘本',
      level: '我的',
      source: 'mine',
      color: '#5E8CA8',
      emoji: '🎧',
      pages: [{ sentences: sentences }],
      audio: null,
    };
    if (source && source.kind === 'blob') {
      book.audio = await APP.AudioBook.saveLocal('audio:' + book.id, source.blob);
    } else if (source && source.kind === 'url') {
      book.audio = { kind: 'url', url: source.url };
    }
    if (!book.audio) throw new Error('没有音频可保存');
    return book;
  }

  function handleSharedLink(o) {
    if (!o || !o.url) return;
    openAudio();
    const inp = $('#audioUrl');
    if (inp) inp.value = o.url;
    if (o.kind === 'pan') {
      // 网盘分享出来的是「链接」不是「文件」，App 没法直接拉取（需要提取码 + 转存接口）。
      // 最实在的作法：把链接丢进系统浏览器，让用户先保存/下载，再用文件管理器把文件分享给本 App；
      // 想直接在 App 里浏览网盘目录，则需要在后端配 AppKey 后点「连接百度网盘」。
      const chip = $('#audioTabs .chip[data-tab="pan"]');
      if (chip) chip.click();
      APP.openExternal(o.url);
      toast('这是网盘分享链接（不是文件）。已帮你打开，先在网盘里把它下载到手机，再用「文件管理」App 分享给本 App 即可导入；或配好 AppKey 后在此登录网盘直接浏览。');
    } else {
      chooseAudio({ kind: 'url', url: o.url }, o.url.split('/').pop().split('?')[0] || '音频');
      toast(o.kind === 'audio' ? '已填入音频链接，点「开始转写」即可' : '已填入链接（若不是音频会转写失败）');
    }
  }

  Native.onFolderAudios = (list) => { try { showFolderList(list); } catch (e) { toast('读取文件夹失败'); } };
  Native.onSharedLink = (o) => { try { handleSharedLink(o); } catch (e) {} };

  function copyText(text, btn) {
    if (!text) { toast('没有可复制的内容'); return; }
    const done = () => {
      if (!btn) return;
      const t = btn.textContent;
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = t; }, 1500);
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('复制失败，请长按地址手动复制');
      } catch (e) { toast('复制失败，请长按地址手动复制'); }
    };
    // 1) 原生剪贴板（WebView 里最可靠）
    try {
      if (window.Android && Android.copy) { Android.copy(text); done(); return; }
    } catch (e) {}
    // 2) 浏览器剪贴板 API（需安全上下文）
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
        return;
      }
    } catch (e) {}
    // 3) 兜底：临时 textarea + execCommand
    fallback();
  }

  async function renderPanPane(pane) {
    pane.innerHTML = '<div class="muted" id="panState">正在检查网盘配置…</div><div id="panList"></div>';
    let cfg = null;
    try {
      cfg = await Api.panConfig();
    } catch (e) {
      $('#panState').textContent = '后端连接失败：' + (e.message || '网络错误');
      return;
    }
    // 不管有没有配 AppKey，都先给「唤起网盘 App → 分享过来」这条路，它不需要任何配置
    if (!cfg || !cfg.baidu) {
      $('#panState').innerHTML =
        '<b>用百度网盘 App 直接送过来（推荐，不用配置）</b><br>' +
        '点下面的按钮打开百度网盘 → 找到音频长按 → <b>分享</b> → 选「悦读绘本」→ 回来就能转写。<br>' +
        '<span class="muted">注意：百度网盘自带的分享面板可能不会列出本 App。若分享菜单里找不到「悦读绘本」，请先把音频<b>下载到手机</b>，再用系统「文件管理」App 把它分享给本 App（或用网盘里的「打开方式 / 其他应用打开」）。</span><br>' +
        '<span class="muted">想直接在 App 里浏览网盘目录，才需要在后端配 AppKey / SecretKey。</span>';
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.style.marginTop = '10px';
      b.textContent = '📂 打开百度网盘';
      b.onclick = () => openPanWithHint();
      $('#panState').appendChild(b);
      return;
    }
    const state = String(Store.settings().panState || '');
    const sess = state ? await Api.panSession(state).catch(() => null) : null;
    if (sess && sess.ok) return panListDir(pane, state, '/');
    $('#panState').innerHTML =
      '还没连接百度网盘。可以直接在 App 里浏览网盘，也可以走「网盘 App → 分享 → 悦读绘本」更快。<br>';
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.style.marginTop = '10px';
    btn.textContent = '连接百度网盘';
    btn.onclick = () => connectPan(pane, btn);
    $('#panState').appendChild(btn);
    const b2 = document.createElement('button');
    b2.className = 'btn ghost';
    b2.style.margin = '10px 0 0 8px';
    b2.textContent = '📂 打开网盘 App';
    b2.onclick = () => openPanWithHint();
    $('#panState').appendChild(b2);

    // 回调地址诊断：授权页若报 redirect_uri_mismatch，就是这里这条和百度后台填的不一致
    // 后端若已升级会直接返回 redirect；旧后端没这个字段时，用当前配置的后端地址本地拼一份兜底，
    // 这样不用等后端重新部署也能拿到正确的回调地址。
    let redirect = (cfg && cfg.redirect) || '';
    let redirectAuto = false;
    if (!redirect) {
      try {
        const b = Api && Api.base ? Api.base() : '';
        if (b) { redirect = b.replace(/\/+$/, '') + '/api/pan/baidu/callback'; redirectAuto = true; }
      } catch (e) {}
    }
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.style.cssText = 'margin-top:14px;line-height:1.7;font-size:12px';
    tip.innerHTML =
      '若点「连接百度网盘」后授权页报 <b>redirect_uri_mismatch</b>（Invalid redirect uri），' +
      '说明百度开放平台「授权回调页」和下面这条不完全一致（http/https、域名、路径、结尾斜杠都要一致）。' +
      '把下面这条<b>原样</b>填进去并保存，再重试即可。' +
      (cfg && cfg.redirectFrom === 'env' ? '<br><span style="color:#c0392b">当前读的是环境变量 BAIDU_PAN_REDIRECT，改环境变量或把它删掉让系统自动推导。</span>' : '') +
      (redirectAuto ? '<br><span style="color:#7a879b">（后端尚未升级，这条是按当前「后端地址」本地推导的；若你设过 BAIDU_PAN_REDIRECT 环境变量，以那个为准。）</span>' : '');
    const code = document.createElement('div');
    code.style.cssText = 'margin:8px 0;padding:9px 10px;border-radius:8px;background:#f2f5fa;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:#22324a;user-select:all';
    code.textContent = redirect || '(未取到：请先在「我的 → 后端地址」填好后端，或浏览器打开 /api/pan/config 查看)';
    tip.appendChild(code);
    if (redirect) {
      const cp = document.createElement('button');
      cp.className = 'btn ghost';
      cp.style.marginTop = '2px';
      cp.textContent = '📋 复制回调地址';
      cp.onclick = () => copyText(redirect, cp);
      tip.appendChild(cp);
    }
    $('#panState').appendChild(tip);
  }

  /** 唤起百度网盘客户端，并告诉用户接下来怎么把音频送进来 */
  function openPanWithHint() {
    if (!Native.available()) {
      toast('网页版不支持唤起 App，已打开网页版百度网盘');
      APP.openExternal('https://pan.baidu.com');
      return;
    }
    Native.onPanApp = (via) => {
      Native.onPanApp = null;
      if (via === 'web') toast('没检测到百度网盘 App，已打开网页版');
      else if (via === 'failed') toast('没有可打开百度网盘的方式，请确认已安装或联网');
      else toast('已唤起百度网盘，在网盘里长按音频 → 分享到「悦读绘本」');
    };
    APP.openPanApp();
  }

  async function connectPan(pane, btn) {
    const state = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    Store.saveSettings({ panState: state });
    const r = await Api.panAuth(state).catch(() => null);
    if (!r || !r.url) return toast((r && r.note) || '获取授权地址失败');
    btn.disabled = true;
    btn.textContent = '等待授权…';
    // 授权页交给系统浏览器：WebView 里没有百度登录态，会一直卡在登录页
    // 手机上若已登录百度账号，浏览器里点一下就能授权；回来时下面的轮询会自动接上
    APP.openExternal(r.url);
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const s = await Api.panSession(state).catch(() => null);
      if (s && s.ok) {
        clearInterval(timer);
        panListDir(pane, state, '/');
      } else if (tries > 90) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = '连接百度网盘';
        toast('授权超时，再试一次');
      }
    }, 2000);
  }

  async function panListDir(pane, state, dir) {
    const st = $('#panState');
    const list = $('#panList');
    if (st) st.textContent = '正在读取 ' + dir + ' …';
    if (list) list.innerHTML = '';
    let r = null;
    try {
      r = await Api.panList(state, dir);
    } catch (e) {
      if (st) {
        const msg = e.status === 401 ? '网盘授权已失效（后端重启后需要重新授权），请重新连接' : e.message || '网络错误';
        st.innerHTML = '读取失败：' + esc(msg) + '<br>';
        const b = document.createElement('button');
        b.className = 'btn ghost';
        b.style.marginTop = '8px';
        b.textContent = '重新连接网盘';
        b.onclick = () => {
          Store.saveSettings({ panState: '' });
          renderPanPane(pane);
        };
        st.appendChild(b);
      }
      return;
    }
    const items = (r && r.items) || [];
    if (st) st.textContent = dir === '/' ? '网盘根目录' : '目录：' + dir;
    if (!items.length) {
      list.innerHTML = '<div class="muted">这个文件夹是空的</div>';
      return;
    }
    // 文件夹在前，音频其次，其它置灰
    items.sort((a, b) => (b.isdir - a.isdir) || (b.audio - a.audio) || a.name.localeCompare(b.name));
    list.innerHTML = items
      .slice(0, 200)
      .map((it, i) => {
        const icon = it.isdir ? '📁' : it.audio ? '🎵' : '📄';
        const size = it.isdir ? '' : it.size ? (it.size / 1048576).toFixed(1) + ' MB' : '';
        const dim = !it.isdir && !it.audio;
        return (
          '<div class="pan-row" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;padding:10px 2px;border-bottom:1px solid var(--line);' +
          (dim ? 'opacity:.42' : '') + '">' +
          '<span style="font-size:16px">' + icon + '</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600">' + esc(it.name) + '</span>' +
          '<span class="muted" style="flex:none">' + size + '</span>' +
          '</div>'
        );
      })
      .join('');
    $$('#panList .pan-row').forEach((row) => {
      const it = items[Number(row.dataset.i)];
      if (!it) return;
      if (it.isdir) {
        row.onclick = () => panListDir(pane, state, it.path);
        return;
      }
      if (!it.audio) return;
      row.onclick = () => {
        const url = Api.panStreamUrl(state, it.fs_id);
        TTS.playClip(url, 0, 8, 1);
        chooseAudio({ kind: 'url', url: url }, it.name);
        toast('正在试听 ' + it.name);
      };
    });
    if (dir !== '/') {
      const back = document.createElement('button');
      back.className = 'btn ghost';
      back.style.marginTop = '10px';
      back.textContent = '← 返回上一级';
      back.onclick = () => {
        const up = dir.replace(/\/[^/]+\/?$/, '') || '/';
        panListDir(pane, state, up || '/');
      };
      list.appendChild(back);
    }
  }

  async function runTranscribe() {
    if (audioRunning) return;
    if (!pickedAudio) return toast('先选一个音频');
    audioRunning = true;
    const run = $('#audioRun');
    const save = $('#audioSave');
    const st = $('#audioState');
    const prog = $('#audioProg');
    run.disabled = true;
    run.textContent = '转写中…';
    try {
      const r = await APP.AudioBook.transcribe(pickedAudio, (p, msg) => {
        if (st) st.textContent = msg;
        if (prog) prog.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
      });
      audioSents = r.sentences;
      const ta = $('#audioText');
      ta.style.display = 'block';
      ta.value = r.sentences.map((s) => s.en).join('\n');
      $('#audioTip').style.display = 'block';
      if (st) st.textContent = '转写完成：' + r.sentences.length + ' 句，共 ' + fmtSec(r.duration) + '。可以改文字后保存。';
      run.style.display = 'none';
      save.style.display = 'block';
      save.disabled = false;
      if (prog) prog.style.width = '100%';
    } catch (e) {
      if (st) st.textContent = '转写失败：' + (e.message || '未知错误');
      toast(e.message || '转写失败');
      run.disabled = false;
      run.textContent = '开始转写';
    } finally {
      audioRunning = false;
    }
  }

  async function saveAudioBook() {
    const ta = $('#audioText');
    const lines = String(ta.value || '')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!lines.length) return toast('还没有文稿');
    const sentences = lines.slice(0, 300).map((en, i) => {
      const src = audioSents && audioSents[i];
      const s = { en: en, zh: '' };
      if (src && src.a && src.en === en) s.a = src.a;
      return s;
    });
    const title = ($('#audioTitle').value || '').trim() || defaultMineTitle();
    loading(true, '正在保存音频…');
    try {
      const book = await makeAudioBook(title, pickedAudio, sentences);
      Store.addMine(book);
      closeSheet();
      const withAudio = sentences.filter((s) => s.a).length;
      toast('已存成《' + title + '》，' + sentences.length + ' 句（' + withAudio + ' 句有原声）');
      APP.go('library');
      renderLibrary();
    } catch (e) {
      loading(false);
      toast('保存失败：' + (e.message || '本机存储空间可能不足'));
    }
  }

  /* ================= 同步公版 ================= */
  async function syncPublic() {
    if (APP.syncing) return;
    APP.syncing = true;
    loading(true, '同步古登堡公版书单…');
    const btn = $('#syncBtn');
    if (btn) btn.textContent = '同步中…';
    try {
      const list = await Api.books();
      if (!Array.isArray(list) || !list.length) throw new Error('书单为空');
      const existing = Store.remoteBooks().map((b) => b.id);
      const colors = ['#6C8FD6', '#6FAE8E', '#B98CC9', '#D9A05B', '#7FB3C8', '#8E9BC4'];
      const added = list
        .filter((x) => existing.indexOf('gb-' + x.id) < 0)
        .slice(0, 24)
        .map((x, i) => ({
          id: 'gb-' + x.id,
          title: x.title || x.titleEn || '未命名',
          titleEn: x.titleEn || '',
          series: '古登堡公版',
          author: x.author || '',
          level: x.level || 'L4',
          color: colors[i % colors.length],
          emoji: '📜',
          remote: true,
          gutenberg: x.url,
          pages: [{ sentences: [{ en: x.intro || 'Tap to load the text.', zh: '' }] }],
        }));
      Store.setRemoteBooks(Store.remoteBooks().concat(added));
      toast(added.length ? '已新增 ' + added.length + ' 本公版绘本' : '已是最新书单');
      renderLibrary();
    } catch (e) {
      toast('同步失败：' + (e.message || '网络错误'));
    } finally {
      loading(false);
      APP.syncing = false;
      if (btn) btn.textContent = '同步公版';
    }
  }

  APP.ui = {
    state: state,
    renderLibrary: renderLibrary,
    openReader: openReader,
    renderReader: renderReader,
    renderGrowth: renderGrowth,
    renderMe: renderMe,
    openOCR: openOCR,
    openImport: openImport,
    openAudio: openAudio,
    openAudioFromShare: openAudioFromShare,
    showFolderList: showFolderList,
    closeSheet: closeSheet,
    syncPublic: syncPublic,
    testApi: testApi,
    stopFollow: stopFollow,
    celebrate: celebrate,
    sayWord: sayWord,
    // 供本地调试/自动化校验的纯函数（无副作用）
    _ocr: {
      clean: cleanOcrText,
      dedupe: dedupeRunningLines,
      pageNum: isPageNumberLine,
      garbage: isGarbageLine,
      split: splitSentences,
      html: htmlToText,
      importClean: cleanImportText,
    },
  };
})();
