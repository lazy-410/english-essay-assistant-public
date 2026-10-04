import { chatJson } from './deepseek.mjs';
import { loadKnowledge } from './kb.mjs';

/**
 * 题型判定：规则层 + AI 层双轨。
 * 规则层负责给出可解释的关键词证据，AI 层负责理解题意；
 * 两层结论不一致时如实上报，让用户确认，而不是悄悄取其一。
 */

// ---------- 规则层 ----------

const BIG_PICTURE = ['图画', '图片', '漫画', '这幅画', '如图', 'picture', 'drawing', 'cartoon'];
const BIG_MATERIAL = ['材料', '短文', '以下文字', '这段话'];
const CHART_STATIC = ['饼图', '饼状图', 'pie chart', '占比', '比例', '构成'];
const CHART_DYNAMIC = ['折线图', '柱状图', 'line chart', 'line graph', 'bar chart', '变化', '趋势', '增长', '下降', '年至', '年到'];
const CHART_ANY = ['图表', '统计', 'chart', 'graph', 'table', '数据'];

const SMALL_ANY = [
  '写一封', '给...写信', 'write a letter', 'write an email', '回信', '邮件',
  '通知', '公告', 'notice', 'announcement', '倡议书', '推荐信', '感谢信', '道歉信', '邀请函',
  '100 词', '100词', '约100', 'Li Ming', '李明',
];

const LETTER_TYPES = [
  { type: '邀请类', keys: ['邀请', '邀请函', 'invite', 'invitation', '参加', '出席'] },
  { type: '道歉类', keys: ['道歉', '抱歉', 'apolog', '致歉', '失约', '未能'] },
  { type: '祝贺类', keys: ['祝贺', '恭喜', 'congratulat', '获奖', '录取', '成功'] },
  { type: '通知类', keys: ['通知', 'notice', '告示', '现将', '安排如下'] },
  { type: '公告类', keys: ['公告', 'announcement', '宣布'] },
  { type: '推荐类', keys: ['推荐', 'recommend', '介绍一本', '介绍一部'] },
  { type: '投诉类', keys: ['投诉', '不满', 'complain', '质量问题', '退款'] },
  { type: '建议类', keys: ['建议', '提出建议', 'suggest', 'advice', '如何改进'] },
  { type: '感谢类', keys: ['感谢', '致谢', 'thank', '答谢'] },
  { type: '介绍类', keys: ['介绍', '说明', 'introduce', '简述'] },
  { type: '咨询类', keys: ['咨询', '询问', 'inquir', '请问', '了解'] },
];

const POSITIVE = ['优点', '好处', '意义', '价值', '重要性', '品质', '美德', '积极', '鼓励', '提倡', '成就', '进步', '坚持', '奉献', '诚信', '感恩'];
const NEGATIVE = ['问题', '危害', '弊端', '不良', '浪费', '污染', '沉迷', '攀比', '焦虑', '内卷', '造假', '失信', '冷漠', '负面', '过度'];

function hits(text, keys) {
  const lower = text.toLowerCase();
  return keys.filter((k) => lower.includes(k.toLowerCase()));
}

export function classifyByRules(text = '') {
  const t = String(text);
  const evidence = {};

  const smallHits = hits(t, SMALL_ANY);
  const chartHits = [...new Set([...hits(t, CHART_ANY), ...hits(t, CHART_STATIC), ...hits(t, CHART_DYNAMIC)])];
  const pictureHits = hits(t, BIG_PICTURE);
  const materialHits = hits(t, BIG_MATERIAL);

  if (smallHits.length) evidence.小作文 = smallHits;
  if (chartHits.length) evidence.图表 = chartHits;
  if (pictureHits.length) evidence.图画 = pictureHits;
  if (materialHits.length) evidence.材料 = materialHits;

  // 大类：小作文信号最强（有明确文体要求），其次图表，再图画/材料
  let category = null;
  let subType = null;
  if (smallHits.length >= 1 && smallHits.length >= chartHits.length) {
    category = '小作文';
  } else if (chartHits.length) {
    category = '图表作文';
    const dyn = hits(t, CHART_DYNAMIC);
    const sta = hits(t, CHART_STATIC);
    subType = dyn.length > sta.length ? '动态' : sta.length ? '静态' : null;
  } else if (pictureHits.length) {
    category = '大作文';
    subType = '图画类';
  } else if (materialHits.length) {
    category = '大作文';
    subType = '材料类';
  }

  // 小作文题型
  let letterType = null;
  const letterScores = [];
  for (const { type, keys } of LETTER_TYPES) {
    const found = hits(t, keys);
    if (found.length) letterScores.push({ type, found });
  }
  letterScores.sort((a, b) => b.found.length - a.found.length);
  if (letterScores.length) {
    letterType = letterScores[0].type;
    evidence.题型 = letterScores.slice(0, 3).map((s) => `${s.type}(${s.found.join('/')})`);
    // 明确命中邀请、道歉、通知、建议等应用文题型时，可直接反推出大类为小作文。
    // 这覆盖「请给朋友写信，邀请……」这类没有出现固定短语“写一封”的简化题干。
    if (!category) category = '小作文';
  }

  // 褒贬倾向
  const pos = hits(t, POSITIVE);
  const neg = hits(t, NEGATIVE);
  if (pos.length) evidence.正面词 = pos;
  if (neg.length) evidence.负面词 = neg;
  let polarity = null;
  if (pos.length || neg.length) polarity = neg.length > pos.length ? '负面' : '正面';

  const signalCount = smallHits.length + chartHits.length + pictureHits.length + materialHits.length;
  return {
    source: 'rules',
    category,
    subType,
    letterType,
    polarity,
    evidence,
    confidence: category ? Math.min(0.9, 0.4 + signalCount * 0.12) : 0,
  };
}

// ---------- AI 层 ----------

const SYSTEM = `你是考研英语作文题型判定助手。你的唯一职责是判定题目类型，不要写作文。

判定维度：
1. category（大类）：必须是「大作文」「图表作文」「小作文」之一。
   - 大作文：给一幅图画或一段材料，要求写 160-220 词的议论文
   - 图表作文：给饼图/柱状图/折线图或表格，要求描述数据并分析
   - 小作文：要求写信、通知、公告、倡议书等应用文，通常 100 词左右，常署名 Li Ming
2. subType：大作文填「图画类」或「材料类」；图表作文填「静态」（饼图/占比构成）或「动态」（折线图/柱状图/时间变化）；小作文留 null。
3. letterType：仅小作文需要，从「邀请类 道歉类 祝贺类 通知类 公告类 推荐类 投诉类 建议类 感谢类 介绍类 咨询类」中选最贴合的一个；非小作文填 null。
4. polarity：题目讨论的现象是值得提倡的正面品质（填「正面」），还是需要纠正的负面现象（填「负面」）。小作文若无明显褒贬可填 null。
5. topicClass：话题类别，从「经济类 校园类 环境生态类 体育健康类 文化自信类 科技网络类 个人品质类 社会现象类」中选一个最贴合的。
6. keyPhrase：题目最核心的「题目相关词」，用中文简明表述（如「父母以身作则」「过度使用手机」）。
7. reason：判定依据，引用题目中的原话，一到两句中文。

严格返回 JSON：
{"category":"","subType":null,"letterType":null,"polarity":"","topicClass":"","keyPhrase":"","reason":"","confidence":0.9}`;

export async function classifyByAI(text) {
  const { data, model, usage } = await chatJson({
    tier: 'reasoning',
    system: SYSTEM,
    messages: [{ role: 'user', content: `题目如下：\n\n${text}` }],
    temperature: 0,
    maxTokens: 2048,
  });
  return { source: 'ai', model, usage, ...data };
}

// ---------- 合并 ----------

/**
 * 双轨判定并合并。以 AI 结论为主（它理解题意），规则层用于交叉验证与提供关键词证据。
 * 出现分歧时不隐藏，标记 needsConfirm 让用户拍板。
 */
export async function classify(text, { skipAI = false } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw Object.assign(new Error('题目内容为空。'), { status: 400 });

  const rules = classifyByRules(clean);
  if (skipAI) {
    return { final: { ...rules }, rules, ai: null, conflicts: [], needsConfirm: !rules.category };
  }

  let ai = null;
  let aiError = null;
  try {
    ai = await classifyByAI(clean);
  } catch (err) {
    aiError = err.message;
  }

  const conflicts = [];
  if (ai && rules.category && ai.category && ai.category !== rules.category) {
    conflicts.push({ field: 'category', rules: rules.category, ai: ai.category });
  }
  if (ai && rules.letterType && ai.letterType && ai.letterType !== rules.letterType) {
    conflicts.push({ field: 'letterType', rules: rules.letterType, ai: ai.letterType });
  }
  if (ai && rules.polarity && ai.polarity && ai.polarity !== rules.polarity) {
    conflicts.push({ field: 'polarity', rules: rules.polarity, ai: ai.polarity });
  }

  const final = ai
    ? {
        category: ai.category ?? rules.category,
        subType: ai.subType ?? rules.subType,
        letterType: ai.letterType ?? rules.letterType,
        polarity: ai.polarity ?? rules.polarity,
        topicClass: ai.topicClass ?? null,
        keyPhrase: ai.keyPhrase ?? null,
        reason: ai.reason ?? null,
        confidence: ai.confidence ?? rules.confidence,
      }
    : { ...rules, topicClass: null, keyPhrase: null, reason: `AI 判定不可用（${aiError}），已回退到关键词规则。` };

  return {
    final,
    rules,
    ai,
    aiError,
    conflicts,
    needsConfirm: conflicts.length > 0 || !final.category,
  };
}

/**
 * 依据判定结果，从知识库取出该题应当使用的模板 kind 序列。
 * 这一步决定了后面「套什么模板」，因此把映射关系显式写出来。
 */
export async function planTemplateKinds(final) {
  await loadKnowledge();
  switch (final.category) {
    case '大作文':
      return {
        paragraphs: [
          { name: '第一段 图画/材料描述+点题', kinds: ['big-essay-opening'] },
          { name: '第二段 主体论证', kinds: ['big-essay-body'] },
          { name: '第三段 结尾', kinds: ['big-essay-closing'] },
        ],
        wordCount: '160-200 词',
      };
    case '图表作文':
      return {
        paragraphs: [
          { name: '第一段 图表描述', kinds: ['chart-essay'] },
          { name: '第二段 原因分析', kinds: ['chart-essay'] },
          { name: '第三段 总结展望', kinds: ['chart-essay'] },
        ],
        wordCount: '180-220 词',
      };
    case '小作文':
      return {
        paragraphs: [
          { name: '第一段 写作目的', kinds: ['small-essay-para1'] },
          { name: '第二段 具体展开', kinds: ['small-essay-para2', 'small-essay-typed'] },
          { name: '第三段 期待与致谢', kinds: ['small-essay-para3'] },
        ],
        wordCount: '约 100 词',
      };
    default:
      throw Object.assign(new Error(`无法为未知大类「${final.category}」规划模板。`), { status: 400 });
  }
}
