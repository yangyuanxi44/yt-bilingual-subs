'use strict';
/**
 * src/background.js 冒烟测试：用 vm + chrome/fetch 桩加载 service worker，验证消息路由。
 * 覆盖：YTBT_TRANSLATE 缓存命中/未命中/分批、YTBT_LOOKUP 缓存、YTBT_WORDBOOK_ADD 去重、
 *       YTBT_CLEAR_CACHE、YTBT_TEST、无 Key、未知消息、onInstalled。
 * 运行：node --test test/background.smoke.test.js（不访问真实网络）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BG_PATH = path.join(ROOT, 'src', 'background.js');

/* ------------------------------------------------------------------ *
 * 桩环境
 * ------------------------------------------------------------------ */

function createEnv(options) {
  const opts = options || {};
  const store = Object.assign({}, opts.store || {});
  const calls = { fetch: [], openOptionsPage: 0 };
  const listeners = { message: [], storage: [], installed: [] };
  const fetchImpl = opts.fetch || async function () { throw new Error('测试未提供 fetch'); };

  function later(cb, value) {
    if (typeof cb === 'function') setTimeout(function () { cb(value); }, 0);
  }

  const chromeStub = {
    runtime: {
      lastError: null,
      onMessage: { addListener: function (fn) { listeners.message.push(fn); } },
      onInstalled: { addListener: function (fn) { listeners.installed.push(fn); } },
      openOptionsPage: function () { calls.openOptionsPage++; },
    },
    storage: {
      local: {
        get: function (keys, cb) {
          let out = {};
          if (keys == null) out = Object.assign({}, store);
          else if (typeof keys === 'string') { if (keys in store) out[keys] = store[keys]; }
          else if (Array.isArray(keys)) keys.forEach(function (k) { if (k in store) out[k] = store[k]; });
          else if (typeof keys === 'object') Object.keys(keys).forEach(function (k) { out[k] = k in store ? store[k] : keys[k]; });
          later(cb, out);
        },
        set: function (items, cb) {
          const changes = {};
          Object.keys(items).forEach(function (key) {
            changes[key] = { oldValue: store[key], newValue: items[key] };
            store[key] = items[key];
          });
          later(cb);
          listeners.storage.forEach(function (fn) { setTimeout(function () { fn(changes, 'local'); }, 0); });
        },
        remove: function (keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (key) { delete store[key]; });
          later(cb);
        },
      },
      onChanged: { addListener: function (fn) { listeners.storage.push(fn); } },
    },
  };

  const context = vm.createContext({
    chrome: chromeStub,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    fetch: fetchImpl,
  });
  context.self = context;
  context.importScripts = function () {
    for (let i = 0; i < arguments.length; i++) {
      const file = path.join(ROOT, 'src', String(arguments[i]));
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(BG_PATH, 'utf8'), context, { filename: BG_PATH });

  /** 发送一条消息并等待 sendResponse */
  function send(message) {
    return new Promise(function (resolve) {
      if (!listeners.message.length) { resolve(undefined); return; }
      for (let i = 0; i < listeners.message.length; i++) {
        const ret = listeners.message[i](message, { id: 'test' }, function (response) { resolve(response); });
        if (ret === true) return;
      }
      resolve(undefined);
    });
  }

  return { context: context, store: store, calls: calls, listeners: listeners, send: send };
}

/** 模拟 DeepSeek：根据请求内容返回翻译 / 查词卡 / 连通性结果 */
function makeFetch() {
  const calls = [];
  async function fetchImpl(url, init) {
    const payload = JSON.parse(init.body);
    calls.push({ url: url, payload: payload });
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const joined = messages.map(function (m) { return String(m.content || ''); }).join('\n');
    let content;
    if (/连通性测试/.test(joined)) {
      content = '{"ok":true}';
    } else if (joined.indexOf('translate_subtitles') >= 0) {
      const data = JSON.parse(messages[1].content);
      content = JSON.stringify({
        translations: data.lines.map(function (line) { return { i: line.i, zh: '译:' + line.en }; }),
      });
    } else {
      const data = JSON.parse(messages[1].content);
      content = JSON.stringify({
        word: data.word,
        lemma: String(data.word).toLowerCase(),
        phonetic: 'ˈtest',
        senses: [{ pos: 'n.', zh: '测试' }],
        example: { en: 'A test.', zh: '一次测试。' },
        context_zh: '这是测试。',
        note: '',
      });
    }
    return {
      ok: true,
      status: 200,
      text: async function () {
        return JSON.stringify({ choices: [{ message: { role: 'assistant', content: content } }] });
      },
    };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const SETTINGS = { apiKey: 'sk-test-key', model: 'deepseek-chat', batchSize: 2 };

/* ------------------------------------------------------------------ *
 * 翻译缓存
 * ------------------------------------------------------------------ */

test('background：YTBT_TRANSLATE 未命中写缓存，二次命中不再请求', async function () {
  const fetchImpl = makeFetch();
  const env = createEnv({ store: { settings: SETTINGS }, fetch: fetchImpl });

  const first = await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: ['Hello', 'World'] } });
  assert.equal(first.ok, true);
  assert.deepEqual(first.translations, ['译:Hello', '译:World']);
  assert.equal(first.cached, 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/chat/completions');

  const cacheKeys = Object.keys(env.store).filter(function (k) { return k.indexOf('tc:') === 0; });
  assert.equal(cacheKeys.length, 2);
  cacheKeys.forEach(function (key) {
    assert.equal(typeof env.store[key].v, 'string');
    assert.equal(typeof env.store[key].t, 'number');
  });

  const second = await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: ['Hello', 'World'] } });
  assert.equal(second.ok, true);
  assert.deepEqual(second.translations, ['译:Hello', '译:World']);
  assert.equal(second.cached, 2);
  assert.equal(fetchImpl.calls.length, 1, '命中缓存后不应再请求 DeepSeek');
});

test('background：YTBT_TRANSLATE 按 batchSize 分批（并发≤2）并保持顺序', async function () {
  const fetchImpl = makeFetch();
  const env = createEnv({ store: { settings: SETTINGS }, fetch: fetchImpl });
  const texts = ['a', 'b', 'c', 'd', 'e'];
  const res = await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: texts } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.translations, texts.map(function (t) { return '译:' + t; }));
  assert.equal(fetchImpl.calls.length, 3, '5 句 / 每批 2 句 = 3 批');
  fetchImpl.calls.forEach(function (call) {
    const lines = JSON.parse(call.payload.messages[1].content).lines;
    assert.ok(lines.length >= 1 && lines.length <= 2);
    assert.deepEqual(call.payload.response_format, { type: 'json_object' });
  });
});

test('background：YTBT_TRANSLATE 无 API Key → ok:false / NO_KEY，且不请求网络', async function () {
  const fetchImpl = makeFetch();
  const env = createEnv({ store: { settings: { model: 'deepseek-chat' } }, fetch: fetchImpl });
  const res = await env.send({ type: 'YTBT_TRANSLATE', payload: { videoId: 'v1', texts: ['Hello'] } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_KEY');
  assert.ok(res.error.message.length > 0);
  assert.equal(fetchImpl.calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 查词缓存
 * ------------------------------------------------------------------ */

test('background：YTBT_LOOKUP 未命中请求并写缓存，二次命中返回 cached', async function () {
  const fetchImpl = makeFetch();
  const env = createEnv({ store: { settings: SETTINGS }, fetch: fetchImpl });

  const first = await env.send({
    type: 'YTBT_LOOKUP',
    payload: { videoId: 'v1', title: 't', word: 'wonder', sentence: 'I wonder why.', cueTime: 12.5 },
  });
  assert.equal(first.ok, true);
  assert.equal(first.card.word, 'wonder');
  assert.equal(first.card.phonetic, 'ˈtest');
  assert.deepEqual(first.card.senses, [{ pos: 'n.', en: '', zh: '测试' }]);
  assert.equal(first.cached, false);
  assert.equal(fetchImpl.calls.length, 1);

  const wcKeys = Object.keys(env.store).filter(function (k) { return k.indexOf('wc:') === 0; });
  assert.equal(wcKeys.length, 1);
  assert.equal(env.store[wcKeys[0]].v.word, 'wonder');

  const second = await env.send({
    type: 'YTBT_LOOKUP',
    payload: { videoId: 'v1', title: 't', word: 'wonder', sentence: 'I wonder why.', cueTime: 12.5 },
  });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.card.word, 'wonder');
  assert.equal(fetchImpl.calls.length, 1);
});

test('background：YTBT_LOOKUP 空单词 → ok:false / BAD_RESPONSE', async function () {
  const env = createEnv({ store: { settings: SETTINGS }, fetch: makeFetch() });
  const res = await env.send({ type: 'YTBT_LOOKUP', payload: { word: '   ' } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'BAD_RESPONSE');
});

/* ------------------------------------------------------------------ *
 * 词库
 * ------------------------------------------------------------------ */

test('background：YTBT_WORDBOOK_ADD 新增 / 同 lemma 去重 count++', async function () {
  const env = createEnv({ store: { settings: SETTINGS }, fetch: makeFetch() });
  const card = {
    word: 'Wonder',
    lemma: 'wonder',
    phonetic: 'ˈwʌndər',
    senses: [{ pos: 'v.', zh: '想知道' }],
    example: { en: 'I wonder.', zh: '我想知道。' },
    contextZh: '我想知道为什么。',
    note: '常接从句',
  };

  const first = await env.send({
    type: 'YTBT_WORDBOOK_ADD',
    payload: { card: card, videoId: 'v1', videoTitle: '视频一', time: 12.3 },
  });
  assert.equal(first.ok, true);
  assert.equal(first.size, 1);
  assert.equal(env.store.wordbook.length, 1);
  assert.equal(env.store.wordbook[0].count, 1);
  assert.equal(env.store.wordbook[0].videoTitle, '视频一');
  assert.equal(env.store.wordbook[0].time, 12.3);
  assert.equal(typeof env.store.wordbook[0].createdAt, 'number');

  const second = await env.send({
    type: 'YTBT_WORDBOOK_ADD',
    payload: { card: Object.assign({}, card, { word: 'wonder' }), videoId: 'v2', videoTitle: '视频二', time: 30 },
  });
  assert.equal(second.ok, true);
  assert.equal(second.size, 1);
  assert.equal(env.store.wordbook.length, 1);
  assert.equal(env.store.wordbook[0].count, 2);
  assert.equal(env.store.wordbook[0].videoTitle, '视频二');
});

test('background：YTBT_WORDBOOK_ADD 空卡片 → ok:false', async function () {
  const env = createEnv({ store: { settings: SETTINGS }, fetch: makeFetch() });
  const res = await env.send({ type: 'YTBT_WORDBOOK_ADD', payload: { card: null } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'BAD_RESPONSE');
});

/* ------------------------------------------------------------------ *
 * 缓存清理 / 测试连接 / 未知消息
 * ------------------------------------------------------------------ */

test('background：YTBT_CLEAR_CACHE 删除 tc:/wc:，保留其它数据', async function () {
  const env = createEnv({
    store: {
      settings: SETTINGS,
      wordbook: [{ word: 'keep', lemma: 'keep' }],
      'tc:abc': { v: '你好', t: 1 },
      'wc:def': { v: { word: 'x' }, t: 2 },
    },
    fetch: makeFetch(),
  });
  const res = await env.send({ type: 'YTBT_CLEAR_CACHE' });
  assert.equal(res.ok, true);
  assert.equal(res.removed, 2);
  assert.equal(env.store['tc:abc'], undefined);
  assert.equal(env.store['wc:def'], undefined);
  assert.ok(Array.isArray(env.store.wordbook));
});

test('background：YTBT_TEST 成功返回模型与延迟', async function () {
  const env = createEnv({ store: { settings: SETTINGS }, fetch: makeFetch() });
  const res = await env.send({ type: 'YTBT_TEST' });
  assert.equal(res.ok, true);
  assert.equal(res.model, 'deepseek-chat');
  assert.equal(typeof res.latencyMs, 'number');
});

test('background：YTBT_TEST 无 Key → ok:false / NO_KEY（不抛异常）', async function () {
  const env = createEnv({ store: { settings: {} }, fetch: makeFetch() });
  const res = await env.send({ type: 'YTBT_TEST' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_KEY');
});

test('background：未知消息类型返回中文错误而不是崩溃', async function () {
  const env = createEnv({ store: { settings: SETTINGS }, fetch: makeFetch() });
  const res = await env.send({ type: 'YTBT_NOT_EXIST' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UNKNOWN_MESSAGE');
  assert.ok(res.error.message.indexOf('未知') >= 0);
});

test('background：onInstalled(install) 打开设置页', async function () {
  const env = createEnv({ store: { settings: SETTINGS }, fetch: makeFetch() });
  env.listeners.installed.forEach(function (fn) { fn({ reason: 'install' }); });
  assert.equal(env.calls.openOptionsPage, 1);
  env.listeners.installed.forEach(function (fn) { fn({ reason: 'update' }); });
  assert.equal(env.calls.openOptionsPage, 1);
});

test('background：storage.settings 变化后重建 client（新 Key 立即生效）', async function () {
  const env = createEnv({ store: { settings: { model: 'deepseek-chat' } }, fetch: makeFetch() });
  const before = await env.send({ type: 'YTBT_TRANSLATE', payload: { texts: ['Hello'] } });
  assert.equal(before.ok, false);
  assert.equal(before.error.code, 'NO_KEY');

  env.store.settings = { apiKey: 'sk-new', model: 'deepseek-chat' };
  env.listeners.storage.forEach(function (fn) {
    fn({ settings: { oldValue: { model: 'deepseek-chat' }, newValue: env.store.settings } }, 'local');
  });
  const after = await env.send({ type: 'YTBT_TRANSLATE', payload: { texts: ['Hello'] } });
  assert.equal(after.ok, true);
  assert.deepEqual(after.translations, ['译:Hello']);
});
