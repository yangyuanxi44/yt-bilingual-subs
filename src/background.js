/*!
 * YT 双语字幕 · 点词查意 — background service worker
 * 职责：消息路由、DeepSeek 客户端生命周期、翻译/查词缓存、词库、测试连接。
 * 经典脚本：importScripts 加载 lib/core.js 与 lib/translate.js。
 */
importScripts('lib/core.js', 'lib/translate.js');

(function () {
  'use strict';

  const core = self.YTBTL;
  const DS = self.YTBTL_DS;

  const TRANSLATE_CACHE_PREFIX = 'tc:';
  const LOOKUP_CACHE_PREFIX = 'wc:';
  const CACHE_LIMIT = 5000;      // 缓存条目上限
  const CACHE_TRIM = 1000;       // 超限时删除最旧条目数
  const WORDBOOK_LIMIT = 2000;   // 词库上限
  const TRANSLATE_CONCURRENCY = 2;
  const CLEANUP_DELAY_MS = 1500;

  let settings = core.normalizeSettings(null);
  let client = null;
  let settingsLoaded = false;
  let settingsPromise = null;
  let cleanupTimer = null;

  /* ------------------------------------------------------------------ *
   * storage 包装（callback → Promise）
   * ------------------------------------------------------------------ */

  function storageGet(keys) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.get(keys, function (items) {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(items || {});
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function storageSet(items) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.set(items, function () {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function storageRemove(keys) {
    if (!keys || !keys.length) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.remove(keys, function () {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 设置与 client
   * ------------------------------------------------------------------ */

  function buildClient() {
    client = settings.apiKey
      ? DS.createClient({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        temperature: settings.temperature,
      })
      : null;
    return client;
  }

  function loadSettings() {
    if (settingsLoaded) return Promise.resolve(settings);
    if (!settingsPromise) {
      settingsPromise = storageGet('settings').then(function (items) {
        settings = core.normalizeSettings(items && items.settings);
        settingsLoaded = true;
        settingsPromise = null;
        buildClient();
        return settings;
      }).catch(function () {
        settingsLoaded = true;
        settingsPromise = null;
        buildClient();
        return settings;
      });
    }
    return settingsPromise;
  }

  function requireClient() {
    if (!client) throw new DS.DSClientError(DS.errorMessage('NO_KEY'), 'NO_KEY');
    return client;
  }

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes || !changes.settings) return;
    settings = core.normalizeSettings(changes.settings.newValue);
    settingsLoaded = true;
    settingsPromise = null;
    buildClient();
  });

  /* ------------------------------------------------------------------ *
   * 工具：并发限制 / 缓存清理
   * ------------------------------------------------------------------ */

  async function mapLimit(items, limit, fn) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return;
    const size = Math.min(Math.max(1, limit), list.length);
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < size; w++) {
      workers.push((async function () {
        while (true) {
          const index = cursor++;
          if (index >= list.length) return;
          await fn(list[index], index);
        }
      })());
    }
    await Promise.all(workers);
  }

  function cacheEntry(value) {
    return { v: value, t: Date.now() };
  }

  function isCacheKey(key) {
    return String(key).indexOf(TRANSLATE_CACHE_PREFIX) === 0 || String(key).indexOf(LOOKUP_CACHE_PREFIX) === 0;
  }

  function scheduleCleanup() {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(function () {
      cleanupTimer = null;
      cleanupCaches().catch(function () { /* 清理失败不影响主流程 */ });
    }, CLEANUP_DELAY_MS);
  }

  async function cleanupCaches() {
    const all = await storageGet(null);
    const entries = [];
    Object.keys(all || {}).forEach(function (key) {
      if (!isCacheKey(key)) return;
      const rec = all[key];
      entries.push({ key: key, t: rec && typeof rec.t === 'number' ? rec.t : 0 });
    });
    if (entries.length <= CACHE_LIMIT) return;
    entries.sort(function (a, b) { return a.t - b.t; });
    const removeKeys = entries.slice(0, CACHE_TRIM).map(function (e) { return e.key; });
    await storageRemove(removeKeys);
  }

  /* ------------------------------------------------------------------ *
   * YTBT_TRANSLATE
   * ------------------------------------------------------------------ */

  async function handleTranslate(payload) {
    const texts = Array.isArray(payload.texts)
      ? payload.texts.map(function (t) { return String(t == null ? '' : t); })
      : [];
    if (!texts.length) return { ok: true, translations: [], cached: 0 };

    const model = settings.model;
    const keys = texts.map(function (text) {
      return text ? TRANSLATE_CACHE_PREFIX + core.cacheKey(text, model) : null;
    });

    // 1) 批量读缓存（按 key 去重）
    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
    const cachedMap = Object.create(null);
    if (uniqueKeys.length) {
      const items = await storageGet(uniqueKeys);
      uniqueKeys.forEach(function (key) {
        const hit = items[key];
        if (hit && typeof hit.v === 'string' && hit.v) cachedMap[key] = hit.v;
      });
    }

    // 2) 收集未命中的唯一文本（保持顺序）
    const missText = new Map();
    texts.forEach(function (text, index) {
      if (!text) return;
      const key = keys[index];
      if (cachedMap[key]) return;
      if (!missText.has(key)) missText.set(key, text);
    });
    const missKeys = Array.from(missText.keys());
    const hitCount = texts.reduce(function (n, text, index) {
      return n + (text && cachedMap[keys[index]] ? 1 : 0);
    }, 0);

    if (!missKeys.length) {
      return {
        ok: true,
        translations: texts.map(function (text, index) {
          return text ? cachedMap[keys[index]] || '' : '';
        }),
        cached: hitCount,
      };
    }

    // 3) 分批 + 并发 2 请求 DeepSeek
    const active = requireClient();
    const batches = core.chunk(missKeys, Math.max(1, settings.batchSize));
    const fetched = Object.create(null);
    let firstError = null;
    let successBatches = 0;

    await mapLimit(batches, TRANSLATE_CONCURRENCY, async function (keyBatch) {
      try {
        const sourceTexts = keyBatch.map(function (key) { return missText.get(key); });
        const zhList = await active.translate(sourceTexts);
        successBatches++;
        keyBatch.forEach(function (key, index) {
          const zh = zhList[index];
          if (typeof zh === 'string' && zh) fetched[key] = zh;
        });
      } catch (err) {
        if (!firstError) firstError = err;
      }
    });

    if (!successBatches) {
      if (firstError) throw firstError;
      throw new DS.DSClientError(DS.errorMessage('BAD_RESPONSE'), 'BAD_RESPONSE');
    }

    // 4) 写回缓存
    const cacheItems = {};
    let wrote = 0;
    Object.keys(fetched).forEach(function (key) {
      cacheItems[key] = cacheEntry(fetched[key]);
      wrote++;
    });
    if (wrote) {
      storageSet(cacheItems).catch(function () { /* 缓存写入失败可忽略 */ });
      scheduleCleanup();
    }

    return {
      ok: true,
      translations: texts.map(function (text, index) {
        if (!text) return '';
        const key = keys[index];
        return cachedMap[key] || fetched[key] || '';
      }),
      cached: hitCount,
    };
  }

  /* ------------------------------------------------------------------ *
   * YTBT_LOOKUP
   * ------------------------------------------------------------------ */

  async function handleLookup(payload) {
    const word = String(payload.word == null ? '' : payload.word).trim();
    if (!word) throw new DS.DSClientError('查词失败：单词为空', 'BAD_RESPONSE');
    const sentence = String(payload.sentence == null ? '' : payload.sentence);
    // 缓存版本号 v3：单词卡新增英英释义/派生词/短语，旧缓存不再命中
    const key = LOOKUP_CACHE_PREFIX + core.hashString(word + '|' + sentence + '|' + settings.model + '|v3');

    const items = await storageGet(key);
    const hit = items[key];
    if (hit && hit.v && typeof hit.v === 'object') {
      return { ok: true, card: hit.v, cached: true };
    }

    const active = requireClient();
    const card = await active.lookup(word, sentence);
    const cacheItems = {};
    cacheItems[key] = cacheEntry(card);
    storageSet(cacheItems).catch(function () { /* 缓存写入失败可忽略 */ });
    scheduleCleanup();
    return { ok: true, card: card, cached: false };
  }

  /* ------------------------------------------------------------------ *
   * YTBT_WORDBOOK_ADD
   * ------------------------------------------------------------------ */

  function normalizeCardEntry(card, payload) {
    const word = String(card.word || card.lemma || '').trim();
    return {
      word: word,
      lemma: String(card.lemma || word),
      phonetic: String(card.phonetic || ''),
      senses: Array.isArray(card.senses) ? card.senses.slice(0, 4).map(function (s) {
        return { pos: String((s && s.pos) || ''), zh: String((s && s.zh) || '') };
      }) : [],
      example: card.example && typeof card.example === 'object'
        ? { en: String(card.example.en || ''), zh: String(card.example.zh || '') }
        : null,
      contextZh: String(card.contextZh || ''),
      note: String(card.note || ''),
      videoId: String(payload.videoId || ''),
      videoTitle: String(payload.videoTitle || ''),
      time: Number(payload.time) || 0,
      createdAt: Date.now(),
      count: 1,
    };
  }

  async function handleWordbookAdd(payload) {
    const card = payload.card;
    if (!card || typeof card !== 'object') {
      throw new DS.DSClientError('加入词库失败：单词卡为空', 'BAD_RESPONSE');
    }
    const word = String(card.word || card.lemma || '').trim();
    if (!word) throw new DS.DSClientError('加入词库失败：单词为空', 'BAD_RESPONSE');

    const items = await storageGet('wordbook');
    let list = Array.isArray(items.wordbook) ? items.wordbook.slice() : [];
    const entry = normalizeCardEntry(card, payload);
    const lemmaKey = core.normalizeWordKey(entry.lemma || entry.word);
    let index = -1;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it && core.normalizeWordKey(it.lemma || it.word) === lemmaKey) { index = i; break; }
    }

    if (index >= 0) {
      const prev = list[index] || {};
      const merged = Object.assign({}, prev, entry, {
        count: Math.max(1, Number(prev.count) || 1) + 1,
        createdAt: Date.now(),
      });
      list.splice(index, 1);
      list.unshift(merged);
    } else {
      list.unshift(entry);
      if (list.length > WORDBOOK_LIMIT) list = list.slice(0, WORDBOOK_LIMIT);
    }

    await storageSet({ wordbook: list });
    return { ok: true, size: list.length };
  }

  /* ------------------------------------------------------------------ *
   * YTBT_TEST / YTBT_CLEAR_CACHE
   * ------------------------------------------------------------------ */

  async function handleTest() {
    const active = requireClient();
    const result = await active.test();
    if (result && result.ok) {
      return { ok: true, model: result.model || settings.model, latencyMs: result.latencyMs || 0 };
    }
    const rawError = (result && result.error) || null;
    return {
      ok: false,
      model: (result && result.model) || settings.model,
      error: {
        code: (rawError && rawError.code) || 'BAD_RESPONSE',
        message: (rawError && rawError.message) || '连通性测试失败，请检查 API Key 与网络',
      },
    };
  }

  async function handleClearCache() {
    const all = await storageGet(null);
    const keys = Object.keys(all || {}).filter(isCacheKey);
    if (keys.length) await storageRemove(keys);
    return { ok: true, removed: keys.length };
  }

  /** 内容脚本工具栏齿轮：打开设置页（content script 不能直接 openOptionsPage） */
  async function handleOpenOptions() {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      throw new DS.DSClientError('无法打开设置页，请从扩展菜单进入', 'BAD_RESPONSE');
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 消息路由
   * ------------------------------------------------------------------ */

  const HANDLERS = {
    YTBT_TRANSLATE: handleTranslate,
    YTBT_LOOKUP: handleLookup,
    YTBT_WORDBOOK_ADD: handleWordbookAdd,
    YTBT_TEST: handleTest,
    YTBT_CLEAR_CACHE: handleClearCache,
    YTBT_OPEN_OPTIONS: handleOpenOptions,
  };

  async function dispatch(msg) {
    if (!msg || typeof msg.type !== 'string') {
      return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: '消息缺少 type 字段' } };
    }
    const handler = HANDLERS[msg.type];
    if (!handler) {
      return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: '未知的消息类型：' + msg.type } };
    }
    await loadSettings();
    try {
      return await handler(msg.payload || {});
    } catch (err) {
      return { ok: false, error: DS.toErrorInfo(err) };
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    dispatch(msg).then(function (response) {
      try { sendResponse(response); } catch (e) { /* 端口已关闭 */ }
    }).catch(function (err) {
      try { sendResponse({ ok: false, error: DS.toErrorInfo(err) }); } catch (e) { /* 端口已关闭 */ }
    });
    return true;
  });

  chrome.runtime.onInstalled.addListener(function (details) {
    try {
      if (details && details.reason === 'install') chrome.runtime.openOptionsPage();
    } catch (e) { /* 某些环境不支持 openOptionsPage */ }
  });
})();
