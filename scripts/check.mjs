#!/usr/bin/env node
/**
 * 静态检查：语法 + manifest 引用完整性 + 架构红线。
 * 用法：node scripts/check.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
let checked = 0;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(root);
const jsFiles = allFiles.filter((p) => p.endsWith('.js'));

for (const file of jsFiles) {
  if (file.includes(join('node_modules'))) continue;
  const src = readFileSync(file, 'utf8');
  try {
    new vm.Script(src, { filename: file });
    checked++;
  } catch (err) {
    errors.push(`语法错误 ${relative(root, file)}: ${err.message}`);
  }
}

// --- manifest ---
const manifestPath = join(root, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  errors.push(`manifest.json 解析失败: ${err.message}`);
}

if (manifest) {
  const mustExist = [];
  if (manifest.background?.service_worker) mustExist.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) mustExist.push(f);
    for (const f of cs.css || []) mustExist.push(f);
  }
  if (manifest.action?.default_popup) mustExist.push(manifest.action.default_popup);
  if (manifest.options_ui?.page) mustExist.push(manifest.options_ui.page);
  for (const size of ['16', '32', '48', '128']) {
    const icon = manifest.icons?.[size];
    if (!icon) errors.push(`manifest.icons 缺少 ${size}`);
    else mustExist.push(icon);
  }
  for (const f of mustExist) {
    if (!existsSync(join(root, f))) errors.push(`manifest 引用的文件不存在: ${f}`);
  }
  const war = manifest.web_accessible_resources || [];
  for (const entry of war) {
    for (const res of entry.resources || []) {
      if (!res.includes('*') && !existsSync(join(root, res))) {
        errors.push(`web_accessible_resources 不存在: ${res}`);
      }
    }
  }
  if (!manifest.permissions?.includes('storage')) errors.push('manifest 缺少 storage 权限');
  if (!manifest.content_scripts?.some((c) => c.world === 'MAIN')) {
    errors.push('manifest 缺少 MAIN world 的 bridge content script');
  }
}

// --- 架构红线 ---
function fileText(relPath) {
  const p = join(root, relPath);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
const ui = fileText('src/content/ui.js');
if (ui && /\bchrome\s*\./.test(ui)) errors.push('src/content/ui.js 不允许依赖 chrome.* API（应由 main.js 注入）');
const demoFiles = ['demo/index.html', 'demo/demo.js', 'demo/mock-data.js'];
for (const f of demoFiles) {
  const txt = fileText(f);
  if (/\bchrome\s*\.\s*(runtime|storage|tabs)/.test(txt)) errors.push(`${f} 不允许依赖 chrome 扩展 API`);
}
const bg = fileText('src/background.js');
if (bg) {
  if (!/importScripts\([^)]*lib\/core\.js/.test(bg)) errors.push('background.js 必须 importScripts lib/core.js');
  if (!/importScripts\([^)]*lib\/translate\.js/.test(bg)) errors.push('background.js 必须 importScripts lib/translate.js');
}
const styleFile = join(root, 'src/content/styles.css');
if (!existsSync(styleFile)) errors.push('缺少 src/content/styles.css');
for (const icon of ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png']) {
  if (!existsSync(join(root, 'src/assets/icons', icon))) errors.push(`缺少图标 src/assets/icons/${icon}`);
}
// TODO 占位检查（demo 与文档允许出现，源码不允许）
for (const file of jsFiles) {
  const rel = relative(root, file);
  if (rel.startsWith('test') || rel.startsWith('scripts')) continue;
  const txt = readFileSync(file, 'utf8');
  if (/\bTODO\b|\bFIXME\b|占位实现/.test(txt)) warnings.push(`含 TODO/FIXME: ${rel}`);
}

console.log(`检查 ${checked} 个 JS 文件，${allFiles.length} 个文件，${jsFiles.length} 个 JS`);
for (const w of warnings) console.log(`  warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  ERROR ${e}`);
  console.error(`\n✗ ${errors.length} 个问题`);
  process.exit(1);
}
console.log('✓ 静态检查通过');
