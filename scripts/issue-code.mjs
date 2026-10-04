/**
 * 激活码【签发】核心 —— 仅在作者机器/回归测试中使用，绝不进入发行包。
 * 需要作者私钥；与 lib/license.mjs（用户端验证）共用码格式常量。
 *
 * 用法：
 *   import { signWithDays } from './issue-code.mjs';
 */
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CODE_PREFIX, EPOCH_UTC, DAY_MS, DATA_LEN, normalizeCode, displayCode } from '../lib/license.mjs';

/** 把 YYYY-MM-DD（视为 UTC）换算为距 2024-01-01 的天数。 */
export function daysFromDate(dateText) {
  if (!dateText) return 0;
  const m = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`到期日格式应为 YYYY-MM-DD，收到：${dateText}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((t - EPOCH_UTC) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0 || days > 0xffff) throw new Error('到期日超出支持范围（2024-01-01 之后 179 年内）');
  return days;
}

/** 从私钥 PEM 文本签发一个激活码。days=0 表示永久。 */
export function signWithDays(privateKeyPem, days) {
  const data = Buffer.alloc(DATA_LEN);
  data[0] = 0x4b; // 'K'
  data[1] = 0x01; // 格式版本
  data.writeUInt16BE(days, 2);
  data.writeUInt32BE(randomBytes(4).readUInt32BE(0), 4);
  const sig = sign(null, data, createPrivateKey(privateKeyPem));
  const canonical = CODE_PREFIX + data.toString('base64url') + sig.toString('base64url');
  return {
    code: canonical,
    display: displayCode(canonical),
    permanent: days === 0,
    expiresAt: days === 0 ? null : new Date(EPOCH_UTC + days * DAY_MS).toISOString(),
  };
}

export async function readPemFile(filePath) {
  return String(await readFile(filePath, 'utf8')).trim();
}

export { normalizeCode, displayCode };
