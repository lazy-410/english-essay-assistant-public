#!/usr/bin/env node
/**
 * 黑盒授权验证（发行构建前后通用）：
 * 启动一个服务实例（源码 server.mjs / 混淆版 app.mjs / SEA 单文件 .exe 均可），
 * 按真实 HTTP 断言激活闸门：未激活锁定 → 无效码拒绝 → 真码激活 → 解锁。
 *
 *   node scripts/verify-package.mjs                 # 默认验证源码 server.mjs
 *   node scripts/verify-package.mjs --entry dist/app.mjs
 *   node scripts/verify-package.mjs --entry dist/考研英语作文助手.exe
 *   node scripts/verify-package.mjs --entry <入口> --code <预置有效码>
 *
 * 说明：--code 用于发行态验证「真码激活成功」；若不提供，发行包构建时由
 * 构建脚本用作者私钥现签一个码传给本脚本（发行包里绝不携带私钥）。
 * 未提供 --code 时跳过激活成功断言（源码态由 verify-license.mjs 覆盖）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dft) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dft;
};
const entryArg = arg('--entry', path.join(ROOT, 'server.mjs'));
const entry = path.resolve(entryArg);
const presetCode = arg('--code', '');
const isExe = entry.toLowerCase().endsWith('.exe');
const PORT = Number(arg('--port', '7991'));

const licenseDir = mkdtempSync(path.join(os.tmpdir(), 'eea-pkg-verify-'));
let fail = 0;
const chk = (label, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) fail++;
};

const server = spawn(isExe ? entry : process.execPath, isExe ? [] : [entry], {
  cwd: path.dirname(entry),
  env: { ...process.env, EEA_NO_BROWSER: '1', EEA_PORT: String(PORT), EEA_LICENSE_DIR: licenseDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', (d) => { bootLog += String(d); });
server.stderr.on('data', (d) => { bootLog += String(d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function untilReady(tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
}
async function get(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
}
async function post(p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
}

try {
  chk('服务就绪（' + path.basename(entry) + '）', await untilReady(), bootLog.split('\n').filter(Boolean).slice(-2).join(' | '));

  const health0 = await get('/api/health');
  chk('未激活 health.activated=false', health0.json && health0.json.data && health0.json.data.activated === false);

  const home0 = await get('/');
  chk('首页呈现激活页', home0.status === 200 && home0.text.includes('激活') && home0.text.includes('EEA1'));

  const ocrLocked = await post('/api/review/ocr', { image: 'x'.repeat(100) });
  chk('未激活业务 API 403 NOT_ACTIVATED', ocrLocked.status === 403 && ocrLocked.json?.code === 'NOT_ACTIVATED');
  const locked2 = await post('/api/compose', { text: 'hello' });
  const locked3 = await get('/api/analysis/exam?id=e1-2007-b');
  chk('其余核心接口均锁定', locked2.status === 403 && locked3.status === 403);

  if (!presetCode) {
    chk('（未提供 --code，跳过激活成功断言）', true);
  } else {
    const bad = await post('/api/activate', { code: 'EEA1' + 'A'.repeat(97) });
    chk('垃圾码被拒', bad.status === 400 && bad.json?.code === 'CODE_INVALID');
    const act = await post('/api/activate', { code: '\n  ' + presetCode + '  ' });
    chk('真码激活成功', act.status === 200 && act.json?.ok === true && act.json?.data?.activated === true);
    const health1 = await get('/api/health');
    chk('激活后 health.activated=true', health1.json && health1.json.data && health1.json.data.activated === true);
    const home1 = await get('/');
    chk('激活后首页恢复 index', home1.status === 200 && !home1.text.includes('EEA1'));
    const opened = await post('/api/review/ocr', { image: 'x'.repeat(100) });
    chk('激活后业务放行（进入参数校验）', opened.status === 400 && opened.json?.code !== 'NOT_ACTIVATED');
  }
} finally {
  server.kill();
  await sleep(300);
  rmSync(licenseDir, { recursive: true, force: true });
}
console.log(fail === 0 ? '\nVERIFY-PACKAGE ALL PASS' : '\nFAILED=' + fail);
process.exit(fail === 0 ? 0 : 1);
