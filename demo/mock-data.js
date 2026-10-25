/*!
 * demo/mock-data.js — 本地预览用示例数据
 * 纯静态：JSON3 字幕（12 句英文）+ 中文翻译 + mock 查词词典。
 * 不依赖任何扩展 API；node 下可 require 用于校验。
 */
(function (root, factory) {
  const api = factory();
  if (root) root.YTBTL_MOCK = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 示例字幕：en/zh 一一对应，时长为毫秒 */
  const lines = [
    { en: 'Welcome back to the channel.', zh: '欢迎回到本频道。', start: 0, dur: 3200 },
    { en: 'Today we are going to explore a quiet little town.', zh: '今天我们要探索一座安静的小镇。', start: 3400, dur: 3000 },
    { en: 'The morning light was soft and the air felt fresh.', zh: '晨光柔和，空气清新。', start: 6600, dur: 3300 },
    { en: 'I started walking down an unfamiliar street.', zh: '我开始沿着一条陌生的街道走。', start: 10000, dur: 3200 },
    { en: 'Every corner seemed to hide a small surprise.', zh: '每个角落似乎都藏着小惊喜。', start: 13300, dur: 3300 },
    { en: 'A bakery owner offered us a warm loaf of bread.', zh: '面包店老板送给我们一条热面包。', start: 16700, dur: 3400 },
    { en: 'She told me the recipe had been in her family for generations.', zh: '她告诉我这个配方在她家传了好几代。', start: 20200, dur: 3600 },
    { en: 'It is amazing how a simple meal can bring people together.', zh: '一顿简单的饭能让人聚在一起，真令人惊叹。', start: 23900, dur: 3300 },
    { en: 'We sat by the window and watched the town wake up.', zh: '我们坐在窗边，看着小镇醒来。', start: 27300, dur: 3200 },
    { en: 'By noon the square was full of laughter and music.', zh: '到了中午，广场上满是笑声和音乐。', start: 30600, dur: 3300 },
    { en: 'I realized that slow travel changes the way you see things.', zh: '我意识到慢旅行会改变你看待事物的方式。', start: 34000, dur: 3400 },
    { en: 'Thanks for watching, and see you next time.', zh: '感谢观看，我们下次再见。', start: 37500, dur: 3200 },
  ];

  /** YouTube timedtext JSON3 结构（parseJson3 会解析成 cues） */
  const json3 = {
    events: lines.map(function (line) {
      return {
        tStartMs: line.start,
        dDurationMs: line.dur,
        segs: [{ utf8: line.en }],
      };
    }),
  };

  const sentences = lines.map(function (line) { return line.en; });
  const translations = lines.map(function (line) { return line.zh; });

  function zhForSentence(sentence) {
    const text = String(sentence == null ? '' : sentence).trim();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].en === text) return lines[i].zh;
    }
    return '';
  }

  /** 词条：senses 用 [词性, 中文释义] 简写 */
  function entry(lemma, phonetic, senses, exampleEn, exampleZh, note) {
    return {
      lemma: lemma,
      phonetic: phonetic,
      senses: senses.map(function (pair) {
        return { pos: pair[0], zh: pair[1] };
      }),
      example: { en: exampleEn, zh: exampleZh },
      note: note || '',
    };
  }

  const DICT = {
    welcome: entry('welcome', 'ˈwelkəm', [['v.', '欢迎；迎接'], ['adj.', '受欢迎的']],
      'You are always welcome at our table.', '我们的餐桌永远欢迎你。', 'welcome back 是「欢迎回来」的固定说法'),
    back: entry('back', 'bæk', [['adv.', '回来；向后'], ['n.', '背部']],
      'She came back after a long trip.', '长途旅行后她回来了。', ''),
    channel: entry('channel', 'ˈtʃænl', [['n.', '频道；渠道'], ['v.', '引导；输送']],
      'This channel shares short travel films.', '这个频道分享短篇旅行影片。', ''),
    today: entry('today', 'təˈdeɪ', [['adv.', '今天'], ['n.', '今天；现今']],
      'Today the weather is perfect for a walk.', '今天的天气非常适合散步。', ''),
    explore: entry('explore', 'ɪkˈsplɔːr', [['v.', '探索；勘探'], ['v.', '探究']],
      'We love to explore small towns on foot.', '我们喜欢步行探索小镇。', ''),
    quiet: entry('quiet', 'ˈkwaɪət', [['adj.', '安静的；平静的'], ['n.', '安静']],
      'The library was quiet in the afternoon.', '下午的图书馆很安静。', ''),
    little: entry('little', 'ˈlɪtl', [['adj.', '小的；少量的'], ['adv.', '很少地']],
      'A little cafe hides behind the square.', '广场后面藏着一家小咖啡馆。', ''),
    town: entry('town', 'taʊn', [['n.', '城镇；市镇']],
      'The town wakes up slowly on Sundays.', '小镇在周日慢慢醒来。', ''),
    morning: entry('morning', 'ˈmɔːrnɪŋ', [['n.', '早晨；上午']],
      'Morning light filled the kitchen.', '晨光洒满了厨房。', ''),
    light: entry('light', 'laɪt', [['n.', '光；灯'], ['adj.', '轻的；明亮的']],
      'The light turned golden before sunset.', '日落前光线变成了金色。', ''),
    soft: entry('soft', 'sɔːft', [['adj.', '柔软的；柔和的'], ['adj.', '温和的']],
      'The music was soft and easy to enjoy.', '音乐轻柔，听起来很舒服。', ''),
    air: entry('air', 'er', [['n.', '空气；气氛'], ['v.', '晾晒；播送']],
      'The morning air smelled of rain.', '清晨的空气里有雨的味道。', ''),
    fresh: entry('fresh', 'freʃ', [['adj.', '新鲜的；清新的'], ['adj.', '新的']],
      'We bought fresh bread from the bakery.', '我们从面包店买了新鲜面包。', ''),
    walk: entry('walk', 'wɔːk', [['v.', '走路；散步'], ['n.', '散步；步行']],
      'They walk along the river every evening.', '他们每天傍晚沿河散步。', 'walking 是 walk 的现在分词'),
    street: entry('street', 'striːt', [['n.', '街道；马路']],
      'The street was empty before sunrise.', '日出前街道空无一人。', ''),
    corner: entry('corner', 'ˈkɔːrnər', [['n.', '角落；拐角'], ['v.', '使陷入困境']],
      'A small flower shop sits on the corner.', '拐角处有一家小花店。', ''),
    surprise: entry('surprise', 'sərˈpraɪz', [['n.', '惊喜；意外'], ['v.', '使惊讶']],
      'The gift was a lovely surprise.', '这份礼物是个可爱的惊喜。', ''),
    bakery: entry('bakery', 'ˈbeɪkəri', [['n.', '面包店；烘焙坊']],
      'The bakery opens at six in the morning.', '这家面包店早上六点开门。', ''),
    owner: entry('owner', 'ˈoʊnər', [['n.', '所有者；店主']],
      'The owner greeted every guest by name.', '店主叫得出每位客人的名字。', ''),
    offer: entry('offer', 'ˈɔːfər', [['v.', '提供；主动提出'], ['n.', '提议；报价']],
      'They offered us a seat by the window.', '他们让我们坐在窗边。', 'offered 是 offer 的过去式'),
    warm: entry('warm', 'wɔːrm', [['adj.', '温暖的；热情的'], ['v.', '使暖和']],
      'A warm cup of tea waited on the table.', '桌上放着一杯热茶。', ''),
    loaf: entry('loaf', 'loʊf', [['n.', '一条（面包）'], ['v.', '游荡；虚度']],
      'She cut the loaf into thick slices.', '她把面包切成厚片。', '复数是 loaves'),
    bread: entry('bread', 'bred', [['n.', '面包'], ['n.', '生计']],
      'The bread was still warm from the oven.', '面包还带着烤箱的余温。', ''),
    recipe: entry('recipe', 'ˈresəpi', [['n.', '食谱；配方'], ['n.', '方法；秘诀']],
      'This recipe needs only five ingredients.', '这个食谱只需要五种食材。', ''),
    family: entry('family', 'ˈfæməli', [['n.', '家庭；家人'], ['adj.', '家庭的']],
      'Her family has lived here for decades.', '她的家人在这里住了几十年。', ''),
    generation: entry('generation', 'ˌdʒenəˈreɪʃn', [['n.', '一代人；世代'], ['n.', '产生']],
      'Three generations work in the same shop.', '三代人都在同一家店里工作。', 'generations 是复数形式'),
    amazing: entry('amazing', 'əˈmeɪzɪŋ', [['adj.', '令人惊叹的；了不起的']],
      'The view from the hill was amazing.', '从山上望去的景色令人惊叹。', ''),
    simple: entry('simple', 'ˈsɪmpl', [['adj.', '简单的；朴素的']],
      'A simple meal can feel like a feast.', '一顿简单的饭也能像盛宴。', ''),
    meal: entry('meal', 'miːl', [['n.', '一餐；一顿饭']],
      'We shared a long meal with friends.', '我们和朋友一起吃了顿长长的饭。', ''),
    people: entry('people', 'ˈpiːpl', [['n.', '人们；人民'], ['n.', '民族']],
      'People gathered in the square at noon.', '中午人们聚集在广场上。', ''),
    together: entry('together', 'təˈɡeðər', [['adv.', '一起；共同'], ['adj.', '镇定的']],
      'They cooked together every weekend.', '他们每个周末一起做饭。', ''),
    window: entry('window', 'ˈwɪndoʊ', [['n.', '窗户；窗口']],
      'Sunlight came through the open window.', '阳光从敞开的窗户照进来。', ''),
    watch: entry('watch', 'wɑːtʃ', [['v.', '观看；注视'], ['n.', '手表；看守']],
      'We watched the boats leave the harbor.', '我们看着船只离开港口。', 'watched / watching 都是 watch 的变形'),
    wake: entry('wake', 'weɪk', [['v.', '醒来；唤醒'], ['n.', '尾流']],
      'The town begins to wake at dawn.', '小镇在黎明时开始醒来。', 'wake up 是常用短语'),
    noon: entry('noon', 'nuːn', [['n.', '正午；中午']],
      'At noon the streets are full of people.', '中午街上满是人。', ''),
    square: entry('square', 'skwer', [['n.', '广场；正方形'], ['adj.', '正方形的']],
      'The square hosts a market every Sunday.', '广场每周日都有集市。', ''),
    laughter: entry('laughter', 'ˈlæftər', [['n.', '笑声；笑']],
      'Her laughter filled the whole room.', '她的笑声充满了整个房间。', ''),
    music: entry('music', 'ˈmjuːzɪk', [['n.', '音乐；乐曲']],
      'Soft music played in the background.', '背景里放着轻柔的音乐。', ''),
    realize: entry('realize', 'ˈriːəlaɪz', [['v.', '意识到；认识到'], ['v.', '实现']],
      'I did not realize how late it was.', '我没意识到已经这么晚了。', 'realized 是过去式'),
    slow: entry('slow', 'sloʊ', [['adj.', '慢的；缓慢的'], ['v.', '放慢']],
      'Slow travel lets you notice small details.', '慢旅行让你注意到小细节。', ''),
    travel: entry('travel', 'ˈtrævl', [['n.', '旅行；游历'], ['v.', '旅行；行进']],
      'Travel changes the way you see the world.', '旅行改变你看世界的方式。', ''),
    change: entry('change', 'tʃeɪndʒ', [['v.', '改变；更换'], ['n.', '变化；零钱']],
      'Small habits change over time.', '小习惯会随时间改变。', 'changes 是第三人称单数'),
    thanks: entry('thanks', 'θæŋks', [['n.', '感谢；谢意'], ['int.', '谢谢']],
      'Thanks for helping me today.', '谢谢你今天帮我。', 'thank 是动词，thanks 常作名词'),
    time: entry('time', 'taɪm', [['n.', '时间；次数'], ['v.', '计时']],
      'We had a great time at the market.', '我们在集市上玩得很开心。', ''),
    see: entry('see', 'siː', [['v.', '看见；明白'], ['v.', '会见']],
      'I can see the mountains from here.', '从这里我能看见群山。', ''),
    hide: entry('hide', 'haɪd', [['v.', '隐藏；躲藏'], ['n.', '兽皮']],
      'The cat likes to hide under the chair.', '这只猫喜欢躲在椅子下面。', ''),
    seem: entry('seem', 'siːm', [['v.', '似乎；好像']],
      'Everything seemed calm that afternoon.', '那天下午一切似乎都很平静。', 'seemed 是过去式'),
    tell: entry('tell', 'tel', [['v.', '告诉；讲述'], ['v.', '分辨']],
      'She will tell us the story tonight.', '今晚她会给我们讲这个故事。', 'told 是过去式'),
    start: entry('start', 'stɑːrt', [['v.', '开始；启动'], ['n.', '开端']],
      'Let us start the tour from the square.', '我们从广场开始这次游览吧。', 'started 是过去式'),
    feel: entry('feel', 'fiːl', [['v.', '感觉；觉得'], ['n.', '手感']],
      'The air feels cool in the morning.', '早晨的空气感觉很凉爽。', 'felt 是过去式'),
    sit: entry('sit', 'sɪt', [['v.', '坐；位于']],
      'We sit by the window every morning.', '我们每天早上坐在窗边。', 'sat 是过去式'),
    every: entry('every', 'ˈevri', [['adj.', '每个；每一']],
      'Every corner of the town has a story.', '小镇的每个角落都有故事。', ''),
  };

  function lemmaCandidates(word) {
    const out = [word];
    if (/ing$/.test(word)) {
      out.push(word.slice(0, -3));
      out.push(word.slice(0, -3) + 'e');
    }
    if (/ied$/.test(word)) out.push(word.slice(0, -3) + 'y');
    if (/ed$/.test(word)) {
      out.push(word.slice(0, -2));
      out.push(word.slice(0, -1));
    }
    if (/es$/.test(word)) out.push(word.slice(0, -2));
    if (/s$/.test(word)) out.push(word.slice(0, -1));
    if (/ly$/.test(word)) out.push(word.slice(0, -2));
    return out;
  }

  function findEntry(key) {
    if (DICT[key]) return DICT[key];
    const candidates = lemmaCandidates(key);
    for (let i = 1; i < candidates.length; i++) {
      if (DICT[candidates[i]]) return DICT[candidates[i]];
    }
    return null;
  }

  /** 未收录词的兜底音标：简单规则生成，仅用于 UI 演示 */
  function demoPhonetic(word) {
    let out = String(word || '').toLowerCase();
    const rules = [
      ['tion', 'ʃən'], ['sion', 'ʒən'], ['ough', 'ʌf'], ['ph', 'f'], ['ck', 'k'],
      ['ee', 'iː'], ['oo', 'uː'], ['ing', 'ɪŋ'], ['er', 'ər'], ['th', 'θ'],
      ['sh', 'ʃ'], ['ch', 'tʃ'], ['ai', 'eɪ'], ['ay', 'eɪ'], ['oa', 'oʊ'],
    ];
    for (let i = 0; i < rules.length; i++) {
      out = out.split(rules[i][0]).join(rules[i][1]);
    }
    return out;
  }

  function buildFallback(word, sentence) {
    const display = String(word || 'word');
    return {
      word: display,
      lemma: display.toLowerCase(),
      phonetic: demoPhonetic(display),
      senses: [
        { pos: 'n.', zh: '「' + display + '」的兜底示例释义（本地 mock 数据）' },
        { pos: 'v.', zh: '示例动词义：与「' + display + '」相关' },
      ],
      example: {
        en: 'This is a demo example sentence using "' + display + '".',
        zh: '这是一句包含「' + display + '」的演示例句。',
      },
      contextZh: zhForSentence(sentence),
      note: '演示数据：词典未收录该词时自动生成兜底释义。',
    };
  }

  /**
   * mock 查词：返回与 YTBTL.parseWordCard 同结构的卡片。
   * @param {string} word 点击的原始词
   * @param {string} sentence 所在整句
   */
  function lookup(word, sentence) {
    const clicked = String(word == null ? '' : word).trim();
    const key = clicked.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    const hit = findEntry(key);
    if (!hit) return buildFallback(clicked || 'word', sentence);
    return {
      word: clicked || hit.lemma,
      lemma: hit.lemma,
      phonetic: hit.phonetic,
      senses: hit.senses.map(function (sense) { return { pos: sense.pos, zh: sense.zh }; }),
      example: { en: hit.example.en, zh: hit.example.zh },
      contextZh: zhForSentence(sentence),
      note: hit.note,
    };
  }

  return {
    json3: json3,
    lines: lines,
    sentences: sentences,
    translations: translations,
    lookup: lookup,
    zhForSentence: zhForSentence,
  };
});
