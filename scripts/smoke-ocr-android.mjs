// 冒烟：模拟 Android 平台 recognizeImage → 千问视觉转录（真实题图 + 真实 API）
import fs from 'node:fs';
process.env.EEA_PLATFORM = 'android';
const { recognizeImage } = await import('../lib/ocr.mjs');
const img = fs.readFileSync('../pages/p01.png');
const dataUrl = `data:image/png;base64,${img.toString('base64')}`;
const t0 = Date.now();
const out = await recognizeImage(dataUrl);
console.log('OK backend:', out.backend, '| fallback:', out.fallback, '| 耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('lines:', out.lines.length);
console.log('text head:', out.text.slice(0, 400).replace(/\n+/g, ' ⏎ '));
