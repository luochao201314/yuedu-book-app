/* 界面渲染与交互 */
(function () {
  const APP = window.APP;
  const { $, $$, esc, toast, loading, buzz, dayKey } = APP.util;
  const Store = APP.Store, Api = APP.Api, TTS = APP.TTS, Rec = APP.Rec, Books = APP.books;

  const state = (APP.state = { view: 'library', book: null, filter: '全部', q: '', zh: Store.settings().zh, scoring: {} });

  const LEVELS = ['全部', 'L1', 'L2', 'L3', 'L4', '我的'];
  const DAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

  function shade(hex, amt) {
    const c = hex.replace('#', '');
    const n = parseInt(c, 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + (amt || -30)));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + (amt || -30)));
    const b = Math.max(0, Math.min(255, (n & 255) + (amt || -30)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* ================= 绘本库 ================= */
  function greeting() {
    const h = new Date().getHours();
    return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  }

  function renderLibrary() {
    const s = Store.settings();
    $('#greet').textContent = greeting() + '，' + s.name;
    $('#avatarBtn').textContent = (s.name || '宝').slice(0, 1);

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
          '<div class="cover" style="background:linear-gradient(135deg,' + b.color + ',' + shade(b.color, -34) + ')">' +
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

  function renderReader() {
    const b = state.book;
    if (!b) return;
    const cache = Store.get('yq.body.v2', {});
    if (!b._loaded && cache[b.id]) {
      b.pages = cache[b.id];
      b._loaded = true;
    }
    $('#readerName').textContent = b.title;
    $('#readerMeta').textContent = [b.titleEn, b.series, b.level].filter(Boolean).join(' · ');
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
              '<div class="en">' + esc(s.en) + '</div>' +
              (state.zh && s.zh ? '<div class="zh">' + esc(s.zh) + '</div>' : '') +
              '<div class="actions">' +
              '<button class="btn lead" data-act="lead">🔊 领读</button>' +
              '<button class="btn follow" data-act="follow">🎤 跟读</button>' +
              '<button class="btn slow" data-act="slow" aria-label="慢读">慢读</button>' +
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

    $$('.sentence', list).forEach((card) => {
      const pi = Number(card.dataset.pi), si = Number(card.dataset.si);
      const key = card.dataset.key;
      const saved = Store.progress()[key];
      if (saved) paintScore(card, saved, false);
      card.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-act]');
        if (!btn) {
          const w = ev.target.closest('.w');
          if (w) TTS.speakWord(w.textContent.trim());
          return;
        }
        const act = btn.dataset.act;
        const s = Books.sentenceAt(b, pi, si);
        if (!s) return;
        if (act === 'lead') TTS.speak(s.en, Store.settings().rate);
        if (act === 'slow') TTS.speak(s.en, 0.62);
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
      // 评分播报：等级词（Great! / Wonderful! …）走本地缓存，命中即出声
      const grade = TTS.speakPraise(res.score);
      showRecRow(ctx);
      renderReaderFoot();
      updateReaderBar();
      buzz(14);
      toast(res.score + ' 分 · ' + grade);
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
      note.textContent = '服务存活 · 语音评测' + (h.azure ? '已配置' : '未配置') + ' · OCR' + (h.ocr ? '已配置' : '未配置') + '（健康检查不等于评分可用，跟读时以实际结果为准）';
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
      '<div class="desc">可以一次拍/选多页，识别后合成同一本绘本，再起个名字。图片只在本机与你的后端之间传输，不会保存。' +
      '<br><span class="muted">照片里的页码、页眉页脚会自动过滤。</span></div>' +
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
      if (!n) $('#ocrState').textContent = '还没有图片，先拍一页或从相册多选';
      else if (!ocrPages.length) $('#ocrState').textContent = '已选 ' + n + ' 页，点『开始识别』';
      else $('#ocrState').textContent = '已识别 ' + n + ' 页，可修改文字后保存';
    };

    const addImgs = (arr) => {
      arr.forEach((b64) => {
        if (b64 && ocrImgs.length < 8) ocrImgs.push(b64);
      });
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
        toast('可一次选多张');
        const arr = await APP.pickPhotos();
        if (arr && arr.length) addImgs(arr);
      } catch (e) {
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
    closeSheet: closeSheet,
    syncPublic: syncPublic,
    testApi: testApi,
    stopFollow: stopFollow,
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
