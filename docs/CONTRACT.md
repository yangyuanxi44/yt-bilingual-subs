# 开发契约（CONTRACT）— YT 双语字幕 · 点词查意

> 本文件是并行开发的唯一接口约定。所有成员只写自己 scope 内的文件，不改他人文件；接口有疑问先按本文件执行，确实需要变更请先告知 Lead。

## 1. 产品目标

Chrome/Edge MV3 扩展，在 YouTube 观看页提供：

1. **英文字幕逐词可点**：点击任意单词 → 暂停播放 → 弹出单词卡（音标、词性释义、例句、本句翻译、朗读、加入词库），查词走 DeepSeek API，结果本地缓存。
2. **中文字幕非必要不看**：默认「悬停时显示」，可彻底隐藏，可常显；字号可调到 8px（8–24px）。
3. **翻译使用 DeepSeek API**：英文轨字幕自动按批翻译成简体中文，带本地缓存、预翻译、失败重试；API Key 在本机配置。
4. 附加：词库（保存/导出 CSV）、字幕工具栏（中/EN、A−/A+、设置、重试）、快捷键。

不做：Shorts、移动端、非英文视频、逐词时间轴（v1）。

## 2. 目录与文件归属（严禁越界修改）

```
yt-bilingual-subs/
├── manifest.json                 Lead
├── package.json                  Lead
├── README.md                     Lead
├── docs/CONTRACT.md              Lead
├── src/lib/core.js               Lead（已就绪，勿改）
├── src/lib/translate.js          pipeline
├── src/background.js             pipeline
├── src/content/bridge.js         pipeline
├── src/content/main.js           pipeline
├── src/content/ui.js             ui
├── src/content/styles.css        ui
├── src/content/page.css          ui
├── src/popup/popup.html|css|js   settings
├── src/options/options.html|css|js settings
├── src/assets/icons/*.png        settings（由 scripts/make-icons.py 生成）
├── demo/index.html|demo.css|demo.js|mock-data.js  ui
├── test/*.test.js                Lead + 各自模块自测脚本
└── scripts/make-icons.py         settings
```

## 3. 编码约定

- **无构建**：全部为经典脚本（IIFE / 普通 `<script>`），不使用 ES module、npm 依赖、外部 CDN。MV3 CSP 禁止内联脚本与远程脚本。
- 共享库通过全局对象访问：
  - `self.YTBTL`（core），`self.YTBTL_DS`（translate），`self.YTBTL_UI`（ui）。
  - 文件包装模式参考 `src/lib/core.js` 顶部 UMD 写法；node 测试可直接 `require()`。
- content script 不能使用 `eval`/`new Function`；不能用 `innerHTML` 插入动态文本（用 `textContent` / `createElement`）。
- 注释、按钮文案用中文；代码标识符英文。严格模式，2 空格缩进，单引号。
- 不引入第三方库、不请求 `chrome.storage.sync`（API Key 存 local）。
- UI 视觉统一：深色半透明玻璃风，字体 `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`，主色 `#ffd166` / `#8ecdf7`，圆角 8–12px。

## 4. `core.js` API（已实现，直接使用）

关键常量：`VERSION`, `DEFAULT_SETTINGS`, `SETTINGS_SCHEMA`。

设置：
- `normalizeSettings(raw) -> settings`（补默认值、clamp、trim；content/background/popup/options 都必须用它）
- `DEFAULT_SETTINGS` 字段：`enabled, enSize, zhMode('off'|'hover'|'on'), zhSize, opacity, bottomOffset, hideNativeCaptions, pauseOnWordClick, resumeAfterCard, autoTranslate, prefetchAhead, batchSize, apiKey, baseUrl, model, temperature`
- `SETTINGS_SCHEMA`: `[{key, group, label, type, min?, max?, step?, unit?, hint?, options?, default?}]`，type ∈ boolean|select|range|text|password|number。设置页按 group 分组、按此渲染。

工具：`hashString`, `cacheKey(text, model)`, `chunk(arr, n)`, `cleanText`, `formatTime`, `getVideoIdFromUrl(url)`, `isSupportedPage(url)`。

字幕：`parseJson3(json3OrString, opts?) -> cue[]`（cue = `{start, end, text, index}`，秒）；`splitCue`；`findCueIndex(cues, time, grace?) -> number`；`pickEnglishTrack(tracks) -> track|null`。

分词：`tokenize(text) -> [{v, word}]`；`wordForLookup(raw) -> string`；`normalizeWordKey(word)`。

DeepSeek：`buildTranslateMessages(texts)`, `buildLookupMessages(word, sentence)`, `parseTranslations(content, count)`, `parseWordCard(content, fallbackWord)`, `extractJson(text)`。

其他：`wordbookToCsv(items)`。

## 5. UI 模块契约（`src/content/ui.js` → `self.YTBTL_UI`）

不得依赖 `chrome.*`、不得依赖 main.js。所有外部能力通过参数/回调注入。

```js
const overlay = self.YTBTL_UI.createOverlay({
  playerEl,          // #movie_player（HTMLElement，必须已在文档中）
  settings,          // 规范化后的 settings
  stylesUrl,         // styles.css 的绝对 URL（chrome.runtime.getURL 或 demo 相对路径）
  callbacks: {
    onWordClick(info),      // info = {word, raw, sentence, cueIndex, cue, anchor:{x,y,width,height}}（player 内坐标）
    onPatch(patch),         // 工具栏触发设置变更，如 {zhMode:'on'} / {enSize:28}；main 负责保存并回传 setSettings
    onRetry(),              // 翻译错误条上的「重试」
    onOpenOptions(),        // 工具栏齿轮
    onWordbookAdd(card),    // 卡片「加入词库」
    onCardClose(),          // 卡片关闭（main 可据此恢复播放）
    onRetryLookup(),        // 查词失败后的重试
  },
});
```

方法（必须全部实现，缺失回调时安全降级）：

- `mount()` / `destroy()`
- `setCues(cues)`：cue 数组，来自 `YTBTL.parseJson3`；重置当前行与翻译。
- `setTranslations(arr)`：与 cues 等长的中文数组，`''` 表示未翻译；若当前行受影响立即刷新。
- `setSettings(settings)`：更新字号、中文模式、透明度、底部偏移、enabled、hideNativeCaptions 等。
- `setStatus(status)`：`{phase:'idle'|'loading'|'translating'|'ready'|'error'|'no-captions'|'dom', message?, done?, total?, retryable?}`
  - `loading`：显示「正在获取字幕…」；`no-captions`：给出「未找到英文字幕，请开启 YouTube CC」提示；`error`：工具栏旁红色错误条，retryable 时带「重试」；`translating`：工具栏显示进度 pill。
- `tick(currentTime)`：rAF 每帧调用，内部用 `YTBTL.findCueIndex`，仅在行变化时更新 DOM。
- `showWordCardLoading(info)` / `showWordCard(card, info)` / `showWordCardError(message, info)` / `hideWordCard()` / `isCardOpen()`。
  - `info` 同上（含 anchor）；`card` 结构见 `parseWordCard`：`{word, lemma, phonetic, senses:[{pos,zh}], example:{en,zh}|null, contextZh, note}`。
- `flashMessage(text, ms?)`：顶部小提示（如「已加入词库」）。
- `isEnabled()` 可选。

交互要求：
- Shadow DOM 挂载到 `#movie_player` 内；容器覆盖播放器，空白区域 `pointer-events:none`，仅单词/按钮/卡片可点，绝不能挡住 YouTube 控件。
- 英文行：居中、白字、强 text-shadow，单词为 `<span class="ytbtl-word">`，hover 高亮；点击调用 `onWordClick`，并传 player 相对坐标。
- 中文行：位于英文行下方。`zhMode==='off'` 不显示；`'hover'` 时监听 playerEl 的 `mousemove`（rAF 节流）判断指针是否在字幕块矩形内，是则显示；`'on'` 常显。字号 `--ytbtl-zh-size`，最小 8px。
- 中文行显示时，若对应翻译为空且 `phase==='translating'`，显示 `译…` 占位（不要报错）。
- 工具栏：右上角小胶囊，按钮 `中`（循环 off→hover→on，图标/底色反映状态）、`A−`、`A+`、`重试`（仅 error 时）、`⚙`；有 title/aria-label。工具栏自身不参与鼠标 hover 显示中文。
- 单词卡：320–360px 深色玻璃卡，靠近点击单词定位（player 内坐标，边界内夹取，空间不足翻到上方）；含单词、音标、朗读按钮（`speechSynthesis`，rate 0.9，en-US）、词性+释义、例句、本句翻译、`加入词库`、`关闭`；Esc 或点击播放器空白处关闭；加载态 skeleton；错误态可重试。
- 原生字幕隐藏：settings.enabled && hideNativeCaptions 时给 playerEl 加 class `ytbtl-hide-native`（page.css 负责 `.ytbtl-hide-native .ytp-caption-window-container{display:none!important}`），否则移除。
- 全屏/剧场模式自适应：靠 `#movie_player` 内绝对定位 + CSS 变量，不监听 window resize 也行，但要处理 `fullscreenchange` 重算卡片位置（可简单关闭卡片）。
- 不阻塞 YouTube 快捷键：只有卡片输入类元素聚焦时才 stopPropagation（本扩展无输入框，尽量不 stopPropagation）。

## 6. MAIN world bridge 协议（`src/content/bridge.js`）

- `run_at: document_start`，`world: MAIN`，只处理 `www.youtube.com`。初始化后 `postMessage({__ytbtl:1, dir:'to-content', type:'ready'})`。
- 页面 → bridge（content 发）：`window.postMessage({__ytbtl:1, dir:'to-page', type:'getTracks', id}, '*')`
  - bridge 取 `document.getElementById('movie_player').getPlayerResponse()`（并可回退轮询 `window.ytInitialPlayerResponse` / hook fetch `/youtubei/v1/player`），返回：
  `{__ytbtl:1, dir:'to-content', type:'tracks', id, payload:{videoId, title, tracks:[{languageCode, kind, name, baseUrl, vssId}]}}`（失败 payload.tracks=[]）
- `type:'fetchTimedtext'`，`url`：bridge 在页面上下文 `fetch(url, {credentials:'include'})`，返回
  `{type:'timedtext', id, payload:{ok:true, status, body}}` 或 `{ok:false, status, error}`。body 上限 ~8MB，超限报错。
- `type:'getVideoInfo'` → `{type:'videoInfo', id, payload:{videoId, title, duration}}`。
- SPA 导航变化时主动发 `{type:'tracks-updated', payload:{videoId, tracks}}`（可选，main 也会主动拉取）。
- 所有请求 2s 无响应由 content 侧重试（最多 3 次）。bridge 必须容错：player 未就绪、无字幕、`getPlayerResponse` 抛错时返回空 tracks，绝不抛未捕获异常。
- 若 bridge 未注入，content 侧降级到 DOM 捕获模式（读取 `.ytp-caption-segment`）。

## 7. background / translate 契约（`src/lib/translate.js` + `src/background.js`）

### 7.1 `translate.js`

UMD 暴露 `self.YTBTL_DS`（node `module.exports` 同）。

```js
const client = YTBTL_DS.createClient({
  apiKey, baseUrl, model, temperature,
  fetchImpl,            // 可注入（node 测试）；默认 globalThis.fetch
  timeoutMs,            // 默认 45000
  signal,               // 可选 AbortSignal
});
await client.translate(texts)        // -> string[]，长度=texts.length，缺失为 ''
await client.lookup(word, sentence)  // -> card（YTBTL.parseWordCard 结果），并保证 card.word 非空
await client.test()                  // -> {ok, model, latencyMs, error?}
```

- 端点：`POST {baseUrl}/chat/completions`（baseUrl 已去尾斜杠），`Authorization: Bearer key`，`Content-Type: application/json`，`response_format:{type:'json_object'}`，`stream:false`。
- 模型返回 JSON 用 `YTBTL.extractJson` / `parseTranslations` / `parseWordCard` 解析；JSON 解析失败自动追加一次「只返回合法 JSON」的修复重试。
- 若 API 返回 400 且与 response_format 有关：去掉 `response_format` 重试一次。
- 错误统一 `throw new DSClientError(message, code)`，code ∈ `NO_KEY | AUTH | BALANCE | RATE | NETWORK | TIMEOUT | SERVER | BAD_JSON | BAD_RESPONSE | ABORTED`；`message` 为中文用户可读文案（如 `API Key 无效或已过期`、`DeepSeek 账户余额不足`）。
- 重试：429/5xx/网络错误最多 2 次，退避 600ms/1800ms；401/402 不重试。
- 不做本地缓存（缓存由 background 负责），可测试性优先。

### 7.2 `background.js`（service worker，`importScripts('lib/core.js','lib/translate.js')`）

消息协议（content/popup/options → background）：

```js
{type:'YTBT_TRANSLATE', payload:{videoId, title, texts:string[]}}
 -> {ok:true, translations:string[], cached:number} | {ok:false, error:{code, message}}

{type:'YTBT_LOOKUP', payload:{videoId, title, word, sentence, cueTime}}
 -> {ok:true, card} | {ok:false, error:{code,message}}

{type:'YTBT_WORDBOOK_ADD', payload:{card, videoId, videoTitle, time}}
 -> {ok:true, size} | {ok:false, error}

{type:'YTBT_TEST'} -> {ok:true, model, latencyMs} | {ok:false, error}

{type:'YTBT_CLEAR_CACHE'} -> {ok:true, removed}
```

- 设置：`chrome.storage.local.get('settings')` + `YTBTL.normalizeSettings`；监听 `chrome.storage.onChanged` 重建 client。无 API Key 时 `NO_KEY`。
- 翻译缓存：key `tc:<YTBTL.cacheKey(text, model)>`，value `{v:zh, t:Date.now()}`；批量 `storage.get(keys)` 命中，未命中按 `settings.batchSize` 分批、并发 2（`pLimit`）调用 `client.translate`，成功写缓存。全部失败抛首个错误；部分成功合并返回，缺失为空串。
- 查词缓存：key `wc:<hash(word|sentence|model)>`，value `{v:card, t}`；命中直接返回。
- 缓存清理：`tc:`/`wc:` 总数超过 5000 时异步删除最旧 1000 条（按 t），避免无限增长。
- 词库：`wordbook` 数组，元素 `{word, lemma, phonetic, senses, example, contextZh, note, videoId, videoTitle, time, createdAt, count}`；按 lemma 去重（存在则 count++、更新 createdAt），最多 2000 条（超限丢最旧）。popup/options 直接读写 storage（不用额外消息）也可以，但需保证一致。
- `chrome.runtime.onInstalled`：首次安装 `chrome.runtime.openOptionsPage()`。
- 消息处理必须 `return true` 保持异步 sendResponse；捕获所有异常转 `{ok:false,error}`；不得让 SW 崩溃。

### 7.3 storage key 一览

| key | 内容 |
|---|---|
| `settings` | 规范化设置对象 |
| `wordbook` | 数组，最新在前 |
| `tc:<hash>` | 翻译缓存 `{v,t}` |
| `wc:<hash>` | 查词缓存 `{v,t}` |

## 8. popup / options 要求（settings）

- 全部使用 `YTBTL.SETTINGS_SCHEMA` 渲染（popup 只放常用：enabled、zhMode、zhSize、API 状态、测试连接、打开设置；options 全量 + 词库管理）。不得硬编码重复的默认值。
- 启动时 `storage.local.get(['settings','wordbook'])` → normalize；保存时 `storage.local.set({settings: YTBTL.normalizeSettings(next)})`，防抖 300ms。
- 无 API Key：显示「未配置 API Key」引导按钮跳 options#deepseek。
- 测试连接：`chrome.runtime.sendMessage({type:'YTBT_TEST'})`，展示模型/延迟/错误。
- 词库：表格（单词/音标/释义/来源/时间），删除、清空、导出 CSV（`YTBTL.wordbookToCsv` + Blob 下载，文件名 `wordbook-YYYYMMDD.csv`）。
- 自定义 baseUrl 保存时，若 origin 不在已有 host 权限，调用 `chrome.permissions.request({origins:[origin+'/*']})`（必须在点击事件中调用）；被拒绝则提示并回退默认地址。
- 安全：无内联 JS/CSS（CSP）；API Key 输入框 type=password + 显示切换；页面内不得把 key 写进 DOM 文本。
- 视觉与扩展一致（深色/浅色跟随 `prefers-color-scheme`，简单干净即可）。

## 9. demo 预览页（`demo/`）

- 纯静态，可 `file://` 直接打开：假播放器（16:9 深色画面 + 播放/暂停 + 时间轴），加载 `../src/lib/core.js` + `../src/content/ui.js` + `../src/content/styles.css`（`stylesUrl:'../src/content/styles.css'`）。
- 12 条左右示例 cue（英文），`demo/mock-data.js` 提供 mock 翻译与 mock 查词（覆盖常用词 + 兜底），点击单词走 mock 查词并显示卡片，可加入词库（内存数组即可，写入 localStorage 可选）。
- 侧栏演示设置：中文字幕 off/hover/on、中文 8/11/14px、英文 20/24/28px、启用开关；与 overlay `setSettings` 联动。
- 顶部说明「本地预览，不会请求 DeepSeek 或连接 YouTube」。
- 目标：用于截图验收 UI（Lead 会用浏览器打开截图）。

## 10. 验收清单

- [ ] `node --check` 全部 JS 通过；`node --test test/` 通过（core + translate + 集成逻辑）。
- [ ] manifest 合法：JS 路径存在、图标存在、WAR 正确、`world:"MAIN"` bridge 注入顺序正确。
- [ ] demo 可交互截图：英文可点、卡片、中文 hover/8px、工具栏。
- [ ] 无 chrome.* 依赖泄漏到 ui.js/demo。
- [ ] 无 TODO/占位实现；错误路径有中文提示。

## 11. 自测方式

Node（bundle 路径）：

```powershell
$node = "C:\Users\33488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --check src/content/ui.js
& $node --test test/
```

浏览器（ego 工具，可开 `file:///D:/DSHwork/yt-bilingual-subs/demo/index.html` 截图）：仅 Lead 需要做最终截图；ui 成员可用 `ego_navigate` + `ego_screenshot` 自检 demo。
