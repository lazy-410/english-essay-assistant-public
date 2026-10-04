#!/usr/bin/env node
/**
 * 激活码统一管理 CLI（作者本机使用，不进入发行包）。
 *
 * 默认通过 SSH 在服务器本机访问管理接口，避免管理口令经过公网 HTTP。
 * 用法：node scripts/license-admin.mjs help
 */
import { createHash, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { daysFromDate, readPemFile, signWithDays } from './issue-code.mjs';
import { normalizeCode, verifyCodeWith } from '../lib/license.mjs';

const argv = process.argv.slice(2);
const flags = new Set(['json', 'show-code', 'no-register', 'help']);
const options = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith('--')) {
    positional.push(token);
    continue;
  }
  const eq = token.indexOf('=');
  if (eq > -1) {
    options.set(token.slice(2, eq), token.slice(eq + 1));
    continue;
  }
  const name = token.slice(2);
  if (flags.has(name)) {
    options.set(name, true);
    continue;
  }
  if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
    throw new Error(`参数 --${name} 缺少值`);
  }
  options.set(name, argv[++i]);
}

const opt = (name, fallback = '') => options.has(name) ? options.get(name) : fallback;
const has = (name) => options.has(name);
const expandHome = (p) => {
  const text = String(p || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
};

const defaultLicenseDir = path.join(os.homedir(), 'english-essay-license');
const keyFile = expandHome(opt('key', process.env.EEA_LICENSE_KEY || path.join(defaultLicenseDir, 'private.pem')));
const ledgerFile = expandHome(opt('ledger', process.env.EEA_LICENSE_LEDGER || path.join(path.dirname(keyFile), 'license-ledger.json')));
const publicUrl = String(opt('public-url', process.env.EEA_LICENSE_PUBLIC_URL || 'http://120.26.211.236:8080/license')).replace(/\/+$/, '');
const directAdminUrl = String(opt('admin-url', process.env.EEA_LICENSE_ADMIN_URL || '')).replace(/\/+$/, '');
const directToken = String(opt('token', process.env.EEA_LICENSE_TOKEN || ''));
const sshHost = String(opt('ssh-host', process.env.EEA_LICENSE_SSH_HOST || 'root@120.26.211.236'));
const sshKey = expandHome(opt('ssh-key', process.env.EEA_LICENSE_SSH_KEY || path.join(os.homedir(), '.ssh', 'journal_ed25519')));
const sshKnownHosts = opt('known-hosts', process.env.EEA_LICENSE_KNOWN_HOSTS || '');
const remoteAdminUrl = String(opt('remote-admin-url', process.env.EEA_LICENSE_REMOTE_ADMIN_URL || 'http://127.0.0.1:3100')).replace(/\/+$/, '');
const remoteEnvFile = String(opt('remote-env', process.env.EEA_LICENSE_REMOTE_ENV || '/etc/essay-license.env'));
const command = String(positional[0] || (has('help') ? 'help' : 'help')).toLowerCase();
const nowIso = () => new Date().toISOString();

function fail(message) {
  throw new Error(message);
}

async function exists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function hashOf(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function prefixMatch(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return Boolean(x && y && (x.startsWith(y) || y.startsWith(x)));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '');
}

async function loadLedger() {
  if (!(await exists(ledgerFile))) return { version: 1, updatedAt: null, entries: [] };
  let doc;
  try {
    doc = JSON.parse(await readFile(ledgerFile, 'utf8'));
  } catch (error) {
    fail(`台账无法读取：${ledgerFile}（${error.message}）`);
  }
  if (!doc || !Array.isArray(doc.entries)) fail(`台账格式错误：${ledgerFile}`);
  return { version: 1, updatedAt: doc.updatedAt || null, entries: doc.entries };
}

async function saveLedger(doc) {
  await mkdir(path.dirname(ledgerFile), { recursive: true });
  doc.version = 1;
  doc.updatedAt = nowIso();
  const temp = `${ledgerFile}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temp, ledgerFile);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await rm(ledgerFile, { force: true });
    await rename(temp, ledgerFile);
  }
  try { await chmod(ledgerFile, 0o600); } catch { /* Windows ACL 由系统管理 */ }
}

function upsertLedger(doc, entry) {
  const index = doc.entries.findIndex((x) => x.hash === entry.hash);
  if (index < 0) doc.entries.push(entry);
  else doc.entries[index] = { ...doc.entries[index], ...entry };
}

async function authorMaterial() {
  if (!(await exists(keyFile))) fail(`找不到作者私钥：${keyFile}`);
  const privatePem = await readPemFile(keyFile);
  let publicPem;
  try {
    publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    fail(`无法从作者私钥派生公钥：${keyFile}`);
  }
  return { privatePem, publicPem };
}

function requestJson(urlText, method = 'GET', body = null, headers = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlText); } catch { reject(new Error(`地址无效：${urlText}`)); return; }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = mod.request(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = JSON.parse(text || '{}'); } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${urlText}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sshAdminRequest(apiPath, method, body) {
  const request = Buffer.from(JSON.stringify({ base: remoteAdminUrl, path: apiPath, method, body }), 'utf8').toString('base64');
  const envFile = Buffer.from(remoteEnvFile, 'utf8').toString('base64');
  const remoteScript = `
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const reqData = JSON.parse(Buffer.from('${request}', 'base64').toString('utf8'));
const envFile = Buffer.from('${envFile}', 'base64').toString('utf8');
const envText = fs.readFileSync(envFile, 'utf8');
const line = envText.split(/\\r?\\n/).find((x) => x.startsWith('CLOUD_LICENSE_TOKEN='));
if (!line) throw new Error('CLOUD_LICENSE_TOKEN missing in ' + envFile);
const token = line.slice(line.indexOf('=') + 1).trim().replace(/^['\"]|['\"]$/g, '');
const url = new URL(reqData.base + reqData.path);
const payload = reqData.body == null ? null : JSON.stringify(reqData.body);
const mod = url.protocol === 'https:' ? https : http;
const headers = { accept: 'application/json', 'x-cloud-license-token': token };
if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
const r = mod.request(url, { method: reqData.method, headers, timeout: 12000 }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed = {};
    try { parsed = JSON.parse(text || '{}'); } catch { parsed = { raw: text }; }
    process.stdout.write(JSON.stringify({ status: res.statusCode || 0, body: parsed }));
  });
});
r.on('timeout', () => r.destroy(new Error('remote admin request timeout')));
r.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
if (payload) r.write(payload);
r.end();
`;
  const sshArgs = [
    '-i', sshKey,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (sshKnownHosts) sshArgs.push('-o', `UserKnownHostsFile=${expandHome(sshKnownHosts)}`);
  sshArgs.push(sshHost, 'node', '-');
  const result = spawnSync('ssh', sshArgs, { input: remoteScript, encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) fail(`SSH 管理请求失败：${result.error.message}`);
  if (result.status !== 0) fail(`SSH 管理请求失败：${String(result.stderr || '').trim() || `退出码 ${result.status}`}`);
  try {
    return JSON.parse(String(result.stdout || '').trim());
  } catch {
    fail(`SSH 管理响应无法解析：${String(result.stdout || '').trim()}`);
  }
}

async function adminRequest(apiPath, method = 'GET', body = null) {
  if (directAdminUrl) {
    if (!directToken) fail('直连管理接口需要 --token 或 EEA_LICENSE_TOKEN');
    return requestJson(`${directAdminUrl}${apiPath}`, method, body, { 'x-cloud-license-token': directToken });
  }
  return sshAdminRequest(apiPath, method, body);
}

function requireOk(response, action) {
  if (!response || response.status < 200 || response.status >= 300 || response.body?.ok === false) {
    const detail = response?.body?.error || response?.body?.status || response?.body?.raw || `HTTP ${response?.status || 0}`;
    fail(`${action}失败：${detail}`);
  }
  return response.body;
}

async function cloudList() {
  return requireOk(await adminRequest('/v1/admin/list'), '查询云端状态');
}

function serverNote(customer, note) {
  return [String(customer || '').trim(), String(note || '').trim()].filter(Boolean).join(' · ').slice(0, 200);
}

function targetInput() {
  const code = String(opt('code', '') || '').trim();
  const hash = String(opt('hash', '') || '').trim().toLowerCase();
  if (code) return { code: normalizeCode(code), hash: hashOf(code) };
  if (hash) return { hash };
  const fallback = String(positional[1] || '').trim();
  if (fallback.startsWith('EEA1')) return { code: normalizeCode(fallback), hash: hashOf(fallback) };
  if (fallback) return { hash: fallback.toLowerCase() };
  fail('请提供 --code <完整激活码> 或 --hash <哈希前缀>');
}

function redactEntry(entry) {
  if (has('show-code')) return entry;
  const { code: _code, ...safe } = entry;
  return safe;
}

function findLocal(entries, hash) {
  return entries.find((x) => prefixMatch(x.hash, hash)) || null;
}

function findCloud(codes, hash) {
  return codes.find((x) => prefixMatch(x.hash, hash)) || null;
}

function expiryText(entry) {
  if (!entry) return '未知';
  return entry.permanent ? '永久' : String(entry.expiresAt || '未知').slice(0, 10);
}

function stateText(local, cloud) {
  if (cloud?.revoked || local?.revoked) return '已吊销';
  if (local && !local.permanent && local.expiresAt) {
    const today = new Date().toISOString().slice(0, 10);
    if (local.expiresAt.slice(0, 10) < today) return '已过期';
  }
  if (cloud) return cloud.deviceCount > 0 ? '已激活' : '已登记';
  return '未登记';
}

function printOne(local, cloud, index = 1, quota = 2) {
  const hash = local?.hash?.slice(0, 16) || cloud?.hash || '未知';
  console.log(`${index}. ${hash}  ${stateText(local, cloud)}`);
  console.log(`   客户：${local?.customer || '未填写'}  期限：${expiryText(local)}  设备：${cloud?.deviceCount ?? 0}/${quota}`);
  const note = local?.note || cloud?.note;
  if (note) console.log(`   备注：${note}`);
  if (has('show-code') && local?.code) console.log(`   激活码：${local.code}`);
  for (const device of cloud?.devices || []) {
    console.log(`   └─ ${device.name || '未知设备'}  id=${device.id}  最近=${device.lastSeen || '未知'}`);
  }
}

async function commandHelp() {
  console.log(`激活码统一管理 CLI

常用命令：
  node scripts/license-admin.mjs health
  node scripts/license-admin.mjs issue --customer "张三" --expiry 2027-03-31
  node scripts/license-admin.mjs issue --count 10 --expiry 2027-03-31 --out codes.txt
  node scripts/license-admin.mjs list
  node scripts/license-admin.mjs status --code "EEA1..."
  node scripts/license-admin.mjs revoke --code "EEA1..."
  node scripts/license-admin.mjs restore --hash "哈希前16位"
  node scripts/license-admin.mjs unbind --hash "哈希前16位" --device-id "设备ID"
  node scripts/license-admin.mjs strict on|off

issue 选项：
  --count N            数量，默认 1
  --expiry YYYY-MM-DD  到期日；不传表示永久
  --customer 姓名      客户/订单标识
  --note 备注           备注
  --out 文件            码表输出路径；默认写到私钥目录
  --no-register        只生成并写台账，不预登记云端

通用选项：
  --key 文件            默认 ${keyFile}
  --ledger 文件         默认 ${ledgerFile}
  --ssh-host 主机       默认 ${sshHost}
  --ssh-key 文件        默认 ${sshKey}
  --known-hosts 文件    可指定独立 known_hosts
  --public-url 地址     默认 ${publicUrl}
  --json                输出 JSON
  --show-code           list/status 中显示完整激活码

默认管理操作经 SSH 访问服务器本机接口，不在公网 HTTP 上传管理口令。
直连测试可使用 --admin-url URL --token TOKEN。`);
}

async function commandHealth() {
  const keyOk = await exists(keyFile);
  const ledgerOk = await exists(ledgerFile);
  let publicHealth;
  try { publicHealth = await requestJson(`${publicUrl}/v1/health`); }
  catch (error) { fail(`公网健康检查失败：${error.message}`); }
  if (publicHealth.status !== 200 || publicHealth.body?.ok !== true) fail(`公网健康检查异常：HTTP ${publicHealth.status}`);
  const cloud = await cloudList();
  if (has('json')) {
    console.log(JSON.stringify({ ok: true, keyFile, keyExists: keyOk, ledgerFile, ledgerExists: ledgerOk, publicUrl, cloud: { quota: cloud.quota, strict: cloud.strict, codes: cloud.codes.length, devices: cloud.codes.reduce((n, x) => n + x.deviceCount, 0) } }, null, 2));
    return;
  }
  console.log('激活码管理环境正常');
  console.log(`  作者私钥：${keyOk ? '存在' : '缺失'}  ${keyFile}`);
  console.log(`  本地台账：${ledgerOk ? '存在' : '尚未创建'}  ${ledgerFile}`);
  console.log(`  公网服务：正常  ${publicUrl}`);
  console.log(`  管理通道：正常  ${directAdminUrl ? '直连模式' : `SSH ${sshHost}`}`);
  console.log(`  云端状态：strict=${cloud.strict}，激活码=${cloud.codes.length}，设备=${cloud.codes.reduce((n, x) => n + x.deviceCount, 0)}`);
}

async function commandIssue() {
  const count = Number(opt('count', '1'));
  if (!Number.isInteger(count) || count < 1 || count > 10000) fail('--count 应为 1～10000 的整数');
  const expiry = String(opt('expiry', '') || '').trim();
  const customer = String(opt('customer', '') || '').trim();
  const note = String(opt('note', '') || '').trim();
  const days = expiry ? daysFromDate(expiry) : 0;
  const { privatePem, publicPem } = await authorMaterial();
  const ledger = await loadLedger();
  const issuedAt = nowIso();
  const generated = [];
  for (let i = 0; i < count; i++) {
    const signed = signWithDays(privatePem, days);
    const verified = verifyCodeWith(signed.code, publicPem);
    if (!verified.ok) fail('内部验签失败，已停止发码');
    const entry = {
      hash: hashOf(signed.code),
      code: signed.code,
      customer,
      note,
      issuedAt,
      expiresAt: signed.expiresAt,
      permanent: signed.permanent,
      cloudRegistered: false,
      cloudRegisteredAt: null,
      revoked: false,
    };
    generated.push(entry);
    upsertLedger(ledger, entry);
  }
  const outText = String(opt('out', '') || '').trim();
  const outFile = expandHome(outText || path.join(path.dirname(keyFile), `codes-${timestampForFile()}.txt`));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, generated.map((x) => x.code).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  try { await chmod(outFile, 0o600); } catch { /* Windows ACL 由系统管理 */ }
  await saveLedger(ledger);

  const errors = [];
  if (!has('no-register')) {
    for (const entry of generated) {
      try {
        requireOk(await adminRequest('/v1/admin/add', 'POST', { code: entry.code, note: serverNote(customer, note) }), '云端登记');
        entry.cloudRegistered = true;
        entry.cloudRegisteredAt = nowIso();
        upsertLedger(ledger, entry);
      } catch (error) {
        errors.push(`${entry.hash.slice(0, 16)}：${error.message}`);
      }
    }
    await saveLedger(ledger);
  }

  console.log(`已生成 ${generated.length} 个${expiry ? `（到期 ${expiry}）` : '（永久）'}激活码`);
  console.log(`码表：${outFile}`);
  console.log(`台账：${ledgerFile}`);
  console.log(`云端登记：${has('no-register') ? '已跳过' : `${generated.length - errors.length}/${generated.length} 成功`}`);
  console.log('────────────────────────────────────────────────────────────────');
  for (const entry of generated) console.log(entry.code);
  console.log('────────────────────────────────────────────────────────────────');
  if (errors.length) fail(`部分云端登记失败，激活码已安全写入码表和台账：\n${errors.join('\n')}`);
}

async function commandRegister() {
  const { code } = targetInput();
  if (!code) fail('register 必须提供完整激活码');
  const customer = String(opt('customer', '') || '').trim();
  const note = String(opt('note', '') || '').trim();
  const { publicPem } = await authorMaterial();
  const verified = verifyCodeWith(code, publicPem);
  if (!verified.ok) fail(`激活码无效：${verified.reason}`);
  const addBody = { code };
  const cloudNote = serverNote(customer, note);
  if (cloudNote) addBody.note = cloudNote;
  requireOk(await adminRequest('/v1/admin/add', 'POST', addBody), '云端登记');
  const ledger = await loadLedger();
  const hash = hashOf(code);
  const old = findLocal(ledger.entries, hash);
  upsertLedger(ledger, {
    hash,
    code,
    customer: customer || old?.customer || '',
    note: note || old?.note || '',
    issuedAt: old?.issuedAt || nowIso(),
    expiresAt: verified.expiresAt,
    permanent: verified.permanent,
    cloudRegistered: true,
    cloudRegisteredAt: nowIso(),
    revoked: false,
  });
  await saveLedger(ledger);
  console.log(`登记成功：${hash.slice(0, 16)}`);
}

async function commandList() {
  const ledger = await loadLedger();
  const cloud = await cloudList();
  if (has('json')) {
    console.log(JSON.stringify({ local: ledger.entries.map(redactEntry), cloud }, null, 2));
    return;
  }
  const rows = [];
  for (const local of ledger.entries) rows.push({ local, cloud: findCloud(cloud.codes, local.hash) });
  for (const one of cloud.codes) {
    if (!rows.some((row) => prefixMatch(row.local?.hash || '', one.hash))) rows.push({ local: null, cloud: one });
  }
  console.log(`激活码状态：本地台账 ${ledger.entries.length} 条，云端 ${cloud.codes.length} 条，strict=${cloud.strict}`);
  if (!rows.length) {
    console.log('暂无激活码记录。');
    return;
  }
  rows.forEach((row, i) => printOne(row.local, row.cloud, i + 1, cloud.quota));
}

async function commandStatus() {
  const target = targetInput();
  const ledger = await loadLedger();
  const cloud = await cloudList();
  const local = findLocal(ledger.entries, target.hash);
  const remote = findCloud(cloud.codes, target.hash);
  if (!local && !remote) fail(`未找到激活码状态：${target.hash.slice(0, 16)}`);
  if (has('json')) {
    console.log(JSON.stringify({ state: stateText(local, remote), local: local ? redactEntry(local) : null, cloud: remote }, null, 2));
    return;
  }
  printOne(local, remote, 1, cloud.quota);
}

async function commandRevoke(revoke) {
  const target = targetInput();
  const body = target.code ? { code: target.code, revoke } : { hash: target.hash, revoke };
  const result = requireOk(await adminRequest('/v1/admin/revoke', 'POST', body), revoke ? '吊销' : '恢复');
  const ledger = await loadLedger();
  for (const entry of ledger.entries) if (prefixMatch(entry.hash, target.hash)) entry.revoked = revoke;
  await saveLedger(ledger);
  console.log(`${revoke ? '吊销' : '恢复'}成功：${result.hash}`);
}

async function commandUnbind() {
  const target = targetInput();
  const deviceId = String(opt('device-id', '') || '').trim();
  if (!deviceId) fail('unbind 需要 --device-id <完整设备ID>');
  const body = target.code ? { code: target.code, deviceId } : { hash: target.hash, deviceId };
  const result = requireOk(await adminRequest('/v1/admin/unbind', 'POST', body), '设备解绑');
  console.log(`解绑完成：${result.hash}，移除设备数 ${result.removed}`);
}

async function commandStrict() {
  const value = String(positional[1] || opt('value', '')).toLowerCase();
  if (!['on', 'off'].includes(value)) fail('strict 用法：strict on 或 strict off');
  const result = requireOk(await adminRequest('/v1/admin/strict', 'POST', { on: value === 'on' }), '切换严格模式');
  console.log(`严格白名单模式：${result.strict ? '已开启' : '已关闭'}`);
}

async function main() {
  switch (command) {
    case 'help': return commandHelp();
    case 'health': return commandHealth();
    case 'issue': return commandIssue();
    case 'register': return commandRegister();
    case 'list': return commandList();
    case 'status': return commandStatus();
    case 'revoke': return commandRevoke(true);
    case 'restore': return commandRevoke(false);
    case 'unbind': return commandUnbind();
    case 'strict': return commandStrict();
    default: fail(`未知命令：${command}（运行 help 查看用法）`);
  }
}

main().catch((error) => {
  console.error(`[错误] ${error.message}`);
  process.exitCode = 1;
});
