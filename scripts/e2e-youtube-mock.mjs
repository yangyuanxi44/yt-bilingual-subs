#!/usr/bin/env node
/**
 * 端到端联动测试（真实浏览器 + 假 YouTube 页面 + mock DeepSeek API）：
 *  1. --load-extension 加载扩展；
 *  2. 用 CDP Fetch 拦截 https://www.youtube.com/watch?v=... 返回假播放器页面，
 *     页面暴露 #movie_player.getPlayerResponse() 与 /api/timedtext JSON3；
 *  3. 拦截 api.deepseek.com 的 /chat/completions 返回 mock 翻译/词典；
 *  4. 断言：bridge 注入 → 字幕轨解析 → 双语渲染（中文来自 background 翻译）→ 点词卡片 → Esc 关闭 →
 *     原生字幕隐藏 class / 翻译缓存写入 storage。
 *
 * 用法：node scripts/e2e-youtube-mock.mjs   （BROWSER=... 指定浏览器，HEADFUL=1 可视化）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 9412;
const headful = process.env.HEADFUL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO_ID = 'E2ETEST123';

const candidates = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('✗ 未找到 Edge/Chrome，可用 BROWSER 环境变量指定');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'ytbtl-e2e-'));
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--autoplay-policy=no-user-gesture-required',
  `--disable-extensions-except=${root}`,
  `--load-extension=${root}`,
  'about:blank',
];
if (!headful) args.unshift('--headless=new', '--disable-gpu');
const browser = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
browser.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

let failures = 0;
const ok = (m) => console.log('✓ ' + m);
const bad = (m) => { failures++; console.error('✗ ' + m); };

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock Video - YouTube</title>
<style>html,body{margin:0;background:#0b0d10;color:#fff;font-family:sans-serif}#movie_player{position:relative;width:960px;height:540px;margin:24px auto;background:#000}video{width:100%;height:100%}</style>
</head><body>
<div id="movie_player" class="html5-video-player">
  <video muted playsinline></video>
  <div class="ytp-caption-window-container"><div class="ytp-caption-window"><span class="ytp-caption-segment">native caption</span></div></div>
</div>
<script>
  var player = document.getElementById('movie_player');
  player.getPlayerResponse = function () {
    return {
      videoDetails: { videoId: '${VIDEO_ID}', title: 'Mock English Learning Video', lengthSeconds: 43 },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        languageCode: 'en', kind: '', name: { simpleText: 'English' },
        baseUrl: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en',
        vssId: '.en'
      }] } }
    };
  };
  var v = document.querySelector('video');
  try { Object.defineProperty(v, 'currentTime', { get: function () { return 0.6; }, set: function () {} }); } catch (e) {}
</script>
</body></html>`;

const TIMEDTEXT = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Welcome back to the channel.' }] },
    { tStartMs: 2500, dDurationMs: 2500, segs: [{ utf8: 'This channel shares short travel films.' }] },
    { tStartMs: 5000, dDurationMs: 3000, segs: [{ utf8: 'Subscribe for more videos.' }] },
  ],
});

function apiReply(bodyText) {
  let body = {};
  try { body = JSON.parse(bodyText || '{}'); } catch (e) { body = {}; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = messages.length > 1 ? String(messages[1].content || '') : '';
  let user = {};
  try { user = JSON.parse(userText); } catch (e) { user = {}; }
  let content;
  if (Array.isArray(user.lines)) {
    content = JSON.stringify({ translations: user.lines.map((line, i) => ({ i, zh: '【译】' + String(line.en || '').slice(0, 12) })) });
  } else if (user.word) {
    content = JSON.stringify({
      word: user.word,
      lemma: user.word.toLowerCase(),
      phonetic: 'ˈmɒk',
      senses: [{ pos: 'n.', en: 'a mock English definition', zh: '测试释义（mock）' }],
      example: { en: 'This is a mock word.', zh: '这是一个测试单词。' },
      derivatives: [{ word: 'mockable', pos: 'adj.', zh: '可测试的' }],
      phrases: [{ en: 'mock test', zh: '模拟测试' }],
      context_en: 'This is a mock English paraphrase of the sentence.',
      context_zh: '【译】欢迎回到本频道。',
    });
  } else {
    content = '{"ok":true}';
  }
  return JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content } }] });
}

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map(); }
  static connect(url) {
    return new Promise((resolveConn, reject) => {
      const ws = new WebSocket(url);
      const client = new CDP(ws);
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.id && client.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = client.pending.get(msg.id);
          client.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'CDP 错误'));
          else res(msg.result);
          return;
        }
        for (const fn of client.handlers.get(msg.method) || []) {
          try { fn(msg.params); } catch (e) { /* 忽略 */ }
        }
      });
      ws.addEventListener('open', () => resolveConn(client));
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || '页面执行异常');
    return res.result ? res.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

async function waitJson(path, timeoutMs, predicate) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (res.ok) {
        const data = await res.json();
        if (!predicate || predicate(data)) return data;
      }
    } catch (e) { /* 浏览器还没起来 */ }
    await sleep(300);
  }
  throw new Error(`等待 ${path} 超时`);
}

function fulfill(cdp, requestId, contentType, text) {
  return cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: Buffer.from(text, 'utf8').toString('base64'),
  }).catch(() => { /* 请求可能已取消 */ });
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms） last=${last && last.message ? last.message : ''}`);
}

(async () => {
  try {
    await waitJson('/json/version', 25000);
    ok(`浏览器已启动：${exe.split('\\').pop()}（headless=${!headful}）`);

    const version = await waitJson('/json/version', 5000);
    const browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
    let extensionId = '';
    await waitFor(async () => {
      const targets = await browserCdp.send('Target.getTargets');
      const sw = targets.targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
      if (sw) { extensionId = new URL(sw.url).host; return true; }
      return false;
    }, 15000, '扩展 service worker');
    ok(`扩展已加载 ID=${extensionId}`);

    // 1) 先通过 options 页写入设置（mock Key + 中文字幕常显 + 小批量预翻译）
    const { targetId: optionsTargetId } = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/src/options/options.html` });
    const optionsInfo = await waitFor(async () => {
      const list = await waitJson('/json/list', 3000);
      return list.find((t) => t.id === optionsTargetId && t.webSocketDebuggerUrl) || null;
    }, 10000, 'options 页');
    const optionsCdp = await CDP.connect(optionsInfo.webSocketDebuggerUrl);
    await optionsCdp.send('Runtime.enable');
    await optionsCdp.eval(`new Promise((resolve) => chrome.storage.local.set({ settings: {
      enabled: true, enSize: 26, zhMode: 'on', zhSize: 12, opacity: 0.95, bottomOffset: 92,
      hideNativeCaptions: true, pauseOnWordClick: true, resumeAfterCard: true,
      autoTranslate: true, prefetchAhead: 3, batchSize: 3,
      apiKey: 'sk-mock-e2e', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.2
    } }, () => resolve(true)))`);
    // 触发一次后台消息，确保 SW 已启动
    await optionsCdp.eval(`new Promise((r) => chrome.runtime.sendMessage({ type: 'YTBT_TEST' }, () => { void chrome.runtime.lastError; r(true); }))`);
    ok('已写入 mock 设置并唤醒 background');

    // 2) 拦截 background 的 DeepSeek 请求（SW 目标单独启用 Fetch）
    let swCdp = null;
    for (let i = 0; i < 20 && !swCdp; i++) {
      const list = await waitJson('/json/list', 3000);
      const swInfo = list.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/src/background.js`);
      if (swInfo) swCdp = await CDP.connect(swInfo.webSocketDebuggerUrl);
      else await sleep(300);
    }
    if (!swCdp) throw new Error('background service worker 不可用');
    await swCdp.send('Runtime.enable');
    await swCdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api.deepseek.com*', requestStage: 'Request' }] });
    swCdp.on('Fetch.requestPaused', (params) => {
      const url = params.request && params.request.url || '';
      if (/\/chat\/completions/.test(url)) {
        fulfill(swCdp, params.requestId, 'application/json', apiReply(params.request.postData || ''));
      } else {
        swCdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      }
    });
    ok('已拦截 background 的 DeepSeek 请求（mock /chat/completions）');

    // 3) 打开假 YouTube watch 页并拦截页面请求
    const pageUrl = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
    const pageInfo = await waitFor(async () => {
      const list = await waitJson('/json/list', 3000);
      return list.find((t) => t.id === targetId && t.webSocketDebuggerUrl) || null;
    }, 10000, '测试页面');
    const pageCdp = await CDP.connect(pageInfo.webSocketDebuggerUrl);
    const pageExceptions = [];
    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Page.enable');
    await pageCdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await pageCdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://www.youtube.com/*', requestStage: 'Request' },
        { urlPattern: 'https://api.deepseek.com/*', requestStage: 'Request' },
      ],
    });
    pageCdp.on('Runtime.exceptionThrown', (p) => pageExceptions.push(p.exceptionDetails && p.exceptionDetails.text));
    pageCdp.on('Fetch.requestPaused', (params) => {
      const url = params.request && params.request.url || '';
      if (url.includes('/watch')) {
        fulfill(pageCdp, params.requestId, 'text/html; charset=utf-8', HTML);
      } else if (url.includes('/api/timedtext')) {
        fulfill(pageCdp, params.requestId, 'application/json; charset=utf-8', TIMEDTEXT);
      } else if (url.includes('api.deepseek.com')) {
        fulfill(pageCdp, params.requestId, 'application/json', apiReply(params.request.postData || ''));
      } else {
        pageCdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      }
    });
    await pageCdp.send('Page.navigate', { url: pageUrl });
    ok('已打开假 YouTube 页面（拦截 document / timedtext）');

    // 4) 断言：bridge → 字幕 → 中文 → 点词
    const probe = `(() => {
      const host = document.querySelector('#movie_player [data-ytbtl-ui="1"]');
      const shadow = host && host.shadowRoot;
      const text = (sel) => { const n = shadow && shadow.querySelector(sel); return n ? n.textContent : ''; };
      return {
        host: !!host,
        shadow: !!shadow,
        stylesheet: !!(shadow && shadow.querySelector('link[data-ytbtl-style]')),
        en: text('.ytbtl-line-en'),
        zh: text('.ytbtl-line-zh'),
        words: shadow ? shadow.querySelectorAll('.ytbtl-word').length : 0,
        toolbar: shadow ? shadow.querySelectorAll('.ytbtl-btn').length : 0,
        nativeHidden: document.getElementById('movie_player').classList.contains('ytbtl-hide-native'),
        cardOpen: shadow ? !shadow.querySelector('.ytbtl-card').hidden : false,
        cardText: text('.ytbtl-card'),
        status: text('.ytbtl-errbar'),
        enFontSize: shadow && shadow.querySelector('.ytbtl-line-en') ? getComputedStyle(shadow.querySelector('.ytbtl-line-en')).fontSize : '',
        align: shadow && shadow.querySelector('.ytbtl-subs') ? getComputedStyle(shadow.querySelector('.ytbtl-subs')).alignItems : '',
        videoPaused: document.querySelector('video').paused
      };
    })()`;

    const state = await waitFor(async () => {
      const r = await pageCdp.eval(probe);
      return r.host && r.en && /Welcome/.test(r.en) && r.zh && /译/.test(r.zh) ? r : null;
    }, 20000, '字幕渲染 + 中文翻译');
    ok(`bridge/字幕渲染正常：英文「${state.en.slice(0, 40)}…」，中文「${state.zh}」`);
    ok(`逐词 span=${state.words}，工具栏按钮=${state.toolbar}，样式表已加载=${state.stylesheet}`);
    if (state.enFontSize !== '26px') bad(`styles.css 未生效：英文 computed font-size=${state.enFontSize}（期望 26px）`);
    else ok('styles.css 生效（英文 computed font-size=26px）');
    if (state.align !== 'flex-start') bad(`默认字幕对齐不是左对齐：${state.align}`);
    else ok('默认字幕左对齐生效');

    // 原生模式暂时关闭：按钮应隐藏、设置页不渲染该项
    const modeHidden = await pageCdp.eval(`(() => {
      const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      const btn = s.querySelector('.ytbtl-btn-mode');
      return !!btn && btn.hidden;
    })()`);
    if (!modeHidden) bad('原生模式应暂时关闭（按钮未隐藏）');
    else ok('原生模式已暂时关闭（代码保留，UI 隐藏）');
    // 工具栏「字幕」总开关：关闭后字幕隐藏、工具栏保留、原生字幕仍隐藏；再点恢复
    const toggleOff = await pageCdp.eval(`(() => {
      const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      s.querySelector('.ytbtl-subs-switch').click();
      return true;
    })()`);
    await sleep(400);
    const offState = await pageCdp.eval(`(() => {
      const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      return {
        subsDisplay: getComputedStyle(s.querySelector('.ytbtl-subs')).display,
        toolbarDisplay: getComputedStyle(s.querySelector('.ytbtl-toolbar')).display,
        checked: s.querySelector('.ytbtl-subs-switch').getAttribute('aria-checked'),
        nativeHidden: document.getElementById('movie_player').classList.contains('ytbtl-hide-native'),
        toolbarVisible: s.querySelector('.ytbtl-subs-switch').getClientRects().length > 0,
      };
    })()`);
    if (offState.subsDisplay !== 'none' || offState.checked !== 'false') bad(`字幕总开关关闭无效：${JSON.stringify(offState)}`);
    else if (!offState.toolbarVisible || offState.toolbarDisplay === 'none') bad('关闭字幕后工具栏不应消失（否则无法恢复）');
    else if (offState.nativeHidden) bad('关闭插件字幕后应恢复 YouTube 原生字幕');
    else ok('字幕总开关：关闭后插件字幕隐藏、工具栏保留、原生字幕恢复');
    await pageCdp.eval(`(() => {
      const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      s.querySelector('.ytbtl-subs-switch').click();
      return true;
    })()`);
    await sleep(400);
    const onState = await pageCdp.eval(`(() => {
      const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      return { subsDisplay: getComputedStyle(s.querySelector('.ytbtl-subs')).display, checked: s.querySelector('.ytbtl-subs-switch').getAttribute('aria-checked'), nativeHidden: document.getElementById('movie_player').classList.contains('ytbtl-hide-native') };
    })()`);
    if (onState.subsDisplay === 'none' || onState.checked !== 'true') bad('字幕总开关无法恢复');
    else if (!onState.nativeHidden) bad('重新开启插件字幕后应再次隐藏原生字幕');
    else ok('字幕总开关：再次点击恢复插件字幕（并重新隐藏原生字幕）');

    // 拖动字幕块 → 位置持久化 → 工具栏 ⌖ 复位
    const before = await pageCdp.eval(`(() => {
      const shadow = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      const r = shadow.querySelector('.ytbtl-line-en').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top };
    })()`);
    await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + i * 15, y: before.y - i * 9, button: 'left', buttons: 1 });
      await sleep(20);
    }
    await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 120, y: before.y - 72, button: 'left', clickCount: 1 });
    await sleep(700);
    const dragResult = await pageCdp.eval(`(() => {
      const shadow = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      const subs = shadow.querySelector('.ytbtl-subs');
      const r = shadow.querySelector('.ytbtl-line-en').getBoundingClientRect();
      return {
        custom: subs.classList.contains('ytbtl-custom-pos'),
        left: r.left, top: r.top,
        styleLeft: subs.style.left, styleTop: subs.style.top,
        resetVisible: !shadow.querySelector('.ytbtl-btn-reset-pos').hidden,
        cardOpen: !shadow.querySelector('.ytbtl-card').hidden
      };
    })()`);
    if (!dragResult.custom || !dragResult.styleLeft) bad('拖动字幕未生效');
    else if (Math.abs(dragResult.left - before.left) < 30) bad('拖动后字幕位置没有明显变化');
    else ok(`字幕拖动生效：left/top=${dragResult.styleLeft}/${dragResult.styleTop}，复位按钮已出现`);
    if (dragResult.cardOpen) bad('拖动结束误触发了查词卡片');
    else ok('拖动不会误触发查词');
    const posSettings = await waitFor(async () => {
      const v = await optionsCdp.eval(`new Promise((r) => chrome.storage.local.get('settings', (x) => r(x && x.settings ? x.settings.subtitlePos : null)))`);
      return v && typeof v.x === 'number' ? v : null;
    }, 5000, '字幕位置写入设置');
    ok(`字幕位置已持久化：x=${posSettings.x.toFixed(3)}, y=${posSettings.y.toFixed(3)}`);
    await pageCdp.eval(`(() => { const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot; s.querySelector('.ytbtl-btn-reset-pos').click(); return true; })()`);
    await waitFor(async () => {
      const r = await pageCdp.eval(`(() => {
        const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
        return { custom: s.querySelector('.ytbtl-subs').classList.contains('ytbtl-custom-pos'), resetHidden: s.querySelector('.ytbtl-btn-reset-pos').hidden };
      })()`);
      return (!r.custom && r.resetHidden) ? r : null;
    }, 5000, '字幕位置复位');
    ok('工具栏 ⌖ 复位字幕位置成功');

    // 点击单词 → 卡片
    const clicked = await pageCdp.eval(`(() => {
      const shadow = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      const w = shadow.querySelector('.ytbtl-word');
      w.click();
      return w.textContent;
    })()`);
    const cardState = await waitFor(async () => {
      const r = await pageCdp.eval(probe);
      return r.cardOpen && /测试释义/.test(r.cardText) ? r : null;
    }, 15000, '单词卡');
    ok(`点击「${clicked}」→ 单词卡：${cardState.cardText.replace(/\s+/g, ' ').slice(0, 60)}…`);
    if (!/a mock English definition/.test(cardState.cardText)) bad('单词卡缺少英英释义');
    else if (cardState.cardText.indexOf('a mock English definition') > cardState.cardText.indexOf('测试释义')) bad('英英释义应显示在中文释义上方');
    else ok('单词卡显示英英释义（在中文释义上方）');
    if (!/可测试的/.test(cardState.cardText)) bad('单词卡缺少常见派生词');
    else ok('单词卡显示常见派生词');
    if (!/模拟测试/.test(cardState.cardText)) bad('单词卡缺少常见短语');
    else ok('单词卡显示常见短语');
    if (!/This is a mock English paraphrase/.test(cardState.cardText)) bad('单词卡缺少本句英英释义');
    else if (cardState.cardText.indexOf('This is a mock English paraphrase') > cardState.cardText.indexOf('【译】欢迎回到本频道')) bad('本句英英释义应显示在中文翻译上方');
    else ok('本句英英释义显示在中文翻译上方');

    // 加入词库 → background 写入 storage
    await pageCdp.eval(`(() => {
      const s = document.querySelector('#movie_player [data-ytbtl-ui="1"]').shadowRoot;
      const btn = s.querySelector('.ytbtl-btn-primary');
      if (btn) btn.click();
      return !!btn;
    })()`);
    const bookSize = await waitFor(async () => {
      const n = await optionsCdp.eval(`new Promise((r) => chrome.storage.local.get('wordbook', (v) => r((v && v.wordbook ? v.wordbook.length : 0))))`);
      return n > 0 ? n : null;
    }, 8000, '词库写入');
    ok(`加入词库成功（storage.wordbook = ${bookSize} 个）`);

    // Esc 关闭卡片
    await pageCdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(async () => {
      const r = await pageCdp.eval(probe);
      return r.cardOpen === false ? r : null;
    }, 5000, '卡片关闭');
    ok('Esc 关闭单词卡');

    // 翻译缓存写入 storage
    const cacheKeys = await optionsCdp.eval(`new Promise((r) => chrome.storage.local.get(null, (v) => r(Object.keys(v || {}).filter((k) => k.indexOf('tc:') === 0))))`);
    if (cacheKeys.length > 0) ok(`翻译缓存已写入 storage（${cacheKeys.length} 条 tc:）`);
    else bad('未发现翻译缓存 tc: 键');

    if (pageExceptions.length) bad('页面存在 JS 异常：' + pageExceptions.slice(0, 3).join(' | '));
    else ok('页面无 JS 异常');

    if (failures) throw new Error(`${failures} 项检查失败`);
    console.log('\n✓ 端到端联动测试通过');
  } catch (err) {
    console.error('\n✗ ' + (err && err.message ? err.message : err));
    if (stderr) console.error('浏览器 stderr（截断）：\n' + stderr.slice(-2500));
    failures++;
  } finally {
    try { browser.kill(); } catch (e) { /* 忽略 */ }
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(failures ? 1 : 0);
  }
})();
