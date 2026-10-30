/* 路由与启动 */
(function () {
  const APP = window.APP;
  const { $, $$, toast } = APP.util;
  const Store = APP.Store, Api = APP.Api, Rec = APP.Rec, TTS = APP.TTS;

  const app = $('#app');
  const SCREENS = { library: '#s-library', reader: '#s-reader', growth: '#s-growth', me: '#s-me' };

  function go(view) {
    if (!SCREENS[view]) view = 'library';
    APP.state.view = view;
    $$('.screen').forEach((s) => s.classList.remove('active'));
    $(SCREENS[view]).classList.add('active');
    app.classList.toggle('reader-mode', view === 'reader');
    $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === view && view !== 'reader'));
    window.scrollTo(0, 0);
    if (view === 'library') APP.ui.renderLibrary();
    if (view === 'growth') APP.ui.renderGrowth();
    if (view === 'me') APP.ui.renderMe();
    if (view === 'reader') APP.ui.renderReader();
  }
  APP.go = go;

  /* ---------- 导航 ---------- */
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  $('#avatarBtn').addEventListener('click', () => go('me'));
  $('#readerBack').addEventListener('click', () => go('library'));
  $('#readerZh').addEventListener('click', () => {
    APP.state.zh = !APP.state.zh;
    Store.saveSettings({ zh: APP.state.zh });
    APP.ui.renderReader();
  });
  $('#readerDel').addEventListener('click', () => {
    const b = APP.state.book;
    if (!b || b.source !== 'mine') return;
    $('#sheetBody').innerHTML =
      '<h3>删除这本绘本？</h3><div class="desc">「' + APP.util.esc(b.title) + '」会从我的绘本里移除，已产生的跟读记录会保留。</div>' +
      '<div class="sheet-actions"><button class="btn ghost" id="delCancel">取消</button><button class="btn danger-ghost" id="delOk">删除</button></div>';
    $('#sheetMask').classList.add('show');
    $('#delCancel').onclick = () => APP.ui.closeSheet();
    $('#delOk').onclick = () => {
      Store.removeMine(b.id);
      APP.ui.closeSheet();
      APP.state.book = null;
      go('library');
      toast('已删除');
    };
  });

  /* ---------- 搜索 ---------- */
  $('#searchBtn').addEventListener('click', () => {
    const w = $('#searchWrap');
    w.hidden = !w.hidden;
    if (!w.hidden) $('#searchInput').focus();
    else {
      APP.state.q = '';
      $('#searchInput').value = '';
      APP.ui.renderLibrary();
    }
  });
  $('#searchInput').addEventListener('input', (e) => {
    APP.state.q = e.target.value.trim();
    APP.ui.renderLibrary();
  });

  /* ---------- 弹层 ---------- */
  $('#sheetMask').addEventListener('click', (e) => {
    if (e.target.id === 'sheetMask') APP.ui.closeSheet();
  });

  /* ---------- 绘本库动作 ---------- */
  $('#ocrBtn').addEventListener('click', () => APP.ui.openOCR());
  $('#importBtn').addEventListener('click', () => APP.ui.openImport());
  $('#syncBtn').addEventListener('click', () => APP.ui.syncPublic());

  /* ---------- 录音条 ---------- */
  $('#recStop').addEventListener('click', () => APP.ui.stopFollow());

  /* ---------- 我的 ---------- */
  function bindMe() {
    $('#saveName').addEventListener('click', () => {
      const n = ($('#meName').value || '').trim().slice(0, 12) || '小宝';
      Store.saveSettings({ name: n });
      $('#meAvatar').textContent = n.slice(0, 1);
      APP.ui.renderLibrary();
      toast('已保存');
    });
    $('#meName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#saveName').click();
    });

    $('#rate').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('#rateVal').textContent = v.toFixed(2).replace(/0$/, '') + 'x';
      Store.saveSettings({ rate: v });
    });
    $('#zhSwitch').addEventListener('click', (e) => {
      const on = !e.currentTarget.classList.contains('on');
      e.currentTarget.classList.toggle('on', on);
      Store.saveSettings({ zh: on });
      APP.state.zh = on;
    });
    $('#autoScore').addEventListener('click', (e) => {
      const on = !e.currentTarget.classList.contains('on');
      e.currentTarget.classList.toggle('on', on);
      Store.saveSettings({ autoScore: on });
    });

    $('#apiReset').addEventListener('click', () => {
      Store.saveSettings({ backend: 'https://yuedu-book-backend.onrender.com' });
      $('#apiBase').value = 'https://yuedu-book-backend.onrender.com';
      APP.health = null;
      APP.ui.testApi();
    });
    $('#apiTest').addEventListener('click', () => {
      const v = ($('#apiBase').value || '').trim().replace(/\/+$/, '');
      Store.saveSettings({ backend: v });
      APP.health = null;
      APP.ui.testApi();
    });

    $('#exportBtn').addEventListener('click', () => {
      const data = {
        app: '悦读绘本',
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        settings: { name: Store.settings().name },
        mine: Store.mine(),
        sessions: Store.sessions(),
        progress: Store.progress(),
      };
      const text = JSON.stringify(data, null, 2);
      APP.ui.closeSheet();
      $('#sheetBody').innerHTML =
        '<h3>导出成长记录</h3>' +
        '<div class="desc">复制下面内容保存到备忘录或发给自己，即可备份。</div>' +
        '<textarea class="ocr-text" id="expText" style="min-height:200px;font-size:11px"></textarea>' +
        '<div class="sheet-actions"><button class="btn ghost" id="expClose">关闭</button><button class="btn primary" id="expCopy">复制</button></div>';
      $('#sheetMask').classList.add('show');
      $('#expText').value = text;
      $('#expClose').onclick = () => APP.ui.closeSheet();
      $('#expCopy').onclick = () => {
        const ta = $('#expText');
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (e) {}
        if (!ok && navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('请长按选择复制'));
        else toast(ok ? '已复制' : '请长按选择复制');
      };
    });

    $('#clearBtn').addEventListener('click', () => {
      $('#sheetBody').innerHTML =
        '<h3>清空本机数据？</h3>' +
        '<div class="desc">会删除所有跟读记录、成长数据和你拍照录入的绘本，且无法恢复。建议先导出备份。</div>' +
        '<div class="sheet-actions"><button class="btn ghost" id="clCancel">取消</button><button class="btn danger-ghost" id="clOk">确认清空</button></div>';
      $('#sheetMask').classList.add('show');
      $('#clCancel').onclick = () => APP.ui.closeSheet();
      $('#clOk').onclick = () => {
        Store.clearAll();
        APP.health = null;
        APP.ui.closeSheet();
        go('library');
        toast('已清空');
      };
    });
  }

  /* ---------- 安卓返回键 ---------- */
  window.onAndroidBack = function () {
    if ($('#sheetMask').classList.contains('show')) {
      APP.ui.closeSheet();
      return true;
    }
    if (Rec.isRecording()) {
      APP.ui.stopFollow();
      return true;
    }
    if (APP.state.view === 'reader') {
      go('library');
      return true;
    }
    if (APP.state.view !== 'library') {
      go('library');
      return true;
    }
    return false;
  };

  /* ---------- 启动 ---------- */
  function boot() {
    const s = Store.settings();
    APP.state.zh = s.zh;
    $('#greet').textContent = '你好';
    bindMe();
    APP.ui.renderLibrary();
    go('library');
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {};
    }
    setTimeout(() => {
      if (!APP.health) APP.ui.testApi(true);
    }, 800);
  }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
