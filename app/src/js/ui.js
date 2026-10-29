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
              '<button class="btn slow" data-act="slow" aria-label="慢速">🐢</button>' +
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

  function buildScoreSpeech(res) {
    if (!res) return '';
    const low = (res.words || [])
      .filter((w) => w.score < 72)
      .map((w) => w.w)
      .slice(0, 5);
    let s = '得分 ' + res.score + ' 分。';
    if (low.length) s += ' 需要多练习的单词有：' + low.join('、') + '。';
    else s += ' 读得很棒，继续加油！';
    return s;
  }

  function paintScore(card, res, animate) {
    const pill = $('.score-pill', card);
    const wordsEl = $('.words', card);
    const fixEl = $('.fix', card);
    pill.hidden = false;
    pill.className = 'score-pill' + (res.score >= 85 ? '' : res.score >= 70 ? ' mid' : ' low');
    pill.textContent = (res.score >= 85 ? '🎉 ' : res.score >= 70 ? '👍 ' : '💪 ') + res.score + ' 分';
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
    // 说完后自动停录并评分（无需手动点停止）
    Rec.onAutoStop = () => {
      if (Rec.isRecording()) stopFollow();
    };
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
      // 朗读评分结果（中文）
      const zh = buildScoreSpeech(res);
      if (zh) TTS.speak(zh, 0.95);
      showRecRow(ctx);
      renderReaderFoot();
      updateReaderBar();
      buzz(14);
      toast('已记录：' + res.score + ' 分');
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

  /* ================= 拍照录入 ================= */
  function openOCR() {
    const body = $('#sheetBody');
    body.innerHTML =
      '<h3>📷 拍照录入绘本</h3>' +
      '<div class="desc">拍下绘本页面，自动识别英文文字，生成可跟读的句子。图片只在本机处理，不会保存到云端。</div>' +
      '<div class="dropzone" id="drop"><b>📷 拍照</b> / 🖼 相册<small>建议正对页面，光线充足，字迹清晰</small></div>' +
      '<div class="sheet-actions" style="margin-top:-4px;margin-bottom:6px">' +
      '<button class="btn ghost" id="btnCamera">打开相机</button>' +
      '<button class="btn ghost" id="btnGallery">从相册选</button>' +
      '</div>' +
      '<div id="ocrPreview"></div>' +
      '<label class="field" style="border:none"><span>书名</span><input id="ocrTitle" class="input" placeholder="给我的绘本起个名字" /></label>' +
      '<textarea id="ocrText" class="ocr-text" placeholder="识别结果会出现在这里，可以手动修改"></textarea>' +
      '<div class="sheet-actions">' +
      '<button class="btn ghost" id="ocrCancel">取消</button>' +
      '<button class="btn primary" id="ocrSave" disabled>存入我的绘本</button>' +
      '</div>';
    $('#sheetMask').classList.add('show');
    $('#ocrTitle').value = '我的绘本 ' + dayKey().slice(5);
    $('#ocrText').addEventListener('input', () => {
      $('#ocrSave').disabled = !$('#ocrText').value.trim();
    });
    $('#ocrCancel').onclick = closeSheet;
    const grab = async (mode) => {
      let b64;
      try {
        b64 = await APP.pickPhoto(mode);
      } catch (e) {
        return toast(mode === 'camera' ? '打开相机失败' : '打开相册失败');
      }
      if (!b64) return;
      $('#ocrPreview').innerHTML =
        '<img src="data:image/jpeg;base64,' + b64 + '" style="width:100%;border-radius:14px;margin-bottom:10px;max-height:220px;object-fit:cover" />' +
        '<div class="muted" id="ocrState">正在识别…</div>';
      loading(true, '识别文字中…');
      try {
        const raw = await Api.ocr(b64, 'eng');
        const text = pickOcrText(raw);
        $('#ocrText').value = text;
        $('#ocrSave').disabled = !text.trim();
        $('#ocrState').textContent = text ? '识别完成，可修改后保存' : '没有识别到文字，可重拍或手动输入';
        if (!text) toast('未识别到文字，试试更清晰的照片');
      } catch (e) {
        $('#ocrState').textContent = '';
        toast('识别失败：' + (e.message || '服务异常'));
      } finally {
        loading(false);
      }
    };
    $('#drop').onclick = () => grab('camera');
    $('#btnCamera').onclick = () => grab('camera');
    $('#btnGallery').onclick = () => grab('gallery');
    $('#ocrSave').onclick = () => {
      const text = $('#ocrText').value.trim();
      const sentences = splitSentences(text);
      if (!sentences.length) return toast('至少需要一句完整的英文');
      const book = {
        id: 'mine-' + Date.now(),
        title: ($('#ocrTitle').value || '我的绘本').trim(),
        titleEn: '',
        series: '我的绘本',
        level: '我的',
        source: 'mine',
        color: '#7C8FB5',
        emoji: '📷',
        pages: [{ sentences: sentences.map((en) => ({ en: en, zh: '' })) }],
      };
      Store.addMine(book);
      closeSheet();
      toast('已存入我的绘本');
      APP.go('library');
      renderLibrary();
    };
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

  function splitSentences(text) {
    return String(text)
      .replace(/\r/g, ' ')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/[“”]/g, '"')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim().replace(/^["']+|["']+$/g, ''))
      .filter((s) => s.length > 3 && /[A-Za-z]{2}/.test(s))
      .slice(0, 40);
  }

  function closeSheet() {
    $('#sheetMask').classList.remove('show');
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
    closeSheet: closeSheet,
    syncPublic: syncPublic,
    testApi: testApi,
    stopFollow: stopFollow,
  };
})();
