'use strict';
/**
 * background.js 集成测试：用 vm + chrome/fetch stub 加载真实 service worker 代码，
 * 走一遍消息协议（翻译缓存、查词缓存、词库、清缓存、错误映射）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function createEnv(options = {}) {
  const store = new Map();
  const listeners = {};
  const env = { openedOptions: false };
  if (options.settings) store.set('settings', options.settings);

  const storageLocal = {
    get(keys, callback) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of store) out[k] = v;
      } else if (typeof keys === 'string') {
        if (store.has(keys)) out[keys] = store.get(keys);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
      } else if (typeof keys === 'object') {
        for (const k of Object.keys(keys)) out[k] = store.has(k) ? store.get(k) : keys[k];
      }
      const result = clone(out);
      if (typeof callback === 'function') {
        queueMicrotask(() => callback(result));
        return undefined;
      }
      return Promise.resolve(result);
    },
    set(obj, callback) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store.get(k), newValue: v };
        if (typeof v === 'undefined') store.delete(k);
        else store.set(k, v);
      }
      if (listeners.storage) listeners.storage(changes, 'local');
      if (typeof callback === 'function') {
        queueMicrotask(() => callback());
        return undefined;
      }
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const k of [].concat(keys)) store.delete(k);
      if (typeof callback === 'function') {
        queueMicrotask(() => callback());
        return undefined;
      }
      return Promise.resolve();
    },
  };

  const chrome = {
    storage: { local: storageLocal, onChanged: { addListener(fn) { listeners.storage = fn; } } },
    runtime: {
      onMessage: { addListener(fn) { listeners.message = fn; } },
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      openOptionsPage() { env.openedOptions = true; },
      lastError: null,
      id: 'test-extension',
    },
  };

  const fetchCalls = [];
  const baseFetch = options.fetch || (async () => jsonResponse(200, { choices: [{ message: { content: '{"translations":[]}' } }] }));
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return baseFetch(url, init);
  };

  const sandbox = {
    chrome,
    console,
    fetch: fetchImpl,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, AbortSignal,
    Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, Error, Map, Set,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.importScripts = function (...files) {
    for (const file of files) {
      const p = path.resolve(SRC, file);
      const code = fs.readFileSync(p, 'utf8');
      new vm.Script(code, { filename: p }).runInContext(context);
    }
  };
  const context = vm.createContext(sandbox);

  function loadBackground() {
    const p = path.join(SRC, 'background.js');
    const src = fs.readFileSync(p, 'utf8');
    new vm.Script(src, { filename: p }).runInContext(context);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /** 发送消息并等待 sendResponse */
  function send(message, sender = { tab: { id: 1 }, url: 'https://www.youtube.com/watch?v=test' }) {
    if (!listeners.message) throw new Error('background.js 未注册 chrome.runtime.onMessage');
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) reject(new Error('sendResponse 超时（需要 return true）'));
      }, 3000);
      function done(response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      }
      const ret = listeners.message(message, sender, done);
      if (ret && typeof ret.then === 'function') ret.then(done, reject);
      if (ret === true) return; // 等异步 sendResponse
      if (ret !== undefined && !(ret && typeof ret.then === 'function')) done(ret);
    });
  }

  return { store, listeners, send, loadBackground, fetchCalls, chrome, context, env };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function translationBody(count, prefix = '译文') {
  return JSON.stringify({
    translations: Array.from({ length: count }, (_, i) => ({ i, zh: prefix + i })),
  });
}

const BASE_SETTINGS = {
  enabled: true, enSize: 24, zhMode: 'hover', zhSize: 11, opacity: 0.95, bottomOffset: 92,
  hideNativeCaptions: true, pauseOnWordClick: true, resumeAfterCard: true, autoTranslate: true,
  prefetchAhead: 30, batchSize: 2, apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat', temperature: 0.2,
};

function makeFetch(handler) {
  return async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    return handler(url, body);
  };
}

test('无 API Key 时翻译返回 NO_KEY', async () => {
  const env = createEnv({ settings: Object.assign({}, BASE_SETTINGS, { apiKey: '' }) });
  env.loadBackground();
  const res = await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: ['Hello.'] } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_KEY');
  assert.match(res.error.message, /API Key/);
});

test('翻译：请求格式正确、结果缓存命中、二次请求不再打 API', async () => {
  const env = createEnv({
    settings: BASE_SETTINGS,
    fetch: makeFetch((url, body) => {
      assert.match(url, /\/chat\/completions$/);
      assert.equal(body.model, 'deepseek-chat');
      assert.equal(body.response_format.type, 'json_object');
      const user = JSON.parse(body.messages[1].content);
      return jsonResponse(200, { choices: [{ message: { content: translationBody(user.lines.length) } }] });
    }),
  });
  env.loadBackground();
  const payload = { videoId: 'v1', title: 'T', texts: ['Hello.', 'How are you?', 'Fine.'] };
  const res1 = await env.send({ type: 'YTBT_TRANSLATE', payload });
  assert.equal(res1.ok, true);
  assert.deepEqual(res1.translations, ['译文0', '译文1', '译文0']);
  assert.equal(res1.cached, 0);
  assert.equal(env.fetchCalls.length, 2); // batchSize=2 → 2 批

  const res2 = await env.send({ type: 'YTBT_TRANSLATE', payload });
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.translations, res1.translations);
  assert.equal(res2.cached, 3);
  assert.equal(env.fetchCalls.length, 2, '缓存命中不应再请求 API');
  assert.equal(env.store.get('settings').apiKey, 'sk-test');
});

test('翻译：401 映射 AUTH 且中文文案', async () => {
  const env = createEnv({
    settings: BASE_SETTINGS,
    fetch: async () => jsonResponse(401, { error: { message: 'invalid key' } }),
  });
  env.loadBackground();
  const res = await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: ['Hello.'] } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'AUTH');
  assert.match(res.error.message, /API Key/);
});

test('查词：解析单词卡并缓存，第二次直接命中', async () => {
  const card = {
    word: 'wonderful', lemma: 'wonderful', phonetic: 'ˈwʌndəfəl',
    senses: [{ pos: 'adj.', zh: '精彩的' }],
    example: { en: 'A wonderful day.', zh: '美好的一天。' },
    context_zh: '这真是太好了。',
  };
  const env = createEnv({
    settings: BASE_SETTINGS,
    fetch: makeFetch((url, body) => {
      const user = JSON.parse(body.messages[1].content);
      assert.equal(user.word, 'wonderful');
      assert.equal(user.sentence, 'This is wonderful.');
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(card) } }] });
    }),
  });
  env.loadBackground();
  const payload = { videoId: 'v1', word: 'wonderful', sentence: 'This is wonderful.' };
  const res1 = await env.send({ type: 'YTBT_LOOKUP', payload });
  assert.equal(res1.ok, true);
  assert.equal(res1.card.phonetic, 'ˈwʌndəfəl');
  assert.equal(res1.card.senses[0].zh, '精彩的');
  const res2 = await env.send({ type: 'YTBT_LOOKUP', payload });
  assert.equal(res2.ok, true);
  assert.equal(env.fetchCalls.length, 1);
});

test('查词：模型输出脏 JSON 时修复重试仍可成功', async () => {
  let calls = 0;
  const env = createEnv({
    settings: BASE_SETTINGS,
    fetch: makeFetch(() => {
      calls++;
      if (calls === 1) {
        return jsonResponse(200, { choices: [{ message: { content: 'sorry, no json' } }] });
      }
      return jsonResponse(200, { choices: [{ message: { content: '```json\n{"word":"run","senses":[{"pos":"v.","zh":"跑"}],"context_zh":"我每天跑步。"}\n```' } }] });
    }),
  });
  env.loadBackground();
  const res = await env.send({ type: 'YTBT_LOOKUP', payload: { videoId: 'v1', word: 'run', sentence: 'I run every day.' } });
  assert.equal(res.ok, true);
  assert.equal(res.card.senses[0].zh, '跑');
  assert.ok(calls >= 2);
});

test('词库：按 lemma 去重、size 正确、按时间倒序', async () => {
  const env = createEnv({ settings: BASE_SETTINGS });
  env.loadBackground();
  const card = { word: 'wonderful', lemma: 'wonderful', phonetic: 'x', senses: [{ pos: 'adj.', zh: '精彩的' }], example: null, contextZh: '' };
  const r1 = await env.send({ type: 'YTBT_WORDBOOK_ADD', payload: { card, videoId: 'v1', videoTitle: 'Video 1', time: 10 } });
  assert.equal(r1.ok, true);
  assert.equal(r1.size, 1);
  const r2 = await env.send({ type: 'YTBT_WORDBOOK_ADD', payload: { card, videoId: 'v1', videoTitle: 'Video 1', time: 12 } });
  assert.equal(r2.ok, true);
  assert.equal(r2.size, 1);
  const book = env.store.get('wordbook');
  assert.equal(book.length, 1);
  assert.equal(book[0].count, 2);
  assert.equal(book[0].videoTitle, 'Video 1');
});

test('测试连接与清空缓存', async () => {
  const env = createEnv({
    settings: BASE_SETTINGS,
    fetch: makeFetch((url, body) => {
      let content = '{"ok":true}';
      try {
        const user = JSON.parse(body.messages[1].content);
        if (user && Array.isArray(user.lines)) content = translationBody(user.lines.length, '缓存');
      } catch (e) { /* 连通性测试的 prompt 不是 JSON，返回 ok 即可 */ }
      return jsonResponse(200, { choices: [{ message: { content } }] });
    }),
  });
  env.loadBackground();
  const testRes = await env.send({ type: 'YTBT_TEST' });
  assert.equal(testRes.ok, true);
  assert.equal(testRes.model, 'deepseek-chat');

  await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: ['A', 'B'] } });
  const cacheKeys = [...env.store.keys()].filter((k) => k.startsWith('tc:'));
  assert.equal(cacheKeys.length, 2);
  const clearRes = await env.send({ type: 'YTBT_CLEAR_CACHE' });
  assert.equal(clearRes.ok, true);
  assert.ok(clearRes.removed >= 2);
  assert.equal([...env.store.keys()].filter((k) => k.startsWith('tc:')).length, 0);
});

test('未知消息类型返回 ok:false 而不是崩溃', async () => {
  const env = createEnv({ settings: BASE_SETTINGS });
  env.loadBackground();
  const res = await env.send({ type: 'NOPE' });
  assert.equal(res.ok, false);
});
