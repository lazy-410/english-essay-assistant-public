#!/usr/bin/env node
/**
 * cloud-license-server.mjs — 激活码云端校验服务器（零依赖单文件，Node ≥ 18）
 *
 * 用途：为「考研英语作文助手」增加云端登记/设备绑定/吊销层。
 * 客户端激活码仍为 Ed25519 签名码（作者私钥签发），本服务器只内嵌【公钥】用于验签，
 * 用于：设备绑定（默认每码 2 台）、吊销黑名单、白名单登记、在线状态统计。
 *
 * ── 部署 ─────────────────────────────────────────────────────────────
 *   1) 把本文件 + 作者公钥（C:\...\english-essay-license\public.pem）拷到服务器
 *   2) node cloud-license-server.mjs --port 8080 --token 自设管理口令 \
 *        --public-key public.pem [--host 127.0.0.1]
 *   3) 客户端 config.json 填 server.licenseUrl = "http://<服务器IP>:8080"
 *      （Android 构建：scripts/build-android.mjs --license-url http://<IP>:8080）
 *
 *   对外正式使用建议套 HTTPS（Caddy/Nginx 反代到 8080），url 改 https://…：
 *      caddy reverse_proxy license.example.com:443 :8080   （一行配置示例）
 *
 * ── 管理接口（curl，--token 启动参数同值，以下换 $T、$URL）─────────────
 *   全部要求请求头: -H "x-cloud-license-token: $T"
 *
 *   查看全部码与绑定:      curl $URL/v1/admin/list -H "x-cloud-license-token: $T"
 *   预登记一个码(整码):    curl -X POST $URL/v1/admin/add -H "x-cloud-license-token: $T" \
 *                           -H "content-type: application/json" \
 *                           -d '{"code":"EEA1…","note":"张三 2026 年费"}'
 *   吊销一个码:            curl -X POST $URL/v1/admin/revoke -H "x-cloud-license-token: $T" \
 *                           -H "content-type: application/json" -d '{"code":"EEA1…"}'
 *   解除吊销:              … -d '{"code":"EEA1…","revoke":false}'
 *   释放某设备(换机):      curl -X POST $URL/v1/admin/unbind -H "x-cloud-license-token: $T" \
 *                           -H "content-type: application/json" -d '{"code":"EEA1…","deviceId":"<list 里的 id>"}'
 *   白名单严格模式:        curl -X POST $URL/v1/admin/strict -H "x-cloud-license-token: $T" \
 *                           -H "content-type: application/json" -d '{"on":true}'
 *                          （on=true：未预登记的码一律拒绝；默认 false=自动登记，零维护）
 *   任意管理接口也可用 hash 替代 code（list 输出 hash 前 16 位）。
 *
 * ── 客户端接口 ───────────────────────────────────────────────────────
 *   POST /v1/verify   { code, device: { id, name } }
 *       → { ok:true, status:'ok' }           已绑定/新绑定成功
 *       → { ok:false, status:'revoked' }     该码已被作者吊销
 *       → { ok:false, status:'not_registered' } 严格模式下未预登记
 *       → { ok:false, status:'device_limit', devices:[名称…] } 设备数已满
 *       → { ok:false, status:'invalid'|'expired' } 签名/到期不合法
 *   GET /v1/health → { ok:true }
 *
 * ── 存储 ─────────────────────────────────────────────────────────────
 *   同目录 cloud-license-db.json（原子写：先写临时文件再 rename）。
 */
import { createServer } from 'node:http';
import { createPublicKey, verify as edVerify, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODE_PREFIX = 'EEA1';
const EPOCH_UTC = Date.UTC(2024, 0, 1);
const DAY_MS = 86400000;
const DATA_LEN = 8;
const SIG_B64_LEN = 86;
const CODE_LEN = CODE_PREFIX.length + 11 + SIG_B64_LEN;
const MAX_BODY = 8192;
const RATE_LIMIT = 30; // 每 IP 每窗口失败次数
const RATE_WINDOW_MS = 10 * 60 * 1000;

/** 默认公钥=开发/测试公钥（与 lib/license-pub.mjs 一致）。正式部署必须 --public-key 传作者公钥。 */
const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3VA2aCAaY7Gt9jhjNu5ZnAMjGdFKq1g35aNFiGCBeEM=
-----END PUBLIC KEY-----`;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(argValue('--port', '8080'));
const HOST = argValue('--host', '0.0.0.0');
const QUOTA = Number(argValue('--quota', '2'));
const TOKEN = argValue('--token', process.env.CLOUD_LICENSE_TOKEN || '');
const PUBKEY_FILE = argValue('--public-key', '');
const DB_FILE = argValue('--db', path.join(SCRIPT_DIR, 'cloud-license-db.json'));

if (!TOKEN) {
  console.error('✗ 必须提供管理口令：--token <口令>（或环境变量 CLOUD_LICENSE_TOKEN）');
  process.exit(1);
}
let PUBLIC_KEY = DEFAULT_PUBLIC_KEY;
if (PUBKEY_FILE) {
  try {
    PUBLIC_KEY = readFileSync(PUBKEY_FILE, 'utf8').trim();
    createPublicKey(PUBLIC_KEY); // 提前校验 PEM
  } catch {
    console.error(`✗ 无法读取公钥文件：${PUBKEY_FILE}`);
    process.exit(1);
  }
}

/* ---------------- 存储 ---------------- */

function loadDB() {
  if (!existsSync(DB_FILE)) return { codes: {} };
  try {
    return JSON.parse(readFileSync(DB_FILE, 'utf8'));
  } catch {
    console.error('⚠ 数据库损坏，已备份为 cloud-license-db.json.bad 并重建空库');
    try { renameSync(DB_FILE, DB_FILE + '.bad'); } catch {}
    return { codes: {} };
  }
}
let DB = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(DB, null, 2) + '\n', 'utf8');
    renameSync(tmp, DB_FILE);
  }, 150);
}

function hashOf(code) {
  return createHash('sha256').update(String(code).replace(/\s+/g, '')).digest('hex');
}
/** 管理接口入参：code 整码或 hash 前缀，统一为完整 hash（不存在返回 null）。 */
function resolveHash(input) {
  if (!input || typeof input !== 'string') return null;
  if (input.startsWith(CODE_PREFIX)) return hashOf(input);
  const full = Object.keys(DB.codes).find((h) => h.startsWith(input.toLowerCase()));
  return full || null;
}

/* ---------------- 验签（与 lib/license.mjs 相同规则） ---------------- */

function verifyCode(canonical) {
  if (canonical.length !== CODE_LEN || !canonical.startsWith(CODE_PREFIX)) {
    return { ok: false, reason: 'invalid' };
  }
  let data, sig;
  try {
    data = Buffer.from(canonical.slice(CODE_PREFIX.length, CODE_PREFIX.length + 11), 'base64url');
    sig = Buffer.from(canonical.slice(CODE_PREFIX.length + 11), 'base64url');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (data.length !== DATA_LEN || sig.length !== 64) return { ok: false, reason: 'invalid' };
  if (data[0] !== 0x4b || data[1] !== 0x01) return { ok: false, reason: 'invalid' };
  const days = data.readUInt16BE(2);
  const expiresAt = days === 0 ? null : new Date(EPOCH_UTC + days * DAY_MS);
  try {
    const key = createPublicKey(PUBLIC_KEY);
    if (!edVerify(null, data, key, sig)) return { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (expiresAt) {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (expiresAt.getTime() < todayUtc) return { ok: false, reason: 'expired' };
  }
  return { ok: true, permanent: days === 0, expiresAt: expiresAt ? expiresAt.toISOString() : null };
}

/* ---------------- 客户端接口 ---------------- */

function handleVerify(body) {
  const code = String(body.code ?? '').replace(/\s+/g, '');
  const v = verifyCode(code);
  if (!v.ok) return { ok: false, status: v.reason }; // invalid | expired
  const device = body.device || {};
  const deviceId = String(device.id ?? '').trim().slice(0, 128);
  const deviceName = String(device.name ?? '').trim().slice(0, 80);
  if (!deviceId) return { ok: false, status: 'invalid', detail: 'missing device id' };

  const hash = hashOf(code);
  let rec = DB.codes[hash];
  if (!rec) {
    if (DB.strict) return { ok: false, status: 'not_registered' };
    rec = { note: '', createdAt: new Date().toISOString(), revoked: false, devices: [] };
    DB.codes[hash] = rec;
    saveDB();
  }
  if (rec.revoked) return { ok: false, status: 'revoked' };
  const nowIso = new Date().toISOString();
  const dev = rec.devices.find((d) => d.id === deviceId);
  if (dev) {
    dev.lastSeen = nowIso;
    if (deviceName) dev.name = deviceName;
    saveDB();
    return { ok: true, status: 'ok' };
  }
  if (rec.devices.length >= QUOTA) {
    return { ok: false, status: 'device_limit', devices: rec.devices.map((d) => d.name || d.id.slice(0, 8)) };
  }
  rec.devices.push({ id: deviceId, name: deviceName, firstSeen: nowIso, lastSeen: nowIso });
  saveDB();
  return { ok: true, status: 'ok' };
}

/* ---------------- 管理接口 ---------------- */

function adminList() {
  return {
    ok: true,
    quota: QUOTA,
    strict: Boolean(DB.strict),
    codes: Object.entries(DB.codes).map(([hash, r]) => ({
      hash: hash.slice(0, 16),
      note: r.note,
      createdAt: r.createdAt,
      revoked: r.revoked,
      deviceCount: r.devices.length,
      devices: r.devices.map((d) => ({ id: d.id, name: d.name, firstSeen: d.firstSeen, lastSeen: d.lastSeen })),
    })),
  };
}

function adminAdd(body) {
  let hash = null;
  if (body.code) {
    const v = verifyCode(String(body.code).replace(/\s+/g, ''));
    if (!v.ok) return { ok: false, error: `激活码无效（${v.reason}），拒绝登记` };
    hash = hashOf(body.code);
  } else {
    hash = resolveHash(body.hash);
    if (!hash) return { ok: false, error: '未找到该码（需先验证签发的真码）' };
  }
  if (!DB.codes[hash]) {
    DB.codes[hash] = { note: '', createdAt: new Date().toISOString(), revoked: false, devices: [] };
  }
  if (typeof body.note === 'string') DB.codes[hash].note = body.note.slice(0, 200);
  saveDB();
  return { ok: true, hash: hash.slice(0, 16) };
}

function adminRevoke(body) {
  const hash = resolveHash(body.code || body.hash);
  if (!hash) return { ok: false, error: '未找到该码' };
  DB.codes[hash].revoked = body.revoke !== false;
  saveDB();
  return { ok: true, revoked: DB.codes[hash].revoked, hash: hash.slice(0, 16) };
}

function adminUnbind(body) {
  const hash = resolveHash(body.code || body.hash);
  if (!hash) return { ok: false, error: '未找到该码' };
  const id = String(body.deviceId ?? '');
  const before = DB.codes[hash].devices.length;
  DB.codes[hash].devices = DB.codes[hash].devices.filter((d) => d.id !== id);
  saveDB();
  return { ok: true, removed: before - DB.codes[hash].devices.length, hash: hash.slice(0, 16) };
}

function adminStrict(body) {
  DB.strict = Boolean(body.on);
  saveDB();
  return { ok: true, strict: DB.strict };
}

/* ---------------- HTTP ---------------- */

const failures = new Map(); // ip -> { at, n }
function rateLimited(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f) return false;
  if (now - f.at > RATE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.n >= RATE_LIMIT;
}
function noteFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip) || { at: now, n: 0 };
  if (now - f.at > RATE_WINDOW_MS) { f.at = now; f.n = 0; }
  f.n += 1;
  failures.set(ip, f);
}

function json(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const ip = req.socket.remoteAddress || '';
  const url = req.url.split('?')[0];
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    let body = {};
    if (req.method === 'POST') {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return json(res, 400, { ok: false, status: 'bad_json' }); }
    }
    try {
      // ── 客户端 ──
      if (req.method === 'GET' && url === '/v1/health') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url === '/v1/verify') {
        if (rateLimited(ip)) return json(res, 429, { ok: false, status: 'rate_limited' });
        const r = handleVerify(body);
        if (!r.ok && (r.status === 'invalid' || r.status === 'expired')) noteFailure(ip);
        else failures.delete(ip);
        return json(res, r.ok ? 200 : 403, r);
      }
      // ── 管理 ──
      if (url.startsWith('/v1/admin/')) {
        const auth = String(req.headers['x-cloud-license-token'] || '');
        if (auth !== TOKEN) return json(res, 401, { ok: false, error: '管理口令错误' });
        if (url === '/v1/admin/list') return json(res, 200, adminList());
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });
        if (url === '/v1/admin/add') return json(res, 200, adminAdd(body));
        if (url === '/v1/admin/revoke') return json(res, 200, adminRevoke(body));
        if (url === '/v1/admin/unbind') return json(res, 200, adminUnbind(body));
        if (url === '/v1/admin/strict') return json(res, 200, adminStrict(body));
        return json(res, 404, { ok: false, error: 'unknown admin api' });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      console.error('✗ 请求处理异常：', e);
      return json(res, 500, { ok: false, error: 'internal error' });
    }
  });
});

server.listen(PORT, HOST, () => {
  const pub = PUBKEY_FILE ? `--public-key ${PUBKEY_FILE}` : '（默认测试公钥！请用 --public-key 指定作者公钥）';
  console.log('✓ 激活码云端服务器已启动');
  console.log(`  监听     : ${HOST}:${PORT}`);
  console.log(`  每码设备 : ${QUOTA} 台`);
  console.log(`  严格白名单: ${DB.strict ? '开' : '关（未登记的真码自动登记）'}`);
  console.log(`  公钥     : ${pub}`);
  console.log(`  数据文件 : ${DB_FILE}`);
  console.log(`  健康检查 : http://127.0.0.1:${PORT}/v1/health`);
});
