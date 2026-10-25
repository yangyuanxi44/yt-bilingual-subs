/* popup.js — 常用设置的读写 + 连接测试 + 当前视频状态
 * 经典脚本（非 module），依赖 ../lib/core.js 暴露的 self.YTBTL。
 * 无 chrome.storage 时（如 file:// 直接打开）使用内存 shim，仅用于视觉验收。
 */
(function () {
  'use strict';

  var Y = typeof self !== 'undefined' ? self.YTBTL : null;
  var doc = document;
  if (!Y) {
    var tip = doc.getElementById('videoTitle');
    if (tip) tip.textContent = '核心库加载失败，请重新打开弹窗';
    return;
  }

  var SCHEMA = Array.isArray(Y.SETTINGS_SCHEMA) ? Y.SETTINGS_SCHEMA : [];
  var QUICK_KEYS = ['enabled', 'zhMode', 'zhSize'];
  var PHASE_TEXT = {
    idle: '空闲',
    loading: '正在获取字幕…',
    translating: '正在翻译…',
    ready: '就绪',
    error: '出错',
    'no-captions': '未找到英文字幕',
    dom: 'DOM 兼容模式',
  };
  var PHASE_TONE = {
    ready: 'ok',
    error: 'error',
    'no-captions': 'warn',
    loading: 'warn',
    translating: 'warn',
    dom: 'warn',
    idle: '',
  };
  var ZH_MODE_TEXT = { off: '隐藏', hover: '悬停显示', on: '常显' };

  var hasChrome = typeof chrome !== 'undefined' && !!chrome;
  var hasStorage = !!(hasChrome && chrome.storage && chrome.storage.local);
  // 没有扩展存储 API（file:// 预览）时进入 demo 模式；扩展内始终走真实 API
  var DEMO = !hasStorage;
  var DEMO_KEY = DEMO && /[?&]key=1\b/.test(location.search) ? 'sk-preview-demo-key' : '';

  var settings = Y.normalizeSettings({});
  var syncing = [];
  var saveTimer = 0;
  var testing = false;
  var lastConnMeta = { text: '未测试', tone: '' };

  /* ------------------------------------------------------------------ *
   * 存储适配：真实 chrome.storage.local / demo 内存 shim
   * ------------------------------------------------------------------ */

  function createStorage() {
    if (!DEMO) {
      return {
        get: function (keys) {
          return new Promise(function (resolve) {
            try {
              chrome.storage.local.get(keys, function (res) {
                if (chrome.runtime && chrome.runtime.lastError) {
                  resolve({});
                  return;
                }
                resolve(res || {});
              });
            } catch (e) {
              resolve({});
            }
          });
        },
        set: function (obj) {
          return new Promise(function (resolve) {
            try {
              chrome.storage.local.set(obj, function () {
                if (chrome.runtime && chrome.runtime.lastError) {
                  // 忽略写入错误：popup 生命周期短，不值得打断用户
                }
                resolve();
              });
            } catch (e) {
              resolve();
            }
          });
        },
      };
    }
    var memory = {
      settings: Y.normalizeSettings({ apiKey: DEMO_KEY }),
      wordbook: [],
    };
    return {
      get: function (keys) {
        var out = {};
        var list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
        for (var i = 0; i < list.length; i++) {
          if (Object.prototype.hasOwnProperty.call(memory, list[i])) out[list[i]] = memory[list[i]];
        }
        return Promise.resolve(out);
      },
      set: function (obj) {
        Object.assign(memory, obj);
        return Promise.resolve();
      },
    };
  }

  var storage = createStorage();

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function schemaEntry(key) {
    for (var i = 0; i < SCHEMA.length; i++) {
      if (SCHEMA[i] && SCHEMA[i].key === key) return SCHEMA[i];
    }
    return null;
  }

  function shortLabel(label) {
    return String(label || '')
      .replace(/（[^）]*）/g, '')
      .replace(/时显示$/, '')
      .trim();
  }

  function formatRangeValue(def, value) {
    var n = Number(value);
    var rounded = Math.round(n * 100) / 100;
    var shown = String(rounded);
    return def && def.unit ? shown + def.unit : shown;
  }

  function makePatch(key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  }

  function pickNumber() {
    for (var i = 0; i < arguments.length; i++) {
      var n = Number(arguments[i]);
      if (arguments[i] != null && arguments[i] !== '' && Number.isFinite(n)) return n;
    }
    return null;
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'string' && arguments[i].trim()) return arguments[i].trim();
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 常用设置渲染（全部来自 YTBTL.SETTINGS_SCHEMA，不重复硬编码默认值）
   * ------------------------------------------------------------------ */

  function renderSwitch(def, value) {
    var row = el('div', 'setting-row');
    var info = el('div', 'setting-info');
    info.appendChild(el('span', 'setting-label', def.label));
    if (def.hint) info.appendChild(el('span', 'setting-hint', def.hint));

    var label = el('label', 'switch');
    var input = doc.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch-input';
    input.checked = !!value;
    input.setAttribute('aria-label', def.label);
    var track = el('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    label.appendChild(input);
    label.appendChild(track);

    input.addEventListener('change', function () {
      patch(makePatch(def.key, !!input.checked), true);
    });

    row.appendChild(info);
    row.appendChild(label);
    syncing.push({
      key: def.key,
      sync: function (v) {
        input.checked = !!v;
      },
    });
    return row;
  }

  function renderSegmented(def, value) {
    var block = el('div', 'setting-block');
    var line = el('div', 'setting-line');
    line.appendChild(el('span', 'setting-label', def.label));
    block.appendChild(line);

    var group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', def.label);
    var buttons = [];
    var options = Array.isArray(def.options) ? def.options : [];
    options.forEach(function (opt) {
      if (!opt || opt.value == null) return;
      var btn = el('button', 'seg-btn', shortLabel(opt.label) || String(opt.value));
      btn.type = 'button';
      btn.title = opt.label || String(opt.value);
      btn.setAttribute('data-value', String(opt.value));
      btn.setAttribute('aria-pressed', String(value === opt.value));
      btn.addEventListener('click', function () {
        patch(makePatch(def.key, opt.value), true);
      });
      group.appendChild(btn);
      buttons.push({ value: opt.value, node: btn });
    });
    block.appendChild(group);

    syncing.push({
      key: def.key,
      sync: function (v) {
        buttons.forEach(function (item) {
          item.node.setAttribute('aria-pressed', String(item.value === v));
        });
      },
    });
    return block;
  }

  function renderRange(def, value) {
    var block = el('div', 'setting-block');
    var line = el('div', 'setting-line');
    line.appendChild(el('span', 'setting-label', def.label));
    var valueEl = el('span', 'setting-value', formatRangeValue(def, value));
    line.appendChild(valueEl);

    var input = doc.createElement('input');
    input.type = 'range';
    input.className = 'range';
    if (def.min != null) input.min = String(def.min);
    if (def.max != null) input.max = String(def.max);
    if (def.step != null) input.step = String(def.step);
    input.value = String(value);
    input.setAttribute('aria-label', def.label);
    input.setAttribute('aria-valuetext', formatRangeValue(def, value));

    input.addEventListener('input', function () {
      valueEl.textContent = formatRangeValue(def, input.value);
      input.setAttribute('aria-valuetext', valueEl.textContent);
      patch(makePatch(def.key, Number(input.value)), false);
    });

    block.appendChild(line);
    block.appendChild(input);
    syncing.push({
      key: def.key,
      sync: function (v) {
        input.value = String(v);
        valueEl.textContent = formatRangeValue(def, v);
        input.setAttribute('aria-valuetext', valueEl.textContent);
      },
    });
    return block;
  }

  function renderQuick() {
    var root = doc.getElementById('quickSettings');
    if (!root) return;
    root.textContent = '';
    syncing = [];
    QUICK_KEYS.forEach(function (key) {
      var def = schemaEntry(key);
      if (!def) return;
      var node = null;
      if (def.type === 'boolean') node = renderSwitch(def, settings[key]);
      else if (def.type === 'select') node = renderSegmented(def, settings[key]);
      else if (def.type === 'range') node = renderRange(def, settings[key]);
      if (node) root.appendChild(node);
    });
  }

  function syncControls() {
    syncing.forEach(function (item) {
      item.sync(settings[item.key]);
    });
  }

  /* ------------------------------------------------------------------ *
   * 保存（popup 需要即时生效：开关/分段立即写，滑杆 120ms 合并）
   * ------------------------------------------------------------------ */

  function patch(patchObj, immediate) {
    settings = Y.normalizeSettings(Object.assign({}, settings, patchObj));
    syncControls();
    updateDerived();
    if (immediate) flushSave();
    else scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 120);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    storage.set({ settings: Y.normalizeSettings(settings) });
  }

  /* ------------------------------------------------------------------ *
   * 状态展示
   * ------------------------------------------------------------------ */

  function setConnMeta(text, tone) {
    lastConnMeta = { text: text, tone: tone || '' };
    var meta = doc.getElementById('connMeta');
    if (!meta) return;
    meta.textContent = text;
    meta.setAttribute('data-tone', tone || '');
  }

  function setTestResult(tone, text) {
    var node = doc.getElementById('testResult');
    if (!node) return;
    node.textContent = text;
    node.setAttribute('data-tone', tone || '');
    node.hidden = !text;
  }

  function updateDerived() {
    var state = doc.getElementById('enabledState');
    if (state) {
      state.textContent = settings.enabled ? '已启用' : '已关闭';
      state.setAttribute('data-state', settings.enabled ? 'on' : 'off');
    }
    var warn = doc.getElementById('apiWarn');
    if (warn) warn.hidden = !!settings.apiKey;

    var testBtn = doc.getElementById('testBtn');
    if (testBtn) {
      // 没有 Key 时把「去配置」作为唯一高亮按钮，测试按钮保持普通样式
      testBtn.classList.toggle('btn-primary', !!settings.apiKey);
    }
    if (!settings.apiKey) setConnMeta('未配置 API Key', 'warn');
    else if (!testing && lastConnMeta.tone === 'warn' && lastConnMeta.text === '未配置 API Key') setConnMeta('未测试', '');
  }

  /* ------------------------------------------------------------------ *
   * 当前视频状态：向 content script 查询，失败静默降级
   * ------------------------------------------------------------------ */

  function setVideo(title, detail, phase, demo) {
    var titleEl = doc.getElementById('videoTitle');
    var detailEl = doc.getElementById('videoDetail');
    var phaseEl = doc.getElementById('videoPhase');
    if (titleEl) titleEl.textContent = title || '';
    if (detailEl) detailEl.textContent = detail ? (demo ? detail + ' · 预览示例数据' : detail) : (demo ? '预览示例数据' : '');
    if (phaseEl) {
      phaseEl.textContent = PHASE_TEXT[phase] || '未知状态';
      phaseEl.setAttribute('data-tone', PHASE_TONE[phase] != null ? PHASE_TONE[phase] : '');
    }
  }

  function applyVideoState(resp, demo) {
    if (!resp || typeof resp !== 'object') {
      setVideo('未读取到字幕状态', '在 YouTube 视频页打开本扩展即可查看', 'idle', demo);
      return;
    }
    var data = resp.payload && typeof resp.payload === 'object' ? Object.assign({}, resp, resp.payload) : resp;
    var phase = typeof data.phase === 'string' ? data.phase : typeof data.status === 'string' ? data.status : '';
    var title = firstString(data.title, data.videoTitle);
    var cueCount = pickNumber(data.cueCount, Array.isArray(data.cues) ? data.cues.length : null);
    var translated = pickNumber(
      data.translatedCount,
      Array.isArray(data.translations) ? data.translations.filter(Boolean).length : null,
      data.done != null && data.total != null ? data.done : null
    );
    var total = pickNumber(data.totalCount, data.total);
    var zhMode = firstString(data.zhMode);
    if (!zhMode && data.settings && typeof data.settings.zhMode === 'string') zhMode = data.settings.zhMode;
    var message = firstString(data.message, data.errorMessage);

    if (!title && !phase && cueCount == null) {
      setVideo('未读取到字幕状态', '在 YouTube 视频页打开本扩展即可查看', 'idle', demo);
      return;
    }

    var parts = [];
    if (cueCount != null && cueCount > 0) parts.push('英文字幕 ' + cueCount + ' 条');
    if (translated != null && translated > 0) {
      parts.push('已翻译 ' + translated + (total != null && total > 0 ? '/' + total : '') + ' 条');
    }
    if (zhMode && ZH_MODE_TEXT[zhMode]) parts.push('中文：' + ZH_MODE_TEXT[zhMode]);
    if (message) parts.push(message);

    setVideo(
      title || '当前 YouTube 视频',
      parts.join(' · ') || '尚未读取到字幕，请在播放器上开启 CC 字幕',
      phase || 'idle',
      demo
    );
  }

  var DEMO_VIDEO = {
    ok: true,
    payload: {
      videoId: 'dQw4w9WgXcQ',
      title: 'How to Learn English Faster — 3 Habits That Actually Work',
      phase: 'ready',
      cueCount: 48,
      translatedCount: 42,
      totalCount: 48,
      zhMode: 'hover',
    },
  };

  function queryVideoState() {
    if (DEMO) {
      applyVideoState(DEMO_VIDEO, true);
      return;
    }
    if (!hasChrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') {
      setVideo('无法读取当前标签页', '请在 YouTube 视频页打开扩展弹窗', 'idle', false);
      return;
    }
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime && chrome.runtime.lastError) {
          setVideo('无法读取当前标签页', '', 'idle', false);
          return;
        }
        var tab = tabs && tabs[0];
        if (!tab || tab.id == null) {
          setVideo('无法读取当前标签页', '请在 YouTube 视频页打开扩展弹窗', 'idle', false);
          return;
        }
        var supported = typeof Y.isSupportedPage === 'function' ? Y.isSupportedPage(tab.url || '') : false;
        if (!supported) {
          setVideo('当前标签页不是 YouTube 视频页', '打开 youtube.com/watch 页面后即可查看字幕状态', 'idle', false);
          return;
        }
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'YTBT_STATE' }, function (resp) {
            // 先读 lastError，避免控制台出现 unchecked runtime.lastError
            var lastError = chrome.runtime && chrome.runtime.lastError;
            if (lastError) {
              setVideo('未连接字幕脚本', '页面可能刚重新加载，刷新 YouTube 页面后重试', 'idle', false);
              return;
            }
            applyVideoState(resp, false);
          });
        } catch (e) {
          setVideo('未连接字幕脚本', '', 'idle', false);
        }
      });
    } catch (e) {
      setVideo('无法读取当前标签页', '', 'idle', false);
    }
  }

  /* ------------------------------------------------------------------ *
   * 消息 / 打开设置
   * ------------------------------------------------------------------ */

  function sendRuntimeMessage(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (DEMO) {
        setTimeout(function () {
          if (message && message.type === 'YTBT_TEST') {
            resolve({ ok: true, model: settings.model || 'deepseek-chat', latencyMs: 648 });
          } else {
            resolve({ ok: false, error: { message: '预览模式不支持该操作' } });
          }
        }, 420);
        return;
      }
      if (!hasChrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        reject(new Error('扩展运行环境不可用'));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('请求超时，请检查网络或 API 地址'));
      }, timeoutMs || 60000);
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          var lastError = chrome.runtime && chrome.runtime.lastError;
          if (lastError) {
            reject(new Error('扩展后台不可用：' + lastError.message));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function runTest() {
    if (testing) return;
    if (!settings.apiKey) {
      setTestResult('error', '尚未配置 API Key：翻译与查词都不可用，请点击上方「去配置」填写。');
      var warnBtn = doc.getElementById('apiWarnBtn');
      if (warnBtn) {
        try {
          warnBtn.focus();
        } catch (e) {
          /* 忽略 */
        }
      }
      return;
    }
    testing = true;
    var btn = doc.getElementById('testBtn');
    var startedAt = Date.now();
    if (btn) {
      btn.disabled = true;
      btn.textContent = '测试中…';
    }
    setConnMeta('测试中…', 'warn');
    setTestResult('pending', '正在请求 DeepSeek…');
    sendRuntimeMessage({ type: 'YTBT_TEST' }, 60000)
      .then(function (resp) {
        var payload = resp && resp.payload && typeof resp.payload === 'object' ? resp.payload : null;
        var ok = !!(resp && (resp.ok === true || (payload && payload.ok === true)));
        var model = firstString(resp && resp.model, payload && payload.model) || settings.model;
        var latency = pickNumber(resp && resp.latencyMs, payload && payload.latencyMs);
        if (ok) {
          var ms = latency != null ? latency : Date.now() - startedAt;
          setTestResult('ok', '✓ 连接正常 · 模型 ' + model + ' · 延迟 ' + ms + ' ms' + (DEMO ? ' · 预览示例数据' : ''));
          setConnMeta(model, 'ok');
        } else {
          var errObj = (resp && (resp.error || (payload && payload.error))) || {};
          var msg = typeof errObj === 'string' ? errObj : firstString(errObj.message) || '未知错误';
          setTestResult('error', '✗ 连接失败：' + msg);
          setConnMeta('连接失败', 'error');
        }
      })
      .catch(function (err) {
        setTestResult('error', '✗ 连接失败：' + (err && err.message ? err.message : String(err)));
        setConnMeta('连接失败', 'error');
      })
      .then(function () {
        testing = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '测试连接';
        }
      });
  }

  function openOptions(hash) {
    var suffix = hash || '';
    if (DEMO) {
      try {
        window.open('../options/options.html' + suffix, '_blank');
      } catch (e) {
        /* 预览模式打开失败无需打扰 */
      }
      return;
    }
    var url = null;
    if (hasChrome && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      url = chrome.runtime.getURL('src/options/options.html') + suffix;
    }
    if (suffix && url && hasChrome && chrome.tabs && typeof chrome.tabs.create === 'function') {
      try {
        chrome.tabs.create({ url: url });
        return;
      } catch (e) {
        /* 回退到 openOptionsPage */
      }
    }
    if (hasChrome && chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') {
      try {
        chrome.runtime.openOptionsPage();
        return;
      } catch (e) {
        /* 回退到标签页打开 */
      }
    }
    if (url && hasChrome && chrome.tabs && typeof chrome.tabs.create === 'function') {
      try {
        chrome.tabs.create({ url: url });
      } catch (e) {
        /* 忽略：无扩展环境 */
      }
    }
  }

  function markPreview() {
    var hint = doc.querySelector('.footer-hint');
    if (hint) hint.textContent = '本地预览 · 数据仅存内存';
    var meta = doc.getElementById('connMeta');
    if (meta && !settings.apiKey) meta.textContent = '预览模式';
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function bindEvents() {
    var testBtn = doc.getElementById('testBtn');
    if (testBtn) testBtn.addEventListener('click', runTest);
    var optionsBtn = doc.getElementById('optionsBtn');
    if (optionsBtn) optionsBtn.addEventListener('click', function () { openOptions(''); });
    var warnBtn = doc.getElementById('apiWarnBtn');
    if (warnBtn) warnBtn.addEventListener('click', function () { openOptions('#deepseek'); });
  }

  function init() {
    var versionEl = doc.getElementById('versionLabel');
    if (versionEl) versionEl.textContent = 'v' + (Y.VERSION || '1.0.0');
    bindEvents();
    updateDerived();

    var ready = DEMO ? Promise.resolve({ settings: Y.normalizeSettings({ apiKey: DEMO_KEY }) }) : storage.get(['settings']);
    ready
      .then(function (res) {
        settings = Y.normalizeSettings(res && res.settings);
        renderQuick();
        updateDerived();
        if (DEMO) markPreview();
        queryVideoState();
      })
      .catch(function () {
        renderQuick();
        updateDerived();
        queryVideoState();
      });

    // 扩展内：其他界面（工具栏/content）改了设置时同步弹窗控件
    if (!DEMO && hasChrome && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local' || !changes || !changes.settings) return;
          settings = Y.normalizeSettings(changes.settings.newValue);
          syncControls();
          updateDerived();
        });
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
