/*!
 * demo/demo.js — 本地预览页交互
 * 假播放器 + 侧栏演示设置 + mock 查词；纯静态，不使用任何扩展 API。
 */
(function () {
  'use strict';

  const C = self.YTBTL;
  const UI = self.YTBTL_UI;
  const MOCK = self.YTBTL_MOCK;
  const playerEl = document.getElementById('movie_player');

  function showFatal(message) {
    const banner = document.createElement('div');
    banner.className = 'demo-fatal';
    banner.textContent = message;
    document.body.insertBefore(banner, document.body.firstChild);
  }

  if (!playerEl) return;
  if (!C || !UI || !MOCK) {
    showFatal('预览依赖缺失：请确认 src/lib/core.js、src/content/ui.js、demo/mock-data.js 均已加载。');
    return;
  }

  /* ------------------------------------------------------------------ *
   * 数据
   * ------------------------------------------------------------------ */

  const cues = C.parseJson3(MOCK.json3);
  const zhBySentence = new Map(MOCK.lines.map(function (line) {
    return [line.en, line.zh];
  }));
  const translations = cues.map(function (cue, index) {
    return zhBySentence.get(cue.text) || MOCK.translations[index] || '';
  });
  const lastCue = cues.length ? cues[cues.length - 1] : null;
  const duration = lastCue ? Math.max(20, Math.ceil(lastCue.end) + 2) : 30;

  /* ------------------------------------------------------------------ *
   * 元素与状态
   * ------------------------------------------------------------------ */

  const playBtn = document.getElementById('demo-play');
  const progressEl = document.getElementById('demo-progress');
  const fillEl = document.getElementById('demo-progress-fill');
  const timeEl = document.getElementById('demo-time');
  const enabledInput = document.getElementById('opt-enabled');
  const nativeInput = document.getElementById('opt-native');
  const sidebar = document.querySelector('.sidebar');
  const statusRow = document.getElementById('status-row');
  const wordbookCountEl = document.getElementById('wordbook-count');

  const wordbook = loadWordbook();
  let settings = C.normalizeSettings({
    enabled: true,
    zhMode: 'hover',
    zhSize: 11,
    enSize: 24,
    hideNativeCaptions: true,
    pauseOnWordClick: true,
    resumeAfterCard: true,
  });
  let playing = false;
  let currentTime = 1.2;
  let tickTimer = 0;
  let translateTimer = 0;
  let lookupTimer = 0;
  let lookupSeq = 0;
  let lastInfo = null;
  let wasPlayingBeforeCard = false;

  /* ------------------------------------------------------------------ *
   * 假播放器
   * ------------------------------------------------------------------ */

  function renderClock() {
    const ratio = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    fillEl.style.width = (ratio * 100).toFixed(2) + '%';
    progressEl.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    timeEl.textContent = C.formatTime(currentTime) + ' / ' + C.formatTime(duration);
  }

  function pushTick() {
    overlay.tick(currentTime);
    renderClock();
  }

  function setPlaying(next) {
    playing = !!next;
    playerEl.classList.toggle('is-playing', playing);
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.title = playing ? '暂停' : '播放';
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function seekTo(seconds) {
    currentTime = Math.min(duration, Math.max(0, Number(seconds) || 0));
    pushTick();
  }

  playBtn.addEventListener('click', function () {
    setPlaying(!playing);
  });

  progressEl.addEventListener('click', function (event) {
    const rect = progressEl.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    seekTo(ratio * duration);
  });

  progressEl.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekTo(currentTime - 2);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekTo(currentTime + 2);
    }
  });

  tickTimer = self.setInterval(function () {
    if (!playing) return;
    currentTime += 0.25;
    if (currentTime >= duration) currentTime = 0;
    pushTick();
  }, 250);

  /* ------------------------------------------------------------------ *
   * 词库（仅 localStorage，演示「加入词库」）
   * ------------------------------------------------------------------ */

  function loadWordbook() {
    try {
      const raw = self.localStorage.getItem('ytbtl-demo-wordbook');
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  function saveWordbook() {
    try {
      self.localStorage.setItem('ytbtl-demo-wordbook', JSON.stringify(wordbook));
    } catch (error) {
      /* 隐私模式 / 禁用存储时忽略，页面内仍然工作 */
    }
  }

  function renderWordbookCount() {
    if (wordbookCountEl) wordbookCountEl.textContent = String(wordbook.length);
  }

  function addToWordbook(card) {
    if (!card) return;
    const key = String(card.lemma || card.word || '').toLowerCase();
    if (!key) return;
    const existing = wordbook.find(function (item) {
      return String(item.lemma || item.word || '').toLowerCase() === key;
    });
    if (existing) {
      existing.count = (existing.count || 1) + 1;
    } else {
      wordbook.unshift(Object.assign({}, card, { count: 1, createdAt: Date.now() }));
    }
    saveWordbook();
    renderWordbookCount();
    overlay.flashMessage('已加入词库：' + (card.lemma || card.word || ''));
  }

  /* ------------------------------------------------------------------ *
   * mock 查词
   * ------------------------------------------------------------------ */

  function startLookup(info) {
    const seq = ++lookupSeq;
    if (lookupTimer) self.clearTimeout(lookupTimer);
    lookupTimer = self.setTimeout(function () {
      lookupTimer = 0;
      if (seq !== lookupSeq) return;
      let card = null;
      try {
        card = MOCK.lookup(info.word, info.sentence);
      } catch (error) {
        overlay.showWordCardError('mock 查词失败：' + (error && error.message ? error.message : '未知错误'), info);
        return;
      }
      if (!card) {
        overlay.showWordCardError('没有找到这个词的释义，请重试。', info);
        return;
      }
      overlay.showWordCard(card, info);
    }, 400);
  }

  function handleWordClick(info) {
    lastInfo = info;
    if (!overlay.isCardOpen()) wasPlayingBeforeCard = playing;
    if (settings.pauseOnWordClick && playing) setPlaying(false);
    overlay.showWordCardLoading(info);
    startLookup(info);
  }

  /* ------------------------------------------------------------------ *
   * 覆盖层
   * ------------------------------------------------------------------ */

  const overlay = UI.createOverlay({
    playerEl: playerEl,
    settings: settings,
    stylesUrl: '../src/content/styles.css',
    callbacks: {
      onWordClick: handleWordClick,
      onPatch: handlePatch,
      onRetry: startTranslateDemo,
      onOpenOptions: function () {
        overlay.flashMessage('演示页：真实扩展会在这里打开设置页');
      },
      onWordbookAdd: addToWordbook,
      onCardClose: function () {
        if (settings.resumeAfterCard && wasPlayingBeforeCard) setPlaying(true);
        wasPlayingBeforeCard = false;
      },
      onRetryLookup: function () {
        if (!lastInfo) return;
        overlay.showWordCardLoading(lastInfo);
        startLookup(lastInfo);
      },
    },
  });

  overlay.mount();

  /* ------------------------------------------------------------------ *
   * 设置联动（侧栏 / 工具栏）
   * ------------------------------------------------------------------ */

  function handlePatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    Object.assign(settings, patch);
    settings = C.normalizeSettings(settings);
    overlay.setSettings(settings);
    syncSidebar();
  }

  function syncSidebar() {
    document.querySelectorAll('[data-set="zhMode"]').forEach(function (btn) {
      const active = btn.getAttribute('data-value') === settings.zhMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-set="zhSize"]').forEach(function (btn) {
      const active = btn.getAttribute('data-value') === String(settings.zhSize);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-set="enSize"]').forEach(function (btn) {
      const active = btn.getAttribute('data-value') === String(settings.enSize);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    enabledInput.checked = !!settings.enabled;
    nativeInput.checked = !!settings.hideNativeCaptions;
    const zhValueEl = document.getElementById('zh-size-value');
    const enValueEl = document.getElementById('en-size-value');
    if (zhValueEl) zhValueEl.textContent = settings.zhSize + 'px';
    if (enValueEl) enValueEl.textContent = settings.enSize + 'px';
  }

  sidebar.addEventListener('click', function (event) {
    const btn = event.target.closest('button[data-set]');
    if (!btn) return;
    const key = btn.getAttribute('data-set');
    const value = btn.getAttribute('data-value');
    if (key === 'zhMode') handlePatch({ zhMode: value });
    else if (key === 'zhSize') handlePatch({ zhSize: Number(value) });
    else if (key === 'enSize') handlePatch({ enSize: Number(value) });
  });

  enabledInput.addEventListener('change', function () {
    handlePatch({ enabled: enabledInput.checked });
  });

  nativeInput.addEventListener('change', function () {
    handlePatch({ hideNativeCaptions: nativeInput.checked });
  });

  /* ------------------------------------------------------------------ *
   * 状态演示（loading / translating / error / no-captions）
   * ------------------------------------------------------------------ */

  function syncStatusButtons(phase) {
    statusRow.querySelectorAll('[data-phase]').forEach(function (btn) {
      const active = btn.getAttribute('data-phase') === phase;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function stopTranslateDemo() {
    if (translateTimer) {
      self.clearInterval(translateTimer);
      translateTimer = 0;
    }
  }

  function animateTranslate() {
    const total = translations.length;
    let done = 0;
    stopTranslateDemo();
    translateTimer = self.setInterval(function () {
      done += 2;
      if (done >= total) {
        stopTranslateDemo();
        overlay.setStatus({ phase: 'ready' });
        overlay.setTranslations(translations);
        overlay.flashMessage('翻译完成');
        syncStatusButtons('ready');
        return;
      }
      overlay.setStatus({ phase: 'translating', done: done, total: total });
    }, 320);
  }

  function startTranslateDemo() {
    stopTranslateDemo();
    overlay.setStatus({ phase: 'translating', done: 0, total: translations.length });
    syncStatusButtons('translating');
    animateTranslate();
  }

  function applyStatus(phase) {
    stopTranslateDemo();
    if (phase === 'ready') {
      overlay.setStatus({ phase: 'ready' });
      overlay.setTranslations(translations);
    } else if (phase === 'loading') {
      overlay.setStatus({ phase: 'loading' });
    } else if (phase === 'translating') {
      startTranslateDemo();
      return;
    } else if (phase === 'error') {
      overlay.setStatus({
        phase: 'error',
        message: '翻译失败：网络连接超时（mock，可点「重试」）',
        retryable: true,
      });
    } else if (phase === 'no-captions') {
      overlay.setStatus({ phase: 'no-captions' });
    }
    syncStatusButtons(phase);
  }

  statusRow.addEventListener('click', function (event) {
    const btn = event.target.closest('button[data-phase]');
    if (!btn) return;
    applyStatus(btn.getAttribute('data-phase'));
  });

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  overlay.setCues(cues);
  overlay.setTranslations(translations);
  overlay.setStatus({ phase: 'ready' });
  overlay.tick(currentTime);
  renderClock();
  setPlaying(false);
  renderWordbookCount();
  syncSidebar();
  syncStatusButtons('ready');

  self.addEventListener('pagehide', function () {
    if (tickTimer) self.clearInterval(tickTimer);
    stopTranslateDemo();
    if (lookupTimer) self.clearTimeout(lookupTimer);
  });

  // 便于浏览器自检 / 截图脚本读取状态（不参与业务逻辑）
  self.YTBTL_DEMO = {
    overlay: overlay,
    getSettings: function () { return Object.assign({}, settings); },
    getTime: function () { return currentTime; },
    isPlaying: function () { return playing; },
    setTime: function (seconds) { seekTo(seconds); },
    cues: cues,
    translations: translations,
  };
})();
