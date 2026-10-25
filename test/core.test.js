'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Y = require('../src/lib/core.js');

test('normalizeSettings: 补默认值并 clamp', () => {
  const s = Y.normalizeSettings(undefined);
  assert.deepEqual(s, Y.DEFAULT_SETTINGS);
  const s2 = Y.normalizeSettings({ zhSize: 999, enSize: 1, zhMode: 'bad', opacity: -1, prefetchAhead: 9999, batchSize: 0, apiKey: '  sk-1  ', baseUrl: 'https://x.test///', enabled: 0 });
  assert.equal(s2.zhSize, 24);
  assert.equal(s2.enSize, 14);
  assert.equal(s2.zhMode, 'hover');
  assert.equal(s2.opacity, 0.35);
  assert.equal(s2.prefetchAhead, 200);
  assert.equal(s2.batchSize, 1);
  assert.equal(s2.apiKey, 'sk-1');
  assert.equal(s2.baseUrl, 'https://x.test');
  assert.equal(s2.enabled, false);
});

test('normalizeSettings: 合法三态与数值保留', () => {
  const s = Y.normalizeSettings({ zhMode: 'off', zhSize: 8, enSize: 32, temperature: 0.7 });
  assert.equal(s.zhMode, 'off');
  assert.equal(s.zhSize, 8);
  assert.equal(s.enSize, 32);
  assert.equal(s.temperature, 0.7);
});

test('normalizeSettings: 字幕颜色与背景颜色/不透明度', () => {
  const s = Y.normalizeSettings({});
  assert.equal(s.enColor, '#ffffff');
  assert.equal(s.zhColor, '#ffe7a8');
  assert.equal(s.subtitleBgEnabled, true);
  assert.equal(s.subtitleBgColor, '#000000');
  assert.equal(s.subtitleBgOpacity, 0.35);
  assert.equal(Y.normalizeSettings({ subtitleBgEnabled: false }).subtitleBgEnabled, false);
  const s2 = Y.normalizeSettings({ enColor: '#FF0000', zhColor: 'bad', subtitleBgColor: '#123456', subtitleBgOpacity: 2 });
  assert.equal(s2.enColor, '#ff0000');
  assert.equal(s2.zhColor, '#ffe7a8');
  assert.equal(s2.subtitleBgColor, '#123456');
  assert.equal(s2.subtitleBgOpacity, 1);
  assert.equal(Y.normalizeSettings({ subtitleBgOpacity: -1 }).subtitleBgOpacity, 0);
});

test('normalizeSettings: 单词卡中文释义开关（不影响视频字幕）', () => {
  assert.equal(Y.normalizeSettings({}).showCardChinese, true);
  assert.equal(Y.normalizeSettings({ showCardChinese: false }).showCardChinese, false);
  assert.equal(Y.normalizeSettings({ showCardChinese: 0 }).showCardChinese, false);
});

test('normalizeSettings: 单词卡显示本句翻译默认开启', () => {
  assert.equal(Y.normalizeSettings({}).showContextZh, true);
  assert.equal(Y.normalizeSettings({ showContextZh: false }).showContextZh, false);
});

test('normalizeSettings: 字幕对齐默认左对齐，非法值回退', () => {
  assert.equal(Y.normalizeSettings({}).subtitleAlign, 'left');
  assert.equal(Y.normalizeSettings({ subtitleAlign: 'center' }).subtitleAlign, 'center');
  assert.equal(Y.normalizeSettings({ subtitleAlign: 'right' }).subtitleAlign, 'left');
});

test('normalizeSettings: 字幕拖动位置归一化与复位', () => {
  assert.equal(Y.normalizeSettings({}).subtitlePos, null);
  assert.deepEqual(Y.normalizeSettings({ subtitlePos: { x: 0.2, y: 0.8 } }).subtitlePos, { x: 0.2, y: 0.8 });
  assert.deepEqual(Y.normalizeSettings({ subtitlePos: { x: -1, y: 2 } }).subtitlePos, { x: 0, y: 1 });
  assert.equal(Y.normalizeSettings({ subtitlePos: { x: 'bad', y: 0.5 } }).subtitlePos, null);
  assert.equal(Y.normalizeSettings({ subtitlePos: 'nope' }).subtitlePos, null);
  assert.equal(Y.normalizeSettings({ subtitlePos: null }).subtitlePos, null);
  // 显式复位后应回到默认位置
  assert.equal(Y.normalizeSettings({ subtitlePos: { x: 0.3, y: 0.3 }, zhMode: 'off' }).subtitlePos.x, 0.3);
});

test('tokenize: 保留原文、标点与空格，识别单词', () => {
  const text = "Don't stop—well-known 2024! It's fine.";
  const tokens = Y.tokenize(text);
  assert.equal(tokens.map((t) => t.v).join(''), text);
  const words = tokens.filter((t) => t.word).map((t) => t.v);
  assert.deepEqual(words, ["Don't", 'stop', 'well-known', '2024', "It's", 'fine']);
  assert.deepEqual(Y.tokenize(''), []);
});

test('wordForLookup: 去标点、所有格、小写', () => {
  assert.equal(Y.wordForLookup('Word,'), 'word');
  assert.equal(Y.wordForLookup("James's"), 'james');
  assert.equal(Y.wordForLookup('—Hello!'), 'hello');
  assert.equal(Y.wordForLookup('2024'), '2024');
  assert.equal(Y.wordForLookup(''), '');
});

test('parseJson3: 基本解析 / aAppend 忽略 / 时间单调不重叠', () => {
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Hello there.' }] },
      { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'This is a test' }, { utf8: ' of the parser.' }] },
      { tStartMs: 5000, aAppend: true, segs: [{ utf8: 'ignore me' }] },
      { tStartMs: 6000, dDurationMs: 1500, segs: [{ utf8: '  ' }] },
      { tStartMs: 8000, dDurationMs: 2500, segs: [{ utf8: 'Last line.' }] },
    ],
  };
  const cues = Y.parseJson3(json3);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'Hello there.');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 3);
  assert.equal(cues[1].text, 'This is a test of the parser.');
  assert.equal(cues[2].text, 'Last line.');
  for (let i = 0; i < cues.length; i++) {
    assert.equal(cues[i].index, i);
    assert.ok(cues[i].end > cues[i].start);
    if (i + 1 < cues.length) assert.ok(cues[i].end <= cues[i + 1].start + 1e-9, 'cue overlap');
  }
});

test('parseJson3: 接受字符串输入，非法输入返回空数组', () => {
  assert.deepEqual(Y.parseJson3('not json'), []);
  assert.deepEqual(Y.parseJson3(null), []);
  assert.deepEqual(Y.parseJson3({}), []);
  const cues = Y.parseJson3(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi' }] }] }));
  assert.equal(cues.length, 1);
});

test('parseJson3: 长句按标点切分且时长覆盖原区间', () => {
  const text = 'This is the first clause, and this is the second clause, followed by a third clause which is long enough to require splitting.';
  const json3 = { events: [{ tStartMs: 1000, dDurationMs: 8000, segs: [{ utf8: text }] }] };
  const cues = Y.parseJson3(json3);
  assert.ok(cues.length >= 2, 'should split long cue');
  assert.ok(Math.abs(cues[0].start - 1) < 1e-9);
  const last = cues[cues.length - 1];
  assert.ok(last.end <= 9 + 1e-9 && last.end >= 8.5);
  for (const c of cues) {
    assert.ok(c.text.length > 0);
    assert.ok(c.end > c.start);
    assert.ok(c.end - c.start <= 9);
  }
});

test('parseJson3: 超大 event 只在 start..end 内切块不重叠', () => {
  const words = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ');
  const cues = Y.parseJson3({ events: [{ tStartMs: 0, dDurationMs: 6000, segs: [{ utf8: words }] }] });
  assert.ok(cues.length >= 4);
  assert.ok(cues[0].start >= 0);
  assert.ok(cues[cues.length - 1].end <= 6 + 1e-9);
  for (let i = 0; i + 1 < cues.length; i++) assert.ok(cues[i].end <= cues[i + 1].start + 1e-9);
});

test('findCueIndex: 命中、间隙、越界', () => {
  const cues = [
    { start: 0, end: 2, text: 'a', index: 0 },
    { start: 5, end: 7, text: 'b', index: 1 },
  ];
  assert.equal(Y.findCueIndex(cues, 1), 0);
  assert.equal(Y.findCueIndex(cues, 2.2), 0); // grace 0.45
  assert.equal(Y.findCueIndex(cues, 2.6), -1);
  assert.equal(Y.findCueIndex(cues, 5), 1);
  assert.equal(Y.findCueIndex(cues, 7.4), 1);
  assert.equal(Y.findCueIndex(cues, 7.6), -1);
  assert.equal(Y.findCueIndex(cues, -1), -1);
  assert.equal(Y.findCueIndex([], 1), -1);
});

test('pickEnglishTrack: 手动轨优先于自动轨', () => {
  const tracks = [
    { languageCode: 'zh-Hans', kind: '', baseUrl: 'zh' },
    { languageCode: 'en', kind: 'asr', baseUrl: 'en-auto' },
    { languageCode: 'en-US', kind: '', baseUrl: 'en-manual' },
  ];
  assert.equal(Y.pickEnglishTrack(tracks).baseUrl, 'en-manual');
  assert.equal(Y.pickEnglishTrack([{ languageCode: 'en', kind: 'asr', baseUrl: 'auto' }]).baseUrl, 'auto');
  assert.equal(Y.pickEnglishTrack([{ languageCode: 'ja', baseUrl: 'ja' }]), null);
  assert.equal(Y.pickEnglishTrack([]), null);
  assert.equal(Y.pickEnglishTrack(null), null);
});

test('extractJson: 围栏、前后废话、数组、坏 JSON', () => {
  assert.deepEqual(Y.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(Y.extractJson('好的，结果是：{"a":"含 } 括号"} 谢谢'), { a: '含 } 括号' });
  assert.deepEqual(Y.extractJson('prefix [1,2,3] suffix'), [1, 2, 3]);
  assert.throws(() => Y.extractJson('no json here'), /NO_JSON/);
  assert.throws(() => Y.extractJson('{"a":1'), /UNCLOSED_JSON/);
  assert.throws(() => Y.extractJson(''), /EMPTY_RESPONSE/);
});

test('parseTranslations: 对象/数组/索引映射/缺失补空', () => {
  const out = Y.parseTranslations('{"translations":[{"i":0,"zh":"第一句"},{"i":2,"zh":"第三句"}]}', 3);
  assert.deepEqual(out, ['第一句', '', '第三句']);
  assert.deepEqual(Y.parseTranslations('["甲","乙"]', 2), ['甲', '乙']);
  assert.deepEqual(Y.parseTranslations('{"translations":[{"index":1,"text":"1. 乙"}]}', 2), ['', '乙']);
  assert.throws(() => Y.parseTranslations('{"translations":[]}', 2), /EMPTY_TRANSLATIONS/);
  assert.throws(() => Y.parseTranslations('{"nope":1}', 2), /BAD_TRANSLATIONS/);
});

test('parseWordCard: 派生词与常见短语', () => {
  const card = Y.parseWordCard(JSON.stringify({
    word: 'wonder',
    senses: [{ pos: 'n.', zh: '奇迹' }],
    derivatives: [{ word: 'wonderful', pos: 'adj.', zh: '精彩的' }, 'wonderfully'],
    phrases: [{ en: 'no wonder', zh: '难怪' }, 'work wonders'],
  }), 'wonder');
  assert.equal(card.derivatives.length, 2);
  assert.equal(card.derivatives[0].word, 'wonderful');
  assert.equal(card.derivatives[1].word, 'wonderfully');
  assert.equal(card.phrases.length, 2);
  assert.equal(card.phrases[0].en, 'no wonder');
  assert.equal(card.phrases[1].zh, '');
  assert.deepEqual(Y.parseWordCard('{"senses":[{"zh":"跑"}]}', 'run').derivatives, []);
});

test('parseWordCard: 完整/最小/失败', () => {
  const raw = JSON.stringify({
    word: 'wonderful',
    lemma: 'wonderful',
    phonetic: '/ˈwʌndəfəl/',
    senses: [{ pos: 'adj.', en: 'extremely good; making you feel happy', zh: '精彩的；极好的' }, { pos: '', zh: '令人惊叹的' }],
    example: { en: 'What a wonderful day!', zh: '多美好的一天！' },
    context_en: 'This is really wonderful.',
    context_zh: '这真是太好了。',
    note: '口语中常用来表达赞叹',
  });
  const card = Y.parseWordCard(raw, 'wonderful');
  assert.equal(card.word, 'wonderful');
  assert.equal(card.phonetic, 'ˈwʌndəfəl');
  assert.equal(card.senses.length, 2);
  assert.equal(card.senses[0].en, 'extremely good; making you feel happy');
  assert.equal(card.example.en, 'What a wonderful day!');
  assert.equal(card.contextEn, 'This is really wonderful.');
  assert.equal(card.contextZh, '这真是太好了。');

  const minimal = Y.parseWordCard('{"zh":"跑"}', 'run');
  assert.equal(minimal.word, 'run');
  assert.deepEqual(minimal.senses, [{ pos: '', en: '', zh: '跑' }]);
  assert.equal(minimal.example, null);

  assert.throws(() => Y.parseWordCard('{"foo":1}', 'x'), /BAD_WORD_CARD/);
  assert.throws(() => Y.parseWordCard('not json', 'x'));
});

test('cacheKey: 稳定且区分模型/文本', () => {
  const a = Y.cacheKey('hello', 'deepseek-chat');
  assert.equal(a, Y.cacheKey('hello', 'deepseek-chat'));
  assert.notEqual(a, Y.cacheKey('hello!', 'deepseek-chat'));
  assert.notEqual(a, Y.cacheKey('hello', 'other-model'));
  assert.match(a, /^c[a-z0-9]+-[a-z0-9]+$/);
});

test('getVideoIdFromUrl / isSupportedPage', () => {
  assert.equal(Y.getVideoIdFromUrl('https://www.youtube.com/watch?v=abc123XYZ_-'), 'abc123XYZ_-');
  assert.equal(Y.getVideoIdFromUrl('https://www.youtube.com/live/xyz789'), 'xyz789');
  assert.equal(Y.getVideoIdFromUrl('https://www.youtube.com/feed/subscriptions'), null);
  assert.equal(Y.isSupportedPage('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(Y.isSupportedPage('https://www.youtube.com/shorts/abc'), false);
  assert.equal(Y.isSupportedPage('https://example.com/watch?v=abc'), false);
});

test('wordbookToCsv: BOM、表头、转义', () => {
  const csv = Y.wordbookToCsv([
    { word: 'say', lemma: 'say', phonetic: 'seɪ', senses: [{ pos: 'v.', zh: '说；讲' }], example: { en: 'Say "hi".', zh: '说“嗨”。' }, videoTitle: 'A, B', time: 65, createdAt: 1700000000000 },
  ]);
  assert.ok(csv.startsWith('\ufeff'));
  const header = csv.split('\r\n')[0];
  assert.match(header, /单词,音标,词性,释义/);
  assert.ok(csv.includes('"Say ""hi""."'));
  assert.ok(csv.includes('"A, B"'));
  assert.ok(csv.includes('1:05'));
});

test('chunk / formatTime / hashString', () => {
  assert.deepEqual(Y.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(Y.chunk([], 3), []);
  assert.equal(Y.formatTime(65), '1:05');
  assert.equal(Y.formatTime(0), '0:00');
  assert.equal(Y.hashString('abc'), Y.hashString('abc'));
  assert.notEqual(Y.hashString('abc'), Y.hashString('abd'));
});
