/*!
 * YT 双语字幕 · 点词查意 — DeepSeek 客户端
 * 经典脚本（UMD，无构建）：浏览器 self.YTBTL_DS / node module.exports。
 * 只负责「发请求 + 解析 + 错误归一」，缓存由 background 负责。
 */
(function (root, factory) {
  const api = factory(root);
  if (root) root.YTBTL_DS = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  let core = root && root.YTBTL ? root.YTBTL : null;
  if (!core && typeof require === 'function') {
    try { core = require('./core.js'); } catch (e) { core = null; }
  }

  const DEFAULT_BASE_URL = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-chat';
  const DEFAULT_TEMPERATURE = 0.2;
  const DEFAULT_TIMEOUT_MS = 45000;
  const MAX_RETRIES = 2;
  const RETRY_DELAYS = [600, 1800];
  const REPAIR_PROMPT = '上一条回复不是合法 JSON。请只返回合法 JSON：不要 markdown 代码块、不要任何解释文字，字段与数量必须与要求完全一致。';

  function errorMessage(code) {
    switch (code) {
      case 'NO_KEY': return '未配置 DeepSeek API Key，请到设置页填写';
      case 'AUTH': return 'API Key 无效或已过期';
      case 'BALANCE': return 'DeepSeek 账户余额不足';
      case 'RATE': return '请求过于频繁（429），请稍后重试';
      case 'NETWORK': return '网络请求失败，请检查网络或代理设置';
      case 'TIMEOUT': return '请求超时，请稍后重试';
      case 'SERVER': return 'DeepSeek 服务暂时不可用，请稍后重试';
      case 'BAD_JSON': return '模型返回的内容无法解析为 JSON';
      case 'BAD_RESPONSE': return 'DeepSeek 返回了异常响应';
      case 'ABORTED': return '请求已取消';
      default: return 'DeepSeek 请求失败';
    }
  }

  class DSClientError extends Error {
    constructor(message, code) {
      super(String(message || errorMessage(code)));
      this.name = 'DSClientError';
      this.code = code || 'BAD_RESPONSE';
    }
  }

  function toErrorInfo(err) {
    if (err && typeof err.code === 'string' && err.code) {
      return { code: err.code, message: String(err.message || errorMessage(err.code)) };
    }
    const message = err && err.message ? String(err.message) : 'DeepSeek 请求失败';
    return { code: 'BAD_RESPONSE', message: message };
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function statusToCode(status) {
    if (status === 401 || status === 403) return 'AUTH';
    if (status === 402) return 'BALANCE';
    if (status === 429) return 'RATE';
    if (status >= 500) return 'SERVER';
    return 'BAD_RESPONSE';
  }

  function mentionsResponseFormat(text) {
    return /response[_-]?format|json_object/i.test(String(text || ''));
  }

  function serverMessage(out) {
    const data = out && out.data;
    if (data && typeof data === 'object') {
      if (data.error && typeof data.error === 'object' && data.error.message) return String(data.error.message).slice(0, 160);
      if (typeof data.error === 'string') return data.error.slice(0, 160);
      if (data.message) return String(data.message).slice(0, 160);
    }
    return '';
  }

  function extractContent(data) {
    if (!data || !Array.isArray(data.choices) || !data.choices.length) return '';
    const choice = data.choices[0] || {};
    const message = choice.message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    return content.trim();
  }

  function now() {
    return Date.now();
  }

  /**
   * 创建 DeepSeek 客户端。
   * @param {{apiKey?:string, baseUrl?:string, model?:string, temperature?:number,
   *          fetchImpl?:Function, timeoutMs?:number, signal?:AbortSignal,
   *          retryDelays?:number[]}} options
   */
  function createClient(options) {
    const opts = options || {};
    const apiKey = String(opts.apiKey == null ? '' : opts.apiKey).trim();
    let baseUrl = String(opts.baseUrl == null ? DEFAULT_BASE_URL : opts.baseUrl).trim().replace(/\/+$/, '');
    if (!baseUrl) baseUrl = DEFAULT_BASE_URL;
    const model = String(opts.model == null ? DEFAULT_MODEL : opts.model).trim() || DEFAULT_MODEL;
    const temperature = clampNumber(opts.temperature, 0, 1.5, DEFAULT_TEMPERATURE);
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const externalSignal = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
    const retryDelays = Array.isArray(opts.retryDelays) && opts.retryDelays.length ? opts.retryDelays : RETRY_DELAYS;
    const fetchImpl = typeof opts.fetchImpl === 'function'
      ? opts.fetchImpl
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    function sleep(ms) {
      return new Promise(function (resolve, reject) {
        if (externalSignal && externalSignal.aborted) {
          reject(new DSClientError(errorMessage('ABORTED'), 'ABORTED'));
          return;
        }
        let timer = null;
        function onAbort() {
          if (timer) clearTimeout(timer);
          reject(new DSClientError(errorMessage('ABORTED'), 'ABORTED'));
        }
        timer = setTimeout(function () {
          if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
          resolve();
        }, Math.max(0, ms));
        if (externalSignal) externalSignal.addEventListener('abort', onAbort);
      });
    }

    /** 单次 HTTP 请求；网络/超时/中断归一为 DSClientError，不在此处重试。 */
    async function fetchJson(payload) {
      if (!fetchImpl) throw new DSClientError('当前环境不支持 fetch，无法请求 DeepSeek', 'NETWORK');
      if (externalSignal && externalSignal.aborted) throw new DSClientError(errorMessage('ABORTED'), 'ABORTED');
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      let timedOut = false;
      let onExternalAbort = null;
      if (controller) {
        if (externalSignal) {
          onExternalAbort = function () {
            try { controller.abort(); } catch (e) { /* 忽略 */ }
          };
          externalSignal.addEventListener('abort', onExternalAbort);
        }
        timer = setTimeout(function () {
          timedOut = true;
          try { controller.abort(); } catch (e) { /* 忽略 */ }
        }, timeoutMs);
      }
      let res = null;
      try {
        res = await fetchImpl(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        });
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          if (timedOut) throw new DSClientError(errorMessage('TIMEOUT'), 'TIMEOUT');
          throw new DSClientError(errorMessage('ABORTED'), 'ABORTED');
        }
        throw new DSClientError(errorMessage('NETWORK'), 'NETWORK');
      } finally {
        if (timer) clearTimeout(timer);
        if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
      }
      let text = '';
      try {
        if (res && typeof res.text === 'function') text = await res.text();
      } catch (e) {
        text = '';
      }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      return {
        ok: !!(res && res.ok),
        status: Number(res && res.status) || 0,
        text: String(text || ''),
        data: data,
      };
    }

    function httpError(out) {
      const code = statusToCode(out.status);
      const detail = serverMessage(out);
      const message = detail ? errorMessage(code) + '（' + detail + '）' : errorMessage(code);
      return new DSClientError(message, code);
    }

    /** 带 429/5xx/网络退避重试的单轮完成请求，返回模型文本。 */
    async function sendWithRetries(payload) {
      let lastError = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const wait = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] || 600;
          await sleep(wait);
        }
        let out = null;
        try {
          out = await fetchJson(payload);
        } catch (err) {
          const code = err && err.code ? err.code : 'NETWORK';
          if (code === 'NETWORK' || code === 'RATE' || code === 'SERVER') {
            lastError = err;
            continue;
          }
          throw err;
        }
        if (out.ok) {
          const content = extractContent(out.data);
          if (!content) throw new DSClientError(errorMessage('BAD_RESPONSE') + '（模型返回空内容）', 'BAD_RESPONSE');
          return content;
        }
        if (out.status === 400 && mentionsResponseFormat(out.text)) {
          const err = new DSClientError('当前模型不支持 response_format:json_object，已自动降级重试', 'BAD_RESPONSE');
          err.responseFormatIssue = true;
          throw err;
        }
        const err = httpError(out);
        if (err.code === 'RATE' || err.code === 'SERVER') {
          lastError = err;
          continue;
        }
        throw err;
      }
      throw lastError || new DSClientError(errorMessage('SERVER'), 'SERVER');
    }

    /** 完整对话：默认 json_object，400 参数不支持时去掉 response_format 重试一次。 */
    async function complete(messages) {
      if (!apiKey) throw new DSClientError(errorMessage('NO_KEY'), 'NO_KEY');
      const base = { model: model, messages: messages, temperature: temperature, stream: false };
      const withFormat = Object.assign({ response_format: { type: 'json_object' } }, base);
      try {
        return await sendWithRetries(withFormat);
      } catch (err) {
        if (err && err.responseFormatIssue) return sendWithRetries(base);
        throw err;
      }
    }

    /** 在 complete 基础上做一次 JSON 修复重试。 */
    async function completeJson(messages, parse) {
      const first = await complete(messages);
      try {
        return parse(first);
      } catch (parseErr) {
        const repairMessages = messages.concat([
          { role: 'assistant', content: first },
          { role: 'user', content: REPAIR_PROMPT },
        ]);
        const second = await complete(repairMessages);
        try {
          return parse(second);
        } catch (secondErr) {
          throw new DSClientError(errorMessage('BAD_JSON'), 'BAD_JSON');
        }
      }
    }

    async function translate(texts) {
      const list = Array.isArray(texts) ? texts.map(function (t) { return String(t == null ? '' : t); }) : [];
      if (!list.length) return [];
      return completeJson(core.buildTranslateMessages(list), function (content) {
        return core.parseTranslations(content, list.length);
      });
    }

    async function lookup(word, sentence) {
      const w = String(word == null ? '' : word).trim();
      if (!w) throw new DSClientError('查词失败：单词为空', 'BAD_RESPONSE');
      const card = await completeJson(core.buildLookupMessages(w, sentence), function (content) {
        return core.parseWordCard(content, w);
      });
      if (!card.word) card.word = w;
      if (!card.lemma) card.lemma = card.word.toLowerCase();
      return card;
    }

    async function test() {
      const started = now();
      try {
        await complete([{ role: 'user', content: '这是一次 json 连通性测试。请只返回 json，不要任何解释：{"ok":true}' }]);
        return { ok: true, model: model, latencyMs: Math.max(0, Math.round(now() - started)) };
      } catch (err) {
        return {
          ok: false,
          model: model,
          latencyMs: Math.max(0, Math.round(now() - started)),
          error: toErrorInfo(err),
        };
      }
    }

    return {
      model: model,
      baseUrl: baseUrl,
      hasKey: function () { return !!apiKey; },
      translate: translate,
      lookup: lookup,
      test: test,
    };
  }

  return {
    createClient: createClient,
    DSClientError: DSClientError,
    errorMessage: errorMessage,
    toErrorInfo: toErrorInfo,
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  };
});
