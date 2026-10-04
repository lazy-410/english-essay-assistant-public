/**
 * 独立内容规划模块。
 *
 * 这个模块只规划“要说什么”，不生成可直接套用的模板句。它可以被 compose
 * 注入 chatJson 使用，也可以在没有模型、没有密钥时完全确定性地运行。
 */

import { inspectChartNumbers } from './chart-numbers.mjs';
import { deriveChartRows } from './chart-facts.mjs';

const PICTURE_CATEGORY = '大作文';
const CHART_CATEGORY = '图表作文';
const SMALL_CATEGORY = '小作文';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => text(value)))];
}

function classificationValue(classification = {}, key) {
  return classification?.final?.[key] ?? classification?.[key] ?? null;
}

function categoryOf(classification = {}) {
  const value = classificationValue(classification, 'category');
  if (value === '图画作文' || value === '图画类') return PICTURE_CATEGORY;
  if (value === '图表' || value === '图表类') return CHART_CATEGORY;
  if (value === '应用文' || value === '书信') return SMALL_CATEGORY;
  return value || PICTURE_CATEGORY;
}

function parseWordRange(target) {
  if (Array.isArray(target)) {
    const values = target.map(Number).filter(Number.isFinite);
    if (values.length >= 2) return [values[0], values[1]];
    if (values.length === 1) return [values[0], values[0]];
  }
  const value = text(target);
  const range = value.match(/(\d+(?:\.\d+)?)\s*[-–~至到]\s*(\d+(?:\.\d+)?)/);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = value.match(/\d+(?:\.\d+)?/);
  return single ? [Number(single[0]), Number(single[0])] : [180, 220];
}

/** 返回规划器采用的目标接受区间。单边下限保留原下限，上限取 10% 练习余量。 */
export function acceptedWordBand(target) {
  const value = text(target);
  const minimum = value.match(/(?:at\s+least|no\s+less\s+than|not\s+less\s+than|至少|不少于)\s*(\d+(?:\.\d+)?)/i);
  if (minimum) {
    const low = Number(minimum[1]);
    return [low, Math.round(low * 1.1)];
  }
  const [low, high] = parseWordRange(target);
  const center = (low + high) / 2;
  return [Math.round(center * 0.9), Math.round(center * 1.1)];
}

function normalizedClassification(classification = {}) {
  return {
    category: categoryOf(classification),
    subType: classificationValue(classification, 'subType'),
    letterType: classificationValue(classification, 'letterType'),
    polarity: classificationValue(classification, 'polarity'),
    topicClass: classificationValue(classification, 'topicClass'),
    keyPhrase: classificationValue(classification, 'keyPhrase'),
  };
}

function imageValue(imageAnalysis, key) {
  return imageAnalysis?.raw?.[key] ?? imageAnalysis?.[key] ?? null;
}

function normalizeImageFacts(imageAnalysis) {
  const scene = imageValue(imageAnalysis, 'sceneDescription');
  const rawCharacters = imageValue(imageAnalysis, 'characters') ?? imageValue(imageAnalysis, 'objectsSeen');
  const rawActions = imageValue(imageAnalysis, 'actions');
  const caption = imageValue(imageAnalysis, 'caption') ?? imageValue(imageAnalysis, 'chineseText');
  const uncertain = unique([
    ...asArray(imageValue(imageAnalysis, 'uncertain')),
    ...asArray(imageAnalysis?.chartData?.uncertain),
  ]);
  const characters = Array.isArray(rawCharacters) ? unique(rawCharacters) : (rawCharacters ? [text(rawCharacters)] : []);
  const actions = Array.isArray(rawActions) ? unique(rawActions) : (rawActions ? [text(rawActions)] : []);
  return {
    sceneDescription: text(scene),
    characters,
    actions,
    caption: text(caption),
    uncertain,
    hasFacts: Boolean(text(scene) || characters.length || actions.length || text(caption)),
    source: imageAnalysis ? text(imageValue(imageAnalysis, 'sourceType')) || 'imageAnalysis' : null,
  };
}

// 只把题干明确写出的“图中/图片中……”当作题干事实；不会从历年题记忆补画面。
function promptPictureFacts(questionText) {
  const sentences = text(questionText).split(/(?<=[。！？.!?])\s*/).map((item) => item.trim()).filter(Boolean);
  const explicit = sentences.filter((item) => /(图中|画中|图片中|图画中|picture|cartoon|drawing)/i.test(item)
    // Directions/任务要求只说明“要描述图片”，绝不是图片事实。
    && !/(请观察|如下图|见图|如图所示|picture\s+below|write\s+(?:an?\s+)?essay|based\s+on\s+(?:the\s+)?picture|根据图片|根据图画|describe\s+(?:the\s+)?(?:picture|cartoon|drawing)|interpret\s+the\s+implied|give\s+your\s+comments|in\s+your\s+essay|directions?)/i.test(item));
  return {
    sceneDescription: explicit.join(' '),
    characters: [],
    actions: [],
    caption: '',
    uncertain: [],
    hasFacts: explicit.length > 0,
    source: explicit.length ? 'prompt' : null,
  };
}

function normalizeChartData(imageAnalysis, questionText) {
  const supplied = imageValue(imageAnalysis, 'chartData');
  const chart = supplied && typeof supplied === 'object' ? supplied : {};
  const rawPoints = asArray(chart.dataPoints ?? imageValue(imageAnalysis, 'dataPoints'));
  const dataPoints = rawPoints.map((point, index) => {
    if (point && typeof point === 'object') {
      const value = point.value ?? point.y ?? point.number ?? null;
      return {
        label: text(point.label ?? point.name ?? point.x ?? `data-${index + 1}`),
        value: value == null ? null : String(value),
        source: text(point.source) || text(chart.chartAuthority) || 'imageAnalysis',
      };
    }
    return { label: `data-${index + 1}`, value: String(point), source: 'imageAnalysis' };
  }).filter((point) => point.value !== null && point.value !== '');
  const labelNumbers = unique([
    ...asArray(chart.labelNumbers),
    ...asArray(imageValue(imageAnalysis, 'labelNumbers')),
  ]);
  const chartType = text(chart.chartType ?? chart.type ?? imageValue(imageAnalysis, 'type'));
  const unit = text(chart.unit ?? imageValue(imageAnalysis, 'unit'));
  const trend = unique([
    ...asArray(chart.trend),
    ...asArray(chart.keyContrasts),
    text(imageValue(imageAnalysis, 'trend')),
  ]);
  const suppliedRows = asArray(chart.rows).map((row) => ({
    label: text(row?.label ?? row?.name),
    values: asArray(row?.values).map((item) => ({ label: text(item?.label ?? item?.name), value: text(item?.value), source: text(item?.source) || 'chart' })).filter((item) => item.label && item.value),
  })).filter((row) => row.label && row.values.length);
  const rows = suppliedRows.length ? suppliedRows : deriveChartRows({ dataPoints });
  const rawValues = unique(dataPoints.map((point) => point.value));
  const derivedFacts = unique(asArray(chart.derivedFacts));
  const chartAuthority = text(chart.chartAuthority ?? imageValue(imageAnalysis, 'chartAuthority') ?? imageValue(imageAnalysis, 'sourceType')) || 'imageAnalysis';
  const numericPolicy = {
    rawValues,
    labelNumbers,
    derivedFacts,
    allowVerifiedDifferences: true,
    forbidLabelValueConcatenation: true,
    forbidUnlistedNumbers: true,
  };
  const hasFacts = Boolean(chartType || unit || dataPoints.length || labelNumbers.length || trend.length || text(chart.title));
  return {
    chartData: {
      title: text(chart.title),
      type: chartType || null,
      unit: unit || null,
      xAxis: text(chart.xAxis),
      yAxis: text(chart.yAxis),
      dataPoints,
      labelNumbers,
      rows,
      rawValues,
      derivedFacts,
      numericPolicy,
      chartAuthority,
    },
    type: chartType || null,
    unit: unit || null,
    dataPoints,
    labelNumbers,
    rows,
    rawValues,
    derivedFacts,
    numericPolicy,
    trend,
    hasFacts,
    source: hasFacts ? chartAuthority : null,
    questionText: text(questionText),
  };
}

function extractTasks(directions, questionText) {
  const raw = text(directions) || text(questionText);
  const pieces = raw
    .split(/(?:\r?\n|(?<=[.!?])\s+|[；;]|(?:^|\s)[一二三四五六七八九十]\s*[、.)）:]|(?:^|\s)\d+\s*[、.)）:]|(?=\b(?:explain|state|describe|express|provide|mention|tell|invite|recommend|apologize|thank)\b))/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 2);
  const candidates = [];
  for (const piece of pieces) {
    const sentence = piece.replace(/^(please|请|you are asked to|要求|请你)\s*/i, '').trim();
    if (!sentence || /^directions?\s*:?$/i.test(sentence)) continue;
    // 署名、答题卡、卷面和字数属于格式校验，不是正文中的交际任务。
    if (/do\s+not\s+sign|use\s+[“\"']?li\s+ming|answer\s+sheet|write\s+neatly|\b(?:about|approximately)?\s*\d+\s*words?\b|\(?\s*\d+\s*points?\s*\)?|不要署|署名|答题卡|字数|\d+\s*分/i.test(sentence)) continue;
    if (/(write|compose|写|通知|信|邮件|letter|email|notice|announcement)/i.test(sentence)
      && !/(邀请|invit|apolog|道歉|参加|出席|通知|inform|tell|介绍|推荐|recommend|说明)/i.test(sentence)) continue;
    if (sentence) candidates.push(sentence.replace(/[。！？.!?]+$/, ''));
  }
  if (!candidates.length) {
    const verbs = /(邀请|出席|参加|告知|通知|说明|推荐|介绍|道歉|感谢|咨询|建议|申请|报名|inform|invite|recommend|apolog|thank|suggest|ask)/ig;
    for (const match of raw.matchAll(verbs)) candidates.push(match[0]);
  }
  return unique(candidates).slice(0, 8).map((item, index) => ({ id: `task-${index + 1}`, text: item }));
}

function normalizeSmallFacts(questionText, classification, imageAnalysis) {
  const directions = text(imageValue(imageAnalysis, 'directions')) || text(classificationValue(classification, 'directions')) || text(questionText);
  const relationshipMatch = directions.match(/(?:给|致|to|for)\s*([^，。,:：\n]+)/i);
  const addressee = text(imageValue(imageAnalysis, 'addressee')) || (relationshipMatch ? relationshipMatch[1] : '题目指定收件人');
  const register = /正式|official|formal|通知|公告|notice|announcement/i.test(directions) ? '正式' : '礼貌、得体';
  const isNotice = ['通知类', '公告类'].includes(classificationValue(classification, 'letterType'))
    || /通知|公告|notice|announcement/i.test(directions);
  const format = isNotice ? '通知/公告（标题、正文、署名；不使用称呼和书信落款）' : '书信/邮件（称呼、正文、结束语与署名）';
  return {
    directions,
    tasks: extractTasks(directions, questionText),
    addressee,
    relationship: text(imageValue(imageAnalysis, 'relationship')) || '按题干确定的收件关系',
    register,
    format,
    isNotice,
  };
}

/** 将题干、分类结果、视觉识读结果收敛为一个事实包。 */
export function buildPromptFacts(questionText, classification = {}, imageAnalysis = undefined) {
  const normalized = normalizedClassification(classification);
  const category = normalized.category;
  const picture = category === PICTURE_CATEGORY
    ? (normalizeImageFacts(imageAnalysis).hasFacts ? normalizeImageFacts(imageAnalysis) : promptPictureFacts(questionText))
    : { sceneDescription: '', characters: [], actions: [], caption: '', uncertain: [], hasFacts: false, source: null };
  const hybrid = /混合|图画.*图表|picture.*chart/i.test(text(normalized.subType))
    || (category === PICTURE_CATEGORY && Boolean(imageValue(imageAnalysis, 'chartData')));
  const chart = category === CHART_CATEGORY || hybrid ? normalizeChartData(imageAnalysis, questionText) : {
    chartData: { title: '', type: null, unit: null, xAxis: '', yAxis: '', dataPoints: [], labelNumbers: [], rows: [], rawValues: [], derivedFacts: [], numericPolicy: null },
    type: null, unit: null, dataPoints: [], labelNumbers: [], rows: [], rawValues: [], derivedFacts: [], numericPolicy: null, trend: [], hasFacts: false, source: null,
  };
  const small = category === SMALL_CATEGORY ? normalizeSmallFacts(questionText, classification, imageAnalysis) : {
    directions: '', tasks: [], addressee: '', relationship: '', register: '', format: '', isNotice: false,
  };
  const missingVisualFacts = category === PICTURE_CATEGORY && !picture.hasFacts;
  const warnings = [];
  if (missingVisualFacts) warnings.push('缺少可核验的画面事实；规划器不会猜测具体人物、物件或动作。');
  if (category === CHART_CATEGORY && !chart.hasFacts) warnings.push('缺少图表视觉数据；规划器不会编造数值、单位或趋势。');
  return {
    questionText: text(questionText),
    classification: normalized,
    category,
    targetWords: category === SMALL_CATEGORY ? '约100词' : category === CHART_CATEGORY ? '180-220词' : '160-200词',
    picture,
    // 顶层别名便于 compose 直接消费，也保证“图画包含……”字段稳定存在。
    sceneDescription: picture.sceneDescription,
    characters: picture.characters,
    actions: picture.actions,
    caption: picture.caption,
    uncertain: picture.uncertain,
    chart,
    chartData: chart.chartData,
    type: chart.type,
    unit: chart.unit,
    dataPoints: chart.dataPoints,
    trend: chart.trend,
    small,
    directions: small.directions,
    tasks: small.tasks,
    addressee: small.addressee,
    relationship: small.relationship,
    register: small.register,
    format: small.format,
    missingVisualFacts,
    warnings,
  };
}

function evidence(factId, value, sourceType) {
  return { factId, text: text(value), sourceType };
}

function words(value) {
  return text(value).split(/\s+/).filter(Boolean).length;
}

function unit({ contentId, paragraph, rhetoricalFunction, claim, evidence: facts = [], required = true,
  semanticKey, estimatedWords, sourceType, taskIds = [], stance = 'neutral' }) {
  return { contentId, paragraph, rhetoricalFunction, claim, evidence: facts, required, semanticKey,
    estimatedWords, sourceType, taskIds, stance };
}

function pictureFallback(facts) {
  const visual = facts.picture;
  const visualEvidence = [];
  if (visual.sceneDescription) visualEvidence.push(evidence('picture.sceneDescription', visual.sceneDescription, visual.source));
  if (visual.characters.length) visualEvidence.push(evidence('picture.characters', visual.characters.join('；'), visual.source));
  if (visual.actions.length) visualEvidence.push(evidence('picture.actions', visual.actions.join('；'), visual.source));
  if (visual.caption) visualEvidence.push(evidence('picture.caption', visual.caption, visual.source));
  const topic = text(facts.classification.keyPhrase) || '题干所指现象';
  const missing = facts.missingVisualFacts;
  return [
    [unit({ contentId: 'picture-p1-observation', paragraph: '第一段：客观描述与点题', rhetoricalFunction: 'observation',
      claim: missing ? '先客观说明需要依据题图识别可见事实，再围绕题干主题点题。' : `客观呈现题图可见事实，并点明其围绕“${topic}”的主题。`,
      evidence: visualEvidence, required: true, semanticKey: 'picture.observation', estimatedWords: 42,
      sourceType: missing ? 'missingVisualFacts' : visual.source, stance: 'neutral' })],
    [unit({ contentId: 'picture-p2-meaning', paragraph: '第二段：原因或意义分析', rhetoricalFunction: 'analysis',
      claim: `分析“${topic}”出现或产生影响的原因，避免把未在题图中出现的细节当作事实。`, evidence: [], required: true,
      semanticKey: 'picture.cause-analysis', estimatedWords: 58, sourceType: 'reasoning', stance: facts.classification.polarity === '负面' ? 'negative' : 'neutral' })],
    [unit({ contentId: 'picture-p3-action', paragraph: '第三段：影响与行动', rhetoricalFunction: 'implication-action',
      claim: `说明“${topic}”的现实影响，并提出与题干主题相符的可执行行动。`, evidence: [], required: true,
      semanticKey: 'picture.impact-action', estimatedWords: 52, sourceType: 'reasoning', stance: facts.classification.polarity === '负面' ? 'negative' : 'neutral' })],
  ];
}

function chartFallback(facts) {
  const chart = facts.chart;
  const dataEvidence = chart.dataPoints.map((point, index) => evidence(`chart.dataPoints.${index}`, `${point.label}: ${point.value}`, 'imageAnalysis'));
  const trendEvidence = chart.trend.length ? [evidence('chart.trend', chart.trend.join('；'), 'imageAnalysis')] : [];
  const hasData = chart.dataPoints.length > 0;
  return [
    [unit({ contentId: 'chart-p1-description', paragraph: '第一段：图表数据描述', rhetoricalFunction: 'data-description',
      claim: hasData ? `准确介绍${chart.type || '该图表'}的项目、单位（${chart.unit || '以图中标注为准'}）及主要数据差异。` : '仅描述图表类型、项目关系与可见结构，不补写任何数值。',
      evidence: [...dataEvidence, ...(chart.unit ? [evidence('chart.unit', chart.unit, 'imageAnalysis')] : [])], required: true,
      semanticKey: 'chart.observation', estimatedWords: 58, sourceType: hasData ? 'imageAnalysis' : 'missingChartFacts' })],
    [unit({ contentId: 'chart-p2-analysis', paragraph: '第二段：原因与影响分析', rhetoricalFunction: 'cause-impact-analysis',
      claim: '解释数据所反映现象的可能原因，并联系其社会、校园或个人层面的影响；原因属于分析而非图表事实。',
      evidence: trendEvidence, required: true, semanticKey: 'chart.cause-impact', estimatedWords: 64, sourceType: chart.trend.length ? 'imageAnalysis' : 'reasoning' })],
    [unit({ contentId: 'chart-p3-response', paragraph: '第三段：建议与展望', rhetoricalFunction: 'recommendation-outlook',
      claim: '针对数据揭示的问题提出可执行建议，并说明落实建议后的合理展望。', evidence: [], required: true,
      semanticKey: 'chart.recommendation-outlook', estimatedWords: 56, sourceType: 'reasoning' })],
  ];
}

function smallFallback(facts) {
  const tasks = facts.small.tasks.length ? facts.small.tasks : [{ id: 'task-1', text: '完成题干要求的写作目的' }];
  const purpose = tasks[0];
  const middle = tasks.slice(1);
  const taskUnit = (task, index) => unit({ contentId: `small-p2-task-${index + 1}`, paragraph: '第二段：逐项完成具体任务',
    rhetoricalFunction: 'task-fulfillment', claim: `具体完成任务：${task.text}。`,
    evidence: [evidence(`small.tasks.${task.id}`, task.text, 'prompt')], required: true,
    semanticKey: `small.task.${task.id}`, estimatedWords: Math.max(18, Math.min(32, words(task.text) + 15)), sourceType: 'prompt', taskIds: [task.id] });
  return [
    [unit({ contentId: 'small-p1-purpose', paragraph: '第一段：写作目的', rhetoricalFunction: 'purpose',
      claim: `以符合${facts.small.register}语域的方式，向${facts.small.addressee || '题目指定收件人'}说明写作目的：${purpose.text}。`,
      evidence: [evidence(`small.tasks.${purpose.id}`, purpose.text, 'prompt')], required: true,
      semanticKey: 'small.purpose', estimatedWords: 27, sourceType: 'prompt', taskIds: [purpose.id] })],
    [middle.length ? middle.map(taskUnit) : [taskUnit(purpose, 0)]],
    [unit({ contentId: 'small-p3-closing', paragraph: '第三段：格式收束与期待', rhetoricalFunction: 'closing',
      claim: `按${facts.small.format}完成礼貌收束、期待或后续安排；不添加题干没有要求的事项。`, evidence: [], required: true,
      semanticKey: 'small.closing', estimatedWords: 25, sourceType: 'prompt' })],
  ];
}

function flattenParagraphs(paragraphs) {
  return paragraphs.map((items, index) => {
    const units = items.flatMap((item) => Array.isArray(item) ? item : [item]);
    return {
      paragraphId: `p${index + 1}`,
      name: units[0]?.paragraph || `第${index + 1}段`,
      units,
    };
  });
}

function fallbackPlan(promptFacts, classification) {
  const facts = promptFacts?.category ? promptFacts : buildPromptFacts(promptFacts?.questionText || '', classification);
  const groups = facts.category === SMALL_CATEGORY ? smallFallback(facts) : facts.category === CHART_CATEGORY ? chartFallback(facts) : pictureFallback(facts);
  const paragraphs = flattenParagraphs(groups);
  const units = paragraphs.flatMap((paragraph) => paragraph.units);
  return {
    planVersion: 1,
    source: 'fallback',
    category: facts.category,
    targetWords: facts.targetWords,
    wordBand: acceptedWordBand(facts.targetWords),
    paragraphs,
    units,
    contentUnits: units,
    warnings: [...facts.warnings],
    missingVisualFacts: facts.missingVisualFacts,
    factsDigest: { category: facts.category, taskCount: facts.small?.tasks?.length ?? 0, dataCount: facts.chart?.dataPoints?.length ?? 0 },
  };
}

const MODEL_SYSTEM = `你是英语作文内容规划器。只规划论点、事实、任务和段落功能，不写任何模板句或完整成文句。\n每个 unit 必须严格包含 contentId, paragraph, rhetoricalFunction, claim, evidence[], required, semanticKey, estimatedWords, sourceType；semanticKey 全局不得重复。\n图画只能引用 promptFacts.picture 中的事实；没有事实时不得猜人物、物件、动作。图表的数值只能逐字来自 promptFacts.chart.dataPoints/rows/numericPolicy.rawValues，不能创造或四舍五入；年龄和年份等 labelNumbers 只是类别标签，禁止与百分比或其他数据拼成新小数。小作文必须用 taskIds 覆盖 promptFacts.small.tasks 的每一项。返回 JSON：{"paragraphs":[{"name":"...","units":[...]}],"warnings":[],"missingVisualFacts":false}`;

function unwrapModelResponse(response) {
  if (response?.data && typeof response.data === 'object') return response.data;
  return response;
}

function normalizeModelPlan(raw, facts) {
  const sourceParagraphs = asArray(raw?.paragraphs);
  if (sourceParagraphs.length !== 3) return null;
  const paragraphs = sourceParagraphs.map((paragraph, index) => ({
    paragraphId: paragraph.paragraphId || `p${index + 1}`,
    name: text(paragraph.name) || `第${index + 1}段`,
    units: asArray(paragraph.units).map((item, unitIndex) => ({
      contentId: text(item.contentId) || `model-p${index + 1}-u${unitIndex + 1}`,
      paragraph: text(item.paragraph) || text(paragraph.name) || `第${index + 1}段`,
      rhetoricalFunction: text(item.rhetoricalFunction) || 'content-development',
      claim: text(item.claim),
      evidence: asArray(item.evidence).map((itemEvidence) => typeof itemEvidence === 'object'
        ? { factId: text(itemEvidence.factId), text: text(itemEvidence.text), sourceType: text(itemEvidence.sourceType) }
        : { factId: '', text: text(itemEvidence), sourceType: text(item.sourceType) }),
      required: item.required !== false,
      semanticKey: text(item.semanticKey),
      estimatedWords: Number(item.estimatedWords) || 0,
      sourceType: text(item.sourceType) || 'reasoning',
      taskIds: unique(asArray(item.taskIds)),
      stance: text(item.stance) || 'neutral',
    })),
  }));
  const units = paragraphs.flatMap((paragraph) => paragraph.units);
  return { planVersion: 1, source: 'model', category: facts.category, targetWords: facts.targetWords,
    wordBand: acceptedWordBand(facts.targetWords), paragraphs, units, contentUnits: units,
    warnings: asArray(raw.warnings).map(text), missingVisualFacts: Boolean(raw.missingVisualFacts), factsDigest: {} };
}

/** 优先调用注入的 chatJson；模型失败或返回不合规内容时使用确定性 fallback。 */
export async function buildContentPlan(promptFacts, classification = {}, { chatJson } = {}) {
  const facts = promptFacts?.category ? promptFacts : buildPromptFacts(promptFacts?.questionText || '', classification);
  if (typeof chatJson === 'function') {
    try {
      const response = await chatJson({
        tier: 'reasoning',
        system: MODEL_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(facts) }],
        temperature: 0,
        maxTokens: 5000,
        responseFormat: { type: 'json_object' },
      });
      const candidate = normalizeModelPlan(unwrapModelResponse(response), facts);
      if (candidate && validateContentPlan(candidate, facts, classification).valid) return candidate;
    } catch {
      // 规划是 compose 的独立层；模型异常不得阻断确定性内容规划。
    }
  }
  return fallbackPlan(facts, classification);
}

function factMap(promptFacts) {
  const map = new Map();
  const picture = promptFacts?.picture || promptFacts || {};
  if (picture.sceneDescription) map.set('picture.sceneDescription', picture.sceneDescription);
  if (asArray(picture.characters).length) map.set('picture.characters', asArray(picture.characters).join('；'));
  if (asArray(picture.actions).length) map.set('picture.actions', asArray(picture.actions).join('；'));
  if (picture.caption) map.set('picture.caption', picture.caption);
  const chart = promptFacts?.chart || {};
  asArray(chart.dataPoints).forEach((point, index) => map.set(`chart.dataPoints.${index}`, `${point.label}: ${point.value}`));
  if (chart.unit) map.set('chart.unit', chart.unit);
  if (asArray(chart.trend).length) map.set('chart.trend', chart.trend.join('；'));
  asArray(promptFacts?.small?.tasks ?? promptFacts?.tasks).forEach((task) => map.set(`small.tasks.${task.id}`, task.text));
  return map;
}

function planUnits(plan) {
  if (Array.isArray(plan?.units)) return plan.units;
  return asArray(plan?.paragraphs).flatMap((paragraph) => asArray(paragraph.units));
}

function hasConcreteVisualClaim(value) {
  return /(手机|电脑|书本|龙舟|船|孩子|老人|男|女|屏幕|phone|computer|book|dragon boat|child|man|woman|screen)/i.test(text(value));
}

/** 对规划结构、事实来源、任务覆盖和互相矛盾的立场进行校验。 */
export function validateContentPlan(plan, promptFacts, classification = {}) {
  const facts = promptFacts?.category ? promptFacts : buildPromptFacts(promptFacts?.questionText || '', classification);
  const errors = [];
  const warnings = [...asArray(facts.warnings)];
  const paragraphs = asArray(plan?.paragraphs);
  const units = planUnits(plan);
  if (paragraphs.length !== 3) errors.push('必须恰好包含三个段落。');
  if (!units.length) errors.push('规划不能为空。');
  const ids = new Set();
  const keys = new Set();
  const factIds = factMap(facts);
  const hybrid = facts.category === PICTURE_CATEGORY && Boolean(facts.chart?.hasFacts);
  const positive = new Set();
  const negative = new Set();
  for (const item of units) {
    for (const field of ['contentId', 'paragraph', 'rhetoricalFunction', 'claim', 'semanticKey', 'sourceType']) {
      if (!text(item?.[field])) errors.push(`unit 缺少 ${field}。`);
    }
    if (!Number.isFinite(Number(item?.estimatedWords)) || Number(item.estimatedWords) <= 0) errors.push(`${item?.contentId || 'unit'} 的 estimatedWords 无效。`);
    if (ids.has(item.contentId)) errors.push(`contentId 重复：${item.contentId}`); else ids.add(item.contentId);
    if (keys.has(item.semanticKey)) errors.push(`semanticKey 重复：${item.semanticKey}`); else keys.add(item.semanticKey);
    if (item.stance === 'positive') positive.add(item.contentId);
    if (item.stance === 'negative') negative.add(item.contentId);
    for (const itemEvidence of asArray(item.evidence)) {
      const factId = typeof itemEvidence === 'object' ? text(itemEvidence.factId) : '';
      const evidenceText = typeof itemEvidence === 'object' ? text(itemEvidence.text) : text(itemEvidence);
      if (factId && !factIds.has(factId)) errors.push(`${item.contentId} 引用了不存在的事实 ${factId}。`);
      if (facts.category === PICTURE_CATEGORY && !facts.missingVisualFacts && factId
        && !factId.startsWith('picture.') && !(hybrid && factId.startsWith('chart.'))) {
        errors.push(`${item.contentId} 的图画/混合题证据来源错误。`);
      }
      if (facts.category === PICTURE_CATEGORY && facts.missingVisualFacts && (factId || hasConcreteVisualClaim(evidenceText) || hasConcreteVisualClaim(item.claim))) {
        errors.push(`${item.contentId} 在缺少画面事实时编造了视觉细节。`);
      }
      if (facts.category === CHART_CATEGORY && (factId && !factId.startsWith('chart.'))) errors.push(`${item.contentId} 的图表证据来源错误。`);
    }
    if (facts.category === CHART_CATEGORY || hybrid) {
      const evidenceText = asArray(item.evidence).map((itemEvidence) => (
        typeof itemEvidence === 'object' ? text(itemEvidence.text) : text(itemEvidence)
      )).join(' ');
      const numberCheck = inspectChartNumbers(`${item.claim} ${evidenceText}`, facts.chart);
      for (const number of numberCheck.unsupported) errors.push(`${item.contentId} 使用了未经图表事实支持的数值 ${number}。`);
    }
  }
  if (positive.size && negative.size && facts.classification.polarity && [...positive, ...negative].length === units.length) {
    errors.push('规划同时包含互相冲突的正面与负面立场。');
  }
  if (facts.category === SMALL_CATEGORY) {
    const tasks = asArray(facts.small.tasks);
    const covered = new Set(units.flatMap((item) => asArray(item.taskIds)));
    for (const task of tasks) if (!covered.has(task.id)) errors.push(`小作文任务未覆盖：${task.id}（${task.text}）。`);
  }
  if (facts.category === PICTURE_CATEGORY && facts.missingVisualFacts) warnings.push('图画缺少视觉事实：仅允许保留抽象分析，不得猜测画面。');
  if (facts.category === CHART_CATEGORY && !facts.chart.hasFacts) warnings.push('图表缺少视觉数据：不能把题干或常识当作数值来源。');
  return { valid: errors.length === 0, ok: errors.length === 0, errors, warnings, unitCount: units.length,
    contentIds: [...ids], semanticKeys: [...keys] };
}

function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

/** 字数不足时按不同论证维度补充内容，semanticKey 永不重复。 */
export function expandContentPlan(plan, promptFacts, classification = {}, options = {}) {
  const facts = promptFacts?.category ? promptFacts : buildPromptFacts(promptFacts?.questionText || '', classification);
  const expanded = clonePlan(plan);
  expanded.paragraphs = asArray(expanded.paragraphs).map((paragraph) => ({ ...paragraph, units: asArray(paragraph.units) }));
  expanded.units = expanded.paragraphs.flatMap((paragraph) => paragraph.units);
  const minimum = acceptedWordBand(facts.targetWords)[0];
  const current = expanded.units.reduce((sum, item) => sum + (Number(item.estimatedWords) || 0), 0);
  const force = Boolean(options.force);
  const desired = force
    ? current + Math.max(24, Number(options.minimumAdditionalWords) || 30)
    : minimum;
  if (!force && current >= minimum) return expanded;
  const existing = new Set(expanded.units.map((item) => item.semanticKey));
  const candidates = facts.category === SMALL_CATEGORY
    ? [
        ['small.specific-detail', '补充任务所需的具体时间、地点、对象或材料等题干要求信息。', '具体任务', 22, 1],
        ['small.relation-appropriate-tone', `结合收件关系补充一处得体、明确的礼貌表达（${facts.small.register}）。`, '语域落实', 20, 2],
      ]
    : facts.category === CHART_CATEGORY
      ? [
          ['chart.cross-category-comparison', '补充不同项目或时间点之间的对比关系，但只引用已有图表项目和数值。', '对比论证', 30, 1],
          ['chart.mechanism-example', '补充一个解释数据差异的具体机制或例证，明确标作分析而非图表事实。', '原因例证', 32, 1],
          ['chart.social-implication', '补充数据变化对相关群体或社会实践的具体影响。', '影响分析', 30, 1],
        ]
      : [
          ['picture.concrete-example', '补充一个与题干主题相符的现实例证；它必须作为一般性例证，不冒充题图可见事实。', '例证', 30, 1],
          ['picture.mechanism-analysis', '补充现象背后的形成机制或责任链条，避免重复题图描述。', '原因机制', 32, 1],
          ['picture.long-term-impact', '补充该现象对个人、群体或社会的长期影响。', '长期影响', 30, 1],
          ['picture.feasible-action', '补充一项可执行、可检查的行动及其实施对象。', '具体行动', 28, 2],
        ];
  for (const [semanticKey, claim, rhetoricalFunction, estimatedWords, targetParagraphIndex] of candidates) {
    if (expanded.units.reduce((sum, item) => sum + (Number(item.estimatedWords) || 0), 0) >= desired) break;
    if (existing.has(semanticKey)) continue;
    const contentId = `expanded-${semanticKey.replace(/[^a-z0-9]+/gi, '-')}`;
    const targetIndex = Math.min(targetParagraphIndex, expanded.paragraphs.length - 1);
    const added = unit({ contentId, paragraph: expanded.paragraphs[targetIndex]?.name || '第二段：内容展开',
      rhetoricalFunction, claim, evidence: [], required: false, semanticKey, estimatedWords, sourceType: facts.category === SMALL_CATEGORY ? 'prompt' : 'reasoning',
      taskIds: [], stance: 'neutral' });
    const target = expanded.paragraphs[targetIndex] || expanded.paragraphs[expanded.paragraphs.length - 1];
    if (!target) break;
    target.units.push(added);
    expanded.units.push(added);
    expanded.contentUnits = expanded.units;
    existing.add(semanticKey);
    const total = expanded.units.reduce((sum, item) => sum + (Number(item.estimatedWords) || 0), 0);
    if (total >= desired) break;
  }
  expanded.expanded = true;
  return expanded;
}

export default {
  acceptedWordBand,
  buildPromptFacts,
  buildContentPlan,
  validateContentPlan,
  expandContentPlan,
};
