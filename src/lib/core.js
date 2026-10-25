/*!
 * YT 双语字幕 · 点词查意 — core library
 * 经典脚本（无构建步骤）：同时可用于 content script / service worker / node 测试。
 * 暴露 globalThis.YTBTL（浏览器）或 module.exports（node）。
 */
(function (root, factory) {
  const api = factory();
  if (root) root.YTBTL = Object.assign(root.YTBTL || {}, api);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const TARGET_LANG = '简体中文';
  // 原生英文 + 中文模式暂时关闭（保留代码，后续排查完再打开）
  const NATIVE_MODE_ENABLED = false;

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  const DEFAULT_SETTINGS = Object.freeze({
    // 显示
    enabled: true,
    subtitleMode: 'overlay', // overlay = 插件英文+中文（可点词）；native = YouTube 原生英文 + 插件中文
    showCardChinese: true, // 只控制单词卡里的中文释义；视频字幕中文由工具栏「中」切换
    enSize: 24,
    enColor: '#ffffff',
    zhMode: 'hover', // off | hover | on
    zhSize: 11,
    zhColor: '#ffe7a8',
    subtitleBgEnabled: true,
    subtitleBgColor: '#000000',
    subtitleBgOpacity: 0.35,
    opacity: 0.95,
    bottomOffset: 92, // 字幕区距播放器底部 px
    subtitleAlign: 'left', // left | center：左对齐时字幕起点固定，滚动更新不左右跳
    subtitlePos: null, // {x,y}：拖动后的归一化左上角坐标（0–1）；null = 默认底部居中
    hideNativeCaptions: true,
    hideNativeWhenOff: false, // 关闭插件字幕后是否也隐藏原生字幕；默认关闭 = 退回 YouTube 原生字幕
    // 学习行为
    pauseOnWordClick: true,
    resumeAfterCard: true,
    showContextZh: true,
    // 翻译
    autoTranslate: true,
    prefetchAhead: 30,
    batchSize: 12,
    // DeepSeek
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.2,
  });

  /**
   * 设置项元数据：popup / options 页面按此渲染，避免三处重复定义。
   * type: boolean | select | range | text | password | number
   */
  const SETTINGS_SCHEMA = Object.freeze([
    { key: 'enabled', group: '显示', label: '启用双语字幕', type: 'boolean', hint: '关闭后完全隐藏本插件字幕' },
    { key: 'subtitleMode', group: '显示', label: '字幕模式', type: 'select', default: 'overlay',
      options: [
        { value: 'overlay', label: '覆盖模式（插件英文 + 中文，可点词）' },
        { value: 'native', label: '原生英文 + 中文（最流畅，英文不可点词）' },
      ],
      hint: '原生模式：英文由 YouTube 自己渲染，插件只在原生字幕上方叠加中文；英文不能再点击查词' },
    { key: 'showCardChinese', group: '显示', label: '单词卡显示中文释义', type: 'boolean', default: true, hint: '只影响点击单词后的卡片；视频字幕的中文请用播放器工具栏「中」按钮切换' },
    { key: 'zhMode', group: '显示', label: '中文字幕', type: 'select', default: 'hover',
      options: [
        { value: 'off', label: '隐藏（只看英文）' },
        { value: 'hover', label: '悬停时显示' },
        { value: 'on', label: '常显' },
      ],
      hint: '推荐「悬停时显示」：把鼠标移到字幕上才出现中文，减少依赖' },
    { key: 'zhSize', group: '显示', label: '中文字幕字号', type: 'range', min: 8, max: 24, step: 1, unit: 'px', hint: '最小 8px，非必要不看' },
    { key: 'enSize', group: '显示', label: '英文字幕字号', type: 'range', min: 14, max: 40, step: 1, unit: 'px' },
    { key: 'enColor', group: '显示', label: '英文字幕颜色', type: 'color', default: '#ffffff' },
    { key: 'zhColor', group: '显示', label: '中文字幕颜色', type: 'color', default: '#ffe7a8' },
    { key: 'subtitleBgEnabled', group: '显示', label: '显示字幕框背景', type: 'boolean', hint: '关闭后完全去掉字幕背后的底色和内边距，只保留文字描边' },
    { key: 'subtitleBgColor', group: '显示', label: '字幕框背景颜色', type: 'color', default: '#000000', hint: '只影响字幕文字背后的底色' },
    { key: 'subtitleBgOpacity', group: '显示', label: '字幕框背景不透明度', type: 'range', min: 0, max: 1, step: 0.05, hint: '0 = 完全透明；0.3–0.6 兼顾可读性与画面' },
    { key: 'opacity', group: '显示', label: '字幕不透明度', type: 'range', min: 0.35, max: 1, step: 0.05 },
    { key: 'subtitleAlign', group: '显示', label: '字幕对齐', type: 'select', default: 'left',
      options: [
        { value: 'left', label: '左对齐（滚动刷新不跳动）' },
        { value: 'center', label: '居中' },
      ],
      hint: '左对齐时每句字幕都从固定起点开始，自动字幕逐词刷新时不会左右闪动' },
    { key: 'bottomOffset', group: '显示', label: '字幕距底部', type: 'range', min: 40, max: 220, step: 4, unit: 'px' },
    { key: 'hideNativeCaptions', group: '显示', label: '隐藏 YouTube 原生字幕', type: 'boolean', hint: '避免与插件字幕重复显示' },
    { key: 'hideNativeWhenOff', group: '显示', label: '关闭字幕后也隐藏原生字幕', type: 'boolean', default: false, hint: '默认关闭：关掉插件字幕就退回 YouTube 原生字幕；打开则关掉插件后整块字幕都不显示' },

    { key: 'pauseOnWordClick', group: '学习', label: '点击单词时暂停播放', type: 'boolean' },
    { key: 'resumeAfterCard', group: '学习', label: '关闭单词卡后继续播放', type: 'boolean' },
    { key: 'showContextZh', group: '学习', label: '单词卡显示本句翻译', type: 'boolean', default: true, hint: '关闭后单词卡只保留单词释义、例句、派生词和短语' },

    { key: 'autoTranslate', group: '翻译', label: '自动翻译中文字幕', type: 'boolean', hint: '关闭后只查词、不生成中文' },
    { key: 'prefetchAhead', group: '翻译', label: '预翻译前瞻', type: 'range', min: 0, max: 200, step: 5, unit: '句', hint: '提前翻译当前句之后的 N 句；0 表示只翻当前句' },
    { key: 'batchSize', group: '翻译', label: '每批句数', type: 'range', min: 1, max: 30, step: 1, unit: '句', hint: '一次请求翻译多少句，越大越省请求但延迟更高' },

    { key: 'apiKey', group: 'DeepSeek', label: 'API Key', type: 'password', placeholder: 'sk-...', hint: '只保存在本机 chrome.storage.local，不会上传到别处' },
    { key: 'baseUrl', group: 'DeepSeek', label: 'API 地址', type: 'text', placeholder: 'https://api.deepseek.com', hint: '兼容 OpenAI 格式；可填代理地址' },
    { key: 'model', group: 'DeepSeek', label: '模型', type: 'text', placeholder: 'deepseek-chat', hint: '默认 deepseek-chat：快、便宜、支持 JSON 输出，适合字幕；deepseek-reasoner 推理更强但更慢更贵，字幕场景一般不需要。换模型后缓存自动失效' },
    { key: 'temperature', group: 'DeepSeek', label: '温度', type: 'number', min: 0, max: 1.5, step: 0.1, hint: '字幕翻译/查词建议 0–0.3：越低越稳定、越贴近原意；越高越灵活但可能改写或漏译。修改后只影响新请求，已缓存结果需清除缓存才会重算' },
  ]);

  const ENUM_VALUES = {
    zhMode: ['off', 'hover', 'on'],
    subtitleAlign: ['left', 'center'],
    subtitleMode: ['overlay', 'native'],
  };
  const NUMBER_LIMITS = {
    enSize: [14, 40],
    zhSize: [8, 24],
    subtitleBgOpacity: [0, 1],
    opacity: [0.35, 1],
    bottomOffset: [40, 220],
    prefetchAhead: [0, 200],
    batchSize: [1, 30],
    temperature: [0, 1.5],
  };

  function normalizeColor(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
  }

  function normalizeSettings(raw) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const def = DEFAULT_SETTINGS[key];
      if (!(key in raw) || raw[key] === undefined || raw[key] === null) continue;
      const val = raw[key];
      if (typeof def === 'boolean') {
        out[key] = !!val;
      } else if (typeof def === 'number') {
        const n = Number(val);
        if (Number.isFinite(n)) {
          const lim = NUMBER_LIMITS[key];
          out[key] = lim ? Math.min(lim[1], Math.max(lim[0], n)) : n;
        }
      } else if (ENUM_VALUES[key]) {
        if (ENUM_VALUES[key].includes(val)) out[key] = val;
      } else {
        out[key] = String(val);
      }
    }
    if (!out.model) out.model = DEFAULT_SETTINGS.model;
    if (!out.baseUrl) out.baseUrl = DEFAULT_SETTINGS.baseUrl;
    if (!NATIVE_MODE_ENABLED) out.subtitleMode = 'overlay';
    out.apiKey = String(out.apiKey || '').trim();
    out.baseUrl = String(out.baseUrl || '').trim().replace(/\/+$/, '');
    out.model = String(out.model || '').trim();
    out.enColor = normalizeColor(out.enColor, DEFAULT_SETTINGS.enColor);
    out.zhColor = normalizeColor(out.zhColor, DEFAULT_SETTINGS.zhColor);
    out.subtitleBgColor = normalizeColor(out.subtitleBgColor, DEFAULT_SETTINGS.subtitleBgColor);
    // 字幕拖动位置：只接受 {x,y} 归一化坐标，其余一律视为「默认位置」
    const rawPos = raw && raw.subtitlePos;
    const px = rawPos && Number(rawPos.x);
    const py = rawPos && Number(rawPos.y);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      out.subtitlePos = {
        x: Math.min(1, Math.max(0, px)),
        y: Math.min(1, Math.max(0, py)),
      };
    } else {
      out.subtitlePos = null;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 通用小工具
   * ------------------------------------------------------------------ */

  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + '-' + str.length.toString(36);
  }

  /** 翻译缓存 key：与视频无关，同一句在多处复用 */
  function cacheKey(text, model) {
    return 'c' + hashString(String(model || '') + '\u0000' + String(text || ''));
  }

  function chunk(arr, size) {
    const out = [];
    const n = Math.max(1, Number(size) || 1);
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function cleanText(input) {
    return String(input == null ? '' : input)
      .replace(/\u200b/g, '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  function getVideoIdFromUrl(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.pathname === '/watch') return u.searchParams.get('v') || null;
      const m = u.pathname.match(/^\/(?:live|embed|shorts)\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
      return null;
    } catch (e) {
      return null;
    }
  }

  function isSupportedPage(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.hostname !== 'www.youtube.com' && u.hostname !== 'youtube.com' && u.hostname !== 'm.youtube.com') return false;
      if (u.pathname.startsWith('/shorts')) return false; // 播放器布局不同，v1 不支持
      return u.pathname === '/watch' || u.pathname === '/live';
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 字幕解析（YouTube timedtext JSON3）
   * ------------------------------------------------------------------ */

  function estimateDuration(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.min(9, Math.max(1.2, words * 0.34 + 0.7));
  }

  function splitSentences(text) {
    const t = cleanText(text);
    if (!t) return [];
    const parts = t.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [t];
    return parts.map(cleanText).filter(Boolean);
  }

  function wordCountOf(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  /**
   * 把一条 timedtext event 切成适合字幕显示的短句。
   * 规则：先按句末标点分句；长句再按逗号 / 词数上限切块；时长按字符数比例分配。
   */
  function splitCue(cue, options) {
    const maxWords = (options && options.maxWords) || 12;
    const maxChars = (options && options.maxChars) || 84;
    const text = cleanText(cue.text);
    if (!text) return [];
    const start = Number(cue.start) || 0;
    const end = Math.max(start + 0.6, Number(cue.end) || start + estimateDuration(text));
    if (wordCountOf(text) <= maxWords && text.length <= maxChars) {
      return [{ start: start, end: end, text: text }];
    }

    const pieces = [];
    for (const sentence of splitSentences(text)) {
      const words = sentence.split(/\s+/).filter(Boolean);
      if (words.length <= maxWords && sentence.length <= maxChars) {
        pieces.push(sentence);
        continue;
      }
      // 优先在逗号/分号处切
      const clauses = sentence.match(/[^,;:—–]+[,;:—–]*/g) || [sentence];
      let buf = '';
      for (const clauseRaw of clauses) {
        const clause = cleanText(clauseRaw);
        if (!clause) continue;
        const candidate = buf ? buf + ' ' + clause : clause;
        if (wordCountOf(candidate) > maxWords || candidate.length > maxChars) {
          if (buf) pieces.push(buf);
          buf = clause;
          if (wordCountOf(buf) > maxWords || buf.length > maxChars) {
            // 极端长句：按词数硬切
            const ws = buf.split(/\s+/).filter(Boolean);
            for (let i = 0; i < ws.length; i += maxWords) {
              pieces.push(ws.slice(i, i + maxWords).join(' '));
            }
            buf = '';
          }
        } else {
          buf = candidate;
        }
      }
      if (buf) pieces.push(buf);
    }

    const cleanPieces = pieces.map(cleanText).filter(Boolean);
    if (cleanPieces.length <= 1) return [{ start: start, end: end, text: text }];

    const totalChars = cleanPieces.reduce((s, p) => s + p.length, 0) || 1;
    const duration = Math.max(0.6 * cleanPieces.length, end - start);
    const out = [];
    let cursor = start;
    for (let i = 0; i < cleanPieces.length; i++) {
      const share = (cleanPieces[i].length / totalChars) * duration;
      const isLast = i === cleanPieces.length - 1;
      const pieceEnd = isLast ? Math.max(cursor + 0.6, end) : Math.min(end, cursor + Math.max(0.7, share));
      out.push({ start: cursor, end: pieceEnd, text: cleanPieces[i] });
      cursor = pieceEnd;
    }
    return out;
  }

  function finalizeCues(rawCues) {
    const cues = [];
    const seen = new Set();
    for (const c of rawCues) {
      if (!c || !c.text) continue;
      const key = c.text + '@' + Math.round(c.start * 2);
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(c);
    }
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      c.start = Math.max(0, Number(c.start) || 0);
      c.end = Math.max(c.start + 0.5, Number(c.end) || c.start + 2);
      if (c.end - c.start > 9) c.end = c.start + 9;
      const next = cues[i + 1];
      if (next && next.start > c.start && next.start < c.end) {
        c.end = Math.max(c.start + 0.5, next.start);
      }
      c.index = i;
    }
    return cues;
  }

  /**
   * 解析 timedtext JSON3 → 归一化字幕数组 [{start,end,text,index}]
   * @param {object|string} input
   * @param {{maxWords?:number,maxChars?:number}} [options]
   */
  function parseJson3(input, options) {
    const data = typeof input === 'string' ? safeJson(input) : input;
    if (!data || !Array.isArray(data.events)) return [];
    const raw = [];
    for (const ev of data.events) {
      if (!ev || ev.aAppend) continue;
      const segs = Array.isArray(ev.segs) ? ev.segs : [];
      let text = '';
      for (const seg of segs) {
        if (seg && typeof seg.utf8 === 'string') text += seg.utf8;
      }
      text = cleanText(text);
      if (!text) continue;
      const start = Math.max(0, Number(ev.tStartMs || 0) / 1000);
      const durSec = Number(ev.dDurationMs || 0) / 1000;
      raw.push({ start: start, end: start + (durSec > 0 ? durSec : estimateDuration(text)), text: text });
    }
    const out = [];
    for (const c of raw) {
      const parts = splitCue(c, options);
      for (const p of parts) out.push(p);
    }
    return finalizeCues(out);
  }

  function safeJson(str) {
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  /** 二分查找当前时间对应的字幕下标；不在任何字幕区间返回 -1 */
  function findCueIndex(cues, time, grace) {
    if (!Array.isArray(cues) || !cues.length) return -1;
    const t = Number(time) || 0;
    if (t < cues[0].start) return -1;
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return -1;
    const g = grace == null ? 0.45 : grace;
    return t <= cues[ans].end + g ? ans : -1;
  }

  function pickEnglishTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const usable = tracks.filter(function (t) { return t && t.baseUrl; });
    const manual = usable.filter(function (t) {
      return /^en(?:[-_]|$)/i.test(String(t.languageCode || '')) && t.kind !== 'asr';
    });
    const auto = usable.filter(function (t) {
      return /^en(?:[-_]|$)/i.test(String(t.languageCode || '')) && t.kind === 'asr';
    });
    return manual[0] || auto[0] || null;
  }

  /* ------------------------------------------------------------------ *
   * 分词 / 查词
   * ------------------------------------------------------------------ */

  const WORD_RE = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g;

  /**
   * 保留原始空格与标点的分词结果，用于把一条字幕渲染成可点击的 spans。
   * @returns {{v:string, word:boolean}[]}
   */
  function tokenize(text) {
    const src = String(text == null ? '' : text);
    const tokens = [];
    let last = 0;
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(src))) {
      if (m.index > last) tokens.push({ v: src.slice(last, m.index), word: false });
      tokens.push({ v: m[0], word: true });
      last = m.index + m[0].length;
    }
    if (last < src.length) tokens.push({ v: src.slice(last), word: false });
    return tokens;
  }

  /** 点击的原始词 → 用于查词的原形提示（去首尾符号、所有格、小写） */
  function wordForLookup(raw) {
    let w = String(raw == null ? '' : raw).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    w = w.replace(/['’]s$/i, '');
    return w.toLowerCase();
  }

  /* ------------------------------------------------------------------ *
   * DeepSeek 提示词与响应解析
   * ------------------------------------------------------------------ */

  const TRANSLATE_SYSTEM_PROMPT = [
    'You are a professional subtitle translator. Translate English video subtitles into natural, concise Simplified Chinese for a Chinese learner watching with English audio.',
    'Rules:',
    '1. Translate each line independently and faithfully; keep the original meaning and tone. Do not add explanations.',
    '2. Keep each translation short enough for a subtitle, ideally within 32 Chinese characters.',
    '3. Keep proper nouns, numbers and technical terms accurate. Keep a well-known English term if translating it would confuse.',
    '4. Incomplete fragments must stay fragments; never invent context.',
    '5. Output ONLY JSON, no markdown fences: {"translations":[{"i":0,"zh":"简体中文译文"}]}',
    'Return exactly one entry for every input line, using the same index i.',
  ].join('\n');

  function buildTranslateMessages(texts) {
    const lines = texts.map(function (t, i) {
      return { i: i, en: String(t) };
    });
    return [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({ task: 'translate_subtitles', target_language: TARGET_LANG, count: lines.length, lines: lines }),
      },
    ];
  }

  const LOOKUP_SYSTEM_PROMPT = [
    'You are an English dictionary and tutor for Chinese learners. Analyze ONE word as it is used in the given sentence.',
    'Output ONLY JSON, no markdown fences, with exactly this shape:',
    '{"word":"the word as used","lemma":"dictionary form","phonetic":"IPA without slashes","senses":[{"pos":"n.","en":"a concise English definition for learners","zh":"中文释义"}],"example":{"en":"short example sentence","zh":"例句中文"},"derivatives":[{"word":"derived form","pos":"adv.","zh":"中文释义"}],"phrases":[{"en":"common phrase","zh":"中文释义"}],"context_en":"a natural English paraphrase of the sentence","context_zh":"该词所在整句的自然中文翻译","note":"optional usage tip in Chinese"}',
    'Rules: phonetic must be IPA (e.g. "ˈwʌndər"); 1-3 senses ordered by relevance to the sentence; every sense MUST have a short learner-friendly English definition in "en" (do not just repeat the headword) and a Simplified Chinese meaning in "zh"; context_en is a natural English paraphrase of the full sentence (not a literal word-for-word gloss); all explanations in Simplified Chinese; example must be a NEW short sentence; derivatives must be 1-4 common derived forms with different parts of speech (verb/noun/adjective/adverb) or []; phrases must be 1-3 common collocations or idioms with Chinese meaning, or []; if the word is a proper noun, a number, or not English, still give your best effort; never output markdown.',
  ].join('\n');

  function buildLookupMessages(word, sentence) {
    return [
      { role: 'system', content: LOOKUP_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({ word: String(word), sentence: String(sentence || '') }),
      },
    ];
  }

  /** 从模型输出里取出 JSON（容忍 ```json 围栏和前后废话） */
  function extractJson(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) throw new Error('EMPTY_RESPONSE');
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const startObj = s.indexOf('{');
    const startArr = s.indexOf('[');
    let start = -1;
    let open = '';
    let close = '';
    if (startObj >= 0 && (startArr < 0 || startObj < startArr)) { start = startObj; open = '{'; close = '}'; }
    else if (startArr >= 0) { start = startArr; open = '['; close = ']'; }
    if (start < 0) throw new Error('NO_JSON');
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = s.slice(start, i + 1);
          try { return JSON.parse(slice); } catch (e) { throw new Error('BAD_JSON'); }
        }
      }
    }
    throw new Error('UNCLOSED_JSON');
  }

  function asString(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  }

  /**
   * 解析翻译响应，返回与输入等长的字符串数组（缺失为空串）。
   */
  function parseTranslations(raw, count) {
    const data = typeof raw === 'string' ? extractJson(raw) : raw;
    let items = null;
    if (Array.isArray(data)) items = data;
    else if (data && typeof data === 'object') {
      items = data.translations || data.lines || data.items || data.data || null;
    }
    if (!Array.isArray(items)) throw new Error('BAD_TRANSLATIONS');
    const out = new Array(count).fill('');
    items.forEach(function (item, idx) {
      let i = idx;
      let zh = '';
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const ni = Number(item.i != null ? item.i : item.index);
        if (Number.isInteger(ni)) i = ni;
        zh = asString(item.zh != null ? item.zh : (item.text != null ? item.text : item.translation));
      } else {
        zh = asString(item);
      }
      if (i >= 0 && i < count && zh) out[i] = zh.replace(/^\d+[.、]\s*/, '').trim();
    });
    if (!out.some(Boolean)) throw new Error('EMPTY_TRANSLATIONS');
    return out;
  }

  /** 解析单词卡响应 → 规范化卡片对象 */
  function parseWordCard(raw, fallbackWord) {
    const data = typeof raw === 'string' ? extractJson(raw) : raw;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('BAD_WORD_CARD');
    const senses = [];
    const rawSenses = Array.isArray(data.senses) ? data.senses : (Array.isArray(data.definitions) ? data.definitions : []);
    for (const s of rawSenses) {
      if (!s) continue;
      if (typeof s === 'string') {
        if (s.trim()) senses.push({ pos: '', en: '', zh: s.trim() });
        continue;
      }
      if (typeof s === 'object') {
        const zh = asString(s.zh || s.meaning || s.definition || s.translation || '');
        if (zh) {
          senses.push({
            pos: asString(s.pos || s.part_of_speech || ''),
            en: asString(s.en || s.definition_en || s.english || s.def || ''),
            zh: zh,
          });
        }
      }
    }
    if (!senses.length) {
      const zh = asString(data.zh || data.meaning || data.translation || '');
      if (zh) senses.push({ pos: '', en: '', zh: zh });
    }
    if (!senses.length) throw new Error('BAD_WORD_CARD');
    const ex = data.example && typeof data.example === 'object' ? data.example : {};
    const exampleEn = asString(ex.en || ex.english || (typeof data.example === 'string' ? data.example : ''));
    const exampleZh = asString(ex.zh || ex.chinese || '');
    const derivatives = [];
    const rawDerivatives = Array.isArray(data.derivatives) ? data.derivatives : [];
    for (const d of rawDerivatives) {
      if (!d) continue;
      if (typeof d === 'string') {
        if (d.trim()) derivatives.push({ word: d.trim(), pos: '', zh: '' });
        continue;
      }
      if (typeof d === 'object') {
        const w = asString(d.word || d.form || d.derivative || '');
        if (w) derivatives.push({ word: w, pos: asString(d.pos || d.part_of_speech || ''), zh: asString(d.zh || d.meaning || d.definition || '') });
      }
    }
    const phrases = [];
    const rawPhrases = Array.isArray(data.phrases) ? data.phrases : [];
    for (const p of rawPhrases) {
      if (!p) continue;
      if (typeof p === 'string') {
        if (p.trim()) phrases.push({ en: p.trim(), zh: '' });
        continue;
      }
      if (typeof p === 'object') {
        const en = asString(p.en || p.phrase || p.text || '');
        if (en) phrases.push({ en: en, zh: asString(p.zh || p.meaning || p.translation || '') });
      }
    }
    const card = {
      word: asString(data.word) || String(fallbackWord || ''),
      lemma: asString(data.lemma || data.base_form || data.root || '') || (asString(data.word) || String(fallbackWord || '')).toLowerCase(),
      phonetic: asString(data.phonetic || data.ipa || '').replace(/^\/+|\/+$/g, ''),
      senses: senses.slice(0, 4),
      example: exampleEn ? { en: exampleEn, zh: exampleZh } : null,
      derivatives: derivatives.slice(0, 5),
      phrases: phrases.slice(0, 4),
      contextEn: asString(data.context_en || data.sentence_en || ''),
      contextZh: asString(data.context_zh || data.sentence_zh || data.context || ''),
      note: asString(data.note || data.tip || ''),
    };
    return card;
  }

  /* ------------------------------------------------------------------ *
   * 其他
   * ------------------------------------------------------------------ */

  function normalizeWordKey(word) {
    return String(word || '').trim().toLowerCase();
  }

  /** 生成词库 CSV（带 BOM，Excel 可直接打开） */
  function wordbookToCsv(items) {
    const rows = [['单词', '音标', '词性', '释义', '例句', '例句翻译', '视频', '时间', '加入时间']];
    for (const it of items || []) {
      const senses = Array.isArray(it.senses) ? it.senses : [];
      rows.push([
        it.lemma || it.word || '',
        it.phonetic || '',
        senses.map(function (s) { return s.pos; }).filter(Boolean).join('/'),
        senses.map(function (s) { return s.zh; }).filter(Boolean).join('；'),
        it.example && it.example.en ? it.example.en : '',
        it.example && it.example.zh ? it.example.zh : '',
        it.videoTitle || it.videoId || '',
        Number.isFinite(it.time) ? formatTime(it.time) : '',
        it.createdAt ? new Date(it.createdAt).toLocaleString('zh-CN') : '',
      ]);
    }
    return '\ufeff' + rows.map(function (cols) {
      return cols.map(function (c) {
        const s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }

  return {
    VERSION: VERSION,
    NATIVE_MODE_ENABLED: NATIVE_MODE_ENABLED,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SETTINGS_SCHEMA: SETTINGS_SCHEMA,
    normalizeSettings: normalizeSettings,
    normalizeColor: normalizeColor,
    hashString: hashString,
    cacheKey: cacheKey,
    chunk: chunk,
    cleanText: cleanText,
    formatTime: formatTime,
    getVideoIdFromUrl: getVideoIdFromUrl,
    isSupportedPage: isSupportedPage,
    parseJson3: parseJson3,
    splitCue: splitCue,
    splitSentences: splitSentences,
    findCueIndex: findCueIndex,
    pickEnglishTrack: pickEnglishTrack,
    tokenize: tokenize,
    wordForLookup: wordForLookup,
    normalizeWordKey: normalizeWordKey,
    buildTranslateMessages: buildTranslateMessages,
    buildLookupMessages: buildLookupMessages,
    parseTranslations: parseTranslations,
    parseWordCard: parseWordCard,
    extractJson: extractJson,
    wordbookToCsv: wordbookToCsv,
  };
});
