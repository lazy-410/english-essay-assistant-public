import { loadConfig } from './config.mjs';

/**
 * 视觉理解模块：基于千问视觉模型（DashScope 兼容模式）
 * 专为考研英语作文题图识读设计，采用「防幻觉 System Prompt」，
 * 强制做客观描述与主观推断分离，在不确定时标出而不是编造。
 */

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export { DASHSCOPE_BASE };

const VISION_SYSTEM_PROMPT = `你是考研英语作文题图识读助手。你的唯一职责是客观描述这张图上真实可见的内容，并提出可靠的题型与主题判断。

铁律（防幻觉）：
1. 只描述你在这张图上真正看到的线条、形状、人物、物件、文字、数据。
2. 严禁根据中文标注去联想你记忆中的历年真题，严禁套用记忆中的画面细节。这张图可能与任何已知真题都不同。
3. 如果图是简笔画、线条抽象、看不清细节，就如实说"线条简单，无法确定"，不要补充具体物品。
4. 特别注意：不要凭空添加图上不存在的物件（例如手机、电脑、书本等）。只有你确实看到对应形状才能提及。
5. 图表题（饼图/柱状图/折线图/表格）：必须严格读取图上的坐标轴、图例、百分比和具体数值。若刻度模糊，在 uncertain 里注明估计区间，不要假装精确。
6. 结构化输出：先做第一步客观视觉描述，再在此基础上做第二步主题/趋势推断，两者必须明确区分。

严格返回 JSON：
{
  "category": "大作文 / 图表作文 / 小作文",
  "subType": "图画类 / 材料类 / 静态图表 / 动态图表 / null",
  "objectsSeen": ["图上确实看到的形状/人物/物件/标题"],
  "chineseText": "图上的中文标注文字，没有则null",
  "chartData": {
    "title": "图表标题，没有则null",
    "chartType": "pie / bar / line / table / null",
    "xAxis": "横轴含义，没有则null",
    "yAxis": "纵轴含义与单位，没有则null",
    "dataPoints": [{"label":"项目名","value":"数值或百分比"}],
    "keyContrasts": ["最值得写进作文的对比点或趋势"]
  },
  "sceneDescription": "图画客观描述（英文短语/单句，要能直接嵌入 'The picture presents a thought-provoking scene in which ___' 句式），图表题可留空",
  "themeGuess": "主题或寓意推断（中文）",
  "themeBasis": "推断依据，必须引用图上真实存在的元素",
  "keyPhrases": ["核心题目相关词英文表达（2-4个）"],
  "uncertain": ["看不清或不确定的部分，无则空数组"],
  "confidence": 0.9
}`;

/**
 * 识别题图。入参 image 可为 base64 dataURL、纯 base64 或 HTTP URL。
 */
export async function analyzeImage(image, { apiKey, model } = {}) {
  const cfg = await loadConfig();
  const key = apiKey || cfg.vision?.apiKey || process.env.DASHSCOPE_API_KEY || cfg.deepseek?.apiKey;
  if (!key) {
    throw Object.assign(new Error('未配置千问 API Key。请在「设置」页填写千问/百炼 Key。'), { status: 400 });
  }

  const modelName = model || cfg.vision?.model || 'qwen3.7-plus';

  let imageUrl = image;
  if (typeof image === 'string' && !image.startsWith('http://') && !image.startsWith('https://')) {
    imageUrl = image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
  }

  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: '请按系统提示的铁律，识读这张考研英语作文题图，输出 JSON。' },
        ],
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  };

  const t0 = Date.now();
  const res = await fetch(DASHSCOPE_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(`千问视觉 API 请求失败（${res.status}）：${errText.slice(0, 300)}`), { status: res.status });
  }

  const json = await res.json();
  const rawText = json.choices?.[0]?.message?.content ?? '';

  let parsed = null;
  try {
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw Object.assign(new Error(`千问视觉返回的 JSON 无法解析：${err.message}`), { status: 502 });
  }

  return {
    raw: parsed,
    model: json.model || modelName,
    usage: json.usage || null,
    latencyMs: Date.now() - t0,
  };
}

/**
 * 印刷体文字转录（Android 无本地 OCR 时充当 OCR 通道）。
 * 与 analyzeImage 的区别：不做题型推断，只把图上文字原样转成纯文本，
 * 供「题目文本」回填与文字比对使用。
 * 入参 image 可为 base64 dataURL、纯 base64 或 HTTP URL。
 */
const TRANSCRIBE_SYSTEM = `你是图片文字转录引擎，把印刷题目/图表里的文字原样转成文本（用途相当于 OCR）。

铁律：
1. 只转录图中真实存在的文字，按版面顺序输出：自上而下，段落内从左到右，标题在正文前。
2. 严禁翻译（图中若带中文译文，照原样转录，不互相翻译）、严禁改写、严禁补写或解释。
3. 图表里的坐标轴名、图例、数值都要转录；表格按行转录，单元格内容用制表符或空格分隔。
4. 看不清的字符用 [?] 占位，绝不猜测补全。
5. 段落之间保留空行。直接输出纯文本：不要 JSON、不要代码围栏、不要任何开场白或总结。`;

export async function transcribeText(image, { apiKey, model } = {}) {
  const cfg = await loadConfig();
  const key = apiKey || cfg.vision?.apiKey || process.env.DASHSCOPE_API_KEY || cfg.deepseek?.apiKey;
  if (!key) {
    throw Object.assign(new Error('未配置千问 API Key。请在「设置」页填写千问/百炼 Key。'), { status: 400 });
  }

  const modelName = model || cfg.vision?.model || 'qwen3.7-plus';

  let imageUrl = image;
  if (typeof image === 'string' && !image.startsWith('http://') && !image.startsWith('https://')) {
    imageUrl = image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
  }

  const res = await fetch(DASHSCOPE_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: TRANSCRIBE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: '请转录这张图里的全部文字。' },
          ],
        },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(`千问视觉 API 请求失败（${res.status}）：${errText.slice(0, 300)}`), { status: res.status });
  }

  const json = await res.json();
  const text = String(json.choices?.[0]?.message?.content ?? '').trim();
  if (!text) {
    throw Object.assign(new Error('视觉转录未返回任何文字，可能是图片过于模糊或方向不对。'), { status: 502 });
  }

  return {
    text,
    lines: text.split(/\n+/).filter(Boolean),
    backend: 'qwen-vision',
    model: json.model || modelName,
    language: 'mixed',
  };
}
