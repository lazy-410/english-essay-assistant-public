import { loadConfig } from './config.mjs';
import * as win from './ocr-windows.mjs';
import { transcribeText } from './vision.mjs';
import { hasLocalOcr } from './platform.mjs';

const DATA_URL_RE = /^data:(image\/[a-z0-9+.-]+);base64,/i;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/tiff': '.tif',
  'image/webp': '.webp',
};

/** 解码前端传来的 dataURL 或裸 base64 */
export function decodeImage(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('没有收到图片数据。'), { status: 400 });
  }
  const m = input.match(DATA_URL_RE);
  const mime = m ? m[1].toLowerCase() : 'image/png';
  const base64 = m ? input.slice(m[0].length) : input;
  const buffer = Buffer.from(base64.replace(/\s/g, ''), 'base64');

  if (buffer.length < 256) {
    throw Object.assign(new Error('图片数据不完整或过小。'), { status: 400 });
  }
  // 桌面离线识别不认 webp；视觉模型虽然支持，但为让两条通道行为一致，统一在此拦下。
  if (mime === 'image/webp') {
    throw Object.assign(new Error('暂不支持 WebP，请换 PNG 或 JPG 后重试。'), { status: 400 });
  }
  return { buffer, mime, ext: EXT_BY_MIME[mime] ?? '.png' };
}

/**
 * 统一图片识别入口：千问视觉为主通道（印刷题面原样转录 transcribeText）。
 * 桌面发行在未配置视觉 Key 时，允许用系统内置离线识别兜底印刷体（windows）。
 * 百度云 OCR 等第三方后端已移除；返回字段与旧后端保持兼容。
 *
 * @returns {Promise<{text, lines, backend, language?, model?, fallback, attempts, channelLabel}>}
 */
export async function recognizeImage(input) {
  const { buffer, mime, ext } = decodeImage(input);
  const cfg = await loadConfig();
  const visionReady = Boolean(cfg.vision?.apiKey || process.env.DASHSCOPE_API_KEY);
  const attempts = [];

  // 主通道：千问视觉转录（图片可能旋转也能自行纠正阅读方向）。
  if (visionReady) {
    try {
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      const out = await transcribeText(dataUrl);
      if (!out.text.trim()) throw new Error('未识别出任何文字，可能是图片过于模糊。');
      return { ...out, channelLabel: '视觉转录（千问）', attempts, fallback: false };
    } catch (err) {
      attempts.push({ backend: 'qwen-vision', error: err.message });
    }
  }

  // 桌面离线兜底：仅 Windows 内置 OCR 可用，且只在视觉不可用/失败时兜底。
  if (hasLocalOcr()) {
    try {
      const out = await win.recognize(buffer, ext);
      if (!out.text.trim()) throw new Error('未识别出任何文字，可能是图片太模糊或方向不对。');
      return { ...out, channelLabel: '本地离线识别', attempts, fallback: visionReady };
    } catch (err) {
      attempts.push({ backend: 'windows', error: err.message });
    }
  }

  if (!visionReady) {
    throw Object.assign(new Error(
      hasLocalOcr()
        ? '图片识别未配置，且离线识别失败。请在「设置 → 图片识别」填写千问/百炼 Key；印刷体题目也可以直接把文字粘贴到输入框。'
        : '未配置图片识别（千问视觉）。请在「设置 → 图片识别」填写千问/百炼 Key，或直接把题目/作文文字粘贴到输入框。',
    ), { status: 400, code: 'vision_required' });
  }
  const detail = attempts.map((a) => `${a.backend}: ${a.error}`).join('；');
  throw Object.assign(new Error(`图片识别失败。${detail}`), { status: 502 });
}
