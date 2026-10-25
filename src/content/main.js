/*!
 * YT 双语字幕 · 点词查意 — content 编排层（main）
 * 依赖：self.YTBTL（core.js）、self.YTBTL_UI（ui.js）、background 消息、MAIN world bridge。
 * 职责：字幕获取（bridge → JSON3，失败降级 DOM 捕获）、rAF 同步、翻译优先队列、
 *       点词查词、设置同步、快捷键、popup 状态查询。
 */
(function () {
  'use strict';

  if (window.__YTBTL_MAIN__) return;
  window.__YTBTL_MAIN__ = true;

  const core = self.YTBTL;
  const UI = self.YTBTL_UI;
  if (!core || !UI || typeof UI.createOverlay !== 'function') {
    console.warn('[YTBT] 缺少 YTBTL / YTBTL_UI，双语字幕未启动');
    return;
  }

  const BRIDGE_PROTOCOL = 1;
  const BRIDGE_TIMEOUT_MS = 2000;       // 契约：请求 2s 无响应重试，最多 3 次
  const BRIDGE_RETRIES = 3;
  const TIMEDTEXT_TIMEOUT_MS = 12000;
  const PLAYER_WAIT_MS = 15000;
  const NAV_POLL_MS = 1000;
  const DOM_CAPTION_TIMEOUT_MS = 5000;
  const DOM_TAIL_WORDS = 16;            // DOM 兜底模式最多显示/翻译的最新词数
  const DOM_LIVE_MAX_MS = 7000;         // 单条滚动字幕最长存活时间
  const DOM_LIVE_HOLD_SEC = 4.2;        // 无新字幕时，当前一句最多再停留多少秒（避免字幕赖在屏幕上）
  const DOM_STABLE_MS = 300;            // 文本稳定多久后翻译
  const DOM_FAST_INTERVAL_MS = 1400;    // 滚动字幕最多多久补一次实时翻译
  const MAX_TRANSLATE_BATCHES = 2;      // 契约：翻译并发 ≤ 2
  const MAX_TRANSLATE_ATTEMPTS = 2;
  const TRANSLATE_RETRY_DELAY_MS = 5000;
  const FATAL_CODES = { AUTH: true, BALANCE: true, NO_KEY: true };
  const ZH_MODES = ['off', 'hover', 'on'];
  const ZH_MODE_LABEL = { off: '隐藏', hover: '悬停显示', on: '常显' };

  const STYLE_URL = (function () {
    try { return chrome.runtime.getURL('src/content/styles.css'); } catch (e) { return ''; }
  })();

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    settings: core.normalizeSettings(null),
    overlay: null,
    playerEl: null,
    video: null,
    videoId: '',
    title: '',
    booted: false,
    initializing: false,
    destroyed: false,
    generation: 0,
    // 字幕
    cues: [],
    translations: [],
    textTranslations: new Map(), // 文本 → 译文（DOM 捕获模式重建 index 时复用）
    currentIndex: -1,
    domMode: false,
    domObserver: null,
    domCaptureTimer: null,
    domCommitTimer: null,
    domTimeout: null,
    domText: '',
    domCues: [],        // 已结束的 DOM 字幕
    domLive: null,      // 当前正在滚动的 DOM 字幕（{start,end,text,lastAt}）
    domStableTimer: null,
    domRequested: new Set(), // DOM 模式下在途/已请求的文本
    lastDomTranslation: null, // {text, zh} 最近一次 DOM 译文，滚动文本轻微变化时兜底显示
    domLastRequestAt: 0,
    domGrowTimer: null,
    subtitleLoading: false,
    autoRetried: false,
    // 状态展示
    phase: 'idle',
    message: '',
    retryable: false,
    errorCode: '',
    lastErrorKind: '',
    done: 0,
    total: 0,
    // 翻译队列
    requested: new Set(),
    pending: [],
    failures: new Map(),
    activeBatches: 0,
    fatalCode: '',
    fatalMessage: '',
    lastFlashAt: 0,
    retryTimer: null,
    // 交互
    pausedByUs: false,
    cardInfo: null,
    rafId: 0,
    navTimer: 0,
  };

  const bridgePending = new Map();
  let bridgeSeq = 0;

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); });
  }

  function getVideoEl() {
    try {
      if (state.playerEl && state.playerEl.isConnected) {
        const inner = state.playerEl.querySelector('video');
        if (inner) return inner;
      }
      return document.querySelector('#movie_player video') || document.querySelector('video');
    } catch (e) {
      return null;
    }
  }

  function setStatus(next) {
    const status = next || {};
    if (state.domMode) status.dom = true;
    state.phase = status.phase || state.phase;
    if (status.message !== undefined) state.message = String(status.message || '');
    if (status.retryable !== undefined) state.retryable = !!status.retryable;
    if (status.done !== undefined) state.done = Number(status.done) || 0;
    if (status.total !== undefined) state.total = Number(status.total) || 0;
    if (status.phase === 'error') {
      state.errorCode = status.code || state.errorCode || 'BAD_RESPONSE';
    } else if (status.phase !== 'error') {
      state.errorCode = '';
    }
    if (state.overlay) {
      try { state.overlay.setStatus(status); } catch (e) { /* UI 异常不影响主流程 */ }
    }
  }

  function flash(message) {
    if (!state.overlay) return;
    try { state.overlay.flashMessage(message); } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get('settings', function (items) {
          const err = chrome.runtime.lastError;
          if (!err && items && items.settings) {
            state.settings = core.normalizeSettings(items.settings);
          }
          resolve(state.settings);
        });
      } catch (e) {
        resolve(state.settings);
      }
    });
  }

  function applySettings(next, previous) {
    const prev = previous || state.settings;
    state.settings = next;
    if (state.overlay) {
      try { state.overlay.setSettings(next); } catch (e) { /* 忽略 */ }
    }
    const wasOn = !!(prev && prev.autoTranslate && prev.enabled);
    const isOn = !!(next.autoTranslate && next.enabled);
    if (wasOn && !isOn) {
      state.pending.length = 0;
      state.requested.clear();
      state.failures.clear();
      state.fatalCode = '';
      state.fatalMessage = '';
      state.errorCode = '';
      if (state.phase === 'translating' || state.phase === 'error') {
        setStatus({ phase: 'ready' });
      }
    } else if (!wasOn && isOn) {
      scheduleWindow();
      pumpQueue();
    }
    // 用户在设置页补好 Key / 换了模型或地址后，从致命错误里自动恢复
    const clientChanged = next.apiKey !== prev.apiKey || next.baseUrl !== prev.baseUrl || next.model !== prev.model;
    if (clientChanged && state.fatalCode) {
      state.fatalCode = '';
      state.fatalMessage = '';
      state.errorCode = '';
      state.failures.clear();
      state.requested.clear();
      state.pending.length = 0;
      setStatus({ phase: 'ready' });
      if (next.autoTranslate && next.enabled) {
        scheduleWindow();
        pumpQueue();
      }
    }
    // DOM 兜底模式：翻译开关 / 模型变化后重新安排当前滚动文本
    if (state.domMode) {
      if (!isOn) {
        if (state.domStableTimer) { clearTimeout(state.domStableTimer); state.domStableTimer = null; }
        if (state.phase === 'translating' || state.phase === 'error') setStatus({ phase: 'dom' });
      } else if (!wasOn || clientChanged) {
        if (state.domLive) scheduleDomTranslation(state.domLive.text);
        updateDomStatus();
      }
    }
  }

  function savePatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const previous = state.settings;
    const next = core.normalizeSettings(Object.assign({}, state.settings, patch));
    applySettings(next, previous);
    try {
      chrome.storage.local.set({ settings: next }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 忽略 */ }
  }

  function patchAndSave(patch) {
    savePatch(patch);
    if (state.settings.autoTranslate && state.settings.enabled) scheduleWindow();
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes || !changes.settings) return;
      const previous = state.settings;
      const next = core.normalizeSettings(changes.settings.newValue);
      applySettings(next, previous);
    });
  } catch (e) { /* 忽略 */ }

  /* ------------------------------------------------------------------ *
   * bridge 通信
   * ------------------------------------------------------------------ */

  function handleBridgeMessage(event) {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__ytbtl !== BRIDGE_PROTOCOL || data.dir !== 'to-content') return;
      if (data.type === 'tracks-updated') {
        handleTracksUpdated(data.payload);
        return;
      }
      if (data.id === undefined || data.id === null) return;
      const entry = bridgePending.get(data.id);
      if (!entry) return;
      entry.resolve(data);
    } catch (e) { /* 忽略畸形消息 */ }
  }

  window.addEventListener('message', handleBridgeMessage);

  function bridgeRequest(message, timeoutMs) {
    return new Promise(function (resolve) {
      const id = ++bridgeSeq;
      let settled = false;
      function finish(response) {
        if (settled) return;
        settled = true;
        bridgePending.delete(id);
        clearTimeout(timer);
        resolve(response);
      }
      const timer = setTimeout(function () { finish(null); }, timeoutMs);
      bridgePending.set(id, { resolve: finish });
      try {
        window.postMessage(Object.assign({
          __ytbtl: BRIDGE_PROTOCOL,
          dir: 'to-page',
          id: id,
        }, message), '*');
      } catch (e) {
        finish(null);
      }
    });
  }

  async function requestTracks() {
    let lastPayload = null;
    for (let attempt = 1; attempt <= BRIDGE_RETRIES; attempt++) {
      if (state.destroyed) return null;
      const response = await bridgeRequest({ type: 'getTracks' }, BRIDGE_TIMEOUT_MS);
      if (response && response.payload) {
        lastPayload = response.payload;
        if (Array.isArray(response.payload.tracks) && response.payload.tracks.length) {
          return response.payload;
        }
      }
      if (attempt < BRIDGE_RETRIES) await delay(200 * attempt);
    }
    return lastPayload;
  }

  function withJson3(url) {
    try {
      const parsed = new URL(String(url));
      parsed.searchParams.set('fmt', 'json3');
      return parsed.toString();
    } catch (e) {
      const raw = String(url || '');
      return raw + (raw.indexOf('?') >= 0 ? '&' : '?') + 'fmt=json3';
    }
  }

  async function fetchTimedtext(url) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await bridgeRequest({ type: 'fetchTimedtext', url: withJson3(url) }, TIMEDTEXT_TIMEOUT_MS);
      const payload = response && response.payload;
      if (payload && payload.ok && typeof payload.body === 'string') return payload.body;
      if (attempt < 2) await delay(300);
    }
    return null;
  }

  function handleTracksUpdated(payload) {
    try {
      if (!payload) return;
      if (payload.videoId && state.videoId && payload.videoId !== state.videoId) return;
      if (payload.title && !state.title) state.title = payload.title;
      if (!state.booted || state.subtitleLoading) return;
      if (state.cues.length > 3) return;
      if (!Array.isArray(payload.tracks) || !payload.tracks.length) return;
      if (state.autoRetried) return;
      if (!core.pickEnglishTrack(payload.tracks)) return;
      state.autoRetried = true;
      const gen = state.generation;
      loadSubtitles(gen);
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ *
   * 字幕加载
   * ------------------------------------------------------------------ */

  function resetPipeline() {
    stopDomCapture();
    state.cues = [];
    state.translations = [];
    state.textTranslations.clear();
    state.currentIndex = -1;
    state.requested.clear();
    state.pending.length = 0;
    state.failures.clear();
    state.activeBatches = 0;
    state.fatalCode = '';
    state.fatalMessage = '';
    state.errorCode = '';
    state.lastErrorKind = '';
    state.domMode = false;
    state.domText = '';
    state.domCues = [];
    state.domLive = null;
    state.domRequested.clear();
    state.lastDomTranslation = null;
    if (state.domStableTimer) { clearTimeout(state.domStableTimer); state.domStableTimer = null; }
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    if (state.overlay) {
      try {
        state.overlay.setCues([]);
        state.overlay.setTranslations([]);
      } catch (e) { /* 忽略 */ }
    }
  }

  async function loadSubtitles(gen) {
    if (gen !== state.generation || state.destroyed) return;
    state.subtitleLoading = true;
    state.lastErrorKind = 'load';
    setStatus({ phase: 'loading', message: '正在获取字幕…' });
    try {
      const payload = await requestTracks();
      if (gen !== state.generation) return;
      if (payload) {
        // 忽略 bridge 返回的旧视频数据（SPA 切换瞬间的竞态）
        if (payload.videoId && state.videoId && String(payload.videoId) !== state.videoId) {
          startDomFallback('字幕轨与当前视频不匹配，已切换为页面字幕捕获');
          return;
        }
        if (payload.title) state.title = String(payload.title);
        const track = core.pickEnglishTrack(payload.tracks);
        if (track && track.baseUrl) {
          const body = await fetchTimedtext(track.baseUrl);
          if (gen !== state.generation) return;
          let cues = [];
          if (body) {
            try { cues = core.parseJson3(body); } catch (e) { cues = []; }
          }
          if (cues.length) {
            state.domMode = false;
            state.cues = cues;
            state.translations = new Array(cues.length).fill('');
            state.currentIndex = -1;
            state.requested.clear();
            state.pending.length = 0;
            state.failures.clear();
            state.fatalCode = '';
            state.fatalMessage = '';
            state.lastErrorKind = '';
            if (state.overlay) {
              try {
                state.overlay.setCues(cues);
                state.overlay.setTranslations(state.translations);
              } catch (e) { /* 忽略 */ }
            }
            setStatus({ phase: 'ready' });
            scheduleWindow();
            return;
          }
        }
      }
      if (gen !== state.generation) return;
      startDomFallback('未获取到字幕轨，正在从页面原生字幕捕获…');
    } catch (err) {
      if (gen !== state.generation) return;
      startDomFallback('字幕获取失败，正在从页面原生字幕捕获…');
    } finally {
      if (gen === state.generation) state.subtitleLoading = false;
    }
  }

  function startDomFallback(message) {
    stopDomCapture();
    state.domMode = true;
    state.lastErrorKind = 'load';
    state.cues = [];
    state.translations = [];
    state.currentIndex = -1;
    state.domText = '';
    state.domCues = [];
    state.domLive = null;
    state.domRequested.clear();
    state.lastDomTranslation = null;
    if (state.domStableTimer) { clearTimeout(state.domStableTimer); state.domStableTimer = null; }
    state.requested.clear();
    state.pending.length = 0;
    state.failures.clear();
    state.activeBatches = 0;
    if (state.overlay) {
      try {
        state.overlay.setCues([]);
        state.overlay.setTranslations([]);
      } catch (e) { /* 忽略 */ }
    }
    setStatus({ phase: 'dom', message: message || '已切换为页面字幕捕获模式' });
    attachDomCapture();
  }

  /* ------------------------------------------------------------------ *
   * DOM 字幕降级捕获
   * ------------------------------------------------------------------ */

  function readDomCaptionText() {
    // CC 关闭 / 字幕容器被隐藏时，YouTube 的 DOM 里可能还残留旧文本，不能再显示
    const ccBtn = document.querySelector('#movie_player .ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') return '';
    const container = document.querySelector('#movie_player .ytp-caption-window-container');
    if (!container) return '';
    try {
      if (getComputedStyle(container).display === 'none') return '';
    } catch (e) { /* 忽略 */ }
    const segments = container.querySelectorAll('.ytp-caption-segment');
    if (!segments.length) return '';
    const parts = [];
    const start = Math.max(0, segments.length - 6);
    for (let i = start; i < segments.length; i++) {
      const part = core.cleanText(segments[i].textContent || '');
      if (part) parts.push(part);
    }
    let text = parts.join(' ');
    // 去掉 [music] / [applause] 等提示，以及 >> 说话人标记
    text = text.replace(/\[[^\]]{1,24}\]/g, ' ').replace(/>>\s*/g, ' ').replace(/\s+/g, ' ');
    return core.cleanText(text);
  }

  /**
   * 原生 CC 的 DOM 会保留滚动缓存，textContent 可能是一大段历史台词。
   * 这里只取最新一句话；若自动字幕没有标点，就取最后 16 个词，保证屏幕上不是一大块。
   */
  function domTailText(raw) {
    const text = core.cleanText(raw);
    if (!text) return '';
    let tail = text;
    try {
      const sentences = core.splitSentences(text);
      if (sentences.length) tail = sentences[sentences.length - 1];
    } catch (e) {
      tail = text;
    }
    let words = tail.split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length > DOM_TAIL_WORDS) words = words.slice(words.length - DOM_TAIL_WORDS);
    let out = words.join(' ');
    if (out.length > 140) out = out.slice(-140);
    return core.cleanText(out);
  }

  function attachDomCapture() {
    try {
      const target = state.playerEl || document.documentElement || document.body;
      if (!target) return;
      const observer = new MutationObserver(function () {
        if (state.domCaptureTimer) return;
        state.domCaptureTimer = setTimeout(function () {
          state.domCaptureTimer = null;
          captureDomCaptions();
        }, 120);
      });
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      state.domObserver = observer;
      captureDomCaptions();
      state.domTimeout = setTimeout(function () {
        state.domTimeout = null;
        if (!state.domMode) return;
        if (!state.cues.length) {
          state.lastErrorKind = 'load';
          setStatus({
            phase: 'no-captions',
            message: '未找到英文字幕，请点击播放器上的 CC 按钮开启字幕后重试',
            retryable: true,
          });
        } else {
          setStatus({ phase: 'dom', message: '已使用页面原生字幕（DOM 捕获）' });
        }
      }, DOM_CAPTION_TIMEOUT_MS);
    } catch (e) { /* 忽略 */ }
  }

  function stopDomCapture() {
    if (state.domObserver) {
      try { state.domObserver.disconnect(); } catch (e) { /* 忽略 */ }
      state.domObserver = null;
    }
    if (state.domCaptureTimer) { clearTimeout(state.domCaptureTimer); state.domCaptureTimer = null; }
    if (state.domCommitTimer) { clearTimeout(state.domCommitTimer); state.domCommitTimer = null; }
    if (state.domStableTimer) { clearTimeout(state.domStableTimer); state.domStableTimer = null; }
    if (state.domGrowTimer) { clearTimeout(state.domGrowTimer); state.domGrowTimer = null; }
    if (state.domTimeout) { clearTimeout(state.domTimeout); state.domTimeout = null; }
  }

  function captureDomCaptions() {
    if (!state.domMode || state.destroyed) return;
    const video = getVideoEl();
    if (!video) return;
    const time = Number(video.currentTime) || 0;
    const text = domTailText(readDomCaptionText());

    if (!text) {
      finalizeDomLive(time, true);
      return;
    }

    const live = state.domLive;
    if (!live) {
      state.domLive = { start: Math.max(0, time - 0.3), end: time + DOM_LIVE_HOLD_SEC, text: text, lastAt: time };
      scheduleDomTranslation(text);
      commitDomCues();
      return;
    }
    if (text === live.text) {
      live.end = time + DOM_LIVE_HOLD_SEC;
      live.lastAt = time;
      return;
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const tooLong = words >= DOM_TAIL_WORDS || (time - live.start) * 1000 >= DOM_LIVE_MAX_MS;
    const gap = time - live.lastAt;
    if (tooLong || gap > 2.2) {
      finalizeDomLive(time, false);
      state.domLive = { start: Math.max(0, time - 0.2), end: time + DOM_LIVE_HOLD_SEC, text: text, lastAt: time };
    } else {
      live.text = text;
      live.end = time + DOM_LIVE_HOLD_SEC;
      live.lastAt = time;
    }
    scheduleDomTranslation(text);
    commitDomCues();
  }

  function scheduleDomTranslation(text) {
    maybeRequestDomLive(text);
    if (state.domStableTimer) clearTimeout(state.domStableTimer);
    state.domStableTimer = setTimeout(function () {
      state.domStableTimer = null;
      if (state.destroyed || !state.domMode) return;
      requestDomTranslation(text);
    }, DOM_STABLE_MS);
  }

  /** 滚动字幕没有时间轴，只能边说边翻：限制频率地翻当前最新文本，减少中文滞后 */
  function maybeRequestDomLive(text) {
    if (!text || state.destroyed || !state.domMode) return;
    if (!state.settings.autoTranslate || !state.settings.enabled) return;
    if (state.fatalCode) return;
    const now = Date.now();
    if (now - state.domLastRequestAt < DOM_FAST_INTERVAL_MS) return;
    if (state.textTranslations.has(text) || state.domRequested.has(text)) return;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 3) return;
    state.domLastRequestAt = now;
    requestDomTranslation(text);
  }

  function finalizeDomLive(time, silent) {
    const live = state.domLive;
    if (state.domStableTimer) {
      clearTimeout(state.domStableTimer);
      state.domStableTimer = null;
    }
    state.domLive = null;
    if (!live) return;
    const end = Math.max(live.start + 0.5, Math.min(time, live.end));
    state.domCues.push({ start: live.start, end: end, text: live.text });
    if (state.domCues.length > 240) state.domCues.splice(0, state.domCues.length - 240);
    if (!silent) requestDomTranslation(live.text);
    commitDomCues();
  }

  function commitDomCues() {
    const list = state.domCues.slice();
    if (state.domLive) list.push({ start: state.domLive.start, end: state.domLive.end, text: state.domLive.text });
    if (!list.length) {
      state.cues = [];
      state.translations = [];
      if (state.overlay) {
        try {
          state.overlay.setCues([]);
          state.overlay.setTranslations([]);
        } catch (e) { /* 忽略 */ }
      }
      return;
    }
    list.sort(function (a, b) { return a.start - b.start; });
    let prevEnd = 0;
    for (let i = 0; i < list.length; i++) {
      const cue = list[i];
      cue.start = Math.max(0, Number(cue.start) || 0);
      if (cue.start < prevEnd - 0.05) cue.start = prevEnd;
      cue.end = Math.max(cue.start + 0.6, Number(cue.end) || cue.start + 2);
      prevEnd = cue.end;
      cue.index = i;
    }
    const trimmed = list.length > 240 ? list.slice(list.length - 240) : list;
    trimmed.forEach(function (cue, i) { cue.index = i; });
    state.cues = trimmed;
    state.translations = domCueTranslations(trimmed);
    state.currentIndex = -1;
    if (state.overlay) {
      try {
        state.overlay.setCues(trimmed);
        state.overlay.setTranslations(state.translations);
      } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * DOM 模式没有逐词时间轴，滚动文本会不断微调；精确命中优先，
   * 最新一行用「最近一次译文」兜底，保证中文不会一直是空的。
   */
  function domCueTranslations(list) {
    return list.map(function (cue) {
      const exact = state.textTranslations.get(cue.text);
      if (exact) return exact;
      // 滚动字幕文本会随说话不断变化，命中不了时用最近一次译文兜底，
      // 保证中文行不会长时间空着（通常只滞后半句）。
      return state.lastDomTranslation ? state.lastDomTranslation.zh : '';
    });
  }

  function refreshDomTranslations() {
    if (!state.domMode) return;
    state.translations = domCueTranslations(state.cues);
    if (state.overlay) {
      try { state.overlay.setTranslations(state.translations); } catch (e) { /* 忽略 */ }
    }
  }

  function updateDomStatus() {
    if (!state.domMode || state.fatalCode) return;
    const pending = state.domRequested.size;
    if (pending > 0) {
      setStatus({ phase: 'translating', done: state.textTranslations.size, total: state.textTranslations.size + pending });
    } else {
      setStatus({ phase: 'dom', message: '已使用页面原生字幕（DOM 捕获）' });
    }
  }

  function requestDomTranslation(text) {
    if (!text || state.destroyed || !state.domMode) return;
    if (!state.settings.autoTranslate || !state.settings.enabled) return;
    if (state.fatalCode) return;
    if (state.textTranslations.has(text) || state.domRequested.has(text)) return;
    const failKey = 't:' + text;
    if ((state.failures.get(failKey) || 0) >= MAX_TRANSLATE_ATTEMPTS) return;
    state.domRequested.add(text);
    const gen = state.generation;
    updateDomStatus();
    sendBackground({
      type: 'YTBT_TRANSLATE',
      payload: { videoId: state.videoId, title: state.title, texts: [text] },
    }).then(function (response) {
      if (gen !== state.generation || !state.domMode) return;
      state.domRequested.delete(text);
      if (response && response.ok && Array.isArray(response.translations) && response.translations[0]) {
        state.textTranslations.set(text, response.translations[0]);
        state.lastDomTranslation = { text: text, zh: response.translations[0] };
        refreshDomTranslations();
        updateDomStatus();
        return;
      }
      const error = (response && response.error) || {};
      const code = error.code || 'BAD_RESPONSE';
      if (FATAL_CODES[code]) {
        state.fatalCode = code;
        state.fatalMessage = error.message || '翻译失败';
        setStatus({ phase: 'error', message: state.fatalMessage, retryable: true, code: code });
        return;
      }
      state.failures.set(failKey, (state.failures.get(failKey) || 0) + 1);
      updateDomStatus();
      if (Date.now() - state.lastFlashAt > 3000) {
        state.lastFlashAt = Date.now();
        flash('字幕翻译失败，稍后自动重试');
      }
      if ((state.failures.get(failKey) || 0) < MAX_TRANSLATE_ATTEMPTS) {
        setTimeout(function () {
          if (state.destroyed || !state.domMode) return;
          requestDomTranslation(text);
        }, TRANSLATE_RETRY_DELAY_MS);
      }
    }).catch(function () {
      if (gen !== state.generation) return;
      state.domRequested.delete(text);
      updateDomStatus();
    });
  }

  /* ------------------------------------------------------------------ *
   * rAF 同步
   * ------------------------------------------------------------------ */

  function startTick() {
    if (state.rafId) return;
    const loop = function () {
      state.rafId = 0;
      try { tick(); } catch (e) { /* 忽略单帧异常 */ }
      if (!state.destroyed && state.booted) {
        state.rafId = requestAnimationFrame(loop);
      }
    };
    state.rafId = requestAnimationFrame(loop);
  }

  function tick() {
    const video = getVideoEl();
    if (!video) return;
    bindVideoEvents(video);
    if (state.overlay && state.settings.enabled) {
      try { state.overlay.tick(video.currentTime); } catch (e) { /* 忽略 */ }
    }
    if (!state.cues.length) return;
    const index = core.findCueIndex(state.cues, video.currentTime);
    if (index !== state.currentIndex) {
      state.currentIndex = index;
      onCueChanged(index);
    }
  }

  function onCueChanged(index) {
    if (state.domMode) return;
    if (!state.settings.autoTranslate || !state.settings.enabled) return;
    if (index < 0) {
      updateQueueStatus();
      return;
    }
    scheduleWindow();
    pumpQueue();
    updateQueueStatus();
  }

  function bindVideoEvents(video) {
    if (!video || state.video === video) return;
    unbindVideoEvents();
    state.video = video;
    state.onVideoPlay = function () {
      state.pausedByUs = false;
      if (state.settings.autoTranslate && state.settings.enabled) {
        scheduleWindow();
        pumpQueue();
      }
    };
    state.onVideoSeeked = function () {
      state.currentIndex = -1;
      if (state.domMode && state.domLive) {
        finalizeDomLive(Number(state.video && state.video.currentTime) || 0, true);
      }
      if (state.settings.autoTranslate && state.settings.enabled) {
        scheduleWindow();
        pumpQueue();
      }
    };
    state.onVideoPause = function () {
      if (state.domMode && state.domLive) requestDomTranslation(state.domLive.text);
    };
    try {
      video.addEventListener('play', state.onVideoPlay);
      video.addEventListener('seeked', state.onVideoSeeked);
      video.addEventListener('pause', state.onVideoPause);
    } catch (e) { /* 忽略 */ }
  }

  function unbindVideoEvents() {
    if (!state.video) return;
    try {
      state.video.removeEventListener('play', state.onVideoPlay);
      state.video.removeEventListener('seeked', state.onVideoSeeked);
      state.video.removeEventListener('pause', state.onVideoPause);
    } catch (e) { /* 忽略 */ }
    state.video = null;
  }

  /* ------------------------------------------------------------------ *
   * 翻译优先队列
   * ------------------------------------------------------------------ */

  function queuePriority(index, current) {
    if (index < current) return 1000 + (current - index);
    return index - current;
  }

  function scheduleWindow() {
    if (!state.settings.autoTranslate || !state.settings.enabled) return;
    if (state.domMode) return;
    if (state.fatalCode || !state.cues.length) return;
    const current = state.currentIndex;
    if (current < 0) return;
    const ahead = Math.max(0, Number(state.settings.prefetchAhead) || 0);
    const end = Math.min(state.cues.length - 1, current + ahead);
    const video = getVideoEl();
    const paused = !!video && !!video.paused;
    for (let i = current; i <= end; i++) {
      const cue = state.cues[i];
      if (!cue || !cue.text) continue;
      if (state.translations[i]) continue;
      if (state.requested.has(i)) continue;
      const failKey = 'i:' + i;
      if ((state.failures.get(failKey) || 0) >= MAX_TRANSLATE_ATTEMPTS) continue;
      state.requested.add(i);
      state.pending.push(i);
    }
  }

  function pumpQueue() {
    if (state.destroyed || state.fatalCode) return;
    if (!state.settings.autoTranslate || !state.settings.enabled) return;
    if (state.domMode) return;
    const current = state.currentIndex;
    // 丢弃远落后于当前句的待翻译项（跳转/回看后不浪费请求）
    if (state.pending.length) {
      state.pending = state.pending.filter(function (index) {
        if (index < current - 3 && !state.translations[index]) {
          state.requested.delete(index);
          return false;
        }
        return true;
      });
      state.pending.sort(function (a, b) {
        return queuePriority(a, current) - queuePriority(b, current);
      });
    }
    const video = getVideoEl();
    const paused = !!video && !!video.paused;
    while (state.activeBatches < MAX_TRANSLATE_BATCHES && state.pending.length) {
      let batch;
      if (paused) {
        // 暂停时只翻译当前句，不预取
        const pos = state.pending.indexOf(current);
        if (pos < 0) break;
        batch = state.pending.splice(pos, 1);
      } else {
        batch = state.pending.splice(0, Math.max(1, Number(state.settings.batchSize) || 12));
      }
      if (!batch.length) break;
      state.activeBatches++;
      runTranslateBatch(batch);
    }
    updateQueueStatus();
  }

  async function runTranslateBatch(indices) {
    const gen = state.generation;
    const sourceTexts = indices.map(function (index) {
      const cue = state.cues[index];
      return cue ? cue.text : '';
    });
    let response;
    try {
      response = await sendBackground({
        type: 'YTBT_TRANSLATE',
        payload: { videoId: state.videoId, title: state.title, texts: sourceTexts },
      });
    } catch (e) {
      response = { ok: false, error: { code: 'NETWORK', message: '翻译请求失败' } };
    }
    if (gen !== state.generation) return;
    state.activeBatches = Math.max(0, state.activeBatches - 1);
    if (response && response.ok && Array.isArray(response.translations)) {
      applyTranslations(indices, sourceTexts, response.translations);
    } else {
      handleTranslateError(indices, sourceTexts, response);
    }
    if (gen !== state.generation) return;
    scheduleWindow();
    pumpQueue();
    updateQueueStatus();
  }

  function applyTranslations(indices, sourceTexts, zhList) {
    let changed = false;
    indices.forEach(function (index, offset) {
      const text = sourceTexts[offset];
      const zh = zhList[offset];
      if (!text) return;
      if (typeof zh === 'string' && zh) {
        state.textTranslations.set(text, zh);
        if (!state.domMode && index < state.translations.length) {
          state.translations[index] = zh;
        }
        changed = true;
      } else {
        // 模型漏翻/批次部分失败：计入失败次数，避免无限重试
        state.requested.delete(index);
        const failKey = state.domMode ? 't:' + text : 'i:' + index;
        state.failures.set(failKey, (state.failures.get(failKey) || 0) + 1);
      }
    });
    if (state.domMode) {
      state.translations = state.cues.map(function (cue) {
        return state.textTranslations.get(cue.text) || '';
      });
    }
    if (changed && state.overlay) {
      try { state.overlay.setTranslations(state.translations); } catch (e) { /* 忽略 */ }
    }
  }

  function handleTranslateError(indices, sourceTexts, response) {
    const error = (response && response.error) || { code: 'BAD_RESPONSE', message: '翻译失败' };
    const code = String(error.code || 'BAD_RESPONSE');
    const message = String(error.message || '翻译失败');
    if (FATAL_CODES[code]) {
      state.fatalCode = code;
      state.fatalMessage = message;
      state.lastErrorKind = 'translate';
      state.pending.length = 0;
      state.requested.clear();
      setStatus({ phase: 'error', message: message, retryable: true, code: code });
      return;
    }
    // 非致命错误：每个句子最多重试 2 次，然后放弃并轻提示
    let willRetry = false;
    indices.forEach(function (index, offset) {
      const text = sourceTexts[offset];
      if (!text) return;
      const key = state.domMode ? 't:' + text : 'i:' + index;
      const count = (state.failures.get(key) || 0) + 1;
      state.failures.set(key, count);
      if (count < MAX_TRANSLATE_ATTEMPTS) willRetry = true;
      if (!state.domMode) state.requested.delete(index);
    });
    const now = Date.now();
    if (now - state.lastFlashAt > 3000) {
      state.lastFlashAt = now;
      flash('翻译失败，稍后自动重试');
    }
    if (willRetry && !state.retryTimer) {
      state.retryTimer = setTimeout(function () {
        state.retryTimer = null;
        if (state.destroyed || state.fatalCode || !state.settings.autoTranslate) return;
        scheduleWindow();
        pumpQueue();
      }, TRANSLATE_RETRY_DELAY_MS);
    }
  }

  function updateQueueStatus() {
    if (state.domMode) { updateDomStatus(); return; }
    if (state.fatalCode) return;
    if (!state.settings.autoTranslate || !state.settings.enabled) return;
    const current = state.currentIndex;
    if (current < 0 || !state.cues.length) return;
    const ahead = Math.max(0, Number(state.settings.prefetchAhead) || 0);
    const end = Math.min(state.cues.length - 1, current + ahead);
    let total = 0;
    let done = 0;
    for (let i = current; i <= end; i++) {
      total++;
      if (state.translations[i]) done++;
    }
    const busy = state.activeBatches > 0 || state.pending.length > 0;
    if (!busy) {
      if (state.phase === 'translating') setStatus({ phase: 'ready' });
      return;
    }
    if (total === 0) return;
    setStatus({ phase: 'translating', done: done, total: total });
  }

  /* ------------------------------------------------------------------ *
   * background 通信
   * ------------------------------------------------------------------ */

  function sendBackground(message, timeoutMs) {
    const limit = timeoutMs == null ? 120000 : timeoutMs;
    return new Promise(function (resolve) {
      let settled = false;
      let timer = null;
      function finish(response) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(response);
      }
      timer = setTimeout(function () {
        finish({ ok: false, error: { code: 'TIMEOUT', message: '扩展后台响应超时，请刷新页面后重试' } });
      }, limit);
      try {
        chrome.runtime.sendMessage(message, function (response) {
          const err = chrome.runtime.lastError;
          if (err) {
            finish({ ok: false, error: { code: 'NETWORK', message: '扩展后台不可用：' + (err.message || '未知错误') } });
            return;
          }
          finish(response || { ok: false, error: { code: 'BAD_RESPONSE', message: '扩展后台无响应' } });
        });
      } catch (e) {
        finish({ ok: false, error: { code: 'NETWORK', message: '扩展后台不可用：' + (e && e.message ? e.message : '') } });
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * overlay 回调
   * ------------------------------------------------------------------ */

  async function handleWordClick(info) {
    if (!info || !info.word) return;
    const gen = state.generation;
    const video = getVideoEl();
    if (state.settings.pauseOnWordClick && video && !video.paused) {
      try {
        video.pause();
        state.pausedByUs = true;
      } catch (e) { /* 忽略 */ }
    }
    state.cardInfo = info;
    if (state.overlay) {
      try { state.overlay.showWordCardLoading(info); } catch (e) { /* 忽略 */ }
    }
    const sentence = String(info.sentence || (info.cue && info.cue.text) || '');
    const cueTime = info.cue && typeof info.cue.start === 'number'
      ? info.cue.start
      : (video ? video.currentTime : 0);
    let response;
    try {
      response = await sendBackground({
        type: 'YTBT_LOOKUP',
        payload: {
          videoId: state.videoId,
          title: state.title,
          word: info.word,
          sentence: sentence,
          cueTime: cueTime,
        },
      }, 90000);
    } catch (e) {
      response = { ok: false, error: { code: 'NETWORK', message: '查词请求失败' } };
    }
    if (gen !== state.generation || !state.overlay) return;
    if (response && response.ok && response.card) {
      try { state.overlay.showWordCard(response.card, info); } catch (e) { /* 忽略 */ }
    } else {
      const message = (response && response.error && response.error.message) || '查词失败，请稍后重试';
      try { state.overlay.showWordCardError(message, info); } catch (e) { /* 忽略 */ }
    }
  }

  function handleRetryLookup() {
    if (state.cardInfo) handleWordClick(state.cardInfo);
  }

  async function handleWordbookAdd(card) {
    if (!card) return;
    const video = getVideoEl();
    let response;
    try {
      response = await sendBackground({
        type: 'YTBT_WORDBOOK_ADD',
        payload: {
          card: card,
          videoId: state.videoId,
          videoTitle: state.title,
          time: video ? video.currentTime : 0,
        },
      });
    } catch (e) {
      response = { ok: false, error: { code: 'NETWORK', message: '加入词库请求失败' } };
    }
    if (response && response.ok) {
      flash('已加入词库（共 ' + (response.size || 0) + ' 个）');
    } else {
      const message = (response && response.error && response.error.message) || '未知错误';
      flash('加入词库失败：' + message);
    }
  }

  function handleCardClose() {
    const video = getVideoEl();
    state.cardInfo = null;
    if (state.pausedByUs && state.settings.resumeAfterCard && video && video.paused) {
      try {
        const played = video.play();
        if (played && typeof played.catch === 'function') played.catch(function () { /* 自动播放可能被拦截 */ });
      } catch (e) { /* 忽略 */ }
    }
    state.pausedByUs = false;
  }

  function openOptionsPage() {
    try {
      chrome.runtime.sendMessage({ type: 'YTBT_OPEN_OPTIONS' }, function () {
        const err = chrome.runtime.lastError;
        if (err) flash('无法打开设置页，请从扩展菜单进入');
      });
    } catch (e) {
      flash('无法打开设置页，请从扩展菜单进入');
    }
  }

  function handleRetry() {
    const needsReload = !state.cues.length || state.phase === 'no-captions';
    if (needsReload) {
      restartPipeline();
      return;
    }
    state.fatalCode = '';
    state.fatalMessage = '';
    state.errorCode = '';
    state.lastErrorKind = '';
    state.failures.clear();
    state.requested.clear();
    state.pending.length = 0;
    if (state.domMode) {
      state.domRequested.clear();
      setStatus({ phase: 'dom', message: '已使用页面原生字幕（DOM 捕获）' });
      if (state.domLive) scheduleDomTranslation(state.domLive.text);
      return;
    }
    setStatus({ phase: 'ready' });
    scheduleWindow();
    pumpQueue();
  }

  function restartPipeline() {
    if (!state.videoId) {
      evaluatePage();
      return;
    }
    const gen = ++state.generation;
    state.autoRetried = false;
    resetPipeline();
    setStatus({ phase: 'loading', message: '正在重新获取字幕…' });
    loadSubtitles(gen);
  }

  /* ------------------------------------------------------------------ *
   * overlay / player 生命周期
   * ------------------------------------------------------------------ */

  function mountOverlayIfNeeded(player) {
    if (state.overlay) return;
    try {
      const overlay = UI.createOverlay({
        playerEl: player,
        settings: state.settings,
        stylesUrl: STYLE_URL,
        callbacks: {
          onWordClick: handleWordClick,
          onPatch: patchAndSave,
          onRetry: handleRetry,
          onOpenOptions: openOptionsPage,
          onWordbookAdd: handleWordbookAdd,
          onCardClose: handleCardClose,
          onRetryLookup: handleRetryLookup,
        },
      });
      overlay.mount();
      state.overlay = overlay;
      state.playerEl = player;
    } catch (e) {
      console.warn('[YTBT] 字幕 UI 初始化失败：', e);
      state.overlay = null;
    }
  }

  /** 覆盖层是否还挂在当前播放器上（YouTube 偶尔会重建 #movie_player） */
  function overlayAttached() {
    try {
      if (!state.overlay || !state.playerEl || !state.playerEl.isConnected) return false;
      return !!state.playerEl.querySelector('[data-ytbtl-ui="1"]');
    } catch (e) {
      return false;
    }
  }

  function waitForPlayer(timeoutMs) {
    return new Promise(function (resolve) {
      const existing = document.getElementById('movie_player');
      if (existing) { resolve(existing); return; }
      let settled = false;
      let timer = null;
      let observer = null;
      function finish(player) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (observer) {
          try { observer.disconnect(); } catch (e) { /* 忽略 */ }
        }
        resolve(player || null);
      }
      try {
        observer = new MutationObserver(function () {
          const player = document.getElementById('movie_player');
          if (player) finish(player);
        });
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch (e) { /* 忽略 */ }
      timer = setTimeout(function () {
        finish(document.getElementById('movie_player'));
      }, timeoutMs);
    });
  }

  function teardown() {
    if (!state.booted && !state.overlay && !state.playerEl) return;
    state.generation++;
    state.booted = false;
    state.subtitleLoading = false;
    state.autoRetried = false;
    stopDomCapture();
    resetPipeline();
    if (state.rafId) {
      try { cancelAnimationFrame(state.rafId); } catch (e) { /* 忽略 */ }
      state.rafId = 0;
    }
    unbindVideoEvents();
    if (state.overlay) {
      try { state.overlay.destroy(); } catch (e) { /* 忽略 */ }
      state.overlay = null;
    }
    state.playerEl = null;
    state.videoId = '';
    state.title = '';
    state.phase = 'idle';
    state.message = '';
    state.errorCode = '';
    state.lastErrorKind = '';
    state.cardInfo = null;
    state.pausedByUs = false;
  }

  /* ------------------------------------------------------------------ *
   * SPA 页面生命周期
   * ------------------------------------------------------------------ */

  async function runEvaluation() {
    if (state.destroyed) return;
    // 播放器被 YouTube 重建 / 覆盖层被移除时，先拆掉旧状态再重新初始化
    if (state.booted && state.playerEl && (!state.playerEl.isConnected || !overlayAttached())) {
      teardown();
    }
    const supported = core.isSupportedPage(window.location.href);
    if (!supported) {
      teardown();
      return;
    }
    const videoId = core.getVideoIdFromUrl(window.location.href) || '';
    if (!videoId) {
      teardown();
      return;
    }
    if (state.booted && state.videoId === videoId) return;

    state.videoId = videoId;
    state.title = '';
    state.cardInfo = null;
    state.pausedByUs = false;
    const gen = ++state.generation;
    state.autoRetried = false;
    resetPipeline();

    if (!state.booted) {
      state.booted = true;
      await loadSettings();
      if (gen !== state.generation) return;
      const player = await waitForPlayer(PLAYER_WAIT_MS);
      if (gen !== state.generation) return;
      if (!player) {
        state.booted = false;
        return;
      }
      mountOverlayIfNeeded(player);
      if (!state.overlay) {
        state.booted = false;
        return;
      }
      startTick();
    }
    if (gen !== state.generation) return;
    await loadSubtitles(gen);
  }

  function evaluatePage() {
    if (state.initializing || state.destroyed) return;
    state.initializing = true;
    runEvaluation().catch(function (err) {
      console.warn('[YTBT] 页面初始化异常：', err);
    }).then(function () {
      state.initializing = false;
    });
  }

  function setupNavigationWatch() {
    try {
      document.addEventListener('yt-navigate-finish', function () {
        setTimeout(function () { evaluatePage(); }, 150);
      });
      document.addEventListener('yt-page-data-updated', function () {
        setTimeout(function () { evaluatePage(); }, 400);
      });
      window.addEventListener('popstate', function () {
        setTimeout(function () { evaluatePage(); }, 200);
      });
    } catch (e) { /* 忽略 */ }
    setInterval(function () {
      try { evaluatePage(); } catch (e) { /* 忽略 */ }
    }, NAV_POLL_MS);
  }

  /* ------------------------------------------------------------------ *
   * 快捷键（Alt 组合，避开 YouTube 单键快捷键）
   * ------------------------------------------------------------------ */

  function isEditableTarget(target) {
    try {
      if (!target) return false;
      const el = target.nodeType === 1 ? target : target.parentElement;
      if (!el || !el.tagName) return false;
      const tag = String(el.tagName).toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (el.isContentEditable) return true;
      if (typeof el.closest === 'function') {
        if (el.closest('[contenteditable="true"], [contenteditable=""], ytd-commentbox, ytd-comment-simplebox-renderer')) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function cycleZhMode() {
    const index = ZH_MODES.indexOf(state.settings.zhMode);
    savePatch({ zhMode: ZH_MODES[(index + 1) % ZH_MODES.length] });
    if (state.overlay) {
      try { state.overlay.flashMessage('中文字幕：' + ZH_MODE_LABEL[state.settings.zhMode]); } catch (e) { /* 忽略 */ }
    }
  }

  function adjustZhSize(delta) {
    const current = Number(state.settings.zhSize) || 11;
    const next = Math.min(24, Math.max(8, current + delta));
    savePatch({ zhSize: next });
    if (state.overlay) {
      try { state.overlay.flashMessage('中文字号 ' + next + 'px'); } catch (e) { /* 忽略 */ }
    }
  }

  function handleKeydown(event) {
    try {
      if (!state.booted || state.destroyed) return;
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (isEditableTarget(event.target)) return;
      const key = String(event.key || '');
      if (!key) return;
      const lower = key.toLowerCase();
      if (lower === 'z') {
        event.preventDefault();
        event.stopPropagation();
        cycleZhMode();
      } else if (key === '[') {
        event.preventDefault();
        event.stopPropagation();
        adjustZhSize(-1);
      } else if (key === ']') {
        event.preventDefault();
        event.stopPropagation();
        adjustZhSize(1);
      } else if (lower === 'e') {
        event.preventDefault();
        event.stopPropagation();
        savePatch({ enabled: !state.settings.enabled });
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ *
   * popup 状态查询
   * ------------------------------------------------------------------ */

  function buildStateSnapshot() {
    const translated = state.translations.filter(Boolean).length;
    const current = state.currentIndex;
    const currentZh = current >= 0 && current < state.translations.length ? state.translations[current] : '';
    const payload = {
      videoId: state.videoId,
      title: state.title,
      phase: state.phase,
      cueCount: state.cues.length,
      totalCount: state.cues.length,
      translatedCount: translated,
      zhMode: state.settings.zhMode,
      message: state.message,
      errorCode: state.errorCode || state.fatalCode || '',
      currentZh: currentZh,
    };
    return {
      type: 'YTBT_STATE',
      ok: true,
      payload: payload,
      // 兼容扁平读取方式
      videoId: payload.videoId,
      title: payload.title,
      videoTitle: payload.title,
      phase: payload.phase,
      cueCount: payload.cueCount,
      totalCount: payload.totalCount,
      translatedCount: payload.translatedCount,
      zhMode: payload.zhMode,
    };
  }

  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || (message.type !== 'YTBT_STATE' && message.type !== 'YTBT_GET_STATE')) return false;
      try {
        sendResponse(buildStateSnapshot());
      } catch (e) {
        try {
          sendResponse({ type: 'YTBT_STATE', ok: false, payload: null, error: { code: 'INTERNAL', message: '状态读取失败' } });
        } catch (e2) { /* 忽略 */ }
      }
      return false;
    });
  } catch (e) { /* 忽略 */ }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  window.addEventListener('keydown', handleKeydown, true);
  setupNavigationWatch();
  evaluatePage();
})();
