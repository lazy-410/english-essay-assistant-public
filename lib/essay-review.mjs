/**
 * 作文批改引擎。
 *
 * 铁律：每一条修改建议都必须能追溯到讲义来源（页码 / 词表 / 骨架 / 自检规则）。
 * 引擎不做"自由发挥式润色"：
 * - 必改级：完全离线、确定性判定，来自字数规则、格式规则、图表数字校验、重复检测与讲义明令禁止项。
 * - 建议级：句式升级只能引用讲义骨架；词汇替换只能取自 knowledge/vocab.json 与 variants.json。
 * - 结构级：复用与成文链一致的模块流程判定。
 * AI 层只允许在既有结论上生成更自然的改写句，不得引入讲义之外的表达，失败则回退纯离线结果。
 */

import { loadWritingKnowledge } from './writing-kb.mjs';
import { loadKnowledge } from './kb.mjs';
import { getTrack, getModule } from './modules.mjs';
import { analyzeComposedEssay, PARAGRAPH_BLUEPRINT } from './essay-analysis.mjs';
import { inspectChartNumbers } from './chart-numbers.mjs';
import { acceptedWordBand } from './content-plan.mjs';
import { chatJson } from './deepseek.mjs';
import { checkGrammar, reviewGrammarWithAi } from './grammar-check.mjs';
import { detail as examDetail, referenceAnalysis as examReferenceAnalysis } from './exams.mjs';

const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];
const words = (value) => text(value).split(/\s+/).filter(Boolean).length;

export const SEVERITY = { REQUIRED: 'required', SUGGESTED: 'suggested', STRUCTURE: 'structure' };
export const SEVERITY_LABELS = { required: '必改', suggested: '建议', structure: '结构' };

const TRACK_BY_CATEGORY = { 图表作文: 'chart', 大作文: 'picture', 小作文: 'small' };

/* ------------------------------ 题型自动判定 ------------------------------ */

const CHART_HINTS = /\b(chart|table|graph|figure|percent|percentage|proportion|statistics|survey)\b|\d+(?:\.\d+)?\s*%/i;
const PICTURE_HINTS = /\b(picture|drawing|cartoon|photo|caption|depicts?|portrays?|illustration)\b/i;
const SMALL_HINTS = /\b(dear\s+\w+|yours\s+sincerely|yours\s+faithfully|li\s+ming|zhang\s+wei|students'?\s+union|notice|announcement|i\s+am\s+writing)\b/i;

/**
 * 依据作文自身的语言特征判定题型。
 * 只做判定并给出依据，最终由用户确认，避免判错后无法纠正。
 */
export function classifyEssayText(essayText, questionText = '') {
  const body = text(essayText);
  const prompt = text(questionText);
  const combined = `${prompt}\n${body}`;
  const evidence = [];
  const scores = { chart: 0, picture: 0, small: 0 };

  const smallMatch = combined.match(SMALL_HINTS);
  if (smallMatch) { scores.small += 3; evidence.push(`出现应用文格式特征「${smallMatch[0]}」`); }
  const chartMatch = combined.match(CHART_HINTS);
  if (chartMatch) { scores.chart += 2; evidence.push(`出现图表类表述「${chartMatch[0]}」`); }
  const pictureMatch = combined.match(PICTURE_HINTS);
  if (pictureMatch) { scores.picture += 2; evidence.push(`出现图画类表述「${pictureMatch[0]}」`); }

  // 多个百分比数字是图表作文的强特征。
  const percents = body.match(/\d+(?:\.\d+)?\s*%/g) ?? [];
  if (percents.length >= 2) { scores.chart += 2; evidence.push(`正文含 ${percents.length} 处百分比数据`); }

  const count = words(body);
  if (count > 0 && count <= 130) { scores.small += 1; evidence.push(`全文 ${count} 词，接近小作文篇幅`); }
  else if (count >= 150) { evidence.push(`全文 ${count} 词，属大作文篇幅`); }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topTrack, topScore] = ranked[0];
  const track = topScore > 0 ? topTrack : 'picture';
  if (topScore === 0) evidence.push('未发现明确特征，默认按图画大作文处理，请确认');
  const category = Object.entries(TRACK_BY_CATEGORY).find(([, id]) => id === track)?.[0] ?? '大作文';
  return {
    track,
    category,
    confident: topScore >= 3 && topScore > (ranked[1]?.[1] ?? 0),
    evidence,
    scores,
  };
}

/* ------------------------------ 讲义规则加载 ------------------------------ */

/**
 * 从 warnings.json 中挑出可机器判定的规则。
 * 讲义里也有大量"学习方法"类叮嘱（如别外传模板），这类不可判定，必须排除，
 * 否则会产生无法执行的批改项。
 */
const CHECKABLE_WARNINGS = [
  {
    id: 'closing-no-new-info',
    match: /结尾段功能是表达期待与致谢，不要再引入新信息/,
    track: 'small',
    test: ({ paragraphs }) => {
      const last = paragraphs.at(-1);
      if (!last) return null;
      // 「请联系我们 / 期待回复 / 欢迎参加」属于合规的结尾号召，不算新信息。
      const CLOSING_OK = /\b(contact|look(?:ing)?\s+forward|reply|welcome|thank|appreciate|feel\s+free|apply|join)\b/i;
      const offending = array(last.sentences).find((sentence) => sentence.role === 'requirement-detail'
        && !CLOSING_OK.test(sentence.text));
      return offending ? { quote: offending.text, detail: '末段出现新的事项说明，应只保留致谢与期待' } : null;
    },
  },
  {
    id: 'recall-past-tense',
    match: /时态错误：回忆内容必须用过去式/,
    track: 'small',
    test: ({ body }) => {
      // 明确的回忆语境却整篇没有任何过去式动词。
      if (!/\b(recall|remember|last\s+(year|term|semester|summer)|when\s+i\s+was)\b/i.test(body)) return null;
      if (/\b\w+ed\b|\bwas\b|\bwere\b|\bhad\b|\bdid\b/i.test(body)) return null;
      return { quote: '', detail: '出现回忆语境但全文未使用过去式' };
    },
  },
  {
    id: 'room-vs-house',
    match: /用词不当：避免使用 room 代替 house/,
    track: null,
    test: ({ body }) => {
      const hit = body.match(/\bmy\s+room\b/i);
      return hit ? { quote: hit[0], detail: '讲义指出不应用 room 代替 house' } : null;
    },
  },
];

async function loadRules() {
  const kb = await loadWritingKnowledge();
  const warnings = [];
  for (const rule of CHECKABLE_WARNINGS) {
    const source = kb.warnings.find((item) => rule.match.test(text(item.text)));
    if (source) {
      warnings.push({ ...rule, text: text(source.text), page: array(source.sourceRefs)[0]?.page ?? null });
    }
  }
  return { kb, warnings };
}

/** 讲义词表：高级词替换的唯一来源。 */
async function loadVocabulary() {
  try {
    const kb = await loadKnowledge();
    return array(kb.vocab).map((item) => ({
      en: text(item.en),
      zh: text(item.zh),
      page: item.page ?? null,
    })).filter((item) => item.en);
  } catch {
    return [];
  }
}

/* ------------------------------ 文本切分 ------------------------------ */

/** 小数点不是句末：87.5% 必须保持完整，否则会被误判成两个数字。 */
function splitSentences(paragraph) {
  const source = text(paragraph);
  if (!source) return [];
  const out = [];
  let buffer = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    buffer += character;
    if (!'.!?'.includes(character)) continue;
    const before = source[index - 1] ?? '';
    const after = source[index + 1] ?? '';
    // 数字之间的点是小数点；紧跟字母数字说明不是句末（如 U.S.）。
    if (character === '.' && /\d/.test(before) && /\d/.test(after)) continue;
    if (/[A-Za-z0-9]/.test(after)) continue;
    // 吞掉紧随的引号，避免单独成句。注意必须先判空，否则 ''.includes('') 恒真会死循环。
    const QUOTES = '"\u2019\u201D\'';
    while (source[index + 1] && QUOTES.includes(source[index + 1])) {
      buffer += source[index + 1];
      index += 1;
    }
    if (text(buffer)) out.push(text(buffer));
    buffer = '';
  }
  if (text(buffer)) out.push(text(buffer));
  return out.length ? out : [source];
}

/**
 * 按空行分段。
 * 通知类的标题行与落款行不是正文段落，否则会把 3 段正文误判成 4 段。
 */
function splitParagraphs(body, track) {
  const blocks = text(body).split(/\n\s*\n/).map(text).filter(Boolean);
  if (track !== 'small' || blocks.length <= 1) return { paragraphs: blocks, title: null };
  let title = null;
  const paragraphs = [...blocks];
  // 独立成块且极短、又不含句末标点的首块视为标题（Notice / Announcement）。
  if (words(paragraphs[0]) <= 4 && !/[.!?]$/.test(paragraphs[0])) {
    title = paragraphs.shift();
  }
  // 末块若是署名（很短且无句末标点），并入上一段以免多算一段。
  const last = paragraphs.at(-1);
  if (paragraphs.length > 1 && last && words(last) <= 5 && !/[.!?]$/.test(last)) {
    const signature = paragraphs.pop();
    paragraphs[paragraphs.length - 1] = `${paragraphs.at(-1)}\n${signature}`;
  }
  return { paragraphs, title };
}

/* ------------------------------ 修改项构造 ------------------------------ */

let issueSeq = 0;
function makeIssue({ severity, kind, title, detail, quote = '', suggestion = '', basis, page = null, paragraph = null, sentence = null, autoApplicable, replacement = null, slots = [] }) {
  issueSeq += 1;
  return {
    id: `rev-${issueSeq}`,
    severity,
    kind,
    title,
    detail,
    quote,
    suggestion,
    // basis 是可追溯依据，缺失即不允许出现该条目。
    basis,
    page,
    paragraph,
    sentence,
    // 默认：有原文且有改写建议即可自动替换；含占位符的条目会显式传 false。
    autoApplicable: autoApplicable ?? Boolean(text(quote) && text(suggestion)),
    replacement,
    slots,
  };
}

/* ------------------------------ 语法错误 ------------------------------ */

/**
 * 语法错误一律归入必改级并排在最前——它是最直接的失分点。
 * 每条都带规则名与可定位片段，因此可以安全地自动替换。
 */
function grammarIssues(errors) {
  return array(errors).map((error) => makeIssue({
    severity: SEVERITY.REQUIRED,
    kind: `grammar:${error.rule}`,
    title: `${error.rule}错误：${error.quote} → ${error.replacement}`,
    detail: error.why,
    quote: error.quote,
    suggestion: error.replacement,
    basis: error.source === 'ai'
      ? `语法规则（AI 复核，片段已在原文中校验）：${error.rule}`
      : `语法规则：${error.rule}`,
    // 「（改为过去式）」这类占位提示不能直接替换进终稿。
    autoApplicable: !/[（(]/.test(error.replacement),
  }));
}

/* ------------------------------ 真题范文对照 ------------------------------ */

/**
 * 与该年真题范文对比结构与用词。
 * 范文只作参系，不是唯一答案——因此结论以「参考」呈现，不计入必改。
 */
function compareWithModel(analysis, exam, body) {
  const paragraphs = array(exam?.modelEssay?.paragraphs);
  if (!paragraphs.length) {
    return {
      available: false,
      note: '该题暂无已校对范文，因此只用题干做字数与任务校验，不做范文对比。',
    };
  }
  const modelWords = paragraphs.reduce((sum, paragraph) => sum + words(paragraph.text), 0);
  const myWords = words(body);
  const modelModules = [...new Set(paragraphs.flatMap((paragraph) => array(paragraph.modules).map(text)))];
  const myModules = new Set(array(analysis.moduleFlow).filter((item) => item.covered).map((item) => item.id));
  const missing = modelModules.filter((id) => !myModules.has(id))
    .map((id) => getModule(id)?.label ?? id);

  // 范文用到、考生未用的实义词（长度≥6，排除常见虚词），作为用词提示。
  const myWordSet = new Set((body.toLowerCase().match(/[a-z]{6,}/g) ?? []));
  const modelText = paragraphs.map((paragraph) => text(paragraph.text)).join(' ');
  const notable = [...new Set((modelText.toLowerCase().match(/[a-z]{6,}/g) ?? []))]
    .filter((word) => !myWordSet.has(word))
    .slice(0, 12);

  return {
    available: true,
    modelWords,
    myWords,
    wordGap: myWords - modelWords,
    modelParagraphs: paragraphs.length,
    myParagraphs: analysis.paragraphs.length,
    modelModules: modelModules.map((id) => getModule(id)?.label ?? id),
    missingModules: missing,
    notableWords: notable,
    note: '范文是一种得分写法，不是唯一答案。这里只用于对照结构与用词，不要求逐句照搬。',
  };
}

/* ------------------------------ 必改级检查 ------------------------------ */

function checkWordCount(body, track, questionText) {
  const count = words(body);
  const explicit = text(questionText).match(/(?:at\s+least|no\s+less\s+than|not\s+less\s+than)\s*(\d{2,3})/i);
  let band;
  let basis;
  if (explicit) {
    const low = Number(explicit[1]);
    band = acceptedWordBand(`${low}-${Math.round(low * 1.1)}（至少${low}）`);
    basis = `题目要求「至少 ${low} 词」，练习区间取 ${band[0]}-${band[1]}`;
  } else if (track === 'small') {
    band = [90, 110];
    basis = '小作文讲义建议约 100 词';
  } else if (track === 'chart') {
    band = [150, 165];
    basis = '英语二图表大作文讲义建议 150 词以上';
  } else {
    band = [160, 200];
    basis = '英语一图画大作文讲义建议 160-200 词';
  }
  if (count >= band[0] && count <= band[1]) return null;
  const over = count > band[1];
  return makeIssue({
    severity: SEVERITY.REQUIRED,
    kind: 'word-count',
    title: over ? `全文 ${count} 词，超出上限 ${band[1]}` : `全文 ${count} 词，未达下限 ${band[0]}`,
    detail: over
      ? `需要删减约 ${count - band[1]} 词。优先删套话、重复论据与过长修饰，不要删首尾句与过渡词。`
      : `需要补充约 ${band[0] - count} 词。在已有论点内补具体原因、例证或影响，不要靠同义重复凑字数。`,
    basis,
  });
}

function checkParagraphCount(analysis) {
  if (analysis.paragraphs.length === 3) return null;
  return makeIssue({
    severity: SEVERITY.REQUIRED,
    kind: 'paragraph-count',
    title: `全文 ${analysis.paragraphs.length} 段，讲义要求 3 段`,
    detail: array(PARAGRAPH_BLUEPRINT[analysis.track.id]).map((item, index) => `第${index + 1}段：${item.name.replace(/^第.段：/, '')}`).join('；'),
    basis: `${getTrack(analysis.track.id)?.label ?? ''}三段式结构`,
  });
}

function checkSmallFormat(body, track) {
  if (track !== 'small') return [];
  const issues = [];
  const isNotice = /\b(notice|announcement)\b/i.test(body) || /^notice\b/im.test(body);
  if (!isNotice && !/^\s*dear\b/im.test(body)) {
    issues.push(makeIssue({
      severity: SEVERITY.REQUIRED,
      kind: 'small-salutation',
      title: '书信/邮件缺少称呼',
      detail: '首行应有 Dear + 收件人，例如 Dear Jack,',
      basis: '小作文格式规范：称呼、正文、结束语与署名',
    }));
  }
  if (!/\b(yours\s+(sincerely|faithfully|truly)|li\s+ming|zhang\s+wei|students'?\s+union|postgraduates'?\s+association)\b/i.test(body)) {
    issues.push(makeIssue({
      severity: SEVERITY.REQUIRED,
      kind: 'small-signature',
      title: '缺少落款署名',
      detail: isNotice ? '通知类用机构名署名，如 The Students\' Union，不使用书信落款。' : '书信类应有 Yours sincerely, 与规定署名（如 Li Ming），不要写真实姓名。',
      basis: '小作文格式规范：落款与署名要求',
    }));
  }
  if (/\b(li\s+ming|zhang\s+wei)\b/i.test(body) && isNotice) {
    issues.push(makeIssue({
      severity: SEVERITY.REQUIRED,
      kind: 'small-notice-signature',
      title: '通知类误用书信署名',
      detail: '通知/公告应以机构名义署名，不应出现 Li Ming 这类个人署名。',
      basis: '小作文格式规范：通知不使用书信落款',
    }));
  }
  return issues;
}

function checkChartNumbers(analysis, chartFacts) {
  if (analysis.track.id !== 'chart') return [];
  const dataPoints = array(chartFacts?.dataPoints);
  if (!dataPoints.length) return [];
  const issues = [];
  for (const paragraph of analysis.paragraphs) {
    for (const sentence of paragraph.sentences) {
      const unsupported = inspectChartNumbers(sentence.text, chartFacts).unsupported;
      if (!unsupported.length) continue;
      issues.push(makeIssue({
        severity: SEVERITY.REQUIRED,
        kind: 'chart-number',
        title: `第${paragraph.index}段出现无法核验的数字：${unsupported.join('、')}`,
        detail: '图表作文只能使用题图原始数据，或明确表达比较关系的可复算差值。无法确认时改用定性表达，如 a marked increase。',
        quote: sentence.text,
        basis: '图表数字规则：只使用可核验的原始数据',
        paragraph: paragraph.index,
        sentence: sentence.index,
      }));
    }
  }
  return issues;
}

function checkRepeats(analysis) {
  const tokens = analysis.paragraphs
    .flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.text))
    .join(' ')
    .toLowerCase()
    .match(/[a-z']+/g) ?? [];
  const counts = new Map();
  for (let size = 6; size <= 9; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      const slice = tokens.slice(index, index + size);
      if (!slice.some((word) => word.length >= 6)) continue;
      const phrase = slice.join(' ');
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  const repeats = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[0].split(' ').length - a[0].split(' ').length)
    .filter(([phrase], index, all) => !all.slice(0, index).some(([longer]) => longer.includes(phrase)))
    .slice(0, 3);
  return repeats.map(([phrase, count]) => makeIssue({
    severity: SEVERITY.REQUIRED,
    kind: 'repeat',
    title: `重复长短语（${count} 次）：${phrase}`,
    detail: '同一表达重复出现会被判为语言单调。请替换其中一处的说法，或调整句式。',
    quote: phrase,
    basis: '自检规则：无明显重复表达',
  }));
}

function checkWarnings(warnings, { analysis, body, track }) {
  const issues = [];
  for (const rule of warnings) {
    if (rule.track && rule.track !== track) continue;
    const hit = rule.test({ paragraphs: analysis.paragraphs, body });
    if (!hit) continue;
    issues.push(makeIssue({
      severity: SEVERITY.REQUIRED,
      kind: `warning:${rule.id}`,
      title: `违反讲义提醒：${rule.text.slice(0, 34)}`,
      detail: hit.detail,
      quote: hit.quote,
      basis: `讲义明确提醒：${rule.text}`,
      page: rule.page,
    }));
  }
  return issues;
}

/* ------------------------------ 建议级检查 ------------------------------ */

/** 句式升级：只推荐讲义骨架，且必须与该句功能位一致。 */
function suggestSkeletons(analysis, kb) {
  const byTrack = kb.skeletons.filter((item) => item.productionEligible === true
    && text(item.conflictGroup).split(':')[0] === analysis.track.id);
  const issues = [];
  // 同一条骨架只推荐一次，否则多句会收到完全相同的建议，显得敷衍。
  const offered = new Set();
  for (const paragraph of analysis.paragraphs) {
    for (const sentence of paragraph.sentences) {
      // 已经高度贴合讲义模板的句子不再打扰。
      if (sentence.skeletons?.[0]?.exact) continue;
      if ((sentence.skeletons?.[0]?.similarity ?? 0) >= 45) continue;
      const moduleId = sentence.moduleId;
      if (!moduleId) continue;
      const candidates = byTrack.filter((item) => {
        const parts = text(item.conflictGroup).split(':');
        const rhetorical = parts[2] ?? '';
        return rhetoricalMatchesModule(rhetorical, moduleId) && !offered.has(item.id);
      });
      if (!candidates.length) continue;
      const pick = candidates[0];
      offered.add(pick.id);
      const ref = array(pick.sourceRefs)[0] ?? {};
      const skeletonEn = text(pick.en);
      const slots = array(pick.slots).map(text).filter(Boolean);
      issues.push(makeIssue({
        severity: SEVERITY.SUGGESTED,
        kind: 'skeleton-upgrade',
        title: `第${paragraph.index}段第${sentence.index}句可套用讲义「${getModule(moduleId)?.label ?? moduleId}」功能句`,
        detail: slots.length
          ? `讲义功能句：${skeletonEn}\n需要你把 ${slots.map((slot) => `{${slot}}`).join('、')} 换成本题的具体内容。`
          : `讲义功能句：${skeletonEn}`,
        quote: sentence.text,
        suggestion: skeletonEn,
        basis: `讲义 ${text(pick.id)}｜${text(ref.pageTitle) || '功能句'}`,
        page: ref.page ?? null,
        paragraph: paragraph.index,
        sentence: sentence.index,
        // 含占位符的骨架不能直接替换进终稿，否则终稿里会残留 {题目相关词}。
        autoApplicable: slots.length === 0,
        slots,
      }));
    }
  }
  return issues.slice(0, 6);
}

function rhetoricalMatchesModule(rhetorical, moduleId) {
  const map = {
    'chart-introduction': ['description'],
    'chart-data': ['description'],
    'chart-question': ['reason'],
    'chart-reasons': ['reason'],
    'chart-advice': ['advice', 'closing'],
    'chart-outlook': ['closing'],
    'picture-scene': ['description'],
    'picture-theme': ['introduction'],
    'picture-argument': ['development'],
    'picture-advice': ['advice', 'closing'],
    'picture-outlook': ['closing'],
    'small-purpose': ['introduction'],
    'small-details': ['development'],
    'small-support': ['development'],
    'small-politeness': ['closing'],
  };
  return (map[moduleId] ?? []).includes(rhetorical);
}

/**
 * 词汇升级：只从讲义词表取值。
 * 词表条目多为短语，因此按"正文出现了该词条的简单同义/低级说法"这一保守策略匹配，
 * 宁可少提建议，也不凭空创造"高级词"。
 */
const VOCAB_TRIGGERS = [
  { plain: /\bstudy\s+online\b/i, want: /online\s+learning/i },
  { plain: /\bmore\s+and\s+more\s+people\b/i, want: /an\s+increasing\s+number\s+of/i },
  { plain: /\bvery\s+important\b/i, want: /(significance|vital|crucial)/i },
  { plain: /\bmany\s+people\s+think\b/i, want: /(it\s+is\s+widely|generally)\s+(believed|acknowledged)/i },
  { plain: /\bgood\s+for\b/i, want: /(beneficial|conducive)/i },
  { plain: /\bbad\s+for\b/i, want: /(detrimental|harmful)/i },
  { plain: /\bnowadays\b/i, want: /(in\s+contemporary\s+society|at\s+present)/i },
];

function suggestVocabulary(body, vocabulary) {
  const issues = [];
  for (const trigger of VOCAB_TRIGGERS) {
    const hit = body.match(trigger.plain);
    if (!hit) continue;
    // 目标表达必须真实存在于讲义词表，否则不给建议。
    const entry = vocabulary.find((item) => trigger.want.test(item.en));
    if (!entry) continue;
    issues.push(makeIssue({
      severity: SEVERITY.SUGGESTED,
      kind: 'vocab-upgrade',
      title: `「${hit[0]}」可替换为讲义词表表达「${entry.en}」`,
      detail: `${entry.en}${entry.zh ? `（${entry.zh}）` : ''}。替换时保持句子语法与语义一致。`,
      quote: hit[0],
      suggestion: entry.en,
      basis: `讲义词表 P${entry.page ?? '—'}：${entry.en}`,
      page: entry.page ?? null,
    }));
  }
  return issues;
}

/** 骨架替换值：讲义为占位符给出的可替换词，同样是可追溯来源。 */
function suggestVariants(analysis, kb) {
  const used = new Set(analysis.paragraphs
    .flatMap((paragraph) => paragraph.sentences)
    .filter((sentence) => sentence.skeletons?.[0]?.exact)
    .map((sentence) => sentence.skeletons[0].skeletonId));
  if (!used.size) return [];
  const issues = [];
  for (const skeletonId of used) {
    const variants = kb.variants.filter((item) => item.skeletonId === skeletonId).slice(0, 4);
    if (variants.length < 2) continue;
    const ref = array(variants[0].sourceRefs)[0] ?? {};
    issues.push(makeIssue({
      severity: SEVERITY.SUGGESTED,
      kind: 'variant-hint',
      title: `套用的讲义句「${skeletonId}」可换用替换词避免与他人雷同`,
      detail: `讲义给出的替换值：${variants.map((item) => text(item.value)).join('、')}。${text(variants[0].constraint) || ''}`,
      basis: `讲义替换词表｜${skeletonId}`,
      page: ref.page ?? null,
    }));
  }
  return issues.slice(0, 3);
}

/* ------------------------------ 结构级检查 ------------------------------ */

function checkStructure(analysis) {
  return array(analysis.moduleFlow)
    .filter((module) => !module.covered && module.required)
    .map((module) => makeIssue({
      severity: SEVERITY.STRUCTURE,
      kind: 'module-missing',
      title: `缺少写作模块「${module.label}」`,
      detail: module.suggestion || `应补一句承担该功能：${module.description}`,
      basis: `${getTrack(analysis.track.id)?.label ?? ''}模块顺序：${array(getTrack(analysis.track.id)?.modules).map((item) => item.label).join(' → ')}`,
    }));
}

/* ------------------------------ 分档与得失分点 ------------------------------ */

/**
 * 分项估分：内容 / 结构 / 语言 / 格式。
 * 大作文按 20 分制、小作文按 10 分制，各维度给区间而不是确定值——
 * 因为这是基于规则的估算，给单一分数会造成"精确"的错觉。
 */
function scoreBreakdown(issues, analysis, track) {
  const full = track === 'small' ? 10 : 20;
  // 四维度权重：内容与语言权重更高，与阅卷关注点一致。
  const weights = { content: 0.3, structure: 0.25, language: 0.3, format: 0.15 };
  const of = (kinds) => issues.filter((item) => kinds.some((kind) => item.kind.startsWith(kind)));

  const grammar = of(['grammar:']).length;
  const chartNumber = of(['chart-number']).length;
  const wordCount = of(['word-count']).length;
  const formatIssues = of(['small-salutation', 'small-signature', 'small-notice-signature', 'grammar:大小写', 'grammar:标点']).length;
  const structureIssues = issues.filter((item) => item.severity === SEVERITY.STRUCTURE).length
    + of(['paragraph-count']).length;
  const repeats = of(['repeat']).length;
  const suggestions = issues.filter((item) => item.severity === SEVERITY.SUGGESTED).length;

  // 每个维度从满分起扣，扣分上限为该维度满分。
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ratios = {
    content: clamp(1 - (chartNumber * 0.2 + wordCount * 0.25)),
    structure: clamp(1 - structureIssues * 0.2),
    language: clamp(1 - (grammar * 0.12 + repeats * 0.1 + Math.min(suggestions, 6) * 0.03)),
    format: clamp(1 - formatIssues * 0.3),
  };

  const reasons = {
    content: chartNumber || wordCount
      ? [chartNumber ? `${chartNumber} 处数字无法核验` : '', wordCount ? '字数不达标' : ''].filter(Boolean).join('；')
      : '任务与数据引用无明显问题',
    structure: structureIssues ? `${structureIssues} 处结构问题（段落或模块缺失）` : '三段式与模块覆盖完整',
    language: grammar || repeats
      ? [grammar ? `${grammar} 处语法错误` : '', repeats ? `${repeats} 处重复表达` : ''].filter(Boolean).join('；')
      : (suggestions ? `无语法错误，但有 ${suggestions} 处表达可升级` : '语言无明显问题'),
    format: formatIssues ? `${formatIssues} 处格式或标点问题` : '格式规范',
  };

  const dimensions = Object.entries(weights).map(([key, weight]) => {
    const max = full * weight;
    const got = max * ratios[key];
    return {
      key,
      label: { content: '内容', structure: '结构', language: '语言', format: '格式' }[key],
      max: Math.round(max * 10) / 10,
      low: Math.floor(got * 10) / 10,
      high: Math.min(Math.round(max * 10) / 10, Math.ceil((got + max * 0.08) * 10) / 10),
      reason: reasons[key],
    };
  });

  const low = Math.floor(dimensions.reduce((sum, item) => sum + item.low, 0));
  const high = Math.min(full, Math.ceil(dimensions.reduce((sum, item) => sum + item.high, 0)));
  return { full, dimensions, totalLow: low, totalHigh: high };
}

function grade(issues, analysis) {
  const required = issues.filter((item) => item.severity === SEVERITY.REQUIRED).length;
  const structure = issues.filter((item) => item.severity === SEVERITY.STRUCTURE).length;
  const suggested = issues.filter((item) => item.severity === SEVERITY.SUGGESTED).length;

  let band;
  let summary;
  if (required === 0 && structure === 0) {
    band = suggested <= 2 ? '接近满分档' : '中上档';
    summary = suggested <= 2
      ? '结构完整、无硬性错误，语言也较贴合讲义表达。'
      : '结构完整、无硬性错误，但仍有若干表达可以升级到讲义功能句与词表。';
  } else if (required <= 2 && structure === 0) {
    band = '中上档';
    summary = '结构完整，但存在少量必改问题，改掉后可进入更高档位。';
  } else if (required <= 4 || structure <= 1) {
    band = '中档';
    summary = '存在多处必改问题或模块缺失，需要按清单逐条修正。';
  } else {
    band = '需大改';
    summary = '结构与语言均有明显问题，建议先补齐模块结构，再逐句替换为讲义功能句。';
  }

  const gains = [];
  const losses = [];
  const covered = array(analysis.moduleFlow).filter((module) => module.covered);
  if (covered.length) gains.push(`已覆盖 ${covered.length} 个写作模块：${covered.map((item) => item.label).join('、')}`);
  const exact = analysis.paragraphs.flatMap((p) => p.sentences).filter((s) => s.skeletons?.[0]?.exact).length;
  if (exact) gains.push(`有 ${exact} 句直接套用了讲义功能句`);
  if (analysis.paragraphs.length === 3) gains.push('三段式结构完整');

  for (const item of issues.filter((x) => x.severity === SEVERITY.REQUIRED).slice(0, 5)) losses.push(item.title);
  for (const item of issues.filter((x) => x.severity === SEVERITY.STRUCTURE)) losses.push(item.title);

  const grammarCount = issues.filter((item) => item.kind.startsWith('grammar:')).length;
  if (grammarCount === 0) gains.push('未发现高置信语法错误');

  return {
    band,
    summary,
    gains,
    losses,
    counts: { required, suggested, structure, grammar: grammarCount },
    disclaimer: '分项估分与得失分点是依据本软件讲义规则、语法规则与自检项的估算，用于定位问题，不等同真实考研阅卷分数。',
  };
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 批改一篇作文。
 * @param {object} options
 * @param {string} options.essayText 用户确认后的作文全文（空行分段）
 * @param {string} [options.category] 用户确认的题型；缺省时自动判定
 * @param {string} [options.questionText] 题干，用于字数规则与图表事实
 * @param {object} [options.chartFacts] 图表事实（dataPoints/labelNumbers 等）
 */
export async function reviewEssay({ essayText, category, questionText = '', chartFacts = null, examId = null, grammarErrors = null } = {}) {
  const body = text(essayText);
  if (!body) {
    throw Object.assign(new Error('请先提供作文内容。'), { status: 400, code: 'essay_required' });
  }
  issueSeq = 0;

  // 指定真题时，题干与图表数据一律以题库为准，字数与数字校验才有依据。
  let exam = null;
  let effectiveQuestion = text(questionText);
  let effectiveChart = chartFacts;
  let effectiveCategory = text(category);
  if (text(examId)) {
    exam = await examDetail(text(examId));
    if (!exam) throw Object.assign(new Error(`未找到题目：${examId}`), { status: 404, code: 'exam_not_found' });
    effectiveQuestion = text(exam.directions) || effectiveQuestion;
    if (!effectiveChart) effectiveChart = examReferenceAnalysis(exam)?.chartData ?? null;
    // 题库已明确题型，无需依赖文本特征猜测。
    effectiveCategory = exam.section === 'small' ? '小作文' : (exam.essayType === 'chart' ? '图表作文' : '大作文');
  }

  const detected = classifyEssayText(body, effectiveQuestion);
  const finalCategory = effectiveCategory || detected.category;
  const track = TRACK_BY_CATEGORY[finalCategory] ?? detected.track;

  const { paragraphs: paragraphTexts, title: noticeTitle } = splitParagraphs(body, track);
  const analysis = await analyzeComposedEssay({
    essay: {
      paragraphs: paragraphTexts.map((paragraph) => ({
        sentences: splitSentences(paragraph),
        sentenceSources: [],
      })),
    },
    classification: { category: finalCategory },
    facts: effectiveChart ? { chart: effectiveChart } : {},
    question: effectiveQuestion,
  });

  const { kb, warnings } = await loadRules();
  const vocabulary = await loadVocabulary();
  // grammarErrors 可由调用方注入（已含 AI 复核结果）；否则在此做离线检查。
  const grammar = array(grammarErrors).length ? array(grammarErrors) : checkGrammar(body);

  const issues = [
    // 语法错误排在最前：这是最直接的失分点。
    ...grammarIssues(grammar),
    checkWordCount(body, track, effectiveQuestion),
    checkParagraphCount(analysis),
    ...checkSmallFormat(body, track),
    ...checkChartNumbers(analysis, effectiveChart),
    ...checkRepeats(analysis),
    ...checkWarnings(warnings, { analysis, body, track }),
    ...checkStructure(analysis),
    ...suggestSkeletons(analysis, kb),
    ...suggestVocabulary(body, vocabulary),
    ...suggestVariants(analysis, kb),
  ].filter(Boolean);

  // 铁律兜底：没有可追溯依据的条目一律不返回。
  const traceable = issues.filter((item) => text(item.basis));
  const modelComparison = exam ? compareWithModel(analysis, exam, body) : null;

  return {
    track: { id: analysis.track.id, label: analysis.track.label },
    category: finalCategory,
    detectedCategory: detected.category,
    detection: detected,
    exam: exam
      ? {
        id: exam.id,
        year: exam.year,
        examType: exam.examType,
        section: exam.section,
        essayType: exam.essayType,
        label: `${exam.year} ${exam.examType === 'e1' ? '英语一' : '英语二'}${exam.section === 'small' ? '小作文' : '大作文'}`,
        directions: text(exam.directions),
        hasModelEssay: array(exam.modelEssay?.paragraphs).length > 0,
      }
      : null,
    modelComparison,
    words: words(body),
    paragraphs: analysis.paragraphs,
    moduleFlow: analysis.moduleFlow,
    blueprint: analysis.blueprint,
    grammarErrors: grammar,
    issues: traceable,
    grade: grade(traceable, analysis),
    score: scoreBreakdown(traceable, analysis, track),
    aiRewrites: null,
  };
}

/** 供接口层使用：先做离线语法检查，再叠加 AI 复核。 */
export async function collectGrammarErrors(essayText, { useAi = false, chatJsonImpl } = {}) {
  const offline = checkGrammar(essayText);
  if (!useAi) return offline;
  const extra = await reviewGrammarWithAi(essayText, offline, { chatJsonImpl });
  return [...offline, ...extra];
}

/**
 * 按采纳的修改项生成终稿。
 * 只做可安全执行的字面替换（词汇与句式），结构类建议需用户自己动笔。
 */
export function applyAcceptedIssues(essayText, issues = [], acceptedIds = []) {
  const accepted = new Set(array(acceptedIds).map(text));
  let output = text(essayText);
  const applied = [];
  const manual = [];
  for (const issue of array(issues)) {
    if (!accepted.has(text(issue.id))) continue;
    const from = text(issue.quote);
    // AI 改写句已填好具体内容，可直接替换；未填的骨架含占位符，只能提示手改。
    const to = text(issue.replacement) || (issue.autoApplicable ? text(issue.suggestion) : '');
    if (from && to && !/\{[^}]*\}/.test(to) && output.includes(from)) {
      output = output.replace(from, to);
      applied.push({ id: issue.id, from, to });
    } else {
      manual.push({
        id: issue.id,
        title: issue.title,
        detail: issue.detail,
        // 告诉用户到底该替换什么，而不是只说"需手改"。
        template: text(issue.suggestion),
        slots: array(issue.slots),
      });
    }
  }
  return { text: output, applied, manual };
}

const AI_SYSTEM = `你是考研英语作文批改助手。输入包含作文原句与"依据讲义得出的问题与建议"。
只允许把已给出的建议改写成更自然的句子，必须满足：
1. 不得引入输入中没有的讲义表达、词汇或事实；
2. 不得改变问题判定本身，也不得新增问题；
3. 图表作文不得出现输入未提供的数字；
4. 每条改写必须对应输入中的 issueId。
严格返回 JSON：{"rewrites":[{"issueId":"","rewritten":"","why":"改写理由（中文，40字内）"}]}`;

/** AI 层：只在离线结论上生成更自然的改写句；失败静默回退。 */
export async function deepenReview(review, { chatJsonImpl } = {}) {
  const targets = array(review?.issues).filter((item) => text(item.quote) && item.severity !== SEVERITY.STRUCTURE);
  if (!targets.length) return review;
  const impl = typeof chatJsonImpl === 'function' ? chatJsonImpl : chatJson;
  try {
    const response = await impl({
      tier: 'fast',
      system: AI_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          track: review.track,
          issues: targets.map((item) => ({
            issueId: item.id,
            quote: item.quote,
            suggestion: item.suggestion,
            detail: item.detail,
            basis: item.basis,
          })),
        }),
      }],
      temperature: 0.2,
      maxTokens: 2000,
      responseFormat: { type: 'json_object' },
    });
    const raw = response?.data && typeof response.data === 'object' ? response.data : response;
    const byId = new Map(array(raw?.rewrites)
      .map((item) => [text(item?.issueId), { rewritten: text(item?.rewritten), why: text(item?.why) }])
      .filter(([id, value]) => id && value.rewritten));
    if (!byId.size) return review;
    return {
      ...review,
      issues: review.issues.map((item) => {
        const rewrite = byId.get(item.id);
        if (!rewrite) return item;
        return { ...item, replacement: rewrite.rewritten, aiWhy: rewrite.why };
      }),
      aiRewrites: byId.size,
    };
  } catch {
    return review;
  }
}

export default {
  reviewEssay,
  applyAcceptedIssues,
  deepenReview,
  classifyEssayText,
  collectGrammarErrors,
  SEVERITY,
  SEVERITY_LABELS,
};
