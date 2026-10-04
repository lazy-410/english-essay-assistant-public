/**
 * 真题行文解析。
 *
 * 离线层完全确定性：只使用题库已校对范文、题干事实和写作知识库骨架，
 * 逐句说明「这句承担什么功能、为什么必须放在这个位置、对应讲义哪一页」。
 * 题库的句子级 modules 只是段落标签的副本，因此句子功能由位置与语言标记推导。
 *
 * AI 层可选：配了 DeepSeek 时在既有离线结论上补充讲解，失败则静默回退。
 */

import { detail as examDetail, referenceAnalysis } from './exams.mjs';
import { loadWritingKnowledge } from './writing-kb.mjs';
import { getTrack, getModule } from './modules.mjs';
import { extractChartNumbers } from './chart-numbers.mjs';
import { chatJson } from './deepseek.mjs';

const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];
const words = (value) => text(value).split(/\s+/).filter(Boolean).length;

const TRACK_BY_ESSAY_TYPE = { chart: 'chart', picture: 'picture', hybrid: 'picture', small: 'small' };

/** 三条轨道的段落功能骨干，用于解释「为什么这一段要这样安排」。 */
export const PARAGRAPH_BLUEPRINT = {
  chart: [
    { name: '第一段：图表描述', purpose: '交代图表形式与主体，再按最大值、最小值和显著对比选择性描述数据，最后收一句总体判断。', avoid: '不要罗列全部数字，也不要在这一段分析原因。' },
    { name: '第二段：原因分析', purpose: '承接数据抛出疑问，再从两个以上角度解释差异或变化的成因。', avoid: '原因属于合理推断，不能写成图表事实，也不要在这里重复数据。' },
    { name: '第三段：建议与展望', purpose: '针对数据揭示的问题给出可执行建议，并用条件句或趋势判断收束。', avoid: '不要提出与图表主题无关的建议，也不要再引入新数据。' },
  ],
  picture: [
    { name: '第一段：描图与点题', purpose: '先客观描述画面中的环境、人物、动作和文字说明，再从画面过渡到寓意。', avoid: '不要描述画上不存在的物件，也不要在描图阶段提前给建议。' },
    { name: '第二段：现象与论证', purpose: '联系现实分析这一现象的原因、意义、影响或危害，用两到三个角度支撑。', avoid: '不要重复第一段的画面细节，也不要只喊口号而无论证。' },
    { name: '第三段：建议与升华', purpose: '从社会与个人两个层面给出建议，再以号召、警示或价值判断收尾。', avoid: '不要给出空泛且无主体的建议，也不要引入新论点。' },
  ],
  small: [
    { name: '第一段：写作目的', purpose: '按题干身份关系确定语域，用一到两句直接说明来意。', avoid: '不要长篇寒暄，也不要把三段的内容都挤进第一段。' },
    { name: '第二段：事项展开', purpose: '逐条落实题干要求的具体任务，如时间、地点、安排、理由或请求。', avoid: '不要漏掉题干任一项要求，也不要添加题干没有要求的事项。' },
    { name: '第三段：礼貌收束', purpose: '致谢、期待回复或号召参与，并保证称呼与落款格式完整。', avoid: '不要签真实姓名，通知类不使用书信落款。' },
  ],
};

/** 句子功能的语言标记。顺序即优先级：越靠前越具体。 */
const SENTENCE_MARKERS = [
  // 展望标记必须排在建议之前：收尾句常同时含 should 与展望措辞。
  { role: 'outlook', label: '展望收束', pattern: /hopefully|in\s+the\s+(?:years|future)|will\s+be\s+promising|will\s+continue|bear\s+in\s+mind|to\s+conclude|in\s+a\s+nutshell|only\s+in\s+this\s+way|for\s+lasting|in\s+this\s+manner/i, tracks: ['chart', 'picture', 'small'] },
  { role: 'caption-reading', label: '图中文字解读', pattern: /\bcaption\b|characters?\s+(?:can\s+be\s+noticed|say|read|interpret)/i, tracks: ['picture'] },
  { role: 'theme-statement', label: '寓意点题', pattern: /(?:cartoon|picture|drawing|material)\s+(?:is|aims|intends|conveys|reveals|reflects|tells)|message\s+it\s+conveys|what\s+is\s+reflected|symbolizes|thought-provoking/i, tracks: ['picture'] },
  { role: 'scene-description', label: '客观描图', pattern: /^(?:in|inside|on|at|in\s+the\s+(?:left|right)|first\s+of\s+all|to\s+begin\s+with)\b.*(?:there\s+(?:is|are)|we\s+can\s+see|can\s+be\s+seen)|there\s+(?:is|are)\s+/i, tracks: ['picture'] },
  { role: 'chart-overview', label: '图表引入', pattern: /(?:given\s+is|this\s+is\s+a|the\s+(?:chart|table|graph|figure)\s+(?:above\s+)?(?:shows?|presents?|illustrates?|indicates?|describes?|reveals?))/i, tracks: ['chart'] },
  { role: 'transition-question', label: '原因设问', pattern: /\?\s*$|what\s+(?:has\s+)?results?(?:ed)?\s+in|what\s+caused/i, tracks: ['chart', 'picture'] },
  { role: 'summary-judgement', label: '总体判断', pattern: /^(?:there\s+is\s+a\s+significant|it\s+is\s+clear|obviously|apparently|in\s+general|overall|generally|not\s+surprisingly)/i, tracks: ['chart', 'picture'] },
  { role: 'cause-analysis', label: '原因分析', pattern: /because|since|due\s+to|owing\s+to|result(?:s|ed)?\s+from|attribut|stem\s+from|relates?\s+to|comes?\s+(?:primarily\s+)?from|reason/i, tracks: ['chart', 'picture', 'small'] },
  { role: 'impact-analysis', label: '影响分析', pattern: /lead(?:s|ing)?\s+to|result(?:s|ing)?\s+in|consequen|impact|influence|bring\s+(?:us|them|about)|enable|contribut/i, tracks: ['chart', 'picture', 'small'] },
  { role: 'advice', label: '建议措施', pattern: /should|ought\s+to|must|it\s+is\s+(?:advisable|essential|necessary|high\s+time)|are\s+supposed\s+to|take\s+(?:actions?|measures?|steps?)|need\s+to/i, tracks: ['chart', 'picture', 'small'] },
  { role: 'purpose', label: '写作目的', pattern: /i\s+am\s+writing|on\s+behalf\s+of|we\s+are\s+looking\s+for|this\s+is\s+to\s+(?:inform|announce)|i\s+would\s+like\s+to/i, tracks: ['small'] },
  { role: 'requirement-detail', label: '事项说明', pattern: /(?:are|is)\s+(?:required|expected|preferred|organized|scheduled)|please\s+|candidates?|应/i, tracks: ['small'] },
  { role: 'politeness', label: '礼貌收束', pattern: /thank|look(?:ing)?\s+forward|appreciate|feel\s+free|contact\s+(?:us|me)|welcome/i, tracks: ['small'] },
];

const SIGNATURE_PATTERN = /^(?:li\s+ming|zhang\s+wei|students?'?\s+union|yours\s+sincerely|the\s+students'?\s+union|postgraduates'?\s+association)/i;

function splitSentences(value) {
  return text(value).match(/[^.!?]+(?:[.!?]+["'”]?|$)/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function trackOfExam(exam) {
  if (exam.section === 'small') return 'small';
  return TRACK_BY_ESSAY_TYPE[text(exam.essayType)] ?? 'picture';
}

/**
 * 依据段落位置与语言标记推导句子功能。
 * 数据描述必须真的引用了图表原始数据，否则含年龄、年份的分析句会被误判成数据句。
 */
function classifySentence(sentence, { track, paragraphIndex, paragraphCount, sentenceIndex, sentenceCount, citesChartValue }) {
  if (SIGNATURE_PATTERN.test(sentence) && words(sentence) <= 5) {
    return { role: 'signature', label: '格式落款' };
  }
  const isLastParagraph = paragraphIndex === paragraphCount - 1;
  const isLastSentence = sentenceIndex === sentenceCount - 1;
  // 首段引用了原始数据即为数据描述；后续段落即便出现数字也优先按论证功能判定。
  if (track === 'chart' && citesChartValue && paragraphIndex === 0) {
    return { role: 'data-point', label: '数据描述' };
  }
  for (const marker of SENTENCE_MARKERS) {
    if (!marker.tracks.includes(track)) continue;
    // 收尾段不再把概括句判成数据段总结。
    if (marker.role === 'summary-judgement' && isLastParagraph) continue;
    if (marker.pattern.test(sentence)) return { role: marker.role, label: marker.label };
  }
  if (track === 'chart' && citesChartValue) return { role: 'data-point', label: '数据描述' };
  if (isLastParagraph && isLastSentence) return { role: 'outlook', label: '展望收束' };
  if (paragraphIndex === 0) return track === 'chart' ? { role: 'data-point', label: '数据描述' } : { role: 'scene-description', label: '客观描图' };
  if (paragraphIndex === 1) return { role: 'cause-analysis', label: '原因分析' };
  return { role: 'advice', label: '建议措施' };
}

/** 为句子功能生成「为什么这样写」的确定性解释。 */
function explainRole(role, context) {
  const { paragraphIndex, paragraphCount, factNote } = context;
  const position = paragraphIndex === 0 ? '开篇段' : paragraphIndex === paragraphCount - 1 ? '收尾段' : '主体段';
  const explanations = {
    'chart-overview': `${position}第一句先交代图表形式与统计主体，读者才知道后面的数字在讲什么。`,
    'data-point': '这句把图表数据落到文字上。只挑最大值、最小值和显著对比来写，避免把整张表读一遍。',
    'summary-judgement': paragraphIndex === 0
      ? '这句用一句概括收住数据段，把零散数字提炼成一个可被下一段追问的结论。'
      : '这句用一句概括收住本段论证，把前面的分析提炼成明确结论。',
    'transition-question': '这句用设问承接上文数据并自然转入原因，避免段落之间硬切。',
    'cause-analysis': '这句解释现象的成因，属于合理推断而不是题面事实，所以用推测性措辞而非断言。',
    'impact-analysis': '这句把原因推进到影响层面，让论证从「为什么」延伸到「所以怎样」。',
    'scene-description': `${position}先做客观描图，只写画面里真实存在的环境、人物和动作，这是后续立论的事实基础。`,
    'caption-reading': '这句读出图中文字，考研图画题的文字标注往往直接点明命题意图，必须写进去。',
    'theme-statement': '这句从画面过渡到寓意，是图画作文得分的关键一跳：没有它，描图就成了无主题的复述。',
    advice: `${position}给出可执行建议，需要明确行动主体，否则会写成空泛口号。`,
    outlook: '这句用条件句或价值判断收束全文，既呼应主题又避免结尾突然中断。',
    purpose: '小作文第一段必须直接说明来意，阅卷人首先确认的就是写作目的是否清楚。',
    'requirement-detail': '这句落实题干要求的具体事项，小作文的分数主要来自任务是否逐条完成。',
    politeness: '这句完成礼貌收束，符合应用文的语域要求。',
    signature: '这是格式落款，按考研要求使用规定署名，不写真实姓名。',
  };
  const base = explanations[role] ?? '这句承接上文，继续推进本段的核心功能。';
  return factNote ? `${base}${factNote}` : base;
}

/** 用骨架库反查这句可以对应哪些讲义功能句。 */
function matchSkeletons(sentence, { track, role }, skeletonsByTrack) {
  const candidates = skeletonsByTrack.get(track) ?? [];
  const lower = sentence.toLowerCase();
  const scored = [];
  for (const skeleton of candidates) {
    const template = text(skeleton.en);
    // 用骨架固定部分（去掉占位符）的长词做重叠打分，避免占位符干扰。
    const anchors = template
      .replace(/\{[^}]*\}/g, ' ')
      .toLowerCase()
      .match(/[a-z][a-z'-]{4,}/g) ?? [];
    if (anchors.length < 3) continue;
    const hits = anchors.filter((anchor) => lower.includes(anchor)).length;
    const ratio = hits / anchors.length;
    if (hits >= 3 && ratio >= 0.25) scored.push({ skeleton, hits, ratio });
  }
  scored.sort((a, b) => b.ratio - a.ratio || b.hits - a.hits);
  return scored.slice(0, 2).map(({ skeleton, ratio }) => {
    const ref = array(skeleton.sourceRefs)[0] ?? {};
    return {
      skeletonId: skeleton.id,
      en: text(skeleton.en),
      zh: text(skeleton.zh),
      similarity: Math.round(ratio * 100),
      source: { label: text(ref.source), page: ref.page ?? null, pageTitle: text(ref.pageTitle) },
    };
  });
}

/** 题面事实提示：图表句提示可用数据，图画句提示画面事实，小作文提示任务项。 */
function factNoteFor(role, sentence, facts) {
  if (role === 'data-point' || role === 'chart-overview') {
    // 只把能对上原始数据的数字算作「引用数据」；年龄、年份等标签数字不计入。
    const valueSet = new Set(facts.chartValues.flatMap((value) => extractChartNumbers(value).map((token) => token.value)));
    const used = extractChartNumbers(sentence)
      .filter((token) => valueSet.has(token.value))
      .map((token) => token.raw);
    if (used.length) return `本句引用的图表数据：${used.join('、')}。`;
    if (facts.chartValues.length) return `本段可引用的原始数据：${facts.chartValues.slice(0, 4).join('、')} 等。`;
    return '';
  }
  if (role === 'scene-description' || role === 'caption-reading') {
    return facts.caption ? `题图文字：${facts.caption}。` : '';
  }
  return '';
}

function buildFacts(exam) {
  const analysis = referenceAnalysis(exam) ?? {};
  const chart = analysis.chartData ?? {};
  return {
    chartValues: array(chart.dataPoints).map((point) => text(point.value)).filter(Boolean),
    chartRows: array(chart.dataPoints).map((point) => `${text(point.label)}: ${text(point.value)}`),
    caption: text(analysis.chineseText),
    themeGuess: text(analysis.themeGuess),
    keyContrasts: array(chart.keyContrasts).map(text).filter(Boolean),
  };
}

function moduleCoverage(track, paragraphs) {
  const trackInfo = getTrack(track);
  const covered = new Set(paragraphs.flatMap((paragraph) => array(paragraph.modules).map(text)));
  return array(trackInfo?.modules).map((module) => ({
    id: module.id,
    label: module.label,
    required: module.required,
    covered: covered.has(module.id),
  }));
}

/** 句子功能到写作模块的映射，用于"这句由哪个模块组装"的模块流程条。 */
const ROLE_TO_MODULE = {
  chart: {
    'chart-overview': 'chart-introduction',
    'data-point': 'chart-data',
    'summary-judgement': 'chart-data',
    'transition-question': 'chart-question',
    'cause-analysis': 'chart-reasons',
    'impact-analysis': 'chart-reasons',
    advice: 'chart-advice',
    outlook: 'chart-outlook',
  },
  picture: {
    'scene-description': 'picture-scene',
    'caption-reading': 'picture-scene',
    'theme-statement': 'picture-theme',
    'summary-judgement': 'picture-theme',
    'transition-question': 'picture-argument',
    'cause-analysis': 'picture-argument',
    'impact-analysis': 'picture-argument',
    advice: 'picture-advice',
    outlook: 'picture-outlook',
  },
  small: {
    purpose: 'small-purpose',
    'requirement-detail': 'small-details',
    'cause-analysis': 'small-support',
    'impact-analysis': 'small-support',
    advice: 'small-support',
    politeness: 'small-politeness',
    outlook: 'small-politeness',
    signature: 'small-format',
  },
};

function moduleIdForRole(track, role) {
  return ROLE_TO_MODULE[track]?.[role] ?? null;
}

/**
 * 按轨道的 6 个模块生成"模块流程条"：
 * 每个模块显示由哪几句承担、是否缺失，缺失时给出可执行的补写建议。
 */
function buildModuleFlow(track, paragraphs) {
  const trackInfo = getTrack(track);
  const byModule = new Map();
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.sentences) {
      const moduleId = moduleIdForRole(track, sentence.role);
      if (!moduleId) continue;
      if (!byModule.has(moduleId)) byModule.set(moduleId, []);
      byModule.get(moduleId).push({ paragraph: paragraph.index, index: sentence.index, roleLabel: sentence.roleLabel });
    }
  }
  return array(trackInfo?.modules).map((module) => {
    const hits = byModule.get(module.id) ?? [];
    return {
      id: module.id,
      label: module.label,
      description: module.description,
      order: module.order,
      required: module.required,
      covered: hits.length > 0,
      sentences: hits,
      suggestion: hits.length
        ? ''
        : module.required
          ? `本篇缺少「${module.label}」，建议补一句承担该功能：${module.description}`
          : `可选模块「${module.label}」未使用，如需更完整可补写：${module.description}`,
    };
  });
}

async function skeletonIndex() {
  const kb = await loadWritingKnowledge();
  const byTrack = new Map();
  const byId = new Map();
  for (const skeleton of kb.skeletons) {
    byId.set(skeleton.id, skeleton);
    if (skeleton.productionEligible !== true) continue;
    const key = text(skeleton.conflictGroup).split(':')[0];
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push(skeleton);
  }
  return { byTrack, byId };
}

/** 离线行文解析，永远可用。 */
export async function analyzeExamEssay(examId) {
  const exam = await examDetail(text(examId));
  if (!exam) throw Object.assign(new Error(`未找到题目：${examId}`), { status: 404, code: 'exam_not_found' });
  const track = trackOfExam(exam);
  const trackInfo = getTrack(track);
  const { byTrack: skeletonsByTrack } = await skeletonIndex();

  const modelParagraphs = array(exam.modelEssay?.paragraphs);
  const hasModelEssay = modelParagraphs.length > 0;
  const facts = buildFacts(exam);
  const blueprint = PARAGRAPH_BLUEPRINT[track] ?? [];

  const paragraphs = modelParagraphs.map((paragraph, paragraphIndex) => {
    const sentences = array(paragraph.sentences).length
      ? array(paragraph.sentences).map((item) => text(item.text ?? item))
      : splitSentences(paragraph.text);
    const chartValueSet = new Set(facts.chartValues.flatMap((value) => extractChartNumbers(value).map((token) => token.value)));
    const analyzed = sentences.filter(Boolean).map((sentence, sentenceIndex) => {
      const classification = classifySentence(sentence, {
        track,
        paragraphIndex,
        paragraphCount: modelParagraphs.length,
        sentenceIndex,
        sentenceCount: sentences.length,
        citesChartValue: extractChartNumbers(sentence).some((token) => chartValueSet.has(token.value) && token.percent),
      });
      const factNote = factNoteFor(classification.role, sentence, facts);
      return {
        index: sentenceIndex + 1,
        text: sentence,
        words: words(sentence),
        role: classification.role,
        roleLabel: classification.label,
        why: explainRole(classification.role, {
          paragraphIndex,
          paragraphCount: modelParagraphs.length,
          factNote,
        }),
        factNote,
        skeletons: matchSkeletons(sentence, { track, role: classification.role }, skeletonsByTrack),
      };
    });
    const plan = blueprint[Math.min(paragraphIndex, blueprint.length - 1)] ?? null;
    return {
      index: paragraphIndex + 1,
      name: plan?.name ?? `第${paragraphIndex + 1}段`,
      purpose: plan?.purpose ?? '',
      avoid: plan?.avoid ?? '',
      modules: array(paragraph.modules).map((id) => ({ id: text(id), label: getModule(text(id))?.label ?? text(id) })),
      words: analyzed.reduce((sum, item) => sum + item.words, 0),
      sentences: analyzed,
    };
  });

  const totalWords = paragraphs.reduce((sum, paragraph) => sum + paragraph.words, 0);
  return {
    exam: {
      id: exam.id,
      year: exam.year,
      examType: exam.examType,
      section: exam.section,
      essayType: exam.essayType,
      directions: text(exam.directions),
      image: exam.image ?? null,
    },
    track: { id: track, label: trackInfo?.label ?? track, description: trackInfo?.description ?? '' },
    source: 'examModelEssay',
    hasModelEssay,
    blueprint,
    facts,
    paragraphs,
    totalWords,
    wordDistribution: paragraphs.map((paragraph) => ({ index: paragraph.index, words: paragraph.words, percent: totalWords ? Math.round((paragraph.words / totalWords) * 100) : 0 })),
    moduleCoverage: moduleCoverage(track, modelParagraphs),
    moduleFlow: buildModuleFlow(track, paragraphs),
    notes: hasModelEssay ? [] : ['本题暂无已校对范文，仅提供题型结构解析；不会凭空生成范文。'],
    aiInsight: null,
  };
}

const CATEGORY_TO_TRACK = { 图表作文: 'chart', 大作文: 'picture', 小作文: 'small' };

/**
 * 解析刚生成的作文。
 *
 * 与真题解析共用同一套功能判定与段落骨架，但骨架引用优先采用成文时
 * 实际绑定的 skeletonId（精确来源），只在没有绑定时才回退到文本反查。
 */
export async function analyzeComposedEssay({ essay, classification, facts: promptFacts, question } = {}) {
  const paragraphsInput = array(essay?.paragraphs);
  if (!paragraphsInput.length) {
    throw Object.assign(new Error('缺少作文内容，无法解析行文。'), { status: 400, code: 'essay_required' });
  }
  const category = text(classification?.category ?? classification?.final?.category);
  const track = CATEGORY_TO_TRACK[category] ?? 'picture';
  const trackInfo = getTrack(track);
  const { byTrack: skeletonsByTrack, byId: skeletonById } = await skeletonIndex();
  const blueprint = PARAGRAPH_BLUEPRINT[track] ?? [];

  const chartValues = array(promptFacts?.chart?.dataPoints).map((point) => text(point.value)).filter(Boolean);
  const facts = {
    chartValues,
    chartRows: array(promptFacts?.chart?.dataPoints).map((point) => `${text(point.label)}: ${text(point.value)}`),
    caption: text(promptFacts?.caption),
    themeGuess: text(promptFacts?.classification?.keyPhrase),
    keyContrasts: array(promptFacts?.chart?.trend).map(text).filter(Boolean),
  };
  const chartValueSet = new Set(chartValues.flatMap((value) => extractChartNumbers(value).map((token) => token.value)));

  const paragraphs = paragraphsInput.map((paragraph, paragraphIndex) => {
    // 成文结果里 sentences 与 sentenceSources 一一对应，可拿到精确骨架绑定。
    const sentences = array(paragraph.sentences).map(text).filter(Boolean);
    const sources = array(paragraph.sentenceSources);
    const analyzed = sentences.map((sentence, sentenceIndex) => {
      const classificationResult = classifySentence(sentence, {
        track,
        paragraphIndex,
        paragraphCount: paragraphsInput.length,
        sentenceIndex,
        sentenceCount: sentences.length,
        citesChartValue: extractChartNumbers(sentence).some((token) => chartValueSet.has(token.value) && token.percent),
      });
      const factNote = factNoteFor(classificationResult.role, sentence, facts);
      const boundId = text(sources[sentenceIndex]?.skeletonId);
      const bound = boundId ? skeletonById.get(boundId) : null;
      const skeletons = bound
        ? [{
          skeletonId: bound.id,
          en: text(bound.en),
          zh: text(bound.zh),
          similarity: 100,
          exact: true,
          source: (() => {
            const ref = array(bound.sourceRefs)[0] ?? {};
            return { label: text(ref.source), page: ref.page ?? null, pageTitle: text(ref.pageTitle) };
          })(),
        }]
        : matchSkeletons(sentence, { track, role: classificationResult.role }, skeletonsByTrack);
      return {
        index: sentenceIndex + 1,
        text: sentence,
        words: words(sentence),
        role: classificationResult.role,
        roleLabel: classificationResult.label,
        moduleId: moduleIdForRole(track, classificationResult.role),
        moduleLabel: getModule(moduleIdForRole(track, classificationResult.role))?.label ?? '',
        why: explainRole(classificationResult.role, {
          paragraphIndex,
          paragraphCount: paragraphsInput.length,
          factNote,
        }),
        factNote,
        // 没有套用讲义模板时如实说明，不虚构来源。
        templateNote: bound ? '' : (skeletons.length ? '与讲义模板高度相似，供对照参考' : '本句未套用讲义模板，由内容规划直接实现'),
        skeletons,
      };
    });
    const plan = blueprint[Math.min(paragraphIndex, blueprint.length - 1)] ?? null;
    const moduleIds = [...new Set(analyzed.map((item) => item.moduleId).filter(Boolean))];
    return {
      index: paragraphIndex + 1,
      name: plan?.name ?? text(paragraph.name) ?? `第${paragraphIndex + 1}段`,
      purpose: plan?.purpose ?? '',
      avoid: plan?.avoid ?? '',
      modules: moduleIds.map((id) => ({ id, label: getModule(id)?.label ?? id })),
      words: analyzed.reduce((sum, item) => sum + item.words, 0),
      sentences: analyzed,
    };
  });

  const totalWords = paragraphs.reduce((sum, paragraph) => sum + paragraph.words, 0);
  const usedSkeletonIds = [...new Set(paragraphs.flatMap((paragraph) => paragraph.sentences
    .filter((sentence) => sentence.skeletons[0]?.exact)
    .map((sentence) => sentence.skeletons[0].skeletonId)))];
  return {
    exam: { id: null, year: null, examType: null, section: null, essayType: null, directions: text(question), image: null },
    track: { id: track, label: trackInfo?.label ?? track, description: trackInfo?.description ?? '' },
    source: 'composedEssay',
    hasModelEssay: true,
    blueprint,
    facts,
    paragraphs,
    totalWords,
    wordDistribution: paragraphs.map((paragraph) => ({ index: paragraph.index, words: paragraph.words, percent: totalWords ? Math.round((paragraph.words / totalWords) * 100) : 0 })),
    moduleCoverage: moduleCoverage(track, paragraphs.map((paragraph) => ({ modules: paragraph.modules.map((item) => item.id) }))),
    moduleFlow: buildModuleFlow(track, paragraphs),
    usedSkeletonIds,
    notes: [],
    aiInsight: null,
  };
}

const AI_SYSTEM = `你是考研英语作文行文讲解老师。输入包含题干、已校对范文和逐句离线解析结论。
只允许在既有结论基础上补充讲解：解释句间衔接、为什么这个顺序更容易得分、考生常见写反的地方。
严禁新增范文没有的句子、严禁编造讲义页码、严禁改写离线结论中的功能判定。
严格返回 JSON：{"summary":"整体行文思路（中文，120字内）","paragraphNotes":[{"index":1,"note":"该段补充讲解"}],"pitfalls":["常见易错点"]}`;

/** AI 深化层。无 Key、超时或返回不合规时静默回退。 */
export async function deepenAnalysis(analysis, { chatJsonImpl } = {}) {
  if (!analysis?.hasModelEssay) return analysis;
  const impl = typeof chatJsonImpl === 'function' ? chatJsonImpl : chatJson;
  try {
    const response = await impl({
      tier: 'reasoning',
      system: AI_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          directions: analysis.exam.directions,
          track: analysis.track,
          paragraphs: analysis.paragraphs.map((paragraph) => ({
            index: paragraph.index,
            name: paragraph.name,
            sentences: paragraph.sentences.map((sentence) => ({ text: sentence.text, role: sentence.roleLabel })),
          })),
        }),
      }],
      temperature: 0.2,
      maxTokens: 2400,
      responseFormat: { type: 'json_object' },
    });
    const raw = response?.data && typeof response.data === 'object' ? response.data : response;
    const summary = text(raw?.summary);
    if (!summary) return analysis;
    const noteByIndex = new Map(array(raw.paragraphNotes)
      .map((item) => [Number(item?.index), text(item?.note)])
      .filter(([index, note]) => Number.isFinite(index) && note));
    return {
      ...analysis,
      paragraphs: analysis.paragraphs.map((paragraph) => ({ ...paragraph, aiNote: noteByIndex.get(paragraph.index) ?? null })),
      aiInsight: { summary, pitfalls: array(raw.pitfalls).map(text).filter(Boolean).slice(0, 6) },
    };
  } catch {
    return analysis;
  }
}

export default { analyzeExamEssay, analyzeComposedEssay, deepenAnalysis, PARAGRAPH_BLUEPRINT };
