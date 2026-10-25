/*!
 * YT 双语字幕 · 点词查意 — UI 覆盖层
 * 经典脚本（无构建）；暴露 self.YTBTL_UI = { createOverlay(opts), version }
 *
 * 设计约束：
 * - 不依赖任何扩展 API，也不依赖 main.js；所有外部能力通过 opts.callbacks 注入。
 * - Shadow DOM 挂载到 #movie_player 内，宿主铺满播放器但 pointer-events:none，
 *   只有单词 / 工具栏按钮 / 单词卡可点，绝不遮挡播放器控件。
 * - 样式由 styles.css 通过 <link> 注入 Shadow Root（opts.stylesUrl）。
 */
(function (root, factory) {
  const api = factory(root);
  if (root) root.YTBTL_UI = Object.assign(root.YTBTL_UI || {}, api);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const VERSION = '1.0.0';

  const ZH_MODES = ['off', 'hover', 'on'];
  const ZH_MODE_LABEL = { off: '隐藏', hover: '悬停时显示', on: '常显' };
  const EN_MIN_SIZE = 14;
  const EN_MAX_SIZE = 40;
  const ZH_MIN_SIZE = 8;
  const ZH_MAX_SIZE = 24;
  const CARD_EDGE_GAP = 8;
  const DRAG_THRESHOLD = 4; // 超过这个位移才算拖动，否则仍按点击单词处理
  const POS_GAP = 8; // 拖动时字幕块与播放器边缘的最小间距

  /** 可交互元素：点击这些元素时阻止事件冒泡到页面，避免触发播放器自身的播放/暂停。 */
  const INTERACTIVE_SELECTOR = '.ytbtl-subs, .ytbtl-word, .ytbtl-btn, .ytbtl-speak, .ytbtl-card, .ytbtl-btn-primary, .ytbtl-btn-ghost';

  /** 依赖的共享库（core.js 必须先加载） */
  function coreLib() {
    const lib = (root && root.YTBTL) || (typeof globalThis !== 'undefined' ? globalThis.YTBTL : null);
    if (!lib) throw new Error('YTBTL_UI 依赖 src/lib/core.js，请先加载 core.js');
    return lib;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function pointInRect(rect, x, y, pad) {
    const p = pad || 0;
    return x >= rect.left - p && x <= rect.right + p && y >= rect.top - p && y <= rect.bottom + p;
  }

  function normalizePhonetic(value) {
    return String(value == null ? '' : value).replace(/^\/+|\/+$/g, '').trim();
  }

  /** #rrggbb → "r,g,b"，供 rgba(var(--ytbtl-bg-rgb), opacity) 使用 */
  function hexToRgb(hex, fallback) {
    const text = String(hex == null ? '' : hex).trim();
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
    if (!m) return fallback || '0,0,0';
    return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16);
  }

  /**
   * 创建字幕覆盖层实例。
   * @param {{
   *   playerEl: HTMLElement,
   *   settings?: object,
   *   stylesUrl?: string,
   *   callbacks?: object,
   * }} opts
   */
  function createOverlay(opts) {
    opts = opts || {};
    const playerEl = opts.playerEl;
    if (!playerEl || !playerEl.nodeType) {
      throw new Error('YTBTL_UI.createOverlay 需要 playerEl（#movie_player）');
    }
    const playerDocument = playerEl.ownerDocument || document;
    const C = coreLib();
    const callbacks = Object.assign({}, opts.callbacks || {});

    let settings = C.normalizeSettings(opts.settings || {});
    let cues = [];
    let translations = [];
    let cueIndex = -1;
    let currentCue = null;
    let status = { phase: 'idle' };
    let hoverInSubs = false;
    let pendingHoverPoint = null;
    let hoverRaf = 0;
    let mounted = false;
    let destroyed = false;
    let cardOpenNow = false;
    let cardInfo = null;
    let activeWordEl = null;
    let toastTimer = 0;
    let nativePosTimer = 0;
    let nativeEnsureAttempted = false;
    let nativeFallbackActive = false;
    let nativeMissingTicks = 0;
    let nativeRevertTimer = 0;
    let nativeLangWarned = false;
    let dragging = null;           // 拖动状态
    let suppressWordClick = false; // 拖动结束后抑制这次点击，避免误查词
    let dragMoveHandler = null;
    let dragEndHandler = null;

    /* ---------------------------------------------------------------- *
     * DOM（Shadow DOM，避免被页面样式污染）
     * ---------------------------------------------------------------- */

    const host = document.createElement('div');
    host.className = 'ytbtl-host';
    host.setAttribute('data-ytbtl-ui', '1');
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483000;';

    const shadowRoot = host.attachShadow({ mode: 'open' });

    if (opts.stylesUrl) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = String(opts.stylesUrl);
      link.setAttribute('data-ytbtl-style', '1');
      shadowRoot.appendChild(link);
    }

    const rootEl = el('div', 'ytbtl-root');
    shadowRoot.appendChild(rootEl);

    // 字幕区
    const subsEl = el('div', 'ytbtl-subs');
    const enLine = el('div', 'ytbtl-line-en');
    const zhLine = el('div', 'ytbtl-line-zh ytbtl-zh-invisible');
    subsEl.appendChild(enLine);
    subsEl.appendChild(zhLine);
    rootEl.appendChild(subsEl);

    // 状态提示（正在获取字幕 / 未找到字幕）
    const hintEl = el('div', 'ytbtl-hint');
    hintEl.hidden = true;
    rootEl.appendChild(hintEl);

    // 工具栏
    const toolbar = el('div', 'ytbtl-toolbar');
    const subsSwitchBtn = el('button', 'ytbtl-btn ytbtl-subs-switch');
    subsSwitchBtn.type = 'button';
    subsSwitchBtn.setAttribute('role', 'switch');
    subsSwitchBtn.setAttribute('aria-checked', 'true');
    subsSwitchBtn.title = '关闭字幕（Alt+E）';
    subsSwitchBtn.setAttribute('aria-label', '字幕开关');
    const switchTrack = el('span', 'ytbtl-subs-switch-track');
    switchTrack.appendChild(el('span', 'ytbtl-subs-switch-knob'));
    subsSwitchBtn.appendChild(switchTrack);
    subsSwitchBtn.appendChild(el('span', 'ytbtl-subs-switch-label', '字幕'));
    const pill = el('span', 'ytbtl-pill');
    pill.hidden = true;
    const domBadge = el('span', 'ytbtl-pill ytbtl-pill-dom', 'DOM');
    domBadge.hidden = true;
    domBadge.title = '未取到字幕接口数据，正在使用页面字幕区域捕获';
    const zhBtn = el('button', 'ytbtl-btn ytbtl-btn-zh', '中');
    zhBtn.type = 'button';
    const modeBtn = el('button', 'ytbtl-btn ytbtl-btn-mode', '覆盖');
    modeBtn.type = 'button';
    modeBtn.hidden = !C.NATIVE_MODE_ENABLED;
    modeBtn.title = '切换字幕模式：覆盖模式 ↔ 原生英文 + 中文';
    modeBtn.setAttribute('aria-label', '切换字幕模式');
    const enMinusBtn = el('button', 'ytbtl-btn', 'A−');
    enMinusBtn.type = 'button';
    enMinusBtn.title = '缩小英文字幕';
    enMinusBtn.setAttribute('aria-label', '缩小英文字幕');
    const enPlusBtn = el('button', 'ytbtl-btn', 'A+');
    enPlusBtn.type = 'button';
    enPlusBtn.title = '放大英文字幕';
    enPlusBtn.setAttribute('aria-label', '放大英文字幕');
    const retryBtn = el('button', 'ytbtl-btn ytbtl-btn-retry', '重试');
    retryBtn.type = 'button';
    retryBtn.hidden = true;
    retryBtn.title = '重试翻译';
    retryBtn.setAttribute('aria-label', '重试翻译');
    const resetPosBtn = el('button', 'ytbtl-btn ytbtl-btn-reset-pos', '⌖');
    resetPosBtn.type = 'button';
    resetPosBtn.hidden = true;
    resetPosBtn.title = '复位字幕位置（拖动字幕后可用）';
    resetPosBtn.setAttribute('aria-label', '复位字幕位置');
    const gearBtn = el('button', 'ytbtl-btn ytbtl-btn-gear', '⚙');
    gearBtn.type = 'button';
    gearBtn.title = '打开设置页';
    gearBtn.setAttribute('aria-label', '打开设置页');
    toolbar.appendChild(subsSwitchBtn);
    toolbar.appendChild(pill);
    toolbar.appendChild(domBadge);
    toolbar.appendChild(zhBtn);
    toolbar.appendChild(modeBtn);
    toolbar.appendChild(enMinusBtn);
    toolbar.appendChild(enPlusBtn);
    toolbar.appendChild(retryBtn);
    toolbar.appendChild(resetPosBtn);
    toolbar.appendChild(gearBtn);
    rootEl.appendChild(toolbar);

    // 错误条（工具栏下方）
    const errbar = el('div', 'ytbtl-errbar');
    errbar.hidden = true;
    const errMsg = el('span', 'ytbtl-errbar-msg');
    const errRetry = el('button', 'ytbtl-errbar-retry', '重试');
    errRetry.type = 'button';
    errRetry.title = '重试翻译';
    errRetry.setAttribute('aria-label', '重试翻译');
    errbar.appendChild(errMsg);
    errbar.appendChild(errRetry);
    rootEl.appendChild(errbar);

    // 顶部小提示
    const toastEl = el('div', 'ytbtl-toast');
    rootEl.appendChild(toastEl);

    // 单词卡
    const cardEl = el('div', 'ytbtl-card');
    cardEl.hidden = true;
    cardEl.setAttribute('role', 'dialog');
    cardEl.setAttribute('aria-label', '单词卡片');
    const cardCloseBtn = el('button', 'ytbtl-card-close', '×');
    cardCloseBtn.type = 'button';
    cardCloseBtn.title = '关闭单词卡（Esc）';
    cardCloseBtn.setAttribute('aria-label', '关闭单词卡');
    const cardBody = el('div', 'ytbtl-card-body');
    const cardActions = el('div', 'ytbtl-card-actions');
    cardEl.appendChild(cardCloseBtn);
    cardEl.appendChild(cardBody);
    cardEl.appendChild(cardActions);
    rootEl.appendChild(cardEl);

    /* ---------------------------------------------------------------- *
     * 小工具
     * ---------------------------------------------------------------- */

    function call(name, arg) {
      const fn = callbacks[name];
      if (typeof fn !== 'function') return;
      try {
        fn(arg);
      } catch (error) {
        if (root.console && typeof root.console.error === 'function') {
          root.console.error('[YTBTL_UI] 回调 ' + name + ' 执行出错', error);
        }
      }
    }

    /** 在线发音兜底：系统没有英文 TTS 或 Web Speech 不工作时，播放有道词典发音 */
    function playOnlinePronunciation(text) {
      try {
        const url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&type=2';
        let audio = null;
        try {
          audio = new root.Audio(url);
        } catch (e) {
          audio = playerDocument.createElement('audio');
          audio.src = url;
        }
        audio.volume = 0.9;
        const played = audio.play();
        if (played && typeof played.catch === 'function') {
          played.catch(function () {
            flashMessage('在线发音失败，请检查网络或系统语音');
          });
        }
      } catch (error) {
        flashMessage('发音失败，请检查系统语音或网络');
      }
    }

    function speakWord(word) {
      const text = String(word || '').trim();
      if (!text) return;
      let usedOnline = false;
      const fallback = function () {
        if (usedOnline) return;
        usedOnline = true;
        playOnlinePronunciation(text);
      };
      try {
        const synth = root.speechSynthesis;
        const Utterance = root.SpeechSynthesisUtterance;
        if (!synth || typeof Utterance !== 'function') {
          fallback();
          return;
        }
        let voices = [];
        try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
        // 系统没有可用语音时，Web Speech 会静默失败，直接用在线发音
        if (!voices.length) {
          fallback();
          return;
        }
        synth.cancel();
        const utter = new Utterance(text);
        utter.lang = 'en-US';
        utter.rate = 0.9;
        const enVoice = voices.find(function (v) { return /^en([-_]|$)/i.test(String(v.lang || '')); });
        if (enVoice) utter.voice = enVoice;
        utter.onerror = fallback;
        synth.speak(utter);
        root.setTimeout(function () {
          try {
            if (!synth.speaking && !synth.pending) fallback();
          } catch (e) { /* 忽略 */ }
        }, 600);
      } catch (error) {
        fallback();
      }
    }

    function clearActiveWord() {
      if (activeWordEl) {
        activeWordEl.classList.remove('is-active');
        activeWordEl = null;
      }
    }

    /* ---------------------------------------------------------------- *
     * 字幕位置：自由拖动 + 复位
     * ---------------------------------------------------------------- */

    function playerSize() {
      const rect = playerEl.getBoundingClientRect();
      return {
        w: Math.max(1, rect.width || playerEl.clientWidth || 0),
        h: Math.max(1, rect.height || playerEl.clientHeight || 0),
      };
    }

    function unionRect(a, b) {
      if (!b) return a;
      const left = Math.min(a.left, b.left);
      const top = Math.min(a.top, b.top);
      const right = Math.max(a.right, b.right);
      const bottom = Math.max(a.bottom, b.bottom);
      return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    }

    /** 当前字幕文字的视觉矩形（默认模式下容器是整行，不能直接用来算拖动起点） */
    function visualSubsRect() {
      const playerRect = playerEl.getBoundingClientRect();
      if (settings.subtitlePos) {
        const r = subsEl.getBoundingClientRect();
        return { left: r.left - playerRect.left, top: r.top - playerRect.top, width: r.width, height: r.height };
      }
      const enRect = enLine.getBoundingClientRect();
      const zhRect = zhLine.classList.contains('ytbtl-zh-invisible') ? null : zhLine.getBoundingClientRect();
      const u = unionRect(enRect, zhRect);
      return { left: u.left - playerRect.left, top: u.top - playerRect.top, width: u.width, height: u.height };
    }

    /** 根据 settings.subtitlePos 定位字幕块；null 时回到默认底部居中 */
    function applyCustomPosition(pos) {
      if (dragging && dragging.moved) return; // 拖动中不用旧设置覆盖
      subsEl.classList.add('ytbtl-custom-pos');
      subsEl.style.bottom = '';
      const size = playerSize();
      const rect = subsEl.getBoundingClientRect();
      const bw = rect.width || 220;
      const bh = rect.height || 40;
      const left = clamp(pos.x * size.w, POS_GAP, Math.max(POS_GAP, size.w - bw - POS_GAP));
      const top = clamp(pos.y * size.h, POS_GAP, Math.max(POS_GAP, size.h - bh - POS_GAP));
      subsEl.style.left = Math.round(left) + 'px';
      subsEl.style.top = Math.round(top) + 'px';
    }

    function applyPosition() {
      if (settings.subtitleMode === 'native') {
        resetPosBtn.hidden = !settings.subtitlePos;
        if (settings.subtitlePos) {
          applyCustomPosition(settings.subtitlePos);
        } else {
          subsEl.classList.remove('ytbtl-custom-pos');
          subsEl.style.left = '';
          subsEl.style.top = '';
        }
        return;
      }
      subsEl.style.bottom = '';
      resetPosBtn.hidden = !settings.subtitlePos;
      const pos = settings.subtitlePos;
      if (!pos) {
        subsEl.classList.remove('ytbtl-custom-pos');
        subsEl.style.left = '';
        subsEl.style.top = '';
        return;
      }
      applyCustomPosition(pos);
    }

    function stopDragListeners() {
      if (dragMoveHandler) {
        playerDocument.removeEventListener('pointermove', dragMoveHandler, true);
        dragMoveHandler = null;
      }
      if (dragEndHandler) {
        playerDocument.removeEventListener('pointerup', dragEndHandler, true);
        playerDocument.removeEventListener('pointercancel', dragEndHandler, true);
        dragEndHandler = null;
      }
    }

    function endDrag(event, cancelled) {
      if (!dragging) return;
      if (event && event.pointerId !== undefined && event.pointerId !== dragging.pointerId) return;
      const state = dragging;
      dragging = null;
      stopDragListeners();
      subsEl.classList.remove('is-pressing');
      subsEl.classList.remove('is-dragging');
      if (!state.moved) return;
      // 拖动结束后紧接着的 click 不应触发查词
      suppressWordClick = true;
      root.setTimeout(function () { suppressWordClick = false; }, 150);
      if (cancelled) {
        applyPosition();
        return;
      }
      const size = playerSize();
      if (!size.w || !size.h) return;
      call('onPatch', {
        subtitlePos: {
          x: clamp(state.lastLeft / size.w, 0, 1),
          y: clamp(state.lastTop / size.h, 0, 1),
        },
      });
      flashMessage('字幕位置已保存，点工具栏 ⌖ 可复位', 1600);
    }

    function onSubsPointerDown(event) {
      if (!settings.enabled || destroyed || !currentCue) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.isPrimary === false) return;
      const target = event.target;
      if (target && target.closest && target.closest('button')) return;
      const visual = visualSubsRect();
      if (!visual.width || !visual.height) return;
      dragging = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: visual.left,
        originTop: visual.top,
        width: visual.width,
        height: visual.height,
        moved: false,
        lastLeft: visual.left,
        lastTop: visual.top,
      };
      subsEl.classList.add('is-pressing');
      if (!dragMoveHandler) {
        dragMoveHandler = function (e) { onSubsPointerMove(e); };
        dragEndHandler = function (e) { endDrag(e, e.type === 'pointercancel'); };
        playerDocument.addEventListener('pointermove', dragMoveHandler, true);
        playerDocument.addEventListener('pointerup', dragEndHandler, true);
        playerDocument.addEventListener('pointercancel', dragEndHandler, true);
      }
    }

    /**
     * 在 document 捕获阶段识别「按在字幕上」：
     * YouTube 播放器自己的 pointerdown 处理可能先于字幕元素执行，用捕获阶段更稳。
     */
    function onDocumentPointerDown(event) {
      if (!settings.enabled || destroyed || !currentCue) return;
      let path = [];
      try { path = typeof event.composedPath === 'function' ? event.composedPath() : []; } catch (e) { path = []; }
      if (path.indexOf(subsEl) === -1) return;
      const target = event.target;
      if (target && target.closest && target.closest('button')) return;
      onSubsPointerDown(event);
    }

    function onSubsPointerMove(event) {
      if (!dragging) return;
      if (event.pointerId !== undefined && event.pointerId !== dragging.pointerId) return;
      const dx = event.clientX - dragging.startX;
      const dy = event.clientY - dragging.startY;
      if (!dragging.moved) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        dragging.moved = true;
        subsEl.classList.add('is-dragging');
        subsEl.classList.add('ytbtl-custom-pos');
        if (cardOpenNow) closeCardByUser();
      }
      if (event.cancelable) event.preventDefault();
      const size = playerSize();
      const bw = Math.max(60, dragging.width);
      const bh = Math.max(24, dragging.height);
      const left = clamp(dragging.originLeft + dx, POS_GAP, Math.max(POS_GAP, size.w - bw - POS_GAP));
      const top = clamp(dragging.originTop + dy, POS_GAP, Math.max(POS_GAP, size.h - bh - POS_GAP));
      dragging.lastLeft = left;
      dragging.lastTop = top;
      subsEl.style.left = Math.round(left) + 'px';
      subsEl.style.top = Math.round(top) + 'px';
    }

    function onSubsDragStart(event) {
      event.preventDefault();
    }

    /* ---------------------------------------------------------------- *
     * 设置 / 原生字幕
     * ---------------------------------------------------------------- */

    function applyCssVars() {
      host.style.setProperty('--ytbtl-en-size', settings.enSize + 'px');
      host.style.setProperty('--ytbtl-zh-size', clamp(settings.zhSize, ZH_MIN_SIZE, ZH_MAX_SIZE) + 'px');
      host.style.setProperty('--ytbtl-en-color', settings.enColor);
      host.style.setProperty('--ytbtl-zh-color', settings.zhColor);
      host.style.setProperty('--ytbtl-bg-rgb', hexToRgb(settings.subtitleBgColor, '0,0,0'));
      host.style.setProperty('--ytbtl-bg-opacity', String(settings.subtitleBgOpacity));
      host.style.setProperty('--ytbtl-opacity', String(settings.opacity));
      host.style.setProperty('--ytbtl-bottom-offset', settings.bottomOffset + 'px');
    }

    function syncNativeCaptions() {
      try {
        let shouldHide;
        if (!settings.enabled) shouldHide = settings.hideNativeWhenOff;
        else if (settings.subtitleMode === 'native') shouldHide = false;
        else shouldHide = settings.hideNativeCaptions;
        if (shouldHide) playerEl.classList.add('ytbtl-hide-native');
        else playerEl.classList.remove('ytbtl-hide-native');
      } catch (error) {
        /* 播放器尚未就绪时忽略 */
      }
    }

    function nativeCaptionVisible() {
      const container = playerEl.querySelector('.ytp-caption-window-container');
      if (!container) return false;
      try {
        const cs = getComputedStyle(container);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.05) return false;
      } catch (e) { /* 忽略 */ }
      const text = String(container.textContent || '').trim();
      if (!text) return false;
      let rect = null;
      try { rect = container.getBoundingClientRect(); } catch (e) { rect = null; }
      if (!rect || rect.width < 2 || rect.height < 2) return false;
      // 新版/旧版 YouTube 可能用不同的 caption 容器结构，只要 segment 有尺寸就算可见
      const segs = container.querySelectorAll('.ytp-caption-segment');
      for (let i = 0; i < segs.length; i++) {
        const el = segs[i];
        let r = null;
        try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
        if (!r || r.width < 1 || r.height < 1) continue;
        let display = '';
        try { display = getComputedStyle(el).display; } catch (e) { display = ''; }
        if (display !== 'none') return true;
      }
      // 兜底：容器里有文本且有尺寸，就认为原生字幕存在，避免误判后回退
      return true;
    }

    /** 原生模式下如果原生字幕不可见，暂时回退到插件英文，避免“只有中文没有英文” */
    function updateNativeFallback() {
      const nativeMode = settings.subtitleMode === 'native' && settings.enabled;
      let fallback = false;
      if (nativeMode) {
        const btn = playerEl.querySelector('.ytp-subtitles-button');
        const ccOff = !!btn && btn.getAttribute('aria-pressed') === 'false';
        if (ccOff) {
          fallback = !nativeCaptionVisible();
        } else {
          const container = playerEl.querySelector('.ytp-caption-window-container');
          const nativeText = container ? String(container.textContent || '').trim() : '';
          const hasNativeText = nativeText.length > 0;
          // YouTube 当前 CC 语言可能被设成了中文（自动翻译），此时原生模式没有英文
          if (nativeText && !nativeLangWarned) {
            const cjk = (nativeText.match(/[\u4e00-\u9fff]/g) || []).length;
            const latin = (nativeText.match(/[A-Za-z]/g) || []).length;
            if (cjk >= 4 && latin < 4) {
              nativeLangWarned = true;
              flashMessage('YouTube 当前字幕语言是中文，不是英文；请在播放器 CC 设置里切换到 English', 5000);
            }
          }
          const visible = nativeCaptionVisible();
          if (!visible && hasNativeText && currentCue) nativeMissingTicks++;
          else nativeMissingTicks = 0;
          if (!visible && hasNativeText && currentCue && nativeMissingTicks >= 3) fallback = true;
        }
      }
      try { subsEl.classList.toggle('ytbtl-native-fallback', fallback); } catch (e) { /* 忽略 */ }
      if (fallback !== nativeFallbackActive) {
        nativeFallbackActive = fallback;
        if (fallback) flashMessage('YouTube 原生字幕暂不可见，已暂时显示插件英文字幕', 3500);
      }
      if (fallback) {
        subsEl.style.bottom = '';
        try {
          playerEl.classList.remove('ytbtl-native-shift');
          playerEl.style.removeProperty('--ytbtl-native-shift');
        } catch (e) { /* 忽略 */ }
        // 原生字幕在这个视频/网络下确实不可用时，自动切回覆盖模式，避免一直卡在“只有中文”
        if (!nativeRevertTimer) {
          nativeRevertTimer = root.setTimeout(function () {
            nativeRevertTimer = 0;
            if (destroyed || !settings.enabled || settings.subtitleMode !== 'native') return;
            settings = C.normalizeSettings(Object.assign({}, settings, { subtitleMode: 'overlay' }));
            applySettings();
            call('onPatch', { subtitleMode: 'overlay' });
            flashMessage('该视频未显示 YouTube 原生字幕，已切回覆盖模式（插件英文）', 3800);
          }, 2500);
        }
      } else if (nativeRevertTimer) {
        root.clearTimeout(nativeRevertTimer);
        nativeRevertTimer = 0;
      }
      return fallback;
    }

    /** 原生模式：把原生字幕动态上移，中文行紧贴其下方 */
    function positionNativeLines() {
      if (updateNativeFallback()) return;
      if (settings.subtitleMode !== 'native' || !settings.enabled) {
        subsEl.style.bottom = '';
        try {
          playerEl.classList.remove('ytbtl-native-shift');
          playerEl.style.removeProperty('--ytbtl-native-shift');
        } catch (e) { /* 忽略 */ }
        return;
      }
      // 用户拖过中文位置后，用自定义位置，不再跟随原生字幕
      if (settings.subtitlePos) return;
      try { playerEl.classList.add('ytbtl-native-shift'); } catch (e) { /* 忽略 */ }
      const container = playerEl.querySelector('.ytp-caption-window-container');
      if (!container) {
        subsEl.style.bottom = '';
        return;
      }
      const playerRect = playerEl.getBoundingClientRect();
      const currentShift = parseFloat(playerEl.style.getPropertyValue('--ytbtl-native-shift')) || 0;
      let nativeBottom = -Infinity;
      const windows = container.querySelectorAll('.caption-window, .ytp-caption-window');
      for (let i = 0; i < windows.length; i++) {
        const el = windows[i];
        let rect = null;
        try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
        if (!rect || rect.width < 2 || rect.height < 2) continue;
        let display = '';
        try { display = getComputedStyle(el).display; } catch (e) { display = ''; }
        if (display === 'none') continue;
        if (rect.bottom > nativeBottom) nativeBottom = rect.bottom;
      }
      if (!Number.isFinite(nativeBottom)) {
        const rect = container.getBoundingClientRect();
        if (!rect.height || rect.width < 2 || rect.height > playerRect.height * 0.6) {
          subsEl.style.bottom = '';
          return;
        }
        nativeBottom = rect.bottom;
      }
      const chromeEl = playerEl.querySelector('.ytp-chrome-bottom');
      const chromeHeight = chromeEl ? chromeEl.getBoundingClientRect().height : 0;
      const minBottom = Math.max(48, chromeHeight) + 6;
      const zhRect = subsEl.getBoundingClientRect();
      const zhHeight = zhRect.height || 24;
      // transform 后的 rect 已经包含当前上移量，先还原成原始底边
      const baseBottom = nativeBottom + currentShift;
      const targetBottom = playerRect.bottom - minBottom - zhHeight - 6;
      let shift = Math.max(0, baseBottom - targetBottom);
      shift = Math.min(shift, Math.round(playerRect.height * 0.35));
      if (Math.abs(shift - currentShift) > 1) {
        playerEl.style.setProperty('--ytbtl-native-shift', Math.round(shift) + 'px');
      }
      // 中文固定在控制栏上方，原生字幕被上移到它上面
      subsEl.style.bottom = Math.round(minBottom) + 'px';
    }

    /** 原生模式依赖 YouTube 自己的 CC 状态，这里不做自动开关，避免误关用户字幕 */

    function updateZhButton() {
      const label = ZH_MODE_LABEL[settings.zhMode] || settings.zhMode;
      zhBtn.dataset.state = settings.zhMode;
      zhBtn.title = '中文字幕：' + label + '（点击切换）';
      zhBtn.setAttribute('aria-label', '中文字幕：' + label + '，点击切换');
    }

    function applySettings() {
      applyCssVars();
      const nativeMode = settings.subtitleMode === 'native';
      subsEl.classList.toggle('ytbtl-align-left', settings.subtitleAlign === 'left');
      subsEl.classList.toggle('ytbtl-no-bg', !settings.subtitleBgEnabled);
      subsEl.classList.toggle('ytbtl-native-mode', nativeMode);
      // 关闭字幕后仍保留右上角工具栏，方便再点开关恢复
      host.style.display = '';
      subsEl.style.display = settings.enabled ? '' : 'none';
      subsSwitchBtn.setAttribute('aria-checked', String(!!settings.enabled));
      subsSwitchBtn.title = settings.enabled ? '关闭字幕（Alt+E）' : '显示字幕（Alt+E）';
      syncNativeCaptions();
      updateZhButton();
      modeBtn.textContent = nativeMode ? '原生' : '覆盖';
      modeBtn.dataset.mode = nativeMode ? 'native' : 'overlay';
      modeBtn.title = nativeMode
        ? '当前：原生英文 + 中文（英文不可点词），点击切回覆盖模式'
        : '当前：覆盖模式（英文可点词），点击切到原生英文 + 中文';
      if (nativeMode && settings.enabled) {
        if (!nativeEnsureAttempted) {
          nativeEnsureAttempted = true;
          try {
            const ccBtn = playerEl.querySelector('.ytp-subtitles-button');
            // 只在明确处于关闭状态时点开，避免把已开启的 CC 误关
            if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
              ccBtn.click();
              root.setTimeout(function () { if (!destroyed) positionNativeLines(); }, 700);
            }
          } catch (e) { /* 忽略 */ }
        }
        updateNativeFallback();
        try { playerEl.classList.add('ytbtl-native-shift'); } catch (e) { /* 忽略 */ }
        positionNativeLines();
        if (!nativePosTimer) nativePosTimer = root.setInterval(positionNativeLines, 500);
      } else {
        nativeEnsureAttempted = false;
        nativeFallbackActive = false;
        nativeMissingTicks = 0;
        nativeLangWarned = false;
        if (nativeRevertTimer) {
          root.clearTimeout(nativeRevertTimer);
          nativeRevertTimer = 0;
        }
        try { subsEl.classList.remove('ytbtl-native-fallback'); } catch (e) { /* 忽略 */ }
        try {
          playerEl.classList.remove('ytbtl-native-shift');
          playerEl.style.removeProperty('--ytbtl-native-shift');
        } catch (e) { /* 忽略 */ }
        if (nativePosTimer) {
          root.clearInterval(nativePosTimer);
          nativePosTimer = 0;
        }
        subsEl.style.bottom = '';
      }
      if (!settings.enabled) {
        hoverInSubs = false;
        hintEl.hidden = true;
        hideWordCard();
      }
      updateZh();
      applyPosition();
      renderStatus();
    }

    /* ---------------------------------------------------------------- *
     * 字幕渲染
     * ---------------------------------------------------------------- */

    function zhText() {
      if (!currentCue) return '';
      const zh = translations[currentCue.index];
      if (zh) return zh;
      if (status.phase === 'translating') return '译…';
      return '';
    }

    function zhShouldShow() {
      if (!settings.enabled || !currentCue) return false;
      // 原生模式下插件只负责中文，默认让中文保持可见（除非用户在「中文字幕」里选隐藏）
      if (settings.subtitleMode === 'native') return settings.zhMode !== 'off';
      if (settings.zhMode === 'on') return true;
      if (settings.zhMode === 'hover') return hoverInSubs || cardOpenNow;
      return false;
    }

    function updateZh() {
      const mode = settings.zhMode;
      const off = !settings.enabled || mode === 'off' || !currentCue;
      subsEl.classList.toggle('ytbtl-reserve-zh', mode === 'hover' && settings.enabled && !!currentCue);
      zhLine.classList.toggle('ytbtl-zh-off', off);
      if (off) {
        zhLine.classList.add('ytbtl-zh-invisible');
        if (zhLine.textContent) zhLine.textContent = '';
        return;
      }
      const text = zhShouldShow() ? zhText() : '';
      if (zhLine.textContent !== text) zhLine.textContent = text;
      zhLine.classList.toggle('ytbtl-zh-invisible', !text);
    }

    function renderCue() {
      clear(enLine);
      clearActiveWord();
      if (!currentCue) {
        updateZh();
        applyPosition();
        return;
      }
      const tokens = C.tokenize(currentCue.text);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.word) {
          const span = el('span', 'ytbtl-word', token.v);
          span.setAttribute('data-raw', token.v);
          enLine.appendChild(span);
        } else {
          enLine.appendChild(playerDocument.createTextNode(token.v));
        }
      }
      updateZh();
      applyPosition();
    }

    /* ---------------------------------------------------------------- *
     * 中文 hover 检测（playerEl mousemove + rAF 节流）
     * ---------------------------------------------------------------- */

    function onPlayerMouseMove(event) {
      if (!settings.enabled) return;
      if (settings.zhMode !== 'hover' && !cardOpenNow) return;
      pendingHoverPoint = { x: event.clientX, y: event.clientY };
      if (hoverRaf) return;
      hoverRaf = root.requestAnimationFrame(function () {
        hoverRaf = 0;
        const point = pendingHoverPoint;
        pendingHoverPoint = null;
        if (!point || destroyed) return;
        const enRect = enLine.getBoundingClientRect();
        const zhRect = zhLine.getBoundingClientRect();
        const inEn = pointInRect(enRect, point.x, point.y, 8);
        const inZh = !zhLine.classList.contains('ytbtl-zh-invisible') && pointInRect(zhRect, point.x, point.y, 8);
        const inSubs = inEn || inZh;
        if (inSubs !== hoverInSubs) {
          hoverInSubs = inSubs;
          updateZh();
        }
      });
    }

    function onPlayerMouseLeave() {
      if (!hoverInSubs) return;
      hoverInSubs = false;
      updateZh();
    }

    /* ---------------------------------------------------------------- *
     * 状态条 / 进度 / 提示
     * ---------------------------------------------------------------- */

    function renderStatus() {
      const phase = status.phase || 'idle';

      const translating = phase === 'translating';
      pill.hidden = !translating;
      if (translating) {
        const done = Number(status.done);
        const total = Number(status.total);
        const hasTotal = Number.isFinite(total) && total > 0;
        const safeDone = Number.isFinite(done) && done >= 0 ? Math.min(done, hasTotal ? total : done) : 0;
        pill.textContent = hasTotal ? safeDone + '/' + total : '翻译中…';
        pill.title = hasTotal ? '字幕翻译进度 ' + safeDone + '/' + total : '正在翻译字幕';
      }

      const isError = phase === 'error' && settings.enabled;
      errbar.hidden = !isError;
      if (isError) {
        errMsg.textContent = String(status.message || '翻译失败，请稍后重试');
        errRetry.hidden = !status.retryable;
        errbar.classList.toggle('is-retryable', !!status.retryable);
      }
      // 错误时右上角工具栏也出现「重试」
      retryBtn.hidden = !isError;

      let hint = '';
      if (settings.enabled) {
        if (phase === 'loading') hint = '正在获取字幕…';
        else if (phase === 'no-captions') hint = '未找到英文字幕，请开启 YouTube CC';
      }
      hintEl.hidden = !hint;
      if (hint) hintEl.textContent = hint;

      domBadge.hidden = !(phase === 'dom' || status.dom === true);

      updateZh();
      applyPosition();
    }

    function flashMessage(text, ms) {
      if (destroyed) return;
      const message = String(text == null ? '' : text);
      if (!message) return;
      toastEl.textContent = message;
      toastEl.classList.add('is-visible');
      if (toastTimer) root.clearTimeout(toastTimer);
      toastTimer = root.setTimeout(function () {
        toastTimer = 0;
        toastEl.classList.remove('is-visible');
      }, Math.max(600, Number(ms) || 1800));
    }

    /* ---------------------------------------------------------------- *
     * 单词卡
     * ---------------------------------------------------------------- */

    function positionCard() {
      if (!cardOpenNow) return;
      const playerRect = playerEl.getBoundingClientRect();
      const cardRect = cardEl.getBoundingClientRect();
      const width = cardRect.width || cardEl.offsetWidth || 340;
      const height = cardRect.height || cardEl.offsetHeight || 180;
      let left = CARD_EDGE_GAP;
      let top = CARD_EDGE_GAP;
      const anchor = cardInfo && cardInfo.anchor;
      if (anchor) {
        left = anchor.x + anchor.width / 2 - width / 2;
        top = anchor.y + anchor.height + 12;
        if (top + height > playerRect.height - CARD_EDGE_GAP) top = anchor.y - height - 12;
      }
      left = clamp(left, CARD_EDGE_GAP, Math.max(CARD_EDGE_GAP, playerRect.width - width - CARD_EDGE_GAP));
      top = clamp(top, CARD_EDGE_GAP, Math.max(CARD_EDGE_GAP, playerRect.height - height - CARD_EDGE_GAP));
      cardEl.style.left = Math.round(left) + 'px';
      cardEl.style.top = Math.round(top) + 'px';
    }

    function refreshCardPosition() {
      positionCard();
      root.requestAnimationFrame(function () {
        if (!destroyed) positionCard();
      });
    }

    function openCardShell() {
      cardEl.hidden = false;
      cardEl.classList.add('is-open');
      cardOpenNow = true;
      updateZh();
    }

    function buildCardWordHead(wordText) {
      const head = el('div', 'ytbtl-card-head');
      head.appendChild(el('span', 'ytbtl-card-word', wordText || '单词'));
      return head;
    }

    function addCardCloseAction() {
      const closeBtn = el('button', 'ytbtl-btn-ghost', '关闭');
      closeBtn.type = 'button';
      closeBtn.title = '关闭单词卡';
      closeBtn.addEventListener('click', function () {
        closeCardByUser();
      });
      cardActions.appendChild(closeBtn);
    }

    function showWordCardLoading(info) {
      if (destroyed) return;
      if (info) cardInfo = info;
      openCardShell();
      clear(cardBody);
      clear(cardActions);
      const wordText = String((cardInfo && cardInfo.word) || '');
      cardBody.appendChild(buildCardWordHead(wordText || '查询中…'));
      const skeleton = el('div', 'ytbtl-card-skeleton');
      skeleton.appendChild(el('div', 'ytbtl-skel ytbtl-skel-w90'));
      skeleton.appendChild(el('div', 'ytbtl-skel ytbtl-skel-w70'));
      skeleton.appendChild(el('div', 'ytbtl-skel ytbtl-skel-w80'));
      skeleton.appendChild(el('div', 'ytbtl-skel ytbtl-skel-w60'));
      cardBody.appendChild(skeleton);
      cardBody.appendChild(el('div', 'ytbtl-card-tip', '正在查询释义…'));
      refreshCardPosition();
    }

    function showWordCard(card, info) {
      if (destroyed) return;
      if (info) cardInfo = info;
      if (!card || typeof card !== 'object') {
        showWordCardError('未获取到释义，请重试', cardInfo);
        return;
      }
      openCardShell();
      clear(cardBody);
      clear(cardActions);

      const wordText = String(card.word || (cardInfo && cardInfo.word) || '');
      const head = buildCardWordHead(wordText);
      const phonetic = normalizePhonetic(card.phonetic);
      const phonEl = el('span', 'ytbtl-card-phon', phonetic ? '/' + phonetic + '/' : '音标暂缺');
      if (!phonetic) phonEl.classList.add('is-empty');
      head.appendChild(phonEl);
      const speakBtn = el('button', 'ytbtl-speak', '🔊');
      speakBtn.type = 'button';
      speakBtn.title = '朗读单词（美式发音）';
      speakBtn.setAttribute('aria-label', '朗读单词');
      speakBtn.addEventListener('click', function () {
        speakWord(wordText || card.lemma || '');
      });
      head.appendChild(speakBtn);
      cardBody.appendChild(head);

      const showZh = settings.showCardChinese !== false;
      const senses = Array.isArray(card.senses) ? card.senses : [];
      const validSenses = senses.filter(function (sense) {
        return sense && (sense.zh || sense.pos || sense.en);
      });
      if (validSenses.length) {
        const list = el('ul', 'ytbtl-card-senses');
        for (let i = 0; i < validSenses.length; i++) {
          const sense = validSenses[i];
          const item = el('li', 'ytbtl-sense');
          if (sense.pos) item.appendChild(el('span', 'ytbtl-pos', String(sense.pos)));
          const body = el('span', 'ytbtl-sense-body');
          if (sense.en) body.appendChild(el('span', 'ytbtl-sense-en', String(sense.en)));
          if (showZh && sense.zh) body.appendChild(el('span', 'ytbtl-sense-zh', String(sense.zh)));
          if (!body.firstChild) continue;
          item.appendChild(body);
          list.appendChild(item);
        }
        cardBody.appendChild(list);
      } else {
        cardBody.appendChild(el('div', 'ytbtl-card-tip', '暂无释义'));
      }

      if (card.example && card.example.en) {
        const example = el('div', 'ytbtl-card-ex');
        example.appendChild(el('div', 'ytbtl-ex-en', String(card.example.en)));
        if (showZh && card.example.zh) example.appendChild(el('div', 'ytbtl-ex-zh', String(card.example.zh)));
        cardBody.appendChild(example);
      }

      const derivatives = Array.isArray(card.derivatives) ? card.derivatives.filter(function (d) { return d && d.word; }) : [];
      if (derivatives.length) {
        const sec = el('div', 'ytbtl-card-sub');
        sec.appendChild(el('div', 'ytbtl-sub-title', '常见派生词'));
        const list = el('ul', 'ytbtl-sub-list');
        for (let i = 0; i < derivatives.length; i++) {
          const item = el('li', 'ytbtl-sub-item');
          item.appendChild(el('span', 'ytbtl-sub-word', String(derivatives[i].word)));
          if (derivatives[i].pos) item.appendChild(el('span', 'ytbtl-pos', String(derivatives[i].pos)));
          if (showZh && derivatives[i].zh) item.appendChild(el('span', 'ytbtl-sub-zh', String(derivatives[i].zh)));
          list.appendChild(item);
        }
        sec.appendChild(list);
        cardBody.appendChild(sec);
      }

      const phrases = Array.isArray(card.phrases) ? card.phrases.filter(function (p) { return p && p.en; }) : [];
      if (phrases.length) {
        const sec = el('div', 'ytbtl-card-sub');
        sec.appendChild(el('div', 'ytbtl-sub-title', '常见短语'));
        const list = el('ul', 'ytbtl-sub-list');
        for (let i = 0; i < phrases.length; i++) {
          const item = el('li', 'ytbtl-sub-item ytbtl-sub-phrase');
          item.appendChild(el('span', 'ytbtl-sub-word', String(phrases[i].en)));
          if (showZh && phrases[i].zh) item.appendChild(el('span', 'ytbtl-sub-zh', String(phrases[i].zh)));
          list.appendChild(item);
        }
        sec.appendChild(list);
        cardBody.appendChild(sec);
      }

      let contextZh = String(card.contextZh || '');
      if (!contextZh && cardInfo && Number.isInteger(cardInfo.cueIndex) && cardInfo.cueIndex >= 0) {
        contextZh = translations[cardInfo.cueIndex] || '';
      }
      const contextEn = String(card.contextEn || '');
      if ((contextEn || contextZh) && settings.showContextZh !== false) {
        const ctx = el('div', 'ytbtl-card-ctx');
        ctx.appendChild(el('span', 'ytbtl-ctx-label', '本句翻译'));
        if (contextEn) ctx.appendChild(el('span', 'ytbtl-ctx-en', contextEn));
        if (contextZh) ctx.appendChild(el('span', 'ytbtl-ctx-text', contextZh));
        cardBody.appendChild(ctx);
      }

      if (card.note && showZh) {
        cardBody.appendChild(el('div', 'ytbtl-card-note', String(card.note)));
      }

      const addBtn = el('button', 'ytbtl-btn-primary', '加入词库');
      addBtn.type = 'button';
      addBtn.title = '把这个单词加入词库';
      addBtn.addEventListener('click', function () {
        call('onWordbookAdd', card);
      });
      cardActions.appendChild(addBtn);
      addCardCloseAction();

      refreshCardPosition();
    }

    function showWordCardError(message, info) {
      if (destroyed) return;
      if (info) cardInfo = info;
      openCardShell();
      clear(cardBody);
      clear(cardActions);
      const wordText = String((cardInfo && cardInfo.word) || '');
      cardBody.appendChild(buildCardWordHead(wordText || '查词'));
      cardBody.appendChild(el('div', 'ytbtl-card-error', String(message || '查词失败，请重试')));
      const retryLookupBtn = el('button', 'ytbtl-btn-primary', '重试');
      retryLookupBtn.type = 'button';
      retryLookupBtn.title = '重新查询这个单词';
      retryLookupBtn.addEventListener('click', function () {
        call('onRetryLookup');
      });
      cardActions.appendChild(retryLookupBtn);
      addCardCloseAction();
      refreshCardPosition();
    }

    function hideWordCard() {
      const wasOpen = cardOpenNow;
      cardOpenNow = false;
      cardInfo = null;
      cardEl.hidden = true;
      cardEl.classList.remove('is-open');
      clear(cardBody);
      clear(cardActions);
      clearActiveWord();
      updateZh();
      return wasOpen;
    }

    function closeCardByUser() {
      if (!cardOpenNow) return;
      hideWordCard();
      call('onCardClose');
    }

    /* ---------------------------------------------------------------- *
     * 交互事件
     * ---------------------------------------------------------------- */

    function onSubtitleClick(event) {
      if (suppressWordClick) return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const span = target.closest('.ytbtl-word');
      if (!span || !currentCue) return;
      event.preventDefault();
      clearActiveWord();
      activeWordEl = span;
      activeWordEl.classList.add('is-active');
      const raw = span.getAttribute('data-raw') || span.textContent || '';
      const rect = span.getBoundingClientRect();
      const playerRect = playerEl.getBoundingClientRect();
      const info = {
        word: C.wordForLookup(raw),
        raw: raw,
        sentence: currentCue.text,
        cueIndex: currentCue.index,
        cue: currentCue,
        anchor: {
          x: rect.left - playerRect.left,
          y: rect.top - playerRect.top,
          width: rect.width,
          height: rect.height,
        },
      };
      call('onWordClick', info);
    }

    function stopInteractivePropagation(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest(INTERACTIVE_SELECTOR)) event.stopPropagation();
    }

    function onPlayerClick() {
      if (cardOpenNow) closeCardByUser();
    }

    function onDocumentKeyDown(event) {
      if (!cardOpenNow) return;
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      event.preventDefault();
      event.stopPropagation();
      closeCardByUser();
    }

    function onFullscreenChange() {
      // 全屏切换时卡片坐标会失效，直接按用户关闭处理（同时让 main 恢复播放）
      if (cardOpenNow) closeCardByUser();
      // 全屏尺寸变化有延迟，稍后再按归一化坐标重新定位字幕
      root.requestAnimationFrame(function () {
        if (!destroyed) applyPosition();
      });
      root.setTimeout(function () {
        if (!destroyed) applyPosition();
      }, 250);
    }

    function onWindowResize() {
      applyPosition();
      if (cardOpenNow) positionCard();
    }

    function cycleZhMode() {
      const index = ZH_MODES.indexOf(settings.zhMode);
      const next = ZH_MODES[(index + 1) % ZH_MODES.length];
      settings = C.normalizeSettings(Object.assign({}, settings, { zhMode: next }));
      applySettings();
      call('onPatch', { zhMode: next });
    }

    function stepEnSize(delta) {
      const next = clamp(settings.enSize + delta, EN_MIN_SIZE, EN_MAX_SIZE);
      if (next === settings.enSize) return;
      settings = C.normalizeSettings(Object.assign({}, settings, { enSize: next }));
      applySettings();
      call('onPatch', { enSize: next });
    }

    zhBtn.addEventListener('click', cycleZhMode);
    modeBtn.addEventListener('click', function () {
      if (!C.NATIVE_MODE_ENABLED) return;
      const next = settings.subtitleMode === 'native' ? 'overlay' : 'native';
      settings = C.normalizeSettings(Object.assign({}, settings, { subtitleMode: next }));
      applySettings();
      call('onPatch', { subtitleMode: next });
      flashMessage(next === 'native' ? '原生英文 + 中文模式（英文不可点词）' : '覆盖模式（英文可点词）', 2000);
    });
    subsSwitchBtn.addEventListener('click', function () {
      const next = !settings.enabled;
      settings = C.normalizeSettings(Object.assign({}, settings, { enabled: next }));
      applySettings();
      call('onPatch', { enabled: next });
      flashMessage(next ? '字幕已开启' : '字幕已关闭 · 点字幕开关或按 Alt+E 恢复', 2200);
    });
    enMinusBtn.addEventListener('click', function () {
      stepEnSize(-2);
    });
    enPlusBtn.addEventListener('click', function () {
      stepEnSize(2);
    });
    gearBtn.addEventListener('click', function () {
      call('onOpenOptions');
    });
    retryBtn.addEventListener('click', function () {
      call('onRetry');
    });
    resetPosBtn.addEventListener('click', function () {
      settings = C.normalizeSettings(Object.assign({}, settings, { subtitlePos: null }));
      applySettings();
      call('onPatch', { subtitlePos: null });
      flashMessage('字幕位置已复位');
    });
    errRetry.addEventListener('click', function () {
      call('onRetry');
    });
    enLine.addEventListener('click', onSubtitleClick);
    subsEl.addEventListener('dragstart', onSubsDragStart);
    cardCloseBtn.addEventListener('click', function () {
      closeCardByUser();
    });

    const PROPAGATION_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart'];
    for (let i = 0; i < PROPAGATION_EVENTS.length; i++) {
      rootEl.addEventListener(PROPAGATION_EVENTS[i], stopInteractivePropagation);
    }

    /* ---------------------------------------------------------------- *
     * 生命周期 / 公开方法
     * ---------------------------------------------------------------- */

    function mount() {
      if (destroyed || mounted) return;
      playerEl.appendChild(host);
      playerEl.addEventListener('mousemove', onPlayerMouseMove);
      playerEl.addEventListener('mouseleave', onPlayerMouseLeave);
      playerEl.addEventListener('click', onPlayerClick);
      playerDocument.addEventListener('keydown', onDocumentKeyDown, true);
      playerDocument.addEventListener('pointerdown', onDocumentPointerDown, true);
      playerDocument.addEventListener('fullscreenchange', onFullscreenChange);
      root.addEventListener('resize', onWindowResize);
      mounted = true;
      applySettings();
      renderStatus();
      renderCue();
    }

    function destroy() {
      if (destroyed) return;
      if (mounted) {
        playerEl.removeEventListener('mousemove', onPlayerMouseMove);
        playerEl.removeEventListener('mouseleave', onPlayerMouseLeave);
        playerEl.removeEventListener('click', onPlayerClick);
        playerDocument.removeEventListener('keydown', onDocumentKeyDown, true);
        playerDocument.removeEventListener('pointerdown', onDocumentPointerDown, true);
        playerDocument.removeEventListener('fullscreenchange', onFullscreenChange);
        root.removeEventListener('resize', onWindowResize);
        mounted = false;
      }
      stopDragListeners();
      dragging = null;
      suppressWordClick = false;
      if (hoverRaf && typeof root.cancelAnimationFrame === 'function') {
        root.cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
      if (nativePosTimer) {
        root.clearInterval(nativePosTimer);
        nativePosTimer = 0;
      }
      if (nativeRevertTimer) {
        root.clearTimeout(nativeRevertTimer);
        nativeRevertTimer = 0;
      }
      if (toastTimer) {
        root.clearTimeout(toastTimer);
        toastTimer = 0;
      }
      hideWordCard();
      try {
        playerEl.classList.remove('ytbtl-hide-native');
      } catch (error) {
        /* 忽略 */
      }
      if (host.parentNode) host.parentNode.removeChild(host);
      cues = [];
      translations = [];
      cueIndex = -1;
      currentCue = null;
      destroyed = true;
    }

    function setCues(nextCues) {
      if (destroyed) return;
      const prevIndex = cueIndex;
      cues = Array.isArray(nextCues) ? nextCues.slice() : [];
      translations = new Array(cues.length).fill('');
      cueIndex = -1;
      currentCue = null;
      // 尽量保留当前字幕位置：DOM 兜底模式会高频重推 cues，
      // 先清空再等下一帧重绘会出现可见的闪白。
      if (prevIndex >= 0 && cues.length) {
        const index = Math.min(prevIndex, cues.length - 1);
        cueIndex = index;
        currentCue = cues[index];
      }
      renderCue();
    }

    function setTranslations(list) {
      if (destroyed) return;
      const next = new Array(cues.length).fill('');
      if (Array.isArray(list)) {
        const count = Math.min(cues.length, list.length);
        for (let i = 0; i < count; i++) {
          next[i] = list[i] == null ? '' : String(list[i]);
        }
      }
      translations = next;
      updateZh();
      applyPosition();
    }

    function setSettings(nextSettings) {
      if (destroyed) return;
      settings = C.normalizeSettings(nextSettings || {});
      applySettings();
    }

    function setStatus(nextStatus) {
      if (destroyed) return;
      const input = nextStatus && typeof nextStatus === 'object' ? nextStatus : {};
      const phase = String(input.phase || 'idle');
      status = Object.assign({ phase: 'idle' }, input, { phase: phase });
      renderStatus();
    }

    function tick(currentTime) {
      if (destroyed) return;
      const time = Number(currentTime);
      if (!Number.isFinite(time)) return;
      if (!cues.length) return;
      let nextIndex = -1;
      try {
        nextIndex = C.findCueIndex(cues, time);
      } catch (error) {
        nextIndex = -1;
      }
      if (nextIndex === cueIndex) return;
      cueIndex = nextIndex;
      currentCue = nextIndex >= 0 ? cues[nextIndex] : null;
      renderCue();
    }

    function isCardOpen() {
      return cardOpenNow;
    }

    function isEnabled() {
      return !!settings.enabled;
    }

    return {
      mount: mount,
      destroy: destroy,
      setCues: setCues,
      setTranslations: setTranslations,
      setSettings: setSettings,
      setStatus: setStatus,
      tick: tick,
      showWordCardLoading: showWordCardLoading,
      showWordCard: showWordCard,
      showWordCardError: showWordCardError,
      hideWordCard: hideWordCard,
      isCardOpen: isCardOpen,
      flashMessage: flashMessage,
      isEnabled: isEnabled,
    };
  }

  return {
    createOverlay: createOverlay,
    version: VERSION,
  };
});
