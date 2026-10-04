#!/usr/bin/env node
/**
 * 作者密钥生成器 —— 只在作者自己电脑上运行，生成激活码签名密钥对。
 *   用法：node scripts/author-keygen.mjs [--out <目录>]
 *   默认输出目录：C:/Users/<你>/english-essay-license
 *
 * 产出：
 *   private.pem —— 私钥。绝不要发给任何人、绝不要放进发行包。
 *   public.pem  —— 公钥。构建发行版时 build-protected.mjs 会自动从私钥提取，
 *                  无需手动复制。
 *
 * [重要] 私钥丢失 = 已发出的激活码全部作废，需要重新生成密钥并重新构建发行版。
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const arg = (name, dft) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dft;
};

const outDir = path.resolve(arg('--out', path.join(homedir(), 'english-essay-license')));
await mkdir(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'pem' });

await writeFile(path.join(outDir, 'private.pem'), priv);
await writeFile(path.join(outDir, 'public.pem'), pub);

console.log('密钥对已生成：');
console.log('  私钥：' + path.join(outDir, 'private.pem'));
console.log('  公钥：' + path.join(outDir, 'public.pem'));
console.log('');
console.log('  [重要] 私钥只保存在你自己的电脑上。不要发给任何人，不要放入发行包。');
console.log('  私钥丢失 = 已发出的激活码全部作废，需重新构建发行版。');
