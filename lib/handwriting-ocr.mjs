/**
 * 手写作文转写。
 *
 * 为什么需要它：Windows 内置 OCR 是为印刷体设计的，对连笔手写几乎无能为力
 * （实测一张仿真手写稿只有 35% 字符可辨认，输出为「D 巴 ' 乙 夕」这类乱码），
 * 而且完全读不了旋转文本。视觉模型对这两点都能正确处理，包括自行纠正方向。
 *
 * 铁律：只转写、不改写。学生的语法与拼写错误必须原样保留——那正是后续批改要处理的对象。
 * 看不清的词标记为 [?]，绝不猜测；宁可让用户手动补，也不能编造他没写过的句子。
 */

import { loadConfig } from './config.mjs';

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const TRANSCRIBE_SYSTEM = `你是手写英文作文转写助手，处理的是学生手写的考研英语作文答题卡照片。
你的唯一职责：把图片中的手写英文原样转写成文本。

铁律：
1. 只转写你确实看到的内容。严禁修改语法、拼写、时态、单复数或用词。
2. 学生写错的地方必须原样保留（例如 he have、a apple、recieve），那是后续批改的对象。
3. 严禁补写、扩写、润色或翻译。不要输出任何解释或评价。
4. 某个词看不清时用 [?] 标记，不要猜测。整行看不清就整行标 [?]。
5. 用空行分隔段落。保留称呼行与落款行各自独立成段。
6. 图片可能是旋转的（横躺），请自行判断正确阅读方向后再转写。
7. 忽略答题卡的印刷内容：题号、"Section III Writing"、"请在答题区域内作答"等提示语与横线，只转写学生手写的作文。

严格返回 JSON：
{
  "text": "转写后的作文全文，段落间用 \\n\\n 分隔",
  "rotationDetected": "图片需要旋转的角度，0/90/180/270 之一",
  "unreadableCount": 无法辨认的词数（整数）,
  "confidence": 0.0-1.0 的转写置信度
}`;

const text = (value) => value == null ? '' : String(value).trim();

/** 从可能带围栏的模型输出里取出 JSON。 */
function parseJson(raw) {
  const source = text(raw);
  if (!source) return null;
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : source;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeImage(image) {
  const source = text(image);
  if (!source) throw Object.assign(new Error('缺少作文照片。'), { status: 400 });
  if (/^https?:\/\//i.test(source) || source.startsWith('data:')) return source;
  return `data:image/jpeg;base64,${source.replace(/\s/g, '')}`;
}

/**
 * 用视觉模型转写手写作文。
 * @returns {Promise<{text,rotationDetected,unreadableCount,confidence,model,backend}>}
 */
export async function transcribeHandwriting(image, { apiKey, model, timeoutMs = 180000, fetchImpl } = {}) {
  const cfg = await loadConfig();
  const key = text(apiKey) || text(cfg.vision?.apiKey);
  const visionModel = text(model) || text(cfg.vision?.model) || 'qwen3.7-plus';
  if (!key) {
    throw Object.assign(new Error('未配置视觉模型 API Key，无法转写手写作文。'), {
      status: 400,
      code: 'vision_key_missing',
    });
  }

  const request = {
    model: visionModel,
    messages: [
      { role: 'system', content: TRANSCRIBE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: normalizeImage(image) } },
          { type: 'text', text: '请把这张图里的手写英文作文原样转写出来，注意图片可能是旋转的。严格按要求返回 JSON。' },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2400,
  };

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await doFetch(DASHSCOPE_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error) {
    throw Object.assign(new Error(`视觉转写请求失败：${error.message}`), { status: 502, code: 'vision_request_failed' });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`视觉转写失败（HTTP ${response.status}）${detail.slice(0, 200)}`), {
      status: 502,
      code: 'vision_http_error',
    });
  }

  const payload = await response.json();
  const content = text(payload?.choices?.[0]?.message?.content);
  const parsed = parseJson(content);
  // 模型没按 JSON 返回时，把纯文本当作转写结果，不因格式问题丢弃可用内容。
  const transcript = text(parsed?.text) || (parsed ? '' : content);
  if (!transcript) {
    throw Object.assign(new Error('视觉模型未返回可用的转写结果。'), { status: 502, code: 'vision_empty' });
  }

  const rotation = Number(parsed?.rotationDetected);
  const unreadable = Number(parsed?.unreadableCount);
  const confidence = Number(parsed?.confidence);
  return {
    text: transcript,
    rotationDetected: [0, 90, 180, 270].includes(rotation) ? rotation : 0,
    unreadableCount: Number.isFinite(unreadable) && unreadable >= 0 ? Math.floor(unreadable) : (transcript.match(/\[\?\]/g) ?? []).length,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    model: text(payload?.model) || visionModel,
    backend: 'vision',
  };
}

/** 转写质量评估，供接口层决定是否提示用户重拍。 */
export function assessTranscript(value) {
  const source = text(value);
  const letters = (source.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (source.match(/[\u3400-\u9FFF]/g) ?? []).length;
  const words = (source.match(/\b[A-Za-z]{2,}\b/g) ?? []).length;
  const unreadable = (source.match(/\[\?\]/g) ?? []).length;
  const total = letters + cjk;
  const latinRatio = total ? letters / total : 0;
  // 单词过少、拉丁占比过低或未辨认过多，都视为质量不佳。
  const lowQuality = words < 25 || latinRatio < 0.85 || (words > 0 && unreadable / words > 0.15);
  return {
    words,
    letters,
    cjk,
    unreadable,
    latinRatio: Number(latinRatio.toFixed(3)),
    lowQuality,
  };
}

export default { transcribeHandwriting, assessTranscript };
