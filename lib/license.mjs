/**
 * 激活码验证与授权状态 —— 运行在用户机器上（会被混淆打包进发行版）。
 *
 * 本模块只含【验证】能力：用内嵌公钥校验激活码的 Ed25519 签名。
 * 产码需要私钥，作者工具（scripts/issue-code.mjs / license-gen.mjs）在项目源码树，
 * 不进入任何发行包 —— 逆向者即使拿到全部发行代码也造不出合法激活码。
 *
 * 激活码格式（101 个字符，字符集为 base64url：A-Za-z0-9 - _）：
 *   'EEA1' + base64url(data 8B) + base64url(ed25519 签名 64B)
 *   data: [0x4B][0x01][uint16BE 到期日距 2024-01-01 的天数, 0=永久][uint32BE 随机数]
 * 注意：base64url 字母表自带 '-' 与 '_'，因此解析时只忽略空白，绝不把 '-' 当分隔符。
 *
 * ── 云端校验（可选叠加层）─────────────────────────────────────────────
 * 当 server.licenseUrl 配置了激活码云端服务器（scripts/cloud-license-server.mjs）
 * 时启用，否则行为与纯离线完全一致（开发/回归测试保持简单）：
 *   · 激活：本地验签通过后【必须】云端确认（自动登记+绑定设备）成功才落盘；
 *   · 启动：已激活用户静默云端确认一次（≤6s），失败时按本地缓存宽限 7 天降级可用；
 *   · 心跳：激活后每 12h 后台心跳；服务器返回 revoked（吊销）时即时本地失效。
 * 设备身份（id=随机 UUID + 名称）持久化在授权目录 device.json，
 * 名称优先取 EEA_DEVICE_NAME（Android 壳注入机型），兜底 os.hostname()。
 */
import { verify as edVerify, createPublicKey, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { licenseFile, licenseDir } from './paths.mjs';
import { LICENSE_PUBKEY } from './license-pub.mjs';
import { loadConfig } from './config.mjs';

export const CODE_PREFIX = 'EEA1';
export const EPOCH_UTC = Date.UTC(2024, 0, 1);
export const DAY_MS = 86400000;
export const DATA_LEN = 8; // 数据区固定 8 字节
const PREFIX_LEN = CODE_PREFIX.length;
// base64url 无填充长度：8B → 11 字符；64B → 86 字符
const SIG_B64_LEN = 86;
export const CODE_LEN = PREFIX_LEN + 11 + SIG_B64_LEN;

/** 云端不可达时的降级宽限期（距上次云端确认成功）。 */
export const CLOUD_GRACE_MS = 7 * 86400000;
const CLOUD_TIMEOUT_MS = 6000;
const HEARTBEAT_MS = 12 * 3600000;

/** 容错：只忽略空白（空格/换行/制表），便于从聊天窗口粘贴。 */
export function normalizeCode(input) {
  return String(input ?? '').replace(/\s+/g, '');
}

/** 便于肉眼核对：每 4 字符插一个空格（复制粘贴时空白会被忽略，无碍验签）。 */
export function displayCode(input) {
  const canonical = normalizeCode(input);
  if (canonical.length !== CODE_LEN) return canonical;
  return canonical.match(/.{1,4}/g).join(' ');
}

/** 校验激活码（用给定 PEM 公钥验签，作者自查/测试用）。返回 { ok, reason?, permanent?, expiresAt? }，reason: invalid | expired。 */
export function verifyCodeWith(input, pubPem) {
  const canonical = normalizeCode(input);
  if (canonical.length !== CODE_LEN || !canonical.startsWith(CODE_PREFIX)) {
    return { ok: false, reason: 'invalid' };
  }
  let data, sig;
  try {
    data = Buffer.from(canonical.slice(PREFIX_LEN, PREFIX_LEN + 11), 'base64url');
    sig = Buffer.from(canonical.slice(PREFIX_LEN + 11), 'base64url');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (data.length !== DATA_LEN || sig.length !== 64) return { ok: false, reason: 'invalid' };
  if (data[0] !== 0x4b || data[1] !== 0x01) return { ok: false, reason: 'invalid' };

  const days = data.readUInt16BE(2);
  const expiresAt = days === 0 ? null : new Date(EPOCH_UTC + days * DAY_MS);
  let key;
  try {
    key = createPublicKey(pubPem);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const good = edVerify(null, data, key, sig);
    if (!good) return { ok: false, reason: 'invalid' };
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

/** 校验激活码（用内嵌分发公钥，用户端/构建后使用）。 */
export function verifyCode(input) {
  return verifyCodeWith(input, LICENSE_PUBKEY);
}

/* ---------------- 云端服务地址（env > config > 空=纯离线） ---------------- */

let cloudUrlOverride = null; // null=未初始化；''=显式关闭

export function setCloudUrl(url) {
  cloudUrlOverride = url ? String(url).replace(/\/+$/, '') : '';
}

async function cloudUrl() {
  if (cloudUrlOverride !== null) return cloudUrlOverride;
  try {
    const cfg = await loadConfig();
    setCloudUrl(cfg.server?.licenseUrl || '');
  } catch {
    setCloudUrl('');
  }
  return cloudUrlOverride;
}

/** 测试辅助：同步判断当前是否云端模式（等待首次读取可先 setCloudUrl）。 */
export function isCloudMode() {
  return cloudUrlOverride !== null && cloudUrlOverride !== '';
}

/* ---------------- 设备身份（授权目录 device.json） ---------------- */

function deviceFile() {
  return path.join(licenseDir(), 'device.json');
}

export async function deviceIdentity() {
  try {
    const doc = JSON.parse(await readFile(deviceFile(), 'utf8'));
    if (doc && typeof doc.id === 'string' && doc.id.length >= 8 && typeof doc.name === 'string' && doc.name) {
      return { id: doc.id, name: doc.name };
    }
  } catch {
    /* 首次或损坏，重建 */
  }
  const id = randomUUID();
  let name = '';
  try {
    name = String(process.env.EEA_DEVICE_NAME || os.hostname() || '').trim().slice(0, 60);
  } catch {
    name = '';
  }
  const identity = { id, name: name || 'unknown-device' };
  try {
    await mkdir(path.dirname(deviceFile()), { recursive: true });
    await writeFile(deviceFile(), JSON.stringify(identity, null, 2) + '\n', 'utf8');
  } catch {
    /* 目录只读时降级为进程内身份（每次启动更换，作者管理端可见新设备） */
  }
  return identity;
}

/* ---------------- 云端确认缓存（cloud-cache.json，与 license.json 分离） ---------------- */

function cloudCacheFile() {
  return path.join(licenseDir(), 'cloud-cache.json');
}

async function readCloudCache() {
  try {
    return JSON.parse(await readFile(cloudCacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCloudCache(lastCloudOkIso) {
  try {
    await mkdir(path.dirname(cloudCacheFile()), { recursive: true });
    await writeFile(cloudCacheFile(), JSON.stringify({ lastCloudOk: lastCloudOkIso }, null, 2) + '\n', 'utf8');
  } catch {
    /* 忽略写失败：下次启动重新确认 */
  }
}

async function clearCloudCache() {
  try {
    await unlink(cloudCacheFile());
  } catch {
    /* 无缓存文件也正常 */
  }
}

/* ---------------- 极简 HTTP 客户端（兼容无 fetch 的嵌入式 Node） ---------------- */

function requestJson(url, payload, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ netError: true });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const body = payload ? JSON.stringify(payload) : null;
    const headers = { 'content-type': 'application/json' };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    let done = false;
    const req = mod.request(
      u,
      { method: payload ? 'POST' : 'GET', headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (done) return;
          done = true;
          let parsed = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            /* 非 JSON 响应按空处理 */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('timeout', () => {
      if (done) return;
      done = true;
      req.destroy();
      resolve({ netError: true });
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve({ netError: true });
    });
    if (body) req.write(body);
    req.end();
  });
}

/* ---------------- 云端校验 ---------------- */

/**
 * 云端确认：POST /v1/verify { code, device }。
 * 返回 { status: 'ok'|'revoked'|'not_registered'|'device_limit'|'invalid'|'expired'|'unreachable'|'skip'(无 URL) }。
 */
async function cloudVerify(code) {
  const url = await cloudUrl();
  if (!url) return { status: 'skip' };
  const dev = await deviceIdentity();
  const r = await requestJson(`${url}/v1/verify`, { code, device: dev }, CLOUD_TIMEOUT_MS);
  if (r.netError) return { status: 'unreachable' };
  if (r.status === 200 && r.body && r.body.ok) return { status: 'ok' };
  const st = r.body && r.body.status ? r.body.status : 'error';
  return { status: st === 'rate_limited' ? 'unreachable' : st };
}

/** 云端明确拒绝（吊销/未登记/设备满/需在线）→ 本地立即失效并清除降级缓存。 */
async function denyWith(reason) {
  await clearCloudCache();
  resetState();
  state.cloud = reason;
  state.cloudReason = reason;
}

/* ---------------- 内存授权状态（进程内单例） ---------------- */

const state = {
  activated: false,
  code: null,
  permanent: false,
  expiresAt: null,
  activatedAt: null,
  cloud: 'off', // off | ok | unreachable | revoked | not_registered | device_limit | need_online | invalid | expired
  cloudReason: null,
};

export function isActivated() {
  return state.activated;
}

export function licenseStatus() {
  return {
    activated: state.activated,
    permanent: state.permanent,
    expiresAt: state.expiresAt,
    activatedAt: state.activatedAt,
    cloud: state.cloud,
    cloudReason: state.cloudReason,
  };
}

function resetState() {
  state.activated = false;
  state.code = null;
  state.permanent = false;
  state.expiresAt = null;
  state.activatedAt = null;
  state.cloud = 'off';
  state.cloudReason = null;
}

function activateFromDoc(doc, v) {
  state.activated = true;
  state.code = doc.code;
  state.permanent = v.permanent;
  state.expiresAt = v.expiresAt;
  state.activatedAt = doc.activatedAt ?? null;
}

async function persistActivation(canonical, v) {
  const doc = {
    code: canonical,
    activatedAt: new Date().toISOString(),
    permanent: v.permanent,
    expiresAt: v.expiresAt,
  };
  await mkdir(path.dirname(licenseFile()), { recursive: true });
  await writeFile(licenseFile(), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

/**
 * 启动时调用：读取并校验本机 license.json（幂等，反映磁盘状态）。
 * 纯离线模式：本地验签通过即激活。
 * 云端模式：本地验签通过后再做一次云端确认——
 *   · ok：激活并刷新降级缓存；
 *   · 云端明确拒绝（revoked / not_registered / device_limit）：立即失效；
 *   · 云端不可达：距上次确认成功 ≤ CLOUD_GRACE_MS 则降级放行，否则失效（need_online）。
 */
export async function loadLicense() {
  try {
    const doc = JSON.parse(await readFile(licenseFile(), 'utf8'));
    const v = verifyCode(doc.code);
    if (!v.ok) {
      resetState();
      return false;
    }
    resetState();
    activateFromDoc(doc, v);
    const url = await cloudUrl();
    if (!url) {
      state.cloud = 'off';
      return true;
    }
    const cache = await readCloudCache();
    const lastOk = cache && cache.lastCloudOk ? Date.parse(cache.lastCloudOk) : NaN;
    const withinGrace = Number.isFinite(lastOk) && Date.now() - lastOk <= CLOUD_GRACE_MS;

    const r = await cloudVerify(doc.code);
    if (r.status === 'ok') {
      state.cloud = 'ok';
      await writeCloudCache(new Date().toISOString());
      return true;
    }
    if (r.status === 'revoked' || r.status === 'not_registered' || r.status === 'device_limit' || r.status === 'invalid' || r.status === 'expired') {
      await denyWith(r.status);
      return false;
    }
    // unreachable：按宽限期降级
    if (withinGrace) {
      state.cloud = 'unreachable';
      return true;
    }
    await denyWith('need_online');
    return false;
  } catch {
    resetState();
    return false;
  }
}

/** 用户提交激活码：本地验签；云端模式还需云端确认成功（自动登记+绑定本设备）才落盘。 */
export async function activateWithCode(input) {
  const v = verifyCode(input);
  if (!v.ok) return { ok: false, reason: v.reason };
  const canonical = normalizeCode(input);
  const url = await cloudUrl();
  if (!url) {
    // 纯离线模式：直接落盘
    const doc = await persistActivation(canonical, v);
    resetState();
    activateFromDoc(doc, v);
    state.cloud = 'off';
    return { ok: true, permanent: v.permanent, expiresAt: v.expiresAt };
  }
  // 云端模式：必须先过云端（登记+绑机/心跳确认）
  const r = await cloudVerify(canonical);
  if (r.status !== 'ok') {
    const reason = `cloud:${r.status}`;
    const messages = {
      'cloud:revoked': '该激活码已被作者吊销，请联系作者。',
      'cloud:not_registered': '该激活码未在服务器登记（白名单模式），请联系作者。',
      'cloud:device_limit': '该激活码绑定的设备数已达上限，请先在服务器释放旧设备或联系作者。',
      'cloud:unreachable': '无法连接激活服务器，请检查网络后重试。',
      'cloud:invalid': '服务器校验未通过（激活码无效）。',
      'cloud:expired': '激活码已过期，请联系作者获取新码。',
      'cloud:error': '服务器返回异常，请稍后重试。',
    };
    return { ok: false, reason, message: messages[reason] || '云端校验失败，请稍后重试。' };
  }
  const doc = await persistActivation(canonical, v);
  resetState();
  activateFromDoc(doc, v);
  state.cloud = 'ok';
  await writeCloudCache(new Date().toISOString());
  return { ok: true, permanent: v.permanent, expiresAt: v.expiresAt };
}

/** 后台心跳：已激活 + 云端模式下每 12h 与服务器核对一次；吊销响应即时本地失效。 */
let heartbeatStarted = false;
export function startCloudHeartbeat() {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  setInterval(async () => {
    if (!state.activated || !state.code) return;
    const url = await cloudUrl();
    if (!url) return;
    const r = await cloudVerify(state.code);
    if (r.status === 'ok') {
      state.cloud = 'ok';
      state.cloudReason = null;
      await writeCloudCache(new Date().toISOString());
    } else if (r.status === 'revoked' || r.status === 'not_registered' || r.status === 'device_limit') {
      await denyWith(r.status);
    } else {
      state.cloud = 'unreachable'; // 仅展示；降级判定以启动宽限为准
    }
  }, HEARTBEAT_MS).unref?.();
}

/** 守卫：深层业务入口调用。未激活时抛 403，由 server 统一包装为 JSON。 */
export function guard() {
  if (!state.activated) {
    const err = new Error('软件尚未激活：请先输入激活码后再使用批改功能。');
    err.code = 'NOT_ACTIVATED';
    err.status = 403;
    throw err;
  }
}
