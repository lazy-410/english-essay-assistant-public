import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS,
  MAC,
  LINUX,
  platformLabel,
  fontDirectories,
  cjkFontCandidates,
  latinFontCandidates,
  CJK_FONT_HINTS,
  openBrowserCommand,
  localOcrBackend,
  hasLocalOcr,
} from '../lib/platform.mjs';
import { renderDocument, findCjkFontFile, findLatinFontFile } from '../lib/print-pdf.mjs';
import { recognize as recognizeLocal } from '../lib/ocr-windows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKSLASH = String.fromCharCode(92);

/* ------------------------------ 平台标签 ------------------------------ */

assert.equal(platformLabel(WINDOWS), 'Windows');
assert.equal(platformLabel(MAC), 'macOS');
assert.equal(platformLabel(LINUX), 'Linux');
assert.equal(platformLabel('freebsd'), 'Linux', '未知平台按 Linux 处理');

/* --------------------------- 字体目录候选 --------------------------- */

const winDirs = fontDirectories(WINDOWS);
assert.equal(winDirs.length, 1);
assert.ok(/Fonts$/i.test(winDirs[0]), `Windows 字体目录异常：${winDirs[0]}`);

const macDirs = fontDirectories(MAC, '/Users/tester');
assert.ok(macDirs.includes('/System/Library/Fonts'));
assert.ok(macDirs.includes('/System/Library/Fonts/Supplemental'), 'macOS 需包含 Supplemental（Times 等在此）');
assert.ok(macDirs.includes('/Library/Fonts'));
assert.ok(macDirs.includes('/Users/tester/Library/Fonts'));

const linuxDirs = fontDirectories(LINUX, '/home/tester');
assert.ok(linuxDirs.includes('/usr/share/fonts'));
assert.ok(linuxDirs.includes('/home/tester/.local/share/fonts'));

// 非 Windows 分支绝不能出现反斜杠：否则在 macOS/Linux 上路径无效。
for (const dir of [...macDirs, ...linuxDirs]) {
  assert.equal(dir.includes(BACKSLASH), false, `非 Windows 路径不应含反斜杠：${dir}`);
  assert.ok(dir.startsWith('/'), `非 Windows 路径应为绝对 posix 路径：${dir}`);
}

/* --------------------------- 字体候选清单 --------------------------- */

// Windows 候选必须保持原有优先级，避免既有用户的 PDF 观感发生变化。
assert.deepEqual(cjkFontCandidates(WINDOWS), ['simkai.ttf', 'simhei.ttf', 'msyh.ttc', 'simsun.ttc']);
assert.deepEqual(latinFontCandidates(WINDOWS), ['times.ttf', 'georgia.ttf', 'calibri.ttf', 'arial.ttf']);

// macOS / Linux 必须给出真实存在于该系统的字体名，且只用可子集化的 ttf/ttc 作为首选。
const macCjk = cjkFontCandidates(MAC);
assert.ok(macCjk.length >= 3);
assert.ok(macCjk.every((name) => /\.(ttf|ttc|otf)$/i.test(name)), 'macOS 候选应带字体扩展名');
assert.ok(/\.ttc$/i.test(macCjk[0]), 'macOS 首选应为可子集化的 TTC');
assert.ok(macCjk.some((name) => /Songti|Hiragino|STHeiti|PingFang/i.test(name)), 'macOS 候选应包含系统自带中文字体');

const linuxCjk = cjkFontCandidates(LINUX);
assert.ok(linuxCjk.some((name) => /Noto.*CJK/i.test(name)), 'Linux 候选应包含 Noto CJK');
assert.ok(linuxCjk.some((name) => /wqy|zenhei|microhei/i.test(name)), 'Linux 候选应包含文泉驿');

assert.ok(latinFontCandidates(MAC).some((name) => /Times/i.test(name)));
assert.ok(latinFontCandidates(LINUX).some((name) => /DejaVu|Liberation/i.test(name)));

// 兜底扫描关键字必须覆盖三平台的主流中文字体名。
for (const hint of ['notosanscjk', 'pingfang', 'hiragino', 'songti', 'wqy', 'simkai']) {
  assert.ok(CJK_FONT_HINTS.includes(hint), `缺少兜底关键字：${hint}`);
}

/* --------------------------- 打开浏览器命令 --------------------------- */

const winOpen = openBrowserCommand('http://127.0.0.1:7654', WINDOWS);
assert.equal(winOpen.command, 'cmd');
assert.deepEqual(winOpen.args, ['/c', 'start', '', 'http://127.0.0.1:7654'], 'Windows 行为必须与改造前完全一致');

assert.deepEqual(openBrowserCommand('http://x', MAC), { command: 'open', args: ['http://x'] });
assert.deepEqual(openBrowserCommand('http://x', LINUX), { command: 'xdg-open', args: ['http://x'] });
assert.equal(openBrowserCommand('', MAC), null, '空地址不应返回命令');

/* ------------------------------ 本地 OCR ------------------------------ */

assert.equal(localOcrBackend(WINDOWS), 'windows');
assert.equal(localOcrBackend(MAC), null, 'macOS 没有系统内置 OCR');
assert.equal(localOcrBackend(LINUX), null, 'Linux 没有系统内置 OCR');
assert.equal(hasLocalOcr(WINDOWS), true);
assert.equal(hasLocalOcr(MAC), false);

// 本地 OCR 模块在非 Windows 上必须快速失败并带明确 code；在 Windows 上必须仍进入真实流程。
if (process.platform === WINDOWS) {
  await assert.rejects(
    () => recognizeLocal(Buffer.alloc(300), '.png'),
    (error) => error.code !== 'local_ocr_unavailable',
    'Windows 上不应被判为平台不可用',
  );
} else {
  await assert.rejects(
    () => recognizeLocal(Buffer.alloc(300), '.png'),
    (error) => error.code === 'local_ocr_unavailable',
  );
}

/* --------------------------- 字体子集化能力 --------------------------- */

// TTC 必须可用：macOS 与 Linux 的中文字体大多是 TTC。
const cjkFile = findCjkFontFile();
assert.ok(cjkFile, '当前系统应能找到中文字体');
const basePdf = renderDocument({ title: '平台测试', blocks: [{ type: 'text', text: '中文与 English 混排 123' }] });
assert.equal(basePdf.subarray(0, 5).toString('latin1'), '%PDF-');

const fontDir = fontDirectories()[0];
let ttcTested = false;
for (const name of fs.readdirSync(fontDir)) {
  if (!name.toLowerCase().endsWith('.ttc')) continue;
  const pdf = renderDocument({ title: 'TTC', blocks: [{ type: 'text', text: '中文 TTC 测试' }], fontFile: path.join(fontDir, name) });
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', `${name} 应能子集化`);
  ttcTested = true;
  break;
}
assert.equal(ttcTested, true, '应至少验证一个 TTC 字体，否则 macOS 方案无依据');

// OTF（CFF 轮廓）无 glyf 表，必须被判为「无可用中文字体」而不是抛底层解析错。
const otf = fs.readdirSync(fontDir).find((name) => name.toLowerCase().endsWith('.otf'));
if (otf) {
  assert.throws(
    () => renderDocument({ title: 'OTF', blocks: [{ type: 'text', text: '中文' }], fontFile: path.join(fontDir, otf) }),
    (error) => error.code === 'cjk_font_missing',
    'OTF 应被干净拒绝',
  );
}

// 完全没有中文字体时仍须给出明确错误码。
assert.throws(
  () => renderDocument({ title: '缺字体', blocks: [{ type: 'text', text: '中文' }], fontFile: '' }),
  (error) => error.code === 'cjk_font_missing' && error.status === 503,
);

/* --------------------------- 启动脚本完备性 --------------------------- */

for (const name of ['start.bat', 'start.command', 'start.sh']) {
  const file = path.join(ROOT, name);
  assert.ok(fs.existsSync(file), `缺少启动脚本：${name}`);
}
for (const name of ['start.command', 'start.sh']) {
  const body = fs.readFileSync(path.join(ROOT, name), 'utf8');
  assert.ok(body.startsWith('#!/bin/bash'), `${name} 缺少 shebang`);
  // Unix 脚本不能含 CRLF，否则 macOS/Linux 会报 bad interpreter。
  assert.equal(body.includes('\r'), false, `${name} 不应包含 CRLF 换行`);
  assert.ok(body.includes('server.mjs'), `${name} 应启动 server.mjs`);
  assert.ok(body.includes('config.example.json'), `${name} 应能生成初始配置`);
  assert.ok(/-lt 18/.test(body), `${name} 应检查 Node 版本`);
}

console.log(`platform verification passed: label=win/mac/linux ok, fontDirs=posix ok, opener=cmd/open/xdg-open, localOcr=win-only, ttc=ok, otf=rejected, launchers=3, current=${platformLabel()}/${findLatinFontFile() ? 'latin-ok' : 'latin-none'}`);
