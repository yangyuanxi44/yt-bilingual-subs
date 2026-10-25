'use strict';
/**
 * src/lib/translate.js 单元测试（node:test，注入 mock fetch，不访问真实网络）。
 * 运行：node --test test/translate.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const core = require('../src/lib/core.js');
const DS = require('../src/lib/translate.js');

/* ------------------------------------------------------------------ *
 * mock fetch 工具
 * ------------------------------------------------------------------ */

function jsonResponse(content, status) {
  const code = status == null ? 200 : status;
  const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: content } }] });
  return {
    ok: code >= 200 && code < 300,
    status: code,
    text: async function () { return body; },
    json: async function () { return JSON.parse(body); },
  };
}

function errorResponse(status, payload) {
  const body = JSON.stringify(payload || { error: { message: '请求失败' } });
  return {
    ok: false,
    status: status,
    text: async function () { return body; },
    json: async function () { return JSON.parse(body); },
  };
}

function makeClient(handler, extra) {
  const calls = [];
  const options = Object.assign({
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.deepseek.com/',
    model: 'deepseek-chat',
    temperature: 0.2,
    retryDelays: [1, 1],
    timeoutMs: 500,
    fetchImpl: async function (url, init) {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: url, init: init, body: body });
      return handler(url, init, calls.length, body);
    },
  }, extra || {});
  const client = DS.createClient(options);
  return { client: client, calls: calls };
}

function expectCode(code) {
  return function (err) {
    assert.ok(err instanceof DS.DSClientError, '应为 DSClientError: ' + String(err && err.message));
    assert.equal(err.code, code);
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length > 0, '错误文案不能为空');
    return true;
  };
}

/* ------------------------------------------------------------------ *
 * translate 正常路径
 * ------------------------------------------------------------------ */

test('translate：正常返回与请求格式（OpenAI 兼容端点 / json_object）', async function () {
  const { client, calls } = makeClient(function () {
    return jsonResponse(JSON.stringify({ translations: [{ i: 0, zh: '你好' }, { i: 1, zh: '世界' }] }));
  });
  const out = await client.translate(['Hello', 'World']);
  assert.deepEqual(out, ['你好', '世界']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].body.model, 'deepseek-chat');
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.ok(calls[0].body.messages[0].content.length > 0);
});

test('translate：空数组不发请求', async function () {
  const { client, calls } = makeClient(function () { return jsonResponse('{}'); });
  assert.deepEqual(await client.translate([]), []);
  assert.equal(calls.length, 0);
});

test('translate：容忍 ```json 围栏与前后废话', async function () {
  const { client } = makeClient(function () {
    return jsonResponse('好的，结果如下：\n```json\n{"translations":[{"i":0,"zh":"你好"}]}\n```');
  });
  assert.deepEqual(await client.translate(['Hello']), ['你好']);
});

test('translate：缺失条目补空串', async function () {
  const { client } = makeClient(function () {
    return jsonResponse('{"translations":[{"i":0,"zh":"你好"}]}');
  });
  assert.deepEqual(await client.translate(['Hello', 'World']), ['你好', '']);
});

test('translate：JSON 解析失败自动追加一次修复重试', async function () {
  const { client, calls } = makeClient(function (url, init, n) {
    if (n === 1) return jsonResponse('抱歉，我不能输出 JSON。');
    return jsonResponse('{"translations":[{"i":0,"zh":"你好"}]}');
  });
  const out = await client.translate(['Hello']);
  assert.deepEqual(out, ['你好']);
  assert.equal(calls.length, 2);
  const repairText = calls[1].body.messages.map(function (m) { return m.content; }).join('\n');
  assert.ok(/合法 JSON/.test(repairText), '第二次请求应包含修复提示');
  assert.equal(calls[1].body.messages[1].content, calls[0].body.messages[1].content);
});

test('translate：两次都无法解析 → BAD_JSON', async function () {
  const { client } = makeClient(function () { return jsonResponse('这里没有 JSON'); });
  await assert.rejects(client.translate(['Hello']), expectCode('BAD_JSON'));
});

/* ------------------------------------------------------------------ *
 * lookup
 * ------------------------------------------------------------------ */

const CARD_JSON = JSON.stringify({
  word: 'wonder',
  lemma: 'wonder',
  phonetic: '/ˈwʌndər/',
  senses: [{ pos: 'v.', zh: '想知道；纳闷' }, { pos: 'n.', zh: '惊奇' }],
  example: { en: 'I wonder where he went.', zh: '我想知道他去了哪里。' },
  context_zh: '我想知道那是什么意思。',
  note: '常接宾语从句',
});

test('lookup：解析单词卡并去除音标斜杠', async function () {
  const { client, calls } = makeClient(function () { return jsonResponse(CARD_JSON); });
  const card = await client.lookup('wonder', 'I wonder what that means.');
  assert.equal(card.word, 'wonder');
  assert.equal(card.lemma, 'wonder');
  assert.equal(card.phonetic, 'ˈwʌndər');
  assert.deepEqual(card.senses, [{ pos: 'v.', en: '', zh: '想知道；纳闷' }, { pos: 'n.', en: '', zh: '惊奇' }]);
  assert.deepEqual(card.example, { en: 'I wonder where he went.', zh: '我想知道他去了哪里。' });
  assert.equal(card.contextZh, '我想知道那是什么意思。');
  assert.equal(card.note, '常接宾语从句');
  assert.ok(calls[0].body.messages[1].content.includes('wonder'));
});

test('lookup：模型没给 word 时回退到点击词', async function () {
  const content = JSON.stringify({ senses: [{ pos: 'n.', zh: '光' }] });
  const { client } = makeClient(function () { return jsonResponse(content); });
  const card = await client.lookup('Light', 'Turn on the light.');
  assert.equal(card.word, 'Light');
  assert.equal(card.lemma, 'light');
  assert.deepEqual(card.senses, [{ pos: 'n.', en: '', zh: '光' }]);
});

test('lookup：空单词直接报错且不发请求', async function () {
  const { client, calls } = makeClient(function () { return jsonResponse(CARD_JSON); });
  await assert.rejects(client.lookup('', 'hello'), expectCode('BAD_RESPONSE'));
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 错误码映射与重试
 * ------------------------------------------------------------------ */

test('错误码：401 → AUTH，不重试', async function () {
  const { client, calls } = makeClient(function () {
    return errorResponse(401, { error: { message: 'Authentication Fails' } });
  });
  await assert.rejects(client.translate(['Hi']), expectCode('AUTH'));
  assert.equal(calls.length, 1);
});

test('错误码：402 → BALANCE，不重试', async function () {
  const { client, calls } = makeClient(function () {
    return errorResponse(402, { error: { message: 'Insufficient Balance' } });
  });
  await assert.rejects(client.translate(['Hi']), expectCode('BALANCE'));
  assert.equal(calls.length, 1);
});

test('错误码：429 → RATE，最多重试 2 次（共 3 次请求）', async function () {
  const { client, calls } = makeClient(function () {
    return errorResponse(429, { error: { message: 'Rate limit' } });
  });
  await assert.rejects(client.translate(['Hi']), expectCode('RATE'));
  assert.equal(calls.length, 3);
});

test('错误码：5xx 先失败后成功 → 自动重试恢复', async function () {
  const { client, calls } = makeClient(function (url, init, n) {
    if (n < 3) return errorResponse(503, { error: { message: 'Service Unavailable' } });
    return jsonResponse('{"translations":[{"i":0,"zh":"你好"}]}');
  });
  assert.deepEqual(await client.translate(['Hello']), ['你好']);
  assert.equal(calls.length, 3);
});

test('错误码：500 持续失败 → SERVER', async function () {
  const { client, calls } = makeClient(function () {
    return errorResponse(500, { error: { message: 'Internal Error' } });
  });
  await assert.rejects(client.translate(['Hi']), expectCode('SERVER'));
  assert.equal(calls.length, 3);
});

test('错误码：网络错误 → NETWORK 并重试', async function () {
  const { client, calls } = makeClient(function () {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(client.translate(['Hi']), expectCode('NETWORK'));
  assert.equal(calls.length, 3);
});

test('错误码：超时 → TIMEOUT，不重试', async function () {
  const { client, calls } = makeClient(function (url, init) {
    return new Promise(function (resolve, reject) {
      const signal = init && init.signal;
      if (signal) {
        signal.addEventListener('abort', function () {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  }, { timeoutMs: 40 });
  await assert.rejects(client.translate(['Hi']), expectCode('TIMEOUT'));
  assert.equal(calls.length, 1);
});

test('错误码：未配置 API Key → NO_KEY，不发请求', async function () {
  const { client, calls } = makeClient(function () { return jsonResponse('{}'); }, { apiKey: '   ' });
  await assert.rejects(client.translate(['Hi']), expectCode('NO_KEY'));
  assert.equal(calls.length, 0);
});

test('400 且与 response_format 有关：去掉该字段重试一次', async function () {
  const { client, calls } = makeClient(function (url, init, n) {
    if (n === 1) return errorResponse(400, { error: { message: "Unsupported parameter: 'response_format'" } });
    return jsonResponse('{"translations":[{"i":0,"zh":"你好"}]}');
  });
  assert.deepEqual(await client.translate(['Hello']), ['你好']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[1].body.response_format, undefined);
});

test('400 与 response_format 无关：BAD_RESPONSE，不降级', async function () {
  const { client, calls } = makeClient(function () {
    return errorResponse(400, { error: { message: 'Invalid model name' } });
  });
  await assert.rejects(client.translate(['Hi']), expectCode('BAD_RESPONSE'));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

/* ------------------------------------------------------------------ *
 * test() 连通性
 * ------------------------------------------------------------------ */

test('test：成功返回模型与延迟', async function () {
  const { client } = makeClient(function () { return jsonResponse('{"ok":true}'); });
  const res = await client.test();
  assert.equal(res.ok, true);
  assert.equal(res.model, 'deepseek-chat');
  assert.equal(typeof res.latencyMs, 'number');
  assert.ok(res.latencyMs >= 0);
});

test('test：失败返回错误信息而不抛异常', async function () {
  const { client } = makeClient(function () {
    return errorResponse(401, { error: { message: 'Authentication Fails' } });
  });
  const res = await client.test();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'AUTH');
  assert.ok(res.error.message.length > 0);
});

test('createClient：默认值补齐（baseUrl 去尾斜杠 / model 默认）', function () {
  const client = DS.createClient({ apiKey: 'k', fetchImpl: async function () { return jsonResponse('{}'); } });
  assert.equal(client.baseUrl, 'https://api.deepseek.com');
  assert.equal(client.model, 'deepseek-chat');
  assert.equal(client.hasKey(), true);
  assert.equal(DS.createClient({ apiKey: '' }).hasKey(), false);
});

test('core 依赖可用（translate 内部使用共享解析）', function () {
  assert.equal(typeof core.parseTranslations, 'function');
  assert.equal(typeof core.buildTranslateMessages, 'function');
  assert.equal(typeof core.buildLookupMessages, 'function');
  assert.equal(typeof core.parseWordCard, 'function');
});
