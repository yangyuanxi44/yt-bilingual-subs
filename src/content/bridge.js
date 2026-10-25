/*!
 * YT 双语字幕 · 点词查意 — MAIN world bridge
 * 运行在页面上下文（document_start, world:MAIN）：
 *  - 读取 #movie_player.getPlayerResponse() 里的字幕轨；
 *  - 在页面上下文请求 timedtext（带 Cookie，避免 403）；
 *  - 监听 SPA 导航，主动推送 tracks-updated。
 * 协议：window.postMessage({__ytbtl:1, dir}, '*')
 * 容错原则：任何异常都返回空结果，绝不向页面抛未捕获异常。
 */
(function () {
  'use strict';

  if (window.__YTBTL_BRIDGE__) return;
  window.__YTBTL_BRIDGE__ = { version: 1, injectedAt: Date.now() };

  const PROTOCOL = 1;
  const MAX_BODY_BYTES = 8 * 1024 * 1024; // timedtext 响应上限 ~8MB
  const WAIT_RESPONSE_MS = 1600;          // getTracks 等待 playerResponse 的上限（content 侧 2s 超时）
  const TIMEDTEXT_TIMEOUT_MS = 20000;
  const POLL_NAV_MS = 1000;
  const ALLOWED_HOST_SUFFIXES = [
    'youtube.com',
    'youtube-nocookie.com',
    'googlevideo.com',
    'ytimg.com',
    'googleusercontent.com',
  ];

  let cachedResponse = null;   // hook fetch 捕到的最新 playerResponse
  let lastVideoId = '';
  let pushTimer = null;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function post(type, payload, id) {
    const message = { __ytbtl: PROTOCOL, dir: 'to-content', type: type, payload: payload };
    if (id !== undefined && id !== null) message.id = id;
    try { window.postMessage(message, '*'); } catch (e) { /* 忽略 */ }
  }

  function readVideoId() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      if (url.pathname.indexOf('/live/') === 0) return url.pathname.split('/')[2] || '';
      if (url.pathname.indexOf('/embed/') === 0) return url.pathname.split('/')[2] || '';
      return '';
    } catch (e) {
      return '';
    }
  }

  function readDomTitle() {
    try {
      const title = String(document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim();
      if (title) return title;
      const meta = document.querySelector('meta[property="og:title"]');
      return meta && meta.content ? String(meta.content) : '';
    } catch (e) {
      return '';
    }
  }

  function readDomDuration() {
    try {
      const video = document.querySelector('video');
      const duration = video && Number(video.duration);
      return Number.isFinite(duration) && duration > 0 ? duration : 0;
    } catch (e) {
      return 0;
    }
  }

  function getPlayer() {
    try {
      return document.getElementById('movie_player')
        || document.querySelector('#movie_player')
        || document.querySelector('.html5-video-player')
        || null;
    } catch (e) {
      return null;
    }
  }

  function isResponse(pr) {
    return !!(pr && typeof pr === 'object' && pr.videoDetails && typeof pr.videoDetails === 'object');
  }

  function matchesCurrentVideo(pr) {
    if (!isResponse(pr)) return false;
    const current = readVideoId();
    if (!current) return true;
    const id = pr.videoDetails && pr.videoDetails.videoId;
    return !id || String(id) === current;
  }

  function readName(name) {
    if (!name) return '';
    if (typeof name === 'string') return name;
    if (typeof name.simpleText === 'string') return name.simpleText;
    if (Array.isArray(name.runs)) {
      return name.runs.map(function (run) { return run && typeof run.text === 'string' ? run.text : ''; }).join('');
    }
    return '';
  }

  /** playerResponse → {videoId, title, duration, tracks[]} */
  function tracksFromResponse(pr) {
    const details = (pr && pr.videoDetails) || {};
    const out = {
      videoId: String(details.videoId || ''),
      title: String(details.title || ''),
      duration: Number(details.lengthSeconds) || 0,
      tracks: [],
    };
    const renderer = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const list = renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];
    for (const track of list) {
      if (!track) continue;
      const languageCode = String(track.languageCode || '');
      if (!languageCode) continue;
      out.tracks.push({
        languageCode: languageCode,
        kind: String(track.kind || ''),
        name: readName(track.name),
        baseUrl: String(track.baseUrl || track.url || ''),
        vssId: String(track.vssId || ''),
      });
    }
    return out;
  }

  function emptyPayload() {
    return { videoId: readVideoId(), title: readDomTitle(), duration: readDomDuration(), tracks: [] };
  }

  /* ------------------------------------------------------------------ *
   * 获取 playerResponse：player API → hook 缓存 → ytInitialPlayerResponse
   * ------------------------------------------------------------------ */

  function readPlayerResponse() {
    const player = getPlayer();
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const pr = player.getPlayerResponse();
        if (matchesCurrentVideo(pr)) {
          cachedResponse = pr;
          return pr;
        }
      } catch (e) { /* player 可能尚未初始化 */ }
    }
    if (matchesCurrentVideo(cachedResponse)) return cachedResponse;
    if (matchesCurrentVideo(window.ytInitialPlayerResponse)) return window.ytInitialPlayerResponse;
    return null;
  }

  /** 轮询等待 playerResponse（player 未就绪 / fetch hook 稍后才有数据） */
  function waitForResponse(timeoutMs) {
    return new Promise(function (resolve) {
      const started = Date.now();
      (function poll() {
        const pr = readPlayerResponse();
        if (pr) { resolve(pr); return; }
        if (Date.now() - started >= timeoutMs) { resolve(null); return; }
        setTimeout(poll, 120);
      })();
    });
  }

  function capturePlayerResponse(data) {
    try {
      if (!data || typeof data !== 'object') return;
      const pr = data.playerResponse;
      if (!matchesCurrentVideo(pr)) return; // 忽略 YouTube 预取的其他视频
      cachedResponse = pr;
    } catch (e) { /* 忽略 */ }
  }

  function hookFetch() {
    try {
      const original = window.fetch;
      if (typeof original !== 'function' || original.__ytbtlHooked) return;
      const wrapped = function (input, init) {
        const promise = original.apply(window, arguments);
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url && /\/youtubei\/v1\/(player|next)\b/.test(url)) {
            promise.then(function (res) {
              try {
                if (!res || !res.ok) return;
                res.clone().json().then(capturePlayerResponse).catch(function () { /* 忽略非 JSON */ });
              } catch (e) { /* 忽略 */ }
            }).catch(function () { /* 忽略页面自身失败 */ });
          }
        } catch (e) { /* 忽略 */ }
        return promise;
      };
      wrapped.__ytbtlHooked = true;
      try { window.fetch = wrapped; } catch (e) { /* 某些页面锁定 fetch 时放弃 hook */ }
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ *
   * 消息处理
   * ------------------------------------------------------------------ */

  async function handleGetTracks(id) {
    let pr = readPlayerResponse();
    if (!pr) pr = await waitForResponse(WAIT_RESPONSE_MS);
    let payload;
    try {
      payload = pr ? tracksFromResponse(pr) : emptyPayload();
    } catch (e) {
      payload = emptyPayload();
    }
    if (!payload.videoId) payload.videoId = readVideoId();
    if (!payload.title) payload.title = readDomTitle();
    if (!payload.duration) payload.duration = readDomDuration();
    lastVideoId = payload.videoId || lastVideoId;
    post('tracks', payload, id);
  }

  async function handleGetVideoInfo(id) {
    let pr = readPlayerResponse();
    if (!pr) pr = await waitForResponse(WAIT_RESPONSE_MS);
    let info;
    try {
      const data = pr ? tracksFromResponse(pr) : emptyPayload();
      info = { videoId: data.videoId, title: data.title, duration: data.duration };
    } catch (e) {
      info = { videoId: readVideoId(), title: readDomTitle(), duration: readDomDuration() };
    }
    if (!info.videoId) info.videoId = readVideoId();
    if (!info.title) info.title = readDomTitle();
    post('videoInfo', info, id);
  }

  function isAllowedHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some(function (suffix) {
      return host === suffix || host.endsWith('.' + suffix);
    });
  }

  /** 校验并规范化 timedtext URL：只允许 YouTube 系域名；fmt 统一为 json3（覆盖已有 fmt） */
  function normalizeTimedtextUrl(raw) {
    try {
      const url = new URL(String(raw || ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (!isAllowedHost(url.hostname)) return null;
      url.searchParams.set('fmt', 'json3');
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  async function handleFetchTimedtext(id, rawUrl) {
    const url = normalizeTimedtextUrl(rawUrl);
    if (!url) {
      post('timedtext', { ok: false, status: 0, error: '不允许的字幕地址' }, id);
      return;
    }
    let controller = null;
    let timer = null;
    try {
      controller = typeof AbortController === 'function' ? new AbortController() : null;
    } catch (e) {
      controller = null;
    }
    if (controller) {
      timer = setTimeout(function () {
        try { controller.abort(); } catch (e) { /* 忽略 */ }
      }, TIMEDTEXT_TIMEOUT_MS);
    }
    try {
      const response = await window.fetch(url, {
        credentials: 'include',
        signal: controller ? controller.signal : undefined,
      });
      const status = Number(response && response.status) || 0;
      if (!response || !response.ok) {
        post('timedtext', { ok: false, status: status, error: '字幕接口返回 HTTP ' + status }, id);
        return;
      }
      let declaredLength = 0;
      try {
        declaredLength = Number(response.headers && response.headers.get('content-length')) || 0;
      } catch (e) {
        declaredLength = 0;
      }
      if (declaredLength > MAX_BODY_BYTES) {
        post('timedtext', { ok: false, status: status, error: '字幕内容超过 8MB 限制' }, id);
        return;
      }
      const body = await response.text();
      if (body.length > MAX_BODY_BYTES) {
        post('timedtext', { ok: false, status: status, error: '字幕内容超过 8MB 限制' }, id);
        return;
      }
      post('timedtext', { ok: true, status: status, body: body }, id);
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      post('timedtext', { ok: false, status: 0, error: aborted ? '字幕请求超时' : '字幕请求失败' }, id);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__ytbtl !== PROTOCOL || data.dir !== 'to-page') return;
      const id = data.id;
      if (data.type === 'getTracks') {
        handleGetTracks(id).catch(function () { post('tracks', emptyPayload(), id); });
      } else if (data.type === 'fetchTimedtext') {
        handleFetchTimedtext(id, data.url).catch(function () {
          post('timedtext', { ok: false, status: 0, error: '字幕请求失败' }, id);
        });
      } else if (data.type === 'getVideoInfo') {
        handleGetVideoInfo(id).catch(function () {
          post('videoInfo', { videoId: readVideoId(), title: readDomTitle(), duration: 0 }, id);
        });
      }
    } catch (e) { /* 绝不抛未捕获异常 */ }
  });

  /* ------------------------------------------------------------------ *
   * SPA 导航
   * ------------------------------------------------------------------ */

  function sendTracksUpdated() {
    (async function () {
      let payload;
      try {
        let pr = readPlayerResponse();
        if (!pr) pr = await waitForResponse(1200);
        payload = pr ? tracksFromResponse(pr) : emptyPayload();
      } catch (e) {
        payload = emptyPayload();
      }
      if (!payload.videoId) payload.videoId = readVideoId();
      if (!payload.title) payload.title = readDomTitle();
      lastVideoId = payload.videoId || lastVideoId;
      post('tracks-updated', { videoId: payload.videoId, title: payload.title, tracks: payload.tracks });
    })().catch(function () { /* 忽略 */ });
  }

  function schedulePush(delayMs) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      try { sendTracksUpdated(); } catch (e) { /* 忽略 */ }
    }, Math.max(0, delayMs || 0));
  }

  function checkNavigation() {
    try {
      const currentId = readVideoId();
      if (currentId && currentId !== lastVideoId) {
        lastVideoId = currentId;
        cachedResponse = null; // 旧视频的 playerResponse 作废
        schedulePush(400);
      }
    } catch (e) { /* 忽略 */ }
  }

  try {
    document.addEventListener('yt-navigate-finish', function () {
      try {
        const currentId = readVideoId();
        if (currentId !== lastVideoId) {
          lastVideoId = currentId;
          cachedResponse = null;
        }
        schedulePush(500);
      } catch (e) { /* 忽略 */ }
    });
    document.addEventListener('yt-page-data-updated', function () {
      try { schedulePush(700); } catch (e) { /* 忽略 */ }
    });
  } catch (e) { /* 忽略 */ }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  try {
    hookFetch();
    lastVideoId = readVideoId();
    setInterval(checkNavigation, POLL_NAV_MS);
    post('ready', { videoId: lastVideoId, version: 1 });
  } catch (e) {
    try { post('ready', { videoId: '', version: 1 }); } catch (e2) { /* 忽略 */ }
  }
})();
