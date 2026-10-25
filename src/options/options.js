/* options.js — 完整设置页：按 YTBTL.SETTINGS_SCHEMA 渲染全部控件，
 * 自动保存（300ms 防抖）、自定义 API 地址 host 权限申请、词库管理与导出。
 * 经典脚本（非 module），依赖 ../lib/core.js 暴露的 self.YTBTL。
 * 无 chrome.storage 时（如 file:// 直接打开）使用内存 shim + 示例词库，仅用于视觉验收。
 */
(function () {
  'use strict';

  var Y = typeof self !== 'undefined' ? self.YTBTL : null;
  var doc = document;
  if (!Y) {
    var foot = doc.getElementById('pageFoot');
    if (foot) foot.textContent = '核心库 core.js 加载失败，请刷新页面重试。';
    return;
  }

  var SCHEMA = Array.isArray(Y.SETTINGS_SCHEMA) ? Y.SETTINGS_SCHEMA : [];
  var hasChrome = typeof chrome !== 'undefined' && !!chrome;
  var hasStorage = !!(hasChrome && chrome.storage && chrome.storage.local);
  // 没有扩展存储 API（file:// 预览）时进入 demo 模式；扩展内始终走真实 API
  var DEMO = !hasStorage;
  var DEMO_KEY = DEMO && /[?&]key=1\b/.test(location.search) ? 'sk-preview-demo-key' : '';
  var STORAGE_KEYS = ['settings', 'wordbook'];

  var draft = Y.normalizeSettings({});
  var lastSaved = Y.normalizeSettings({});
  var wordbook = [];
  var controlList = [];
  var saveTimer = 0;
  var saveSeq = 0;
  var commitToken = 0;
  var pendingBaseUrl = null;
  var toastTimer = 0;
  var testing = false;

  /* ------------------------------------------------------------------ *
   * 存储适配
   * ------------------------------------------------------------------ */

  function demoWordbook() {
    var now = Date.now();
    var videoA = 'How to Learn English Faster — 3 Habits That Actually Work';
    var videoB = 'Why Some People Never Give Up';
    var videoC = 'The Art of Speaking Clearly';
    return [
      {
        word: 'wonder', lemma: 'wonder', phonetic: 'ˈwʌndər',
        senses: [{ pos: 'v.', zh: '想知道；好奇' }, { pos: 'n.', zh: '惊奇；奇迹' }],
        example: { en: 'I wonder what this word means.', zh: '我想知道这个词是什么意思。' },
        contextZh: '我想知道它是怎么做到的。', note: '常与 what / why 引导的从句连用。',
        videoId: 'demo0000001', videoTitle: videoA, time: 75,
        createdAt: now - 2 * 86400000, count: 2,
      },
      {
        word: 'resilient', lemma: 'resilient', phonetic: 'rɪˈzɪliənt',
        senses: [{ pos: 'adj.', zh: '有韧性的；能迅速恢复的' }],
        example: { en: 'Children are often more resilient than adults.', zh: '孩子往往比成年人更有韧性。' },
        contextZh: '她非常坚韧，从不轻易放弃。', note: '',
        videoId: 'demo0000002', videoTitle: videoB, time: 312,
        createdAt: now - 86400000, count: 1,
      },
      {
        word: 'subtle', lemma: 'subtle', phonetic: 'ˈsʌtl',
        senses: [{ pos: 'adj.', zh: '微妙的；不易察觉的' }],
        example: { en: 'There is a subtle difference between the two.', zh: '两者之间有微妙的差别。' },
        contextZh: '这种改变很微妙，但确实存在。', note: '注意 b 不发音。',
        videoId: 'demo0000003', videoTitle: videoC, time: 45,
        createdAt: now - 4 * 3600000, count: 1,
      },
      {
        word: 'inevitable', lemma: 'inevitable', phonetic: 'ɪnˈevɪtəbl',
        senses: [{ pos: 'adj.', zh: '不可避免的；必然发生的' }],
        example: { en: 'Change is inevitable.', zh: '变化是不可避免的。' },
        contextZh: '失败在这个阶段几乎是不可避免的。', note: '',
        videoId: 'demo0000004', videoTitle: videoA, time: 208,
        createdAt: now - 6 * 86400000, count: 3,
      },
    ];
  }

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
          return new Promise(function (resolve, reject) {
            try {
              chrome.storage.local.set(obj, function () {
                var lastError = chrome.runtime && chrome.runtime.lastError;
                if (lastError) {
                  reject(new Error(lastError.message));
                  return;
                }
                resolve();
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      };
    }
    var memory = {
      settings: Y.normalizeSettings({ apiKey: DEMO_KEY }),
      wordbook: demoWordbook(),
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

  function inputEl(type, className) {
    var node = doc.createElement('input');
    node.type = type;
    if (className) node.className = className;
    return node;
  }

  function controlId(key) {
    return 'opt-' + key;
  }

  function formatRangeValue(def, value) {
    var n = Number(value);
    var rounded = Math.round(n * 100) / 100;
    var shown = String(rounded);
    return def && def.unit ? shown + ' ' + def.unit : shown;
  }

  function formatCreatedAt(ts) {
    var n = Number(ts);
    var date = new Date(n);
    if (!Number.isFinite(n) || isNaN(date.getTime())) return '—';
    var pad = function (v) { return String(v).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function dateStamp() {
    var d = new Date();
    var pad = function (v) { return String(v).padStart(2, '0'); };
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  function originPattern(baseUrl) {
    try {
      var url = new URL(String(baseUrl || '').trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (!url.hostname) return null;
      return url.protocol + '//' + url.hostname + '/*';
    } catch (e) {
      return null;
    }
  }

  function hasPermissionsApi() {
    return !!(hasChrome && chrome.permissions && typeof chrome.permissions.contains === 'function');
  }

  function checkHostPermission(pattern) {
    return new Promise(function (resolve) {
      if (!hasPermissionsApi()) {
        resolve(true); // 预览 / 无 chrome.permissions：不阻塞保存
        return;
      }
      try {
        chrome.permissions.contains({ origins: [pattern] }, function (granted) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(!!granted);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 保存状态 / Toast
   * ------------------------------------------------------------------ */

  function setSaveStatus(text, tone) {
    var node = doc.getElementById('saveStatus');
    if (!node) return;
    node.textContent = text;
    node.setAttribute('data-tone', tone || '');
  }

  function toast(text, tone) {
    var node = doc.getElementById('toast');
    if (!node) return;
    node.textContent = text;
    node.setAttribute('data-tone', tone || '');
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.hidden = true;
    }, 2800);
  }

  /* ------------------------------------------------------------------ *
   * 设置控件渲染（全部来自 YTBTL.SETTINGS_SCHEMA）
   * ------------------------------------------------------------------ */

  function registerControl(def, sync) {
    controlList.push({ key: def.key, sync: sync });
  }

  function renderBoolean(def) {
    var ctl = el('div', 'setting-ctl inline');
    var switchLabel = el('label', 'switch');
    var input = inputEl('checkbox', 'switch-input');
    input.id = controlId(def.key);
    input.checked = !!draft[def.key];
    input.setAttribute('aria-label', def.label);
    var track = el('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    switchLabel.appendChild(input);
    switchLabel.appendChild(track);
    ctl.appendChild(switchLabel);
    input.addEventListener('change', function () {
      setDraft(def.key, !!input.checked);
    });
    registerControl(def, function (value) {
      input.checked = !!value;
    });
    return ctl;
  }

  function renderSelect(def) {
    var ctl = el('div', 'setting-ctl');
    var select = doc.createElement('select');
    select.className = 'select';
    select.id = controlId(def.key);
    var options = Array.isArray(def.options) ? def.options : [];
    options.forEach(function (opt) {
      if (!opt || opt.value == null) return;
      var option = doc.createElement('option');
      option.value = String(opt.value);
      option.textContent = opt.label != null ? String(opt.label) : String(opt.value);
      select.appendChild(option);
    });
    select.value = String(draft[def.key]);
    select.addEventListener('change', function () {
      setDraft(def.key, select.value);
    });
    ctl.appendChild(select);
    registerControl(def, function (value) {
      select.value = String(value);
    });
    return ctl;
  }

  function renderRange(def) {
    var ctl = el('div', 'setting-ctl');
    var line = el('div', 'range-line');
    var input = inputEl('range', 'range');
    input.id = controlId(def.key);
    if (def.min != null) input.min = String(def.min);
    if (def.max != null) input.max = String(def.max);
    if (def.step != null) input.step = String(def.step);
    input.value = String(draft[def.key]);
    input.setAttribute('aria-label', def.label);
    var valueEl = el('span', 'range-value', formatRangeValue(def, draft[def.key]));
    input.setAttribute('aria-valuetext', valueEl.textContent);

    input.addEventListener('input', function () {
      valueEl.textContent = formatRangeValue(def, input.value);
      input.setAttribute('aria-valuetext', valueEl.textContent);
      setDraft(def.key, Number(input.value));
    });

    line.appendChild(input);
    line.appendChild(valueEl);
    ctl.appendChild(line);
    registerControl(def, function (value) {
      input.value = String(value);
      valueEl.textContent = formatRangeValue(def, value);
      input.setAttribute('aria-valuetext', valueEl.textContent);
    });
    return ctl;
  }

  function renderText(def) {
    var ctl = el('div', 'setting-ctl');
    var isPassword = def.type === 'password';
    var input = inputEl(isPassword ? 'password' : 'text', 'input' + (def.key === 'baseUrl' ? ' input-url' : ''));
    input.id = controlId(def.key);
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (def.placeholder) input.placeholder = String(def.placeholder);
    input.value = String(draft[def.key] == null ? '' : draft[def.key]);
    input.setAttribute('aria-label', def.label);

    if (isPassword) {
      var row = el('div', 'input-row');
      var toggle = el('button', 'toggle-password', '显示');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', '显示或隐藏 ' + def.label);
      toggle.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? '隐藏' : '显示';
        toggle.setAttribute('aria-pressed', String(show));
      });
      row.appendChild(input);
      row.appendChild(toggle);
      ctl.appendChild(row);
    } else {
      ctl.appendChild(input);
    }

    var keyStatus = null;
    if (def.key === 'apiKey') {
      keyStatus = el('p', 'key-status');
      ctl.appendChild(keyStatus);
      updateKeyStatus(keyStatus, draft[def.key]);
    }
    if (def.key === 'baseUrl') {
      ctl.appendChild(el('p', 'hint-extra', '自定义代理地址首次保存时会申请该域名的访问权限；仅申请你填写的域名。'));
    }

    input.addEventListener('input', function () {
      if (def.key === 'baseUrl') hideBaseUrlNotice();
      setDraft(def.key, input.value);
      if (keyStatus) updateKeyStatus(keyStatus, input.value);
    });

    registerControl(def, function (value) {
      input.value = String(value == null ? '' : value);
      if (keyStatus) updateKeyStatus(keyStatus, value);
    });
    return ctl;
  }

  function renderNumber(def) {
    var ctl = el('div', 'setting-ctl');
    var input = inputEl('number', 'input input-number');
    input.id = controlId(def.key);
    if (def.min != null) input.min = String(def.min);
    if (def.max != null) input.max = String(def.max);
    if (def.step != null) input.step = String(def.step);
    input.value = String(draft[def.key]);
    input.setAttribute('aria-label', def.label);
    input.addEventListener('input', function () {
      var n = Number(input.value);
      if (!Number.isFinite(n)) return;
      setDraft(def.key, n);
    });
    ctl.appendChild(input);
    registerControl(def, function (value) {
      input.value = String(value);
    });
    return ctl;
  }

  function colorValue(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : (fallback || '#ffffff');
  }

  function renderColor(def) {
    var fallback = def.default || '#ffffff';
    var ctl = el('div', 'setting-ctl color-ctl');
    var input = inputEl('color', 'color-input');
    input.id = controlId(def.key);
    input.value = colorValue(draft[def.key], fallback);
    input.setAttribute('aria-label', def.label);
    var valueEl = el('span', 'color-value', input.value.toUpperCase());
    input.addEventListener('input', function () {
      var value = colorValue(input.value, fallback);
      valueEl.textContent = value.toUpperCase();
      setDraft(def.key, value);
    });
    ctl.appendChild(input);
    ctl.appendChild(valueEl);
    registerControl(def, function (value) {
      var next = colorValue(value, fallback);
      input.value = next;
      valueEl.textContent = next.toUpperCase();
    });
    return ctl;
  }

  function updateKeyStatus(node, value) {
    var hasKey = !!String(value || '').trim();
    node.textContent = hasKey
      ? '已配置：仅保存在本机，页面其它位置不会显示 Key'
      : '尚未配置 API Key：翻译与查词不可用';
    node.setAttribute('data-tone', hasKey ? 'ok' : 'warn');
  }

  function renderControl(def) {
    var row = el('div', 'setting');
    row.setAttribute('data-key', def.key);
    var info = el('div', 'setting-info');
    var label = el('label', 'setting-label', def.label);
    label.setAttribute('for', controlId(def.key));
    info.appendChild(label);
    if (def.hint) info.appendChild(el('p', 'setting-hint', def.hint));
    row.appendChild(info);

    var ctl = null;
    if (def.type === 'boolean') ctl = renderBoolean(def);
    else if (def.type === 'select') ctl = renderSelect(def);
    else if (def.type === 'range') ctl = renderRange(def);
    else if (def.type === 'password') ctl = renderText(def);
    else if (def.type === 'text') ctl = renderText(def);
    else if (def.type === 'number') ctl = renderNumber(def);
    else if (def.type === 'color') ctl = renderColor(def);
    else ctl = renderText(def);
    row.appendChild(ctl);
    return row;
  }

  function renderSettings() {
    controlList = [];
    var groups = {};
    SCHEMA.forEach(function (def) {
      if (!def || !def.key) return;
      if (def.key === 'subtitleMode' && !Y.NATIVE_MODE_ENABLED) return;
      var group = def.group || '其他';
      if (!groups[group]) groups[group] = [];
      groups[group].push(def);
    });
    var containers = doc.querySelectorAll('.settings[data-group]');
    Array.prototype.forEach.call(containers, function (container) {
      var group = container.getAttribute('data-group');
      container.textContent = '';
      (groups[group] || []).forEach(function (def) {
        container.appendChild(renderControl(def));
      });
    });
  }

  function syncControls() {
    controlList.forEach(function (item) {
      item.sync(draft[item.key]);
    });
  }

  function syncControl(key, value) {
    controlList.forEach(function (item) {
      if (item.key === key) item.sync(value);
    });
  }

  /* ------------------------------------------------------------------ *
   * 草稿 + 自动保存（300ms 防抖）
   * ------------------------------------------------------------------ */

  function setDraft(key, value) {
    var patch = {};
    patch[key] = value;
    draft = Y.normalizeSettings(Object.assign({}, draft, patch));
    scheduleSave();
  }

  function scheduleSave() {
    setSaveStatus('保存中…', 'pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      saveNow();
    }, 300);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    return saveNow();
  }

  function commit(next) {
    var value = Y.normalizeSettings(next);
    setSaveStatus('保存中…', 'pending');
    var token = ++commitToken;
    return storage.set({ settings: value }).then(function () {
      if (token !== commitToken) return;
      lastSaved = value;
      setSaveStatus('已保存', 'saved');
    }, function () {
      if (token !== commitToken) return;
      setSaveStatus('保存失败', 'error');
    });
  }

  function saveNow() {
    var seq = ++saveSeq;
    var next = Y.normalizeSettings(draft);
    if (lastSaved && next.baseUrl === lastSaved.baseUrl) {
      pendingBaseUrl = null;
      hideBaseUrlNotice();
      return commit(next);
    }
    var pattern = originPattern(next.baseUrl);
    if (!pattern) {
      pendingBaseUrl = null;
      showBaseUrlNotice('API 地址必须是合法的 http(s) 地址（例如 https://api.deepseek.com）。当前地址尚未保存。', false);
      var keepInvalid = Object.assign({}, next, { baseUrl: lastSaved ? lastSaved.baseUrl : Y.DEFAULT_SETTINGS.baseUrl });
      return commit(keepInvalid);
    }
    return checkHostPermission(pattern).then(function (granted) {
      if (seq !== saveSeq) return undefined;
      if (granted) {
        pendingBaseUrl = null;
        hideBaseUrlNotice();
        return commit(next);
      }
      pendingBaseUrl = { pattern: pattern, url: next.baseUrl };
      showBaseUrlNotice(
        '保存 ' + pattern.replace('/*', '') + ' 需要浏览器授权。点击「授权并保存」，在弹窗中选择允许；拒绝则会回退默认地址。',
        true
      );
      // 其余设置照常保存，baseUrl 在授权前不生效
      var keepBase = Object.assign({}, next, { baseUrl: lastSaved ? lastSaved.baseUrl : Y.DEFAULT_SETTINGS.baseUrl });
      return commit(keepBase);
    }, function () {
      return commit(next);
    });
  }

  function showBaseUrlNotice(text, canGrant) {
    var notice = doc.getElementById('baseUrlNotice');
    var textNode = doc.getElementById('baseUrlNoticeText');
    var grantBtn = doc.getElementById('grantBtn');
    if (!notice || !textNode) return;
    textNode.textContent = text;
    if (grantBtn) grantBtn.hidden = !canGrant;
    notice.hidden = false;
  }

  function hideBaseUrlNotice() {
    var notice = doc.getElementById('baseUrlNotice');
    if (notice) notice.hidden = true;
  }

  function grantBaseUrlPermission() {
    var pending = pendingBaseUrl;
    if (!pending) return;
    if (!hasPermissionsApi() || !chrome.permissions || typeof chrome.permissions.request !== 'function') {
      // 预览模式没有权限 API：直接保存地址
      pendingBaseUrl = null;
      hideBaseUrlNotice();
      saveNow();
      return;
    }
    try {
      chrome.permissions.request({ origins: [pending.pattern] }, function (granted) {
        var lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          showBaseUrlNotice('权限申请失败：' + lastError.message, true);
          return;
        }
        if (granted) {
          pendingBaseUrl = null;
          draft = Y.normalizeSettings(Object.assign({}, draft, { baseUrl: pending.url }));
          syncControl('baseUrl', pending.url);
          hideBaseUrlNotice();
          toast('已授权并保存 API 地址', 'ok');
          saveNow();
        } else {
          revertBaseUrl();
          toast('未获得授权，已回退默认 API 地址', 'error');
        }
      });
    } catch (e) {
      showBaseUrlNotice(
        '无法申请权限：' + (e && e.message ? e.message : String(e)) + '。浏览器要求该操作必须由点击直接触发，请刷新页面后重试。',
        true
      );
    }
  }

  function revertBaseUrl() {
    pendingBaseUrl = null;
    hideBaseUrlNotice();
    draft = Y.normalizeSettings(Object.assign({}, draft, { baseUrl: Y.DEFAULT_SETTINGS.baseUrl }));
    syncControl('baseUrl', draft.baseUrl);
    saveNow();
  }

  function resetDefaults() {
    var ok = window.confirm('恢复所有设置为默认值？\nAPI Key 会保留，词库不受影响。');
    if (!ok) return;
    var apiKey = draft.apiKey;
    draft = Y.normalizeSettings(Object.assign({}, Y.DEFAULT_SETTINGS, { apiKey: apiKey }));
    pendingBaseUrl = null;
    hideBaseUrlNotice();
    syncControls();
    clearTestResult();
    saveNow();
    toast('已恢复默认设置（API Key 已保留）', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * 测试连接
   * ------------------------------------------------------------------ */

  function showTestResult(tone, text) {
    var node = doc.getElementById('testResult');
    if (!node) return;
    node.textContent = text || '';
    node.setAttribute('data-tone', tone || '');
    node.hidden = !text;
  }

  function clearTestResult() {
    showTestResult('', '');
  }

  function setTestingState(value) {
    testing = value;
    var ids = ['testBtn', 'testBtnInline'];
    ids.forEach(function (id) {
      var btn = doc.getElementById(id);
      if (!btn) return;
      btn.disabled = value;
      if (id === 'testBtnInline') btn.textContent = value ? '测试中…' : '测试连接';
    });
  }

  function sendRuntimeMessage(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (DEMO) {
        setTimeout(function () {
          if (message && message.type === 'YTBT_TEST') {
            resolve({ ok: true, model: draft.model || 'deepseek-chat', latencyMs: 638 });
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
    if (!String(draft.apiKey || '').trim()) {
      showTestResult('error', '请先填写 DeepSeek API Key，再测试连接。');
      var keyInput = doc.getElementById(controlId('apiKey'));
      if (keyInput) {
        try {
          keyInput.focus();
        } catch (e) {
          /* 忽略 */
        }
      }
      return;
    }
    setTestingState(true);
    showTestResult('pending', '正在请求 DeepSeek…（最长等待 60 秒）');
    var startedAt = Date.now();
    flushSave()
      .then(function () {
        return sendRuntimeMessage({ type: 'YTBT_TEST' }, 60000);
      })
      .then(function (resp) {
        var payload = resp && resp.payload && typeof resp.payload === 'object' ? resp.payload : null;
        var ok = !!(resp && (resp.ok === true || (payload && payload.ok === true)));
        var model = firstNonEmpty(resp && resp.model, payload && payload.model) || draft.model;
        var latency = pickNumber(resp && resp.latencyMs, payload && payload.latencyMs);
        if (ok) {
          var ms = latency != null ? latency : Date.now() - startedAt;
          showTestResult('ok', '✓ 连接正常 · 模型 ' + model + ' · 延迟 ' + ms + ' ms' + (DEMO ? ' · 预览示例数据' : ''));
        } else {
          var error = (resp && (resp.error || (payload && payload.error))) || {};
          var message = typeof error === 'string' ? error : firstNonEmpty(error.message) || '未知错误';
          showTestResult('error', '✗ 连接失败：' + message);
        }
      })
      .then(function () {
        setTestingState(false);
      }, function (err) {
        showTestResult('error', '✗ 连接失败：' + (err && err.message ? err.message : String(err)));
        setTestingState(false);
      });
  }

  function pickNumber() {
    for (var i = 0; i < arguments.length; i++) {
      var n = Number(arguments[i]);
      if (arguments[i] != null && arguments[i] !== '' && Number.isFinite(n)) return n;
    }
    return null;
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'string' && arguments[i].trim()) return arguments[i].trim();
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 词库
   * ------------------------------------------------------------------ */

  function normalizeWordbook(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(function (item) {
      return item && typeof item === 'object' && (item.word || item.lemma);
    });
  }

  function senseNodes(item) {
    var senses = Array.isArray(item.senses) ? item.senses : [];
    var nodes = [];
    senses.forEach(function (sense) {
      if (!sense) return;
      var pos = typeof sense === 'object' ? String(sense.pos || '') : '';
      var zh = typeof sense === 'object' ? String(sense.zh || '') : String(sense);
      if (!pos && !zh) return;
      nodes.push({ pos: pos, zh: zh });
    });
    return nodes;
  }

  function renderWordbook() {
    var tbody = doc.getElementById('wordbookBody');
    var empty = doc.getElementById('wordbookEmpty');
    var count = doc.getElementById('wordbookCount');
    if (!tbody) return;
    tbody.textContent = '';
    if (count) count.textContent = String(wordbook.length);
    if (empty) empty.hidden = wordbook.length > 0;

    wordbook.forEach(function (item, index) {
      var row = doc.createElement('tr');

      var wordCell = doc.createElement('td');
      var wordWrap = el('div', 'word-cell');
      wordWrap.appendChild(el('span', 'word-strong', item.word || item.lemma || '—'));
      if (Number(item.count) > 1) wordWrap.appendChild(el('span', 'word-count', '×' + Number(item.count)));
      wordCell.appendChild(wordWrap);
      row.appendChild(wordCell);

      var phoneticCell = doc.createElement('td');
      phoneticCell.className = 'phonetic';
      phoneticCell.textContent = item.phonetic ? '/' + String(item.phonetic).replace(/^\/+|\/+$/g, '') + '/' : '—';
      row.appendChild(phoneticCell);

      var senseCell = doc.createElement('td');
      senseCell.className = 'sense';
      var senses = senseNodes(item);
      if (!senses.length) {
        senseCell.textContent = '—';
      } else {
        senses.forEach(function (sense, i) {
          if (i > 0) senseCell.appendChild(doc.createTextNode('；'));
          if (sense.pos) senseCell.appendChild(el('span', 'pos', sense.pos));
          senseCell.appendChild(doc.createTextNode((sense.pos ? ' ' : '') + sense.zh));
        });
      }
      row.appendChild(senseCell);

      var sourceCell = doc.createElement('td');
      sourceCell.className = 'source';
      var source = item.videoTitle || item.videoId || '—';
      sourceCell.textContent = source;
      sourceCell.title = source;
      row.appendChild(sourceCell);

      var timeCell = doc.createElement('td');
      timeCell.className = 'time';
      timeCell.textContent = formatCreatedAt(item.createdAt);
      row.appendChild(timeCell);

      var actionCell = doc.createElement('td');
      actionCell.className = 'col-action';
      var delBtn = el('button', 'icon-btn', '删除');
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', '删除 ' + (item.word || item.lemma || ''));
      delBtn.addEventListener('click', function () {
        deleteWord(index);
      });
      actionCell.appendChild(delBtn);
      row.appendChild(actionCell);

      tbody.appendChild(row);
    });
  }

  function persistWordbook(next) {
    wordbook = normalizeWordbook(next);
    renderWordbook();
    storage.set({ wordbook: wordbook }).catch(function () {
      toast('词库保存失败，请重试', 'error');
    });
  }

  function deleteWord(index) {
    var item = wordbook[index];
    if (!item) return;
    var next = wordbook.slice(0, index).concat(wordbook.slice(index + 1));
    persistWordbook(next);
    toast('已删除「' + (item.word || item.lemma || '') + '」', 'ok');
  }

  function clearWordbook() {
    if (!wordbook.length) {
      toast('词库已经是空的');
      return;
    }
    var ok = window.confirm('确定清空词库中的 ' + wordbook.length + ' 个单词吗？此操作不可撤销。');
    if (!ok) return;
    persistWordbook([]);
    toast('词库已清空', 'ok');
  }

  function exportCsv() {
    if (!wordbook.length) {
      toast('词库是空的，没有可导出的内容');
      return;
    }
    try {
      var csv = Y.wordbookToCsv(wordbook);
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = doc.createElement('a');
      link.href = url;
      link.download = 'wordbook-' + dateStamp() + '.csv';
      link.rel = 'noopener';
      doc.body.appendChild(link);
      link.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        if (link.parentNode) link.parentNode.removeChild(link);
      }, 1500);
      toast('已导出 ' + wordbook.length + ' 个单词到 wordbook-' + dateStamp() + '.csv', 'ok');
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : String(e)), 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * 导航高亮 / 锚点
   * ------------------------------------------------------------------ */

  function setupNav() {
    var links = Array.prototype.slice.call(doc.querySelectorAll('.nav-link'));
    var sections = links
      .map(function (link) {
        return doc.getElementById(link.getAttribute('data-target'));
      })
      .filter(Boolean);
    if (!links.length || !sections.length) return;

    var rafPending = false;
    var updateActive = function () {
      var offset = 130;
      var current = sections[0];
      sections.forEach(function (section) {
        if (section.getBoundingClientRect().top - offset <= 0) current = section;
      });
      links.forEach(function (link) {
        link.classList.toggle('is-active', !!current && link.getAttribute('data-target') === current.id);
      });
    };
    links.forEach(function (link) {
      link.addEventListener('click', function () {
        links.forEach(function (other) {
          other.classList.toggle('is-active', other === link);
        });
      });
    });
    window.addEventListener('scroll', function () {
      if (rafPending) return;
      rafPending = true;
      var raf = self.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
      raf(function () {
        rafPending = false;
        updateActive();
      });
    }, { passive: true });
    updateActive();

    var hash = String(location.hash || '');
    if (hash.length > 1) {
      var target = doc.getElementById(hash.slice(1));
      if (target) {
        setTimeout(function () {
          target.scrollIntoView({ block: 'start' });
          updateActive();
        }, 40);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * 翻译 / 查词缓存
   * ------------------------------------------------------------------ */

  var cacheRefreshTimer = 0;

  function countCacheKeys() {
    if (DEMO || !hasChrome || !chrome.storage || !chrome.storage.local) return Promise.resolve(0);
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(null, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(0);
            return;
          }
          var count = 0;
          Object.keys(items || {}).forEach(function (key) {
            if (key.indexOf('tc:') === 0 || key.indexOf('wc:') === 0) count++;
          });
          resolve(count);
        });
      } catch (e) {
        resolve(0);
      }
    });
  }

  function updateCacheInfo() {
    var node = doc.getElementById('cacheInfo');
    if (!node) return;
    countCacheKeys().then(function (count) {
      if (count > 0) node.textContent = '本机缓存 ' + count + ' 条';
      else node.textContent = DEMO ? '预览模式：无真实缓存' : '本机暂无缓存';
    }, function () {
      node.textContent = '缓存数量读取失败';
    });
  }

  function clearCache() {
    if (DEMO) {
      toast('预览模式不连接后台，没有真实缓存可清', 'ok');
      return;
    }
    if (!window.confirm('清除本机全部翻译与查词缓存？\n清除后再次播放会重新调用 DeepSeek（可能产生少量费用）。')) return;
    var btn = doc.getElementById('clearCacheBtn');
    if (btn) btn.disabled = true;
    sendRuntimeMessage({ type: 'YTBT_CLEAR_CACHE' }, 15000)
      .then(function (resp) {
        if (resp && resp.ok) toast('已清除 ' + (resp.removed || 0) + ' 条缓存', 'ok');
        else toast('清除缓存失败：' + ((resp && resp.error && resp.error.message) || '未知错误'), 'error');
      }, function (err) {
        toast('清除缓存失败：' + (err && err.message ? err.message : String(err)), 'error');
      })
      .then(function () {
        if (btn) btn.disabled = false;
        updateCacheInfo();
      });
  }

  function bindStaticEvents() {
    var testBtn = doc.getElementById('testBtn');
    if (testBtn) testBtn.addEventListener('click', runTest);
    var testBtnInline = doc.getElementById('testBtnInline');
    if (testBtnInline) testBtnInline.addEventListener('click', runTest);
    var resetBtn = doc.getElementById('resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetDefaults);
    var resetSubtitlePosBtn = doc.getElementById('resetSubtitlePosBtn');
    if (resetSubtitlePosBtn) {
      resetSubtitlePosBtn.addEventListener('click', function () {
        setDraft('subtitlePos', null);
        toast('字幕位置已复位（已打开的 YouTube 页面会自动更新）', 'ok');
      });
    }
    var grantBtn = doc.getElementById('grantBtn');
    if (grantBtn) grantBtn.addEventListener('click', grantBaseUrlPermission);
    var revertBtn = doc.getElementById('revertBaseUrlBtn');
    if (revertBtn) {
      revertBtn.addEventListener('click', function () {
        revertBaseUrl();
        toast('已回退默认 API 地址', 'ok');
      });
    }
    var exportBtn = doc.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);
    var clearBtn = doc.getElementById('clearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearWordbook);
    var clearCacheBtn = doc.getElementById('clearCacheBtn');
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', clearCache);

    // 页面卸载前把防抖中的改动落盘
    window.addEventListener('pagehide', function () {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
        saveNow();
      }
    });
  }

  function init() {
    var versionEl = doc.getElementById('aboutVersion');
    if (versionEl) versionEl.textContent = 'v' + (Y.VERSION || '1.0.0');
    var pageFoot = doc.getElementById('pageFoot');
    if (pageFoot) {
      pageFoot.textContent = DEMO
        ? '当前为本地预览模式（file://）：数据只保存在内存中，刷新页面会恢复示例数据。'
        : '设置保存在本机 chrome.storage.local；修改后自动保存，无需手动提交。';
    }
    bindStaticEvents();
    setSaveStatus('加载中…', 'pending');
    updateCacheInfo();

    storage.get(STORAGE_KEYS).then(function (res) {
      var rawSettings = res && res.settings;
      draft = Y.normalizeSettings(rawSettings);
      lastSaved = Y.normalizeSettings(rawSettings);
      wordbook = normalizeWordbook(res && res.wordbook);
      renderSettings();
      syncControls();
      renderWordbook();
      setSaveStatus('已保存', 'saved');
      setupNav();
      if (DEMO) {
        var demoBadge = doc.getElementById('saveStatus');
        if (demoBadge) demoBadge.title = '本地预览：数据仅存内存';
      }
    }, function () {
      draft = Y.normalizeSettings({});
      lastSaved = Y.normalizeSettings({});
      wordbook = [];
      renderSettings();
      syncControls();
      renderWordbook();
      setSaveStatus('已保存', 'saved');
      setupNav();
    });

    // 扩展内：后台 / 内容脚本新增词库时刷新表格
    if (!DEMO && hasChrome && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local' || !changes) return;
          var cacheChanged = Object.keys(changes).some(function (key) {
            return key.indexOf('tc:') === 0 || key.indexOf('wc:') === 0;
          });
          if (cacheChanged) {
            clearTimeout(cacheRefreshTimer);
            cacheRefreshTimer = setTimeout(updateCacheInfo, 800);
          }
          if (!changes.wordbook) return;
          wordbook = normalizeWordbook(changes.wordbook.newValue);
          renderWordbook();
        });
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
