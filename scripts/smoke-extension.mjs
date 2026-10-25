#!/usr/bin/env node
/**
 * 扩展冒烟测试（真实浏览器，headless）：
 *  - 以 --load-extension 加载本扩展，确认 manifest 合法、service worker 启动无异常；
 *  - 打开 options / popup 页面，检查按 SETTINGS_SCHEMA 渲染的控件、核心库加载、无 JS 异常；
 *  - 检查 storage 权限可用。
 *
 * 用法：
 *   node scripts/smoke-extension.mjs                       # 自动找 Edge/Chrome
 *   BROWSER="C:\\...\\msedge.exe" node scripts/smoke-extension.mjs
 *   HEADFUL=1 node scripts/smoke-extension.mjs             # 有界面（调试用）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.EXT_ROOT ? resolve(process.env.EXT_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'manifest.json'))) {
  console.error('✗ 扩展目录缺少 manifest.json：' + root);
  process.exit(2);
}
const port = Number(process.env.PORT) || 9411;
const headful = process.env.HEADFUL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const candidates = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('✗ 未找到 Edge/Chrome，可用 BROWSER 环境变量指定可执行文件');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'ytbtl-smoke-'));
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  `--disable-extensions-except=${root}`,
  `--load-extension=${root}`,
  'about:blank',
];
if (!headful) args.unshift('--headless=new', '--disable-gpu');
const browser = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
browser.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

let failures = 0;
const ok = (msg) => console.log('✓ ' + msg);
const bad = (msg) => { failures++; console.error('✗ ' + msg); };

async function waitJson(path, timeoutMs, predicate) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (res.ok) {
        const data = await res.json();
        if (!predicate || predicate(data)) return data;
      }
    } catch (e) { /* 浏览器还没起来 */ }
    await sleep(300);
  }
  throw new Error(`等待 ${path} 超时`);
}

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map(); }
  static connect(url) {
    return new Promise((resolveConn, reject) => {
      const ws = new WebSocket(url);
      const client = new CDP(ws);
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.id && client.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = client.pending.get(msg.id);
          client.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'CDP 错误'));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          const list = client.handlers.get(msg.method) || [];
          for (const fn of list) { try { fn(msg.params); } catch (e) { /* 忽略 */ } }
        }
      });
      ws.addEventListener('open', () => resolveConn(client));
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || '页面执行异常');
    return res.result ? res.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

(async () => {
  try {
    await waitJson('/json/version', 25000);
    ok(`浏览器已启动：${exe.split('\\').pop()}（headless=${!headful}）`);

    // service worker target 出现即代表扩展被成功加载
    const version = await waitJson('/json/version', 5000);
    const browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
    let extensionId = '';
    for (let i = 0; i < 40 && !extensionId; i++) {
      const targets = await browserCdp.send('Target.getTargets');
      const sw = targets.targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'))
        || targets.targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
      if (sw) extensionId = new URL(sw.url).host;
      else await sleep(300);
    }
    if (!extensionId) throw new Error('扩展未加载：未发现 service worker target');
    ok(`扩展已加载，ID=${extensionId}`);

    const inspectPage = async (path, label, checks) => {
      const pageUrl = `chrome-extension://${extensionId}/${path}`;
      const { targetId } = await browserCdp.send('Target.createTarget', { url: pageUrl });
      let pageCdp = null;
      for (let i = 0; i < 40 && !pageCdp; i++) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          const info = list.find((t) => t.id === targetId) || list.find((t) => t.url === pageUrl);
          if (info && info.webSocketDebuggerUrl) pageCdp = await CDP.connect(info.webSocketDebuggerUrl);
        } catch (e) { /* 页面还没就绪 */ }
        if (!pageCdp) await sleep(250);
      }
      if (!pageCdp) throw new Error(`${label} 页面未打开`);
      const errors = [];
      await pageCdp.send('Runtime.enable');
      await pageCdp.send('Log.enable');
      pageCdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails && p.exceptionDetails.text));
      pageCdp.on('Runtime.consoleAPICalled', (p) => {
        if (p.type === 'error') errors.push((p.args || []).map((a) => a.value || a.description || '').join(' '));
      });
      await pageCdp.send('Page.enable');
      await sleep(1200);
      const title = await pageCdp.eval('document.title');
      const result = await pageCdp.eval(`(async () => {
        const Y = self.YTBTL;
        const hasLocal = !!(self.chrome && chrome.storage && chrome.storage.local);
        const out = {
          title: document.title,
          hasCore: !!(Y && Y.SETTINGS_SCHEMA),
          schemaCount: Y ? Y.SETTINGS_SCHEMA.length : 0,
          checkboxes: document.querySelectorAll('input[type=checkbox]').length,
          ranges: document.querySelectorAll('input[type=range]').length,
          selects: document.querySelectorAll('select').length,
          textInputs: document.querySelectorAll('input[type=text],input[type=password],input[type=number]').length,
          buttons: document.querySelectorAll('button').length,
          bodyText: document.body.innerText.slice(0, 4000),
          storageAvailable: hasLocal,
          stored: null,
          testResp: null,
          clearResp: null,
          apiInfo: {
            chrome: typeof self.chrome,
            storage: !!(self.chrome && chrome.storage),
            local: !!(self.chrome && chrome.storage && chrome.storage.local),
            runtime: !!(self.chrome && chrome.runtime && chrome.runtime.sendMessage),
          },
        };
        if (hasLocal) {
          try {
            out.stored = await new Promise((r) => chrome.storage.local.get(null, (v) => r(Object.keys(v || {}))));
          } catch (e) { out.storageError = String(e); }
          try {
            out.testResp = await new Promise((r) => chrome.runtime.sendMessage({ type: 'YTBT_TEST' }, (resp) => {
              r(resp || { ok: false, error: { code: 'NO_RESPONSE', message: String(chrome.runtime.lastError && chrome.runtime.lastError.message) } });
            }));
          } catch (e) { out.testResp = { ok: false, error: { code: 'THROW', message: String(e) } }; }
          try {
            out.clearResp = await new Promise((r) => chrome.runtime.sendMessage({ type: 'YTBT_CLEAR_CACHE' }, (resp) => {
              r(resp || { ok: false, error: { code: 'NO_RESPONSE', message: String(chrome.runtime.lastError && chrome.runtime.lastError.message) } });
            }));
          } catch (e) { out.clearResp = { ok: false, error: { code: 'THROW', message: String(e) } }; }
        }
        return out;
      })()`);
      const findings = checks(result);
      console.log(`  ${label}: title="${result.title}" api=${JSON.stringify(result.apiInfo)} testResp=${JSON.stringify(result.testResp)}`);
      if (errors.length) bad(`${label} 页存在 JS 异常：${errors.slice(0, 3).join(' | ')}`);
      else ok(`${label} 页无 JS 异常`);
      for (const f of findings) {
        if (f.ok) ok(`${label}: ${f.msg}`);
        else bad(`${label}: ${f.msg}`);
      }
      pageCdp.close();
      return result;
    };

    // service worker：只认本扩展（避免误连 Edge 内置扩展的 background.rollup.js）
    const listForSw = await waitJson('/json/list', 8000, (list) =>
      list.some((t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/src/background.js`));
    const swTarget = listForSw.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/src/background.js`);
    if (swTarget && swTarget.webSocketDebuggerUrl) {
      const swCdp = await CDP.connect(swTarget.webSocketDebuggerUrl);
      const swErrors = [];
      const swContexts = [];
      await swCdp.send('Runtime.enable');
      swCdp.on('Runtime.exceptionThrown', (p) => swErrors.push(p.exceptionDetails && p.exceptionDetails.text));
      swCdp.on('Runtime.executionContextCreated', (p) => swContexts.push(p.context));
      await sleep(600);
      const swInfo = await swCdp.eval('({ core: !!self.YTBTL, ds: !!self.YTBTL_DS, version: self.YTBTL && self.YTBTL.VERSION, href: (self.location && self.location.href) || "", keys: Object.keys(self).filter((k) => k.indexOf("YTBTL") === 0) })');
      if (swInfo.core && swInfo.ds) ok(`background service worker 正常（core ${swInfo.version} + DS 客户端）`);
      else bad('background service worker 缺少核心库');
      if (swErrors.length) bad('background 启动异常：' + swErrors.slice(0, 3).join(' | '));
      else ok('background 启动无异常');
      console.log('  swInfo=' + JSON.stringify(swInfo) + ' contexts=' + JSON.stringify(swContexts.map((c) => ({ id: c.id, origin: c.origin, name: c.name }))));
      swCdp.close();
    } else {
      bad('未找到 background service worker 调试目标');
    }

    const options = await inspectPage('src/options/options.html', 'options', (r) => [
      { ok: r.hasCore, msg: 'core.js 已加载' },
      { ok: r.schemaCount >= 15, msg: `SETTINGS_SCHEMA 渲染 ${r.schemaCount} 项` },
      { ok: r.checkboxes >= 4 && r.ranges >= 4, msg: `控件数量 checkbox=${r.checkboxes} range=${r.ranges}` },
      { ok: r.storageAvailable, msg: 'chrome.storage 可用' },
      { ok: /DeepSeek/.test(r.bodyText), msg: 'DeepSeek 配置区存在' },
      { ok: /词库/.test(r.bodyText), msg: '词库区存在' },
      { ok: r.testResp && r.testResp.ok === false && r.testResp.error && r.testResp.error.code === 'NO_KEY', msg: 'background 消息路由可用（未配置 Key → NO_KEY）' },
      { ok: r.clearResp && r.clearResp.ok === true, msg: 'YTBT_CLEAR_CACHE 可用' },
    ]);
    const popup = await inspectPage('src/popup/popup.html', 'popup', (r) => [
      { ok: r.hasCore, msg: 'core.js 已加载' },
      { ok: r.checkboxes >= 1 && r.ranges >= 1, msg: '常用设置控件已渲染' },
      { ok: /测试连接/.test(r.bodyText), msg: '测试连接按钮存在' },
    ]);

    console.log('\n摘要：options schema=' + options.schemaCount + '，popup 控件=' + popup.checkboxes + ' checkbox / ' + popup.ranges + ' range');
    if (failures) throw new Error(`${failures} 项检查失败`);
    console.log('\n✓ 扩展冒烟测试通过');
  } catch (err) {
    console.error('\n✗ ' + (err && err.message ? err.message : err));
    if (stderr) console.error('浏览器 stderr（截断）：\n' + stderr.slice(-2000));
    failures++;
  } finally {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch (e) { /* 已退出 */ }
    try { browser.kill(); } catch (e) { /* 忽略 */ }
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(failures ? 1 : 0);
  }
})();
