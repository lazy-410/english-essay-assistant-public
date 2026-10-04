/* ---------------------- CLI：单码查询（作者给发行人展示/自查） ----------------------
 *   node scripts/verify-license.mjs --code <激活码> [--public-key <公钥PEM>]
 * 无参运行 = 第 15 套件全量回归。缺省公钥用内嵌测试公钥（源码侧）；验正式私钥签发
 * 的码时传配套 public.pem（与 license-gen --verify 同源同输出，入口独立）。
 * 注意：下方 import 声明会被提升，但在本分支 exit 前不执行任何回归代码。
 */
const cliArgv = process.argv;
const cliCodeIdx = cliArgv.indexOf('--code');
if (cliCodeIdx > -1 && cliArgv[cliCodeIdx + 1]) {
  const pkIdx = cliArgv.indexOf('--public-key');
  const pkFile = pkIdx > -1 && cliArgv[pkIdx + 1] ? cliArgv[pkIdx + 1] : '';
  const target = cliArgv[cliCodeIdx + 1];
  const result = pkFile ? verifyCodeWith(target, readFileSync(pkFile, 'utf8')) : verifyCode(target);
  if (!result.ok) {
    console.log('校验结果：无效激活码（' + result.reason + '）');
    process.exit(1);
  }
  console.log('校验结果：有效激活码');
  console.log('  码面格式：' + displayCode(target));
  console.log('  永久有效：' + (result.permanent ? '是' : '否'));
  if (result.expiresAt) console.log('  到期时间：' + result.expiresAt);
  console.log('  当前时间：' + new Date().toISOString());
  process.exit(0);
}

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyCode, verifyCodeWith, normalizeCode, displayCode, CODE_LEN,
  loadLicense, activateWithCode, isActivated, guard, licenseStatus, setCloudUrl,
} from '../lib/license.mjs';
import { readPemFile, signWithDays, daysFromDate } from './issue-code.mjs';

/* ---------------------- 测试密钥准备（测试私钥，与内嵌测试公钥配套） ---------------------- */

const TEST_PRIVATE = fileURLToPath(new URL('./keys/test-private.pem', import.meta.url));
const priv = await readPemFile(TEST_PRIVATE);

/* ---------------------- 产码 → 验签回环 ---------------------- */

for (let i = 0; i < 50; i++) {
  const one = signWithDays(priv, 0);
  const v = verifyCode(one.code);
  assert.equal(v.ok, true, `第 ${i} 个永久码应验签通过`);
}
assert.equal(verifyCode(signWithDays(priv, 0).code).permanent, true, '永久码应标记 permanent');
assert.equal(verifyCode(signWithDays(priv, 0).code).expiresAt, null);

// 到期码：到期日当天仍有效
const dated = signWithDays(priv, daysFromDate('2026-12-31'));
const vd = verifyCode(dated.code);
assert.equal(vd.ok, true);
assert.equal(vd.expiresAt, '2026-12-31T00:00:00.000Z');
assert.equal(vd.permanent, false);

/* ---------------------- 篡改 / 伪造必须被拒 ---------------------- */

const good = signWithDays(priv, 0).code;
const canonical = normalizeCode(good);
assert.equal(canonical.length, CODE_LEN, '码体固定长度');

// 篡改必须被拒。注意避开 base64url 无填充串的“尾字符”：
// 末字符低 4 位是编码填充空位，改它不影响解码字节（验签通过属正确行为）。
const flipAt = (s, idx) => s.slice(0, idx) + (s[idx] === 'A' ? 'B' : 'A') + s.slice(idx + 1);

// 改 data 区第 2 字节（签名对象变化）→ 必须失效
assert.equal(verifyCode(flipAt(canonical, 5)).ok, false, '篡改数据区一个字符即失效');
// 改 sig 区中段字符（签名内容变化）→ 必须失效
assert.equal(verifyCode(flipAt(canonical, 60)).ok, false, '篡改签名一个有效字符即失效');

// 截断/加长
assert.equal(verifyCode(canonical.slice(1)).ok, false);
assert.equal(verifyCode(canonical + 'A').ok, false);

// 无意义的等长串
assert.equal(verifyCode('A'.repeat(CODE_LEN)).ok, false);
assert.equal(verifyCode('EEA1' + '2'.repeat(CODE_LEN - 4)).ok, false);

// 前缀不对
assert.equal(verifyCode('BEE1' + canonical.slice(4)).ok, false);

// 垃圾输入
assert.equal(verifyCode('').ok, false);
assert.equal(verifyCode('HELLO WORLD 激活码').ok, false);
assert.equal(verifyCode(null).ok, false);

/* ---------------------- 容错 ---------------------- */

// 展示格式（空格分组）粘贴后应验签通过——注意是插入空白而非替换字符
const spaced = displayCode(good).replace(/(.{11})/g, '$1\n');
assert.equal(verifyCode('\t' + spaced + '  ').ok, true, '任意空白都应被忽略');
assert.equal(verifyCode(good).ok, true);

/* ---------------------- 过期 ---------------------- */

// 用测试私钥签一张「2024-01-02 到期」的码——现在早已过期
const expired = signWithDays(priv, 1).code;
const ve = verifyCode(expired);
assert.equal(ve.ok, false);
assert.equal(ve.reason, 'expired');

/* ---------------------- 本地授权状态与文件持久化 ---------------------- */

// 回归中的 test-private.pem 只与测试公钥配套；显式关闭 config.json 的生产云端地址，
// 避免开发机当前配置影响纯离线授权测试。
setCloudUrl('');

// 隔离目录：模拟用户机器上的授权目录
const dir = mkdtempSync(path.join(os.tmpdir(), 'eea-lic-reg-'));
const savedEnv = process.env.EEA_LICENSE_DIR;
process.env.EEA_LICENSE_DIR = dir;
try {
  // 首次（无文件）→ 未激活；guard 应抛出 403
  assert.equal(await loadLicense(), false);
  assert.equal(isActivated(), false);
  assert.equal(licenseStatus().activated, false);
  assert.throws(() => guard(), (e) => e.code === 'NOT_ACTIVATED' && e.status === 403);

  // 激活：写坏码 → 失败且不产生文件
  const badAct = await activateWithCode('EEA1' + '9'.repeat(CODE_LEN - 4));
  assert.equal(badAct.ok, false);

  // 真码激活 → 文件落地
  const act = await activateWithCode(good);
  assert.equal(act.ok, true);
  assert.equal(act.permanent, true);
  assert.equal(isActivated(), true);
  assert.equal(licenseStatus().activated, true);
  const file = path.join(dir, 'license.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.code, canonical, '落盘应为规范化码');
  assert.ok(doc.activatedAt, '记录激活时间');

  // 重启模拟：重新 loadLicense 应恢复激活，guard 放行
  const dir2 = dir; // 同一授权目录
  process.env.EEA_LICENSE_DIR = dir2;
  // 重新加载需重置模块内存态：直接再次 loadLicense（其内部先复位状态）
  assert.equal(await loadLicense(), true);
  assert.equal(isActivated(), true);
  assert.doesNotThrow(() => guard());

  // 篡改落盘文件中的授权码 → 重启后失效（expiresAt 等只是 code 派生的展示字段）
  const tamperedDoc = { ...doc, code: flipAt(doc.code, 6) };
  writeFileSync(file, JSON.stringify(tamperedDoc));
  assert.equal(await loadLicense(), false, '篡改 license.json 里的授权码应导致失效');
  assert.equal(isActivated(), false, 'loadLicense 失败后内存态应复位');

  // 目录不存在时 loadLicense 也应安全返回 false（模拟首次安装）
  const emptyDir = path.join(dir, 'nested-missing');
  process.env.EEA_LICENSE_DIR = emptyDir;
  assert.equal(await loadLicense(), false);
} finally {
  process.env.EEA_LICENSE_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
}

// 到期码激活后 expiry 信息随 licenseStatus 可见
const dir3 = mkdtempSync(path.join(os.tmpdir(), 'eea-lic-reg3-'));
process.env.EEA_LICENSE_DIR = dir3;
try {
  await loadLicense();
  const act2 = await activateWithCode(dated.code);
  assert.equal(act2.ok, true);
  assert.equal(act2.expiresAt, '2026-12-31T00:00:00.000Z');
  assert.equal(licenseStatus().expiresAt, '2026-12-31T00:00:00.000Z');
} finally {
  process.env.EEA_LICENSE_DIR = savedEnv;
  rmSync(dir3, { recursive: true, force: true });
}

/* ---------------------- 云端校验回归（本地 mock cloud-license-server） ---------------------- */

import { spawn as spawnCloudProc } from 'node:child_process';
import { setTimeout as sleepMs } from 'node:timers/promises';

{
  const cloudToken = 'reg-token';
  const cloudDb = path.join(os.tmpdir(), `eea-cloud-db-${process.pid}.json`);
  const cloudPort = 19800 + (process.pid % 100);
  const CLOUD_URL = `http://127.0.0.1:${cloudPort}`;
  const cloudScript = fileURLToPath(new URL('./cloud-license-server.mjs', import.meta.url));
  const cloudProc = spawnCloudProc(
    process.execPath,
    [cloudScript, '--port', String(cloudPort), '--token', cloudToken, '--db', cloudDb],
    { stdio: 'ignore', windowsHide: true },
  );
  const cloudApi = async (pathname, payload, admin) => {
    const res = await fetch(`${CLOUD_URL}${pathname}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(admin ? { 'x-cloud-license-token': cloudToken } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };
  const sandbox = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'eea-lic-cloud-'));
    process.env.EEA_LICENSE_DIR = d;
    return d;
  };
  const cleanupDirs = [];
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${CLOUD_URL}/v1/health`)).ok) { ready = true; break; }
      } catch { /* 未就绪 */ }
      await sleepMs(100);
    }
    assert.equal(ready, true, '云端 mock 服务器应就绪');

    const code1 = signWithDays(priv, daysFromDate('2026-12-31')).code;
    const code2 = signWithDays(priv, daysFromDate('2026-12-31')).code;

    // 1) 设备 A 云端激活：自动登记+绑定，重启（loadLicense）再确认 OK
    const dirA = sandbox(); cleanupDirs.push(dirA);
    setCloudUrl(CLOUD_URL);
    let act = await activateWithCode(code1);
    assert.equal(act.ok, true, '云端模式真码应激活成功');
    assert.equal(licenseStatus().cloud, 'ok');
    assert.equal(await loadLicense(), true, '重启模拟：云端确认通过');
    assert.equal(licenseStatus().cloud, 'ok');

    // 2) 设备 B（另一授权目录=另一台机器）同码激活 → 第二台 OK
    const dirB = sandbox(); cleanupDirs.push(dirB);
    act = await activateWithCode(code1);
    assert.equal(act.ok, true, '第二台设备应可绑定');
    process.env.EEA_LICENSE_DIR = dirA;
    assert.equal(await loadLicense(), true, '已绑定设备不受新设备影响');

    // 3) 设备 C → device_limit
    const dirC = sandbox(); cleanupDirs.push(dirC);
    act = await activateWithCode(code1);
    assert.equal(act.ok, false, '第三台设备应被拒绝');
    assert.equal(act.reason, 'cloud:device_limit');
    assert.ok(act.message.includes('上限'), '拒绝信息应含原因');

    // 4) 吊销 → 已绑定设备 A 即时失效
    let r = await cloudApi('/v1/admin/revoke', { code: code1 }, true);
    assert.equal(r.body.ok, true);
    process.env.EEA_LICENSE_DIR = dirA;
    assert.equal(await loadLicense(), false, '吊销后重启应失效');
    assert.equal(licenseStatus().cloudReason, 'revoked');

    // 5) 解吊销 + 释放设备 B → B 重新激活成功
    await cloudApi('/v1/admin/revoke', { code: code1, revoke: false }, true);
    const devB = JSON.parse(readFileSync(path.join(dirB, 'device.json'), 'utf8'));
    r = await cloudApi('/v1/admin/unbind', { code: code1, deviceId: devB.id }, true);
    assert.equal(r.body.removed, 1, '应释放一台设备');
    process.env.EEA_LICENSE_DIR = dirB;
    assert.equal((await activateWithCode(code1)).ok, true, '释放后重绑应成功');

    // 6) strict 白名单：未登记的新码被拒；关闭后自动登记成功
    await cloudApi('/v1/admin/strict', { on: true }, true);
    const dirD = sandbox(); cleanupDirs.push(dirD);
    process.env.EEA_LICENSE_DIR = dirD;
    act = await activateWithCode(code2);
    assert.equal(act.ok, false, '严格模式未登记码应拒绝');
    assert.equal(act.reason, 'cloud:not_registered');
    await cloudApi('/v1/admin/strict', { on: false }, true);
    act = await activateWithCode(code2);
    assert.equal(act.ok, true, '关闭严格模式后自动登记');

    // 7) 断网降级：杀掉服务器后宽限期内照常启动；清缓存后锁定
    const dirE = sandbox(); cleanupDirs.push(dirE);
    process.env.EEA_LICENSE_DIR = dirE;
    assert.equal((await activateWithCode(code2)).ok, true);
    cloudProc.kill();
    await new Promise((ok) => cloudProc.once('exit', ok));
    assert.equal(await loadLicense(), true, '服务器不可达+缓存宽限 → 降级放行');
    assert.equal(licenseStatus().cloud, 'unreachable');
    rmSync(path.join(dirE, 'cloud-cache.json'), { force: true });
    assert.equal(await loadLicense(), false, '无缓存且服务器不可达 → 锁定');
    assert.equal(licenseStatus().cloudReason, 'need_online');

    console.log('cloud verification passed: auto-register=ok, devices=2, revoke=instant, unbind=reissue, strict=on/off, offline-grace=ok');
  } finally {
    setCloudUrl('');
    cloudProc.kill();
    rmSync(cloudDb, { force: true });
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  }
}

console.log(`license verification passed: roundtrip=50, tamper=rejected, garbage=rejected, whitespace=tolerant, expiry=checked, persist=file+reload, guard=403, cloud=checked`);
