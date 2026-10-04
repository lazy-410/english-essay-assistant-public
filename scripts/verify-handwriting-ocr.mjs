import assert from 'node:assert/strict';
import { transcribeHandwriting, assessTranscript } from '../lib/handwriting-ocr.mjs';

const SAMPLE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

/** 构造一个假的 fetch，返回指定的模型响应体。 */
const fakeFetch = (content, { ok = true, status = 200, model = 'qwen3.7-plus' } = {}) => async () => ({
  ok,
  status,
  json: async () => ({ model, choices: [{ message: { content } }] }),
  text: async () => String(content),
});

const GOOD_TEXT = `Dear Customer Service Center,

As a customer who purchased an electronic dictionary from your online store, I am writing to make a complaint about its malfunction.

To be specific, the dictionary I bought the other day fails to turn on properly. I contacted your service center, but no solution has been offered yet.

Yours sincerely,
Li Ming`;

/* ------------------------------ 正常转写 ------------------------------ */

const ok = await transcribeHandwriting(SAMPLE, {
  apiKey: 'test-key',
  fetchImpl: fakeFetch(JSON.stringify({ text: GOOD_TEXT, rotationDetected: 90, unreadableCount: 0, confidence: 0.98 })),
});
assert.equal(ok.backend, 'vision');
assert.equal(ok.text, GOOD_TEXT);
assert.equal(ok.rotationDetected, 90, '应回传检测到的旋转角度');
assert.equal(ok.unreadableCount, 0);
assert.equal(ok.confidence, 0.98);
assert.equal(ok.model, 'qwen3.7-plus');

// 带 ```json 围栏的输出也要能解析
const fenced = await transcribeHandwriting(SAMPLE, {
  apiKey: 'test-key',
  fetchImpl: fakeFetch('```json\n{"text":"Dear Sir,\\n\\nI am writing.","rotationDetected":0,"unreadableCount":0,"confidence":0.9}\n```'),
});
assert.ok(fenced.text.includes('Dear Sir'), '应能解析带围栏的 JSON');

// 非法旋转角度应归一化为 0，而不是原样透出
const badRotation = await transcribeHandwriting(SAMPLE, {
  apiKey: 'test-key',
  fetchImpl: fakeFetch(JSON.stringify({ text: GOOD_TEXT, rotationDetected: 47 })),
});
assert.equal(badRotation.rotationDetected, 0, '非法角度应归一化');

// 模型没按 JSON 返回时，纯文本也不能丢弃
const plain = await transcribeHandwriting(SAMPLE, {
  apiKey: 'test-key',
  fetchImpl: fakeFetch('Dear Editor,\n\nI am writing to you.'),
});
assert.ok(plain.text.includes('Dear Editor'), '纯文本输出应被当作转写结果');

// 未辨认标记应被统计，即使模型没给 unreadableCount
const marked = await transcribeHandwriting(SAMPLE, {
  apiKey: 'test-key',
  fetchImpl: fakeFetch(JSON.stringify({ text: 'I bought a [?] from your [?] store.' })),
});
assert.equal(marked.unreadableCount, 2, '应从 [?] 标记推算未辨认数量');

/* ------------------------------ 失败与降级 ------------------------------ */

// 无 Key 必须给出明确错误码，供接口层决定回退。
// 注意：apiKey 传空会回落到 config.json 里的真实 Key，因此这里临时清空配置来隔离测试。
const { loadConfig } = await import('../lib/config.mjs');
const liveConfig = await loadConfig();
const savedKey = liveConfig.vision?.apiKey;
if (liveConfig.vision) liveConfig.vision.apiKey = '';
try {
  await assert.rejects(
    () => transcribeHandwriting(SAMPLE, { fetchImpl: fakeFetch('{}') }),
    (error) => error.code === 'vision_key_missing' && error.status === 400,
  );
} finally {
  if (liveConfig.vision) liveConfig.vision.apiKey = savedKey;
}

// HTTP 错误
await assert.rejects(
  () => transcribeHandwriting(SAMPLE, { apiKey: 'k', fetchImpl: fakeFetch('quota exceeded', { ok: false, status: 429 }) }),
  (error) => error.code === 'vision_http_error',
);

// 网络异常
await assert.rejects(
  () => transcribeHandwriting(SAMPLE, { apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } }),
  (error) => error.code === 'vision_request_failed',
);

// 空结果不得当成成功
await assert.rejects(
  () => transcribeHandwriting(SAMPLE, { apiKey: 'k', fetchImpl: fakeFetch(JSON.stringify({ text: '' })) }),
  (error) => error.code === 'vision_empty',
);

// 缺图片
await assert.rejects(() => transcribeHandwriting('', { apiKey: 'k' }), (error) => error.status === 400);

/* ------------------------------ 质量评估 ------------------------------ */

const goodQuality = assessTranscript(GOOD_TEXT);
assert.equal(goodQuality.lowQuality, false, '完整英文作文不应判为低质量');
assert.ok(goodQuality.words > 40);
assert.equal(goodQuality.latinRatio, 1);

// Windows OCR 读手写体产出的典型乱码：必须判为低质量
const garbled = assessTranscript("D 巴 ' 乙 “ 夕 1 一 SenÆce 乙 伽 夕 0 仉 ， 夕 0 üb 亻");
assert.equal(garbled.lowQuality, true, '乱码必须判为低质量');
assert.ok(garbled.latinRatio < 0.85);

// 词数过少
assert.equal(assessTranscript('Dear Sir, I am writing.').lowQuality, true, '过短文本应判为低质量');

// 未辨认占比过高
const manyUnreadable = assessTranscript(`${Array.from({ length: 30 }, () => 'word').join(' ')} ${Array.from({ length: 8 }, () => '[?]').join(' ')}`);
assert.equal(manyUnreadable.lowQuality, true, '未辨认过多应判为低质量');
assert.equal(manyUnreadable.unreadable, 8);

assert.equal(assessTranscript('').lowQuality, true);

/* ------------------ 转写提示词必须禁止改写 ------------------ */

// 这是本模块的核心约束：只转写不改写，否则批改的就不是学生的作文。
let capturedBody = null;
await transcribeHandwriting(SAMPLE, {
  apiKey: 'k',
  fetchImpl: async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: GOOD_TEXT }) } }] }), text: async () => '' };
  },
});
const systemPrompt = capturedBody.messages.find((message) => message.role === 'system').content;
for (const rule of ['原样转写', '严禁修改语法', '原样保留', '[?]', '旋转']) {
  assert.ok(systemPrompt.includes(rule), `提示词必须包含约束：${rule}`);
}
assert.equal(capturedBody.temperature, 0, '转写必须用 temperature 0，避免随机改写');
// 图片必须真的被送出去
assert.ok(capturedBody.messages.some((message) => Array.isArray(message.content)
  && message.content.some((part) => part.type === 'image_url')), '请求中必须包含图片');

console.log(`handwriting-ocr verification passed: transcribe=ok, fenced-json=ok, rotation=normalized, unreadable=counted, fallback-codes=4, quality-guard=garbled-detected, prompt=no-rewrite`);
