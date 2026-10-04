#!/usr/bin/env node
/**
 * 作者激活码生成器 —— 只在作者自己电脑上运行（需要私钥），不进入发行包。
 *
 *   node scripts/license-gen.mjs --key <私钥PEM> [选项]
 *
 * 选项：
 *   --key <路径>      作者私钥（author-keygen.mjs 生成的 private.pem）——必填
 *   --count <N>       生成数量，默认 1
 *   --expiry <YYYY-MM-DD>  到期日（不含则为永久有效）
 *   --out <路径>      同时把码表写入文件（每行一个码）
 *   --verify <码>     校验一个已发出的码（用同一私钥同源验签+到期检查），不生成
 *
 * 示例：
 *   node scripts/license-gen.mjs --key C:/Users/你/english-essay-license/private.pem
 *   node scripts/license-gen.mjs --key .../private.pem --count 20 --expiry 2026-12-31
 *   node scripts/license-gen.mjs --key .../private.pem --verify EEA1…
 *   node scripts/verify-license.mjs --code EEA1…   （同源验签的另一入口，仅看单个码）
 *
 * [提示] 发出的码请自己登记（发给谁、何时到期）。离线授权无法远程吊销已发码；
 * 到期日之后码自动失效，无需回收。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readPemFile, signWithDays, daysFromDate } from './issue-code.mjs';
import { verifyCodeWith, displayCode } from '../lib/license.mjs';

const arg = (name, dft) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dft;
};

const keyPath = arg('--key', '');
if (!keyPath) {
  console.error('用法：node scripts/license-gen.mjs --key <私钥PEM> [--count N] [--expiry YYYY-MM-DD] [--out 文件] [--verify 码]');
  process.exit(1);
}
const keyFile = path.resolve(keyPath);

// 私钥加载提前：--verify 用同一私钥派生的公钥做【同源验签】，
// 不受源码内嵌公钥（测试公钥/占位符）影响，正式码也能如实核验。
const priv = await readPemFile(keyFile);
let pubPem;
try {
  pubPem = createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
} catch {
  console.error('无法从私钥派生公钥：' + keyFile);
  process.exit(1);
}

const verifyTarget = arg('--verify', '');
if (verifyTarget) {
  const v = verifyCodeWith(verifyTarget, pubPem);
  if (!v.ok) {
    console.log('校验结果：无效激活码（' + v.reason + '）');
    process.exit(1);
  }
  console.log('校验结果：有效激活码');
  console.log('  码面格式：' + displayCode(verifyTarget));
  console.log('  永久有效：' + (v.permanent ? '是' : '否'));
  if (v.expiresAt) console.log('  到期时间：' + v.expiresAt);
  console.log('  当前时间：' + new Date().toISOString());
  process.exit(0);
}

const count = Math.max(1, Number(arg('--count', '1')) || 1);
const expiryText = arg('--expiry', '');
const days = expiryText ? daysFromDate(expiryText) : 0;
const outFile = arg('--out', '');

const rows = [];
for (let i = 0; i < count; i++) {
  const one = signWithDays(priv, days);
  rows.push(one);
}

console.log('');
console.log('生成激活码 ' + count + ' 个' + (expiryText ? '（到期 ' + expiryText + '）' : '（永久有效）'));
console.log('每行一个码，直接整行复制发给用户即可：');
console.log('─'.repeat(64));
for (const one of rows) {
  console.log(one.code);
  console.log('   （显示格式：' + one.display + '）');
}
console.log('─'.repeat(64));

if (outFile) {
  await writeFile(path.resolve(outFile), rows.map((r) => r.code).join('\n') + '\n', 'utf8');
  console.log('已写入：' + path.resolve(outFile));
}
