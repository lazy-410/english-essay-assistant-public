/**
 * compose v3：骨架作为参考 + AI 成文 + 多轮 AI 修正。
 *
 * 相对 compose-v2 的变化（v2 原样保留作回退）：
 * 1. 写作提示词改为软约束：参考素材是表达库，允许套用 / 改写 / 融合 / 拆句并句；
 *    字数只给“总区间 + 段落建议”，不再逐单元给 min/max 配额；
 * 2. 参考素材层（compose-refs）：骨架候选 + 槽位建议 + 讲义示例 + 方法提醒 + 真题范文；
 * 3. AI 修正链：补写轮 → 语言润色轮 → 范文对照润色轮，每轮都过“底线不退”的接受闸门；
 * 4. 兜底与裁剪：英文安全填充（不再拼接中文 claim）、整句→从句→词三级裁剪、终稿守卫；
 * 5. 检查项扩展：英文纯净 / 范文重合 / 机械化，并如实标记 fallback 块。
 *
 * 设计底线（与 v2 一致，测试依赖这些阶段名与行为）：
 * - 缺可核验视觉事实 → 422 visual_facts_required；
 * - 图表数字只能来自 facts.chart，出现未支持数字 → 422 unsupported_chart_number；
 * - 阶段名保持：classify / plan / skeletons / essay / essay-expanded / essay-contracted /
 *   essay-chart-number-revise / essay-revise-N；新增阶段均以 essay- 前缀补充。
 */

import { chatJson as deepseekChatJson } from './deepseek.mjs';
import { classifyByRules } from './classify.mjs';
import {
  buildPromptFacts,
  buildContentPlan,
  validateContentPlan,
  expandContentPlan,
  acceptedWordBand,
} from './content-plan.mjs';
import { queryWritingSkeletons } from './writing-kb.mjs';
import { inspectChartNumbers, chartNumberGuide, repairMergedChartNumbers } from './chart-numbers.mjs';
import { checkGrammar } from './grammar-check.mjs';
import { detail as examDetail } from './exams.mjs';
import {
  buildReferenceKit,
  collectGuardSentences,
  longestOverlap,
  referenceKitSummary,
  hasCjk,
  hasPlaceholder,
  OVERLAP_LIMIT,
} from './compose-refs.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const text = (v) => v == null ? '' : String(v).trim();
const arr = (v) => Array.isArray(v) ? v : [];
const unique = (v) => [...new Set(arr(v).filter(Boolean).map(text))];
const words = (v) => text(v).split(/\s+/).filter(Boolean).length;
const unwrap = (v) => v?.data && typeof v.data === 'object' ? v.data : v;

function error(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function categoryOf(c = {}) { return c.final?.category ?? c.category ?? ''; }
function targetFor(facts, question) {
  // Directions 中的显式字数优先，兼容英语一“图画+图表”混合题。
  const explicit = text(question).match(/(\d{2,3})\s*[-–~至到]\s*(\d{2,3})\s*words?/i);
  if (explicit) return `${explicit[1]}-${explicit[2]}`;
  const minimum = text(question).match(/(?:at\s+least|no\s+less\s+than|not\s+less\s+than|至少|不少于)\s*(\d{2,3})\s*(?:words?|词)?/i);
  if (minimum) {
    const low = Number(minimum[1]);
    return `${low}-${Math.round(low * 1.1)}（至少${low}）`;
  }
  const approximate = text(question).match(/(?:about|approximately|around|roughly)\s+(\d{2,3})\s*words?/i);
  if (approximate) return `${approximate[1]}-${approximate[1]}`;
  if (facts.category === '小作文') return '90-110';
  if (facts.category === '图表作文') return '180-220';
  return /英语\s*二|english\s*2|180\s*[-–~至到]\s*220/i.test(question) ? '180-220' : '160-200';
}
function rangeFor(facts, question) {
  return Array.isArray(facts.wordBand) ? facts.wordBand : acceptedWordBand(targetFor(facts, question));
}
function lacksVerifiablePictureFacts(facts) {
  if (facts.category !== '大作文') return false;
  const picture = facts.picture || {};
  const scene = text(facts.sceneDescription).toLowerCase();
  const generic = !scene || /^(?:the\s+)?(?:picture|image|drawing|cartoon)\s+(?:shows?|presents?|depicts?)\s+(?:a\s+)?(?:social|common|serious|noteworthy)?\s*(?:problem|phenomenon|issue|scene|situation)\.?$/i.test(scene);
  return !picture.hasFacts || (picture.source !== 'imageAnalysis' && generic);
}
function lacksVerifiableChartFacts(facts) {
  return facts.category === '图表作文' && !facts.chart?.hasFacts;
}
function visualCategoryOf(visual = {}) {
  const category = text(visual.category);
  if (/图表|chart/i.test(category) || visual.chartData?.dataPoints?.length || visual.chartData?.chartType) return '图表作文';
  if (/小作文|应用文|letter|notice|email/i.test(category)) return '小作文';
  if (/大作文|图画|漫画|picture|drawing|cartoon/i.test(category)) return '大作文';
  return null;
}

async function callJson(stage, opts, injected) {
  const call = injected || deepseekChatJson;
  return unwrap(await call({ ...opts, stage }));
}

const CLASSIFY_SYSTEM = `你是考研英语作文题型判定助手。只返回 JSON：{"category":"大作文|图表作文|小作文","subType":null,"letterType":null,"polarity":null,"topicClass":null,"keyPhrase":null,"reason":""}。不得写作文。`;
async function classifyV3(questionText, injected) {
  const rules = classifyByRules(questionText);
  let ai = null;
  try {
    ai = await callJson('classify', {
      tier: 'reasoning', system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: `题目：\n${questionText}` }],
      temperature: 0, maxTokens: 2048,
    }, injected);
  } catch { /* 规则结论仍可工作 */ }
  // 规则层即使给不出结论也能兜底题型；AI 只能补充，不得把已有字段清空。
  const final = { ...rules };
  for (const key of ['subType', 'polarity', 'letterType', 'keyPhrase', 'topicClass', 'reason']) {
    const value = ai?.[key];
    if (value !== undefined && value !== null && text(value)) final[key] = value;
  }
  if (ai && ['大作文', '图表作文', '小作文'].includes(ai.category)) final.category = ai.category;
  if (!['大作文', '图表作文', '小作文'].includes(text(final.category))) throw error('无法判定作文题型。', 400, 'classification_required');
  return { final, rules, ai, conflicts: [], needsConfirm: false };
}

function positionAliases(unit, index) {
  const p = `${unit.paragraph || ''} ${unit.paragraphId || ''}`.toLowerCase();
  const id = `${unit.contentId || ''} ${unit.rhetoricalFunction || ''}`.toLowerCase();
  if (index === 0 || /第一|opening|open|p1|p01/.test(p + id)) return ['opening', 'open', 'p1', 'p01'];
  if (index === 1 || /第二|body|主体|p2|p02|middle/.test(p + id)) return ['body', 'p2', 'p02', 'middle'];
  return ['closing', 'close', 'p3', 'p03', 'ending'];
}
function applicabilityTokens(facts, classification) {
  const c = facts.category;
  if (c === '小作文') return ['small', classification.letterType, classification.polarity].filter(Boolean);
  if (c === '图表作文') return ['chart', facts.classification?.subType === '静态' ? 'static-chart' : 'dynamic-chart', classification.polarity].filter(Boolean);
  const double = /双图|两幅|two\s+(?:pictures|figures)|both\s+pictures/i.test(facts.questionText);
  return ['picture', double ? 'double-picture' : 'single-picture', classification.polarity].filter(Boolean);
}
function hasApp(s, tokens) { return arr(s.applicability).some((a) => tokens.includes(a)); }
function functionSimilar(a, b) {
  const x = text(a).toLowerCase(); const y = text(b).toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const groups = [
    ['observation', 'description', 'introduction', 'opening', 'data-description'],
    ['analysis', 'development', 'reason', 'cause-impact-analysis', 'mechanism'],
    ['impact', 'implication', 'recommendation', 'advice', 'closing', 'outlook', 'action', 'recommendation-outlook'],
    ['purpose', 'introduction'], ['task-fulfillment', 'development'],
  ];
  return groups.some((g) => g.includes(x) && g.includes(y));
}
function polarityOf(s) {
  const groupPolarity = text(s.conflictGroup).split(':').at(-1);
  if (groupPolarity === 'positive' || groupPolarity === 'negative') return groupPolarity;
  const apps = arr(s.applicability);
  if (apps.includes('positive') && !apps.includes('negative')) return 'positive';
  if (apps.includes('negative') && !apps.includes('positive')) return 'negative';
  return text(s.polarity).toLowerCase();
}
function conflictAllowed(s, facts, selected, unit) {
  const p = facts.classification?.polarity === '负面' ? 'negative' : facts.classification?.polarity === '正面' ? 'positive' : '';
  const sp = polarityOf(s);
  if (p && sp && sp !== p) return false;
  // 即使分类未明确褒贬，同一篇也不能同时绑定正面与负面语言骨架。
  const selectedPolarities = new Set(selected.map(polarityOf).filter((value) => value === 'positive' || value === 'negative'));
  if (sp === 'positive' && selectedPolarities.has('negative')) return false;
  if (sp === 'negative' && selectedPolarities.has('positive')) return false;
  const subtype = facts.classification?.subType;
  if (facts.category === '图表作文' && subtype === '静态' && arr(s.applicability).includes('dynamic-chart')) return false;
  if (facts.category === '图表作文' && subtype === '动态' && arr(s.applicability).includes('static-chart')) return false;
  const mode = /双图|两幅|two\s+(?:pictures|figures)|both\s+pictures/i.test(facts.questionText) ? 'double-picture' : 'single-picture';
  if (facts.category === '大作文' && arr(s.applicability).includes(mode === 'double-picture' ? 'single-picture' : 'double-picture')) return false;
  if (selected.some((x) => x.conflictGroup && s.conflictGroup && x.conflictGroup === s.conflictGroup)) return false;
  if (selected.some((x) => x.semanticKey && s.semanticKey && x.semanticKey === s.semanticKey)) return false;
  return true;
}
function scoreSkeleton(s, unit, facts, index) {
  const tokens = applicabilityTokens(facts, facts.classification || {});
  const aliases = positionAliases(unit, index);
  const source = `${s.sourceEntryId || ''} ${s.id || ''}`.toLowerCase();
  let score = 0;
  if (hasApp(s, tokens)) score += 35;
  if (arr(s.applicability).includes(facts.category === '小作文' ? facts.classification.letterType : '')) score += 18;
  if (aliases.some((a) => source.includes(a))) score += 22;
  if (functionSimilar(s.rhetoricalFunction, unit.rhetoricalFunction)) score += 22;
  if (text(s.semanticKey).toLowerCase().includes(text(unit.semanticKey).toLowerCase())) score += 5;
  if (s.productionEligible) score += 3;
  return score;
}
function skeletonSource(s) {
  const ref = s.sourceRefs?.[0] || {};
  const sourceInfo = {
    source: ref.source ?? s.source ?? 'writing-kb', sourceLabel: ref.sourceLabel ?? ref.pageTitle ?? '写作知识库',
    page: ref.page ?? s.page ?? null, key: ref.entryId ?? s.sourceEntryId ?? s.id,
    sourceEntryId: s.sourceEntryId ?? ref.entryId ?? null, href: ref.page ? `/pages/p${String(ref.page).padStart(2, '0')}.png` : null,
  };
  return { sourceInfo, sourceEntryId: s.sourceEntryId ?? ref.entryId ?? null };
}

/** 绑定骨架；v3 额外保留完整候选池，供参考素材层与补写轮使用。 */
async function bindSkeletons(plan, facts, classification, injected) {
  const all = await queryWritingSkeletons({ task: applicabilityTokens(facts, classification)[0], productionOnly: true, limit: 2000 });
  const extra = await queryWritingSkeletons({ productionOnly: true, limit: 2000 });
  // extra 是候选不足时的兜底池，但它不带 task，会把只适用小作文的骨架捞进大作文
  // （曾让图表题绑上 applicability:["small"] 的书信骨架）。这里按大小作文隔离，
  // 并剔掉缺 zh/en 的条目 —— 它们无法在逐句来源里如实展示对照。
  const wantSmall = facts.category === '小作文';
  const crossTask = (s) => arr(s.applicability).includes('small') !== wantSmall;
  const pool = [...new Map([...all, ...extra].map((s) => [s.id, s])).values()]
    .filter((s) => !crossTask(s) && text(s.en) && text(s.zh));
  const selected = []; const units = plan.units || plan.paragraphs?.flatMap((p) => p.units) || [];
  const choices = units.map((unit, index) => {
    const candidates = pool.filter((s) => conflictAllowed(s, facts, selected, unit))
      .map((s) => ({ skeleton: s, score: scoreSkeleton(s, unit, facts, index) }))
      .sort((a, b) => b.score - a.score || String(a.skeleton.id).localeCompare(String(b.skeleton.id)))
      .slice(0, 12);
    return { contentId: unit.contentId, rhetoricalFunction: unit.rhetoricalFunction, claim: unit.claim, candidates };
  });
  let modelPicks = [];
  try {
    const out = await callJson('skeletons', {
      tier: 'reasoning', system: '你是英语作文表达骨架绑定器。每个 contentId 至多选择一个候选，只能返回候选中的 skeletonId。严格返回 JSON：{"bindings":[{"contentId":"","skeletonId":""}]}。',
      messages: [{ role: 'user', content: JSON.stringify({ task: '为每个内容单元选择一个表达骨架', facts, plan, choices: choices.map((x) => ({ contentId: x.contentId, candidates: x.candidates.map(({ skeleton: s, score }) => ({ skeletonId: s.id, semanticKey: s.semanticKey, conflictGroup: s.conflictGroup, rhetoricalFunction: s.rhetoricalFunction, applicability: s.applicability, en: s.en, score })) })) }) }],
      temperature: 0, maxTokens: 12000,
    }, injected);
    modelPicks = arr(out?.bindings);
  } catch { /* deterministic fallback */ }
  const used = [];
  const bindings = units.map((unit, index) => {
    const choice = choices[index];
    const requested = modelPicks.find((p) => p.contentId === unit.contentId);
    let found = choice.candidates.find((c) => c.skeleton.id === requested?.skeletonId && conflictAllowed(c.skeleton, facts, used, unit));
    if (!found) found = choice.candidates.find((c) => conflictAllowed(c.skeleton, facts, used, unit));
    if (!found) return { contentId: unit.contentId, skeletonId: null, skeleton: null, candidates: choice.candidates.map((c) => ({ skeletonId: c.skeleton.id, score: c.score })) };
    const s = found.skeleton; used.push(s);
    const source = skeletonSource(s);
    return { contentId: unit.contentId, skeletonId: s.id, semanticKey: s.semanticKey, conflictGroup: s.conflictGroup, score: found.score, skeleton: { id: s.id, en: s.en, zh: s.zh, semanticKey: s.semanticKey, conflictGroup: s.conflictGroup, rhetoricalFunction: s.rhetoricalFunction, applicability: s.applicability, sourceEntryId: source.sourceEntryId, sourceInfo: source.sourceInfo }, candidates: choice.candidates.map((c) => ({ skeletonId: c.skeleton.id, score: c.score })) };
  });
  return { bindings, choices, candidateCounts: choices.map((x) => ({ contentId: x.contentId, count: x.candidates.length })) };
}

function normalizePlanPriorities(plan, facts) {
  const next = JSON.parse(JSON.stringify(plan));
  if (facts.category !== '小作文') {
    const requiredLimits = [2, 2, 1];
    for (let paragraphIndex = 0; paragraphIndex < (next.paragraphs ?? []).length; paragraphIndex += 1) {
      const units = next.paragraphs[paragraphIndex].units ?? [];
      units.forEach((unit, unitIndex) => {
        unit.required = unit.required !== false && unitIndex < (requiredLimits[paragraphIndex] ?? 1);
      });
    }
  }
  next.units = (next.paragraphs ?? []).flatMap((paragraph) => paragraph.units ?? []);
  next.contentUnits = next.units;
  return next;
}

function planPayload(plan) { return { paragraphs: plan.paragraphs, units: plan.units || plan.contentUnits }; }

/* ------------------------------ 提示词（v3 软约束） ------------------------------ */

const WRITE_SYSTEM = `你是考研英语（一/二）作文成文器。输入包含 promptFacts（题干与视觉事实）、contentPlan（要表达的内容单元）、bindings（每个单元选定的表达骨架）、references（可借鉴的表达素材库）与 lengthGuidance（建议字数）。

成文规则，优先级从高到低：
1. 信息底线：contentPlan 的每个内容单元必须且只能对应一个 block，contentId 一一对应，不遗漏、不新增单元；每块只表达该单元的信息点，不重复主题句。
2. 事实底线：只能使用 promptFacts 中的事实。references 里的范文与示例属于别的题目，其中的具体事实、人物、数字一律不可搬用；不得编造题面不存在的画面细节或数据。
3. 图表数字规则：图表作文只能使用 promptFacts.chart.dataPoints / rows / numericPolicy.rawValues 中可核验的原始数字。表格的行列标签与单元值是不同字段：年龄、年份等 labelNumbers 只能用于说明类别，绝不能与相邻百分比拼成新小数（例如不得把 40.0% 和 41—50 岁写成 40.41）。40.0% 与 40% 属于同一数字；由两个数据点计算出的差值只有在句子明确表达 higher/lower/increase/gap/percentage points 等比较关系时才可使用；约数或上下界必须明确写 about/nearly/no more than 等限定。除此之外不要自行创造、四舍五入或补写阿拉伯数字；无法确认时改用定性表达，如 a marked increase 或 a substantial gap。
4. 表达方式：references 是表达库而不是填空模板。骨架可以整句套用（usage=direct）、可以换词/改写/融合（usage=adapted）、也可以完全自主表达（usage=none）。允许拆句与并句；以英语自然、衔接流畅、句式错落为目标，避免多句使用相同开头、避免堆叠同义套话。骨架中的 {...} / [...] 是槽位，必须用题干信息或具体内容替换后输出。
5. 语言：全文必须为英文。禁止出现中文（含中文标点）、禁止出现任何 {...} 或 [...] 占位符、禁止整句照抄 references.modelEssay。claim / evidence 是中文规划，只能被翻译性地表达出来，绝不能照抄。
6. 长度：lengthGuidance 是建议区间而非硬配额。先保证信息完整与语言自然，再靠近建议词数；偏短时在该单元内补充具体解释、因果、影响或例证，偏长时删掉套话、重复意义与冗余修饰。返回前逐词计数。

严格返回 JSON：{"title":null,"date":null,"salutation":null,"signature":null,"paragraphs":[{"name":"","sentenceBlocks":[{"contentId":"","skeletonId":"","usage":"direct|adapted|none","text":""}]}]}。contentId 必须来自输入且唯一。`;

const REVISE_SYSTEM = `你是考研英语作文定向修订器。输入包含当前作文全文（逐句 contentId）、revisedNotes（本次必须解决的问题）与 lengthGuidance。

规则：
1. 不得删除任何 contentId，不得新增内容单元、事实或数字；
2. 只解决 revisedNotes 中列出的问题，其余句子尽量保持原样；
3. 全文必须为英文，禁止中文与 {...} / [...] 占位符，禁止整句照抄 references.modelEssay；
4. 修订后总词数必须落在 lengthGuidance 的目标区间内。

严格返回 JSON：{"paragraphs":[{"name":"","sentenceBlocks":[{"contentId":"","skeletonId":"","usage":"direct|adapted|none","text":""}]}]}。`;

const POLISH_SYSTEM = `你是英语作文润色器，目标是把“模板拼装感”改成自然流畅的考场高分英文。输入包含作文全文、polishNotes（必须解决的问题）、grammarIssues（离线语法检查给出的可疑点）与 references（表达参考）。

规则：
1. 只做语言层面的润色：修正语法、搭配、时态、冠词、介词；消除机械感（相同的句子开头、堆叠的模板句、生硬的连接词）；拆句或并句都可以，长短句错落；
2. 不得删除任何 contentId、不得新增事实 / 数字 / 内容单元，每个信息点的含义保持不变；
3. 全文必须为英文；禁止中文与 {...} / [...] 占位符；禁止整句照抄 references.modelEssay——与范文连续重合超过 8 个词时必须改写；
4. 总词数保持在 lengthGuidance 区间内，最多允许 5% 偏差。

严格返回 JSON：{"paragraphs":[{"name":"","sentenceBlocks":[{"contentId":"","skeletonId":"","usage":"direct|adapted|none","text":""}]}]}。每个 contentId 至多一个 block。`;

const FILL_SYSTEM = `你是英语作文补写器。作文里缺少列出的内容单元，请只为这些 contentId 各写 1-2 句英文：
- 信息点来自该单元的 claim / evidence，优先借用 candidateSkeletons 的表达（可整句套用、可换词改写），也可以自主表达；
- 与前后文（neighbors 给出相邻句子）衔接自然，句式避免与相邻句子雷同；
- 禁止新增其他 contentId、禁止编造事实或阿拉伯数字、禁止中文与 {...} 占位符。

严格返回 JSON：{"blocks":[{"contentId":"","skeletonId":"","usage":"direct|adapted|none","text":""}]}。`;

const GUARD_SYSTEM = `你是英文句子修复器。下列句子命中了终稿守卫问题（中文残留 / 占位符 / 断裂句尾）。逐句重写为完整、自然、干净的英文句子：
- 保留原句的信息点与 contentId；若有中文，把该处含义用英文表达出来；
- {...} / [...] 占位符必须替换成题干信息或具体内容；
- 断裂句尾要补顺，但重写后的句子不得比原句更长（保持或缩短词数）；
- 不得新增事实或阿拉伯数字。禁止整句照抄 references.modelEssay。

严格返回 JSON：{"blocks":[{"contentId":"","text":""}]}。`;

const STITCH_SYSTEM = `下列句子刚被裁剪到目标词数，句尾可能不完整。逐句重写为语法完整、衔接自然的英文句子：
- 只处理列出的 contentId；
- 不新增事实或数字，不改变信息点；
- 重写后每句词数不得超过原句（只能变短或相等），也不得少于原句的 60%。

严格返回 JSON：{"blocks":[{"contentId":"","text":""}]}。`;

/* ------------------------------ 英文安全兜底（A4：不再拼接中文） ------------------------------ */

const SAFE_FALLBACKS = {
  opening: [
    'This issue has drawn increasing public attention in recent years and deserves a closer look.',
    'The situation described above is common enough to raise a question worth discussing.',
    'Recent years have witnessed growing concern about this topic in everyday life.',
    'This topic is closely related to the choices many people make in their daily lives.',
  ],
  analysis: [
    'Several factors may account for this situation, and they deserve careful analysis.',
    'One important reason lies in the changing expectations that people face today.',
    'Part of the explanation can be found in the environment in which people make such choices.',
    'These developments interact with each other and jointly shape the observed pattern.',
    'The trend also reflects a broader shift in how people understand this issue.',
  ],
  closing: [
    'It is therefore advisable to take practical and targeted measures to address the issue.',
    'Individuals and institutions alike should make steady efforts to improve the situation.',
    'With consistent effort, the situation is likely to move in a more constructive direction.',
    'Such joint efforts would benefit both the individuals involved and society as a whole.',
    'Careful action today would make a meaningful difference in the long run.',
  ],
  small: [
    'I would like to explain the relevant details as clearly as possible.',
    'I hope this information is helpful and meets your expectations.',
    'Please feel free to contact me if you need any further information.',
    'I would appreciate it if you could take my request into consideration.',
  ],
};
const CHART_FALLBACKS = [
  'The available figures reveal a clear distribution across the groups shown in the chart, making the overall pattern easy to identify.',
  'A comparison of the listed categories shows that the indicators vary noticeably under different conditions and deserve closer attention.',
  'These contrasts are meaningful because they may reflect differences in needs, choices, experience, and access to relevant opportunities.',
  'One plausible explanation is that changing social conditions and individual priorities influence the pattern recorded in the data.',
  'Access to information, resources, and practical support may also shape the decisions represented by the different categories.',
  'People with different experiences can naturally evaluate the same situation in distinct ways, producing the observed distribution.',
  'The tendency may have practical consequences for the individuals, institutions, and activities connected with the issue.',
  'Relevant parties should therefore examine the needs behind each category instead of relying on one response for every group.',
  'More targeted measures and clearer communication could help address the differences revealed by the available evidence.',
  'Regular observation and timely feedback would make it easier to identify emerging changes and respond before problems grow.',
  'If appropriate efforts are maintained, the situation may gradually move in a more balanced and constructive direction.',
  'In the long run, evidence-based responses can improve individual outcomes while supporting healthier and more sustainable development.',
];

/** 英文安全填充：只产出干净英文，绝不拼接中文 claim / evidence。 */
function createFallbackPicker(facts) {
  const cursors = new Map();
  return function pick(unit) {
    const functionName = text(unit?.rhetoricalFunction).toLowerCase();
    const group = facts.category === '小作文' ? 'small'
      : facts.category === '图表作文' ? 'chart'
        : /recommend|clos|outlook|implication|action|suggest|conclusion/.test(functionName) ? 'closing'
          : /open|observ|descript|introduc/.test(functionName) ? 'opening'
            : 'analysis';
    const pool = group === 'chart' ? CHART_FALLBACKS : SAFE_FALLBACKS[group] ?? SAFE_FALLBACKS.analysis;
    const index = cursors.get(group) ?? 0;
    cursors.set(group, index + 1);
    return pool[index % pool.length];
  };
}

/* ------------------------------ 生成结果归一化 ------------------------------ */

const USAGE_VALUES = new Set(['direct', 'adapted', 'none']);
const STOPWORDS = new Set(['the', 'and', 'that', 'with', 'this', 'from', 'have', 'will', 'shall', 'would', 'could', 'should', 'there', 'their', 'about', 'which', 'while', 'being', 'been', 'were', 'what', 'when', 'where', 'your', 'they', 'them', 'also', 'into', 'onto', 'than', 'then', 'such', 'more', 'most', 'some', 'many', 'much', 'very', 'just', 'even', 'only', 'over', 'under', 'between', 'among', 'other', 'others', 'its', 'his', 'her', 'our', 'not', 'but', 'for', 'are', 'was', 'has', 'had', 'does', 'did', 'can', 'may', 'might', 'must', 'because', 'however', 'therefore']);

function skeletonTokens(skeleton) {
  return text(skeleton?.en).replace(/\{[^{}]{1,40}\}|\[[^\[\]]{1,40}\]/g, ' ')
    .toLowerCase().match(/[a-z']{3,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
}
function essayTokens(value) {
  return text(value).toLowerCase().match(/[a-z']{3,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
}
/** 依据与骨架的重合度推断来源标注，避免模型自述与事实不符。 */
function deriveUsage(blockText, skeleton) {
  if (!skeleton?.en) return 'none';
  const overlap = longestOverlap(blockText, [{ text: skeleton.en, source: 'skeleton' }], { minRun: 5 });
  if (overlap && overlap.length >= 8) return 'direct';
  const skeletonSet = new Set(skeletonTokens(skeleton));
  const blockTokens = essayTokens(blockText);
  if (!skeletonSet.size || !blockTokens.length) return 'none';
  const shared = blockTokens.filter((word) => skeletonSet.has(word)).length;
  const union = new Set([...skeletonSet, ...blockTokens]).size;
  const jaccard = shared / union;
  if (jaccard >= 0.55) return 'direct';
  return 'adapted';
}
function normalizeUsage(value, blockText, binding) {
  const candidate = text(value).toLowerCase();
  if (USAGE_VALUES.has(candidate)) return candidate;
  return binding?.skeletonId ? deriveUsage(blockText, binding.skeleton) : 'none';
}

function unitMap(plan) { return new Map((plan.units || plan.contentUnits || plan.paragraphs?.flatMap((p) => p.units) || []).map((u) => [u.contentId, u])); }

/**
 * 归一化模型输出的作文。
 * 返回 { essay, missingContentIds }：漏块先用英文安全填充占位（标记 fallback），
 * 由后续补写轮替换；确定性兜底绝不拼接中文规划文本。
 */
function normalizeGenerated(raw, plan, bindings, facts) {
  const units = unitMap(plan); const byBinding = new Map(bindings.bindings.map((b) => [b.contentId, b]));
  const sourceParagraphs = arr(raw?.paragraphs); const seen = new Set(); const paragraphs = [];
  for (let i = 0; i < Math.max(3, sourceParagraphs.length, plan.paragraphs?.length || 0); i += 1) {
    const source = sourceParagraphs[i] || {}; const planPara = plan.paragraphs?.[i];
    const normalized = [];
    for (const block of arr(source.sentenceBlocks)) {
      const id = text(block.contentId); const blockText = text(block.text);
      if (!id || !blockText || seen.has(id) || !units.has(id)) continue;
      const binding = byBinding.get(id);
      const skeletonId = text(block.skeletonId) || binding?.skeletonId || null;
      seen.add(id);
      normalized.push({ contentId: id, skeletonId: skeletonId || null, usage: normalizeUsage(block.usage, blockText, binding), text: blockText });
    }
    paragraphs.push({ name: text(source.name) || planPara?.name || `第${i + 1}段`, sentenceBlocks: normalized });
  }
  const pickFallback = createFallbackPicker(facts);
  const missingContentIds = [];
  for (const unit of units.values()) {
    if (seen.has(unit.contentId)) continue;
    const index = Math.max(0, (plan.paragraphs || []).findIndex((p) => p.units?.some((u) => u.contentId === unit.contentId)));
    while (paragraphs.length <= index) paragraphs.push({ name: `第${paragraphs.length + 1}段`, sentenceBlocks: [] });
    const binding = byBinding.get(unit.contentId);
    paragraphs[index].sentenceBlocks.push({
      contentId: unit.contentId,
      skeletonId: binding?.skeletonId || null,
      usage: 'none',
      text: pickFallback(unit),
      fallback: true,
    });
    missingContentIds.push(unit.contentId);
  }
  const out = { title: raw?.title ?? null, date: raw?.date ?? null, salutation: raw?.salutation ?? null, signature: raw?.signature ?? null, paragraphs };
  if (facts.category === '小作文') {
    if (facts.small?.isNotice) { out.title = 'Notice'; out.salutation = null; out.signature = /学生会|Students'? Union/i.test(facts.questionText) ? "The Students' Union" : (out.signature || "The Students' Union"); if (/Yours sincerely|Li Ming/i.test(out.signature)) out.signature = "The Students' Union"; }
    else { out.salutation = out.salutation || `Dear ${facts.addressee || 'Sir or Madam'},`; out.signature = out.signature || 'Yours sincerely,\nLi Ming'; }
  }
  return { essay: out, missingContentIds };
}

function wordBudget(plan, facts) {
  const [low, high] = Array.isArray(facts.wordBand) ? facts.wordBand : acceptedWordBand(facts.targetWords);
  const target = Math.round((low + high) / 2);
  const paragraphWeights = facts.category === '小作文' ? [0.25, 0.55, 0.20] : [0.25, 0.50, 0.25];
  const paragraphs = (plan.paragraphs ?? []).map((paragraph, index) => {
    const weight = paragraphWeights[index] ?? (1 / Math.max(1, plan.paragraphs.length));
    const paragraphTarget = Math.round(target * weight);
    const paragraphMin = Math.max(1, Math.floor(low * weight));
    const paragraphMax = Math.max(paragraphMin, Math.ceil(high * weight));
    const count = Math.max(1, paragraph.units?.length ?? 0);
    return {
      paragraphId: paragraph.paragraphId ?? `p${index + 1}`,
      minWords: paragraphMin,
      targetWords: paragraphTarget,
      maxWords: paragraphMax,
      unitBudgets: (paragraph.units ?? []).map((unit) => ({
        contentId: unit.contentId,
        minWords: Math.max(10, Math.floor(paragraphMin / count)),
        targetWords: Math.max(12, Math.round(paragraphTarget / count)),
        maxWords: Math.max(14, Math.ceil(paragraphMax / count)),
      })),
    };
  });
  return { low, high, target, paragraphs };
}

/** 给写作模型的软性长度建议：只有总区间与段落建议，没有逐单元配额。 */
function lengthGuidance(budget, facts) {
  return {
    totalRange: `${budget.low}-${budget.high} 词`,
    suggestedTarget: `${budget.target} 词左右`,
    examRequirement: facts.targetWords || null,
    paragraphSuggestions: (budget.paragraphs ?? []).map((paragraph) => ({
      paragraphId: paragraph.paragraphId,
      suggestedWords: `${paragraph.minWords}-${paragraph.maxWords}`,
    })),
    note: '建议值只用于把握篇幅：先保证信息完整与语言自然，再靠近目标词数。',
  };
}

function paragraphsSnapshot(essay) {
  return essay.paragraphs.map((paragraph) => ({
    name: paragraph.name,
    sentenceBlocks: paragraph.sentenceBlocks.map((block) => ({ contentId: block.contentId, skeletonId: block.skeletonId, usage: block.usage, text: block.text })),
  }));
}

/**
 * 写作 / 定向修订。currentEssay 存在时走修订提示词（字数与指定问题），否则首次成文。
 * 阶段名沿用 v2：essay、essay-expanded、essay-contracted、essay-revise-N、essay-chart-number-revise。
 */
async function writeDraft(stage, plan, facts, bindings, references, injected, { tier = 'reasoning', currentEssay = null, notes = [], chartNumberRepair = null } = {}) {
  const budget = wordBudget(plan, facts);
  const revision = currentEssay ? {
    currentWords: essayWords(currentEssay),
    currentEssay: paragraphsSnapshot(currentEssay),
    revisedNotes: arr(notes).map(text).filter(Boolean),
    instruction: `当前草稿共 ${essayWords(currentEssay)} 词。${arr(notes).length ? `必须解决：${arr(notes).map(text).filter(Boolean).join('；')}。` : ''}在不删 contentId、不新增事实与内容单元的前提下完成修订，并把总词数落在 ${budget.low}-${budget.high} 词（目标约 ${budget.target} 词）。`,
  } : null;
  let raw = null;
  try {
    raw = await callJson(stage, {
      tier,
      system: revision ? REVISE_SYSTEM : WRITE_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          promptFacts: facts,
          contentPlan: planPayload(plan),
          bindings,
          references,
          lengthGuidance: lengthGuidance(budget, facts),
          revision,
          chartNumberRepair,
        }),
      }],
      temperature: revision ? 0.15 : 0.3,
      maxTokens: 12000,
    }, injected);
  } catch { raw = {}; }
  return normalizeGenerated(raw, plan, bindings, facts);
}

function essayWords(essay) {
  // 与 buildSources/checkEssay 使用同一分句口径；模型偶尔会输出 "sentence.Next"，
  // 直接按空白计数会把两个词误算成一个，导致超限稿跳过最终裁剪。
  return essay.paragraphs
    .flatMap((paragraph) => paragraph.sentenceBlocks.flatMap((block) => splitSentences(block.text)))
    .join(' ').split(/\s+/).filter(Boolean).length;
}
/**
 * 小数点不是句末：87.5% 必须保持完整。用正则按 [.!?] 切会把 "91.3%" 拆成 "91. 3%"，
 * 逐句视图与终稿里就会出现这个怪空格（与 essay-review 的口径保持一致）。
 */
function splitSentences(value) {
  const source = text(value);
  if (!source) return [];
  const out = [];
  let buffer = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    buffer += character;
    if (!'.!?'.includes(character)) continue;
    const before = source[index - 1] ?? '';
    const after = source[index + 1] ?? '';
    if (character === '.' && /\d/.test(before) && /\d/.test(after)) continue;
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

function repairMergedChartArtifacts(essay, chart) {
  const next = JSON.parse(JSON.stringify(essay));
  const replacements = [];
  for (const paragraph of next.paragraphs ?? []) {
    for (const block of paragraph.sentenceBlocks ?? []) {
      const repaired = repairMergedChartNumbers(block.text, chart);
      if (repaired.replacements.length) {
        block.text = repaired.text;
        replacements.push(...repaired.replacements.map((item) => ({ ...item, contentId: block.contentId })));
      }
    }
  }
  return { essay: next, replacements };
}

function buildSources(essay, plan, bindings) {
  const units = unitMap(plan); const byBind = new Map(bindings.bindings.map((b) => [b.contentId, b]));
  // skeletonId 可能来自 AI 补写轮写回的 block，而非该 contentId 的绑定结果；
  // 只取 b.skeleton 会让这类句子出现「有 skeletonId 但 skeleton 为 null」的悬空引用，
  // 逐句来源里就是一行空白对照。这里用候选池按 id 回查兜底。
  const byId = new Map();
  for (const b of bindings.bindings) if (b?.skeleton?.id) byId.set(b.skeleton.id, b.skeleton);
  for (const choice of arr(bindings.choices)) {
    for (const c of arr(choice.candidates)) {
      const sk = c?.skeleton;
      if (sk?.id && !byId.has(sk.id)) byId.set(sk.id, { id: sk.id, en: sk.en, zh: sk.zh, semanticKey: sk.semanticKey, conflictGroup: sk.conflictGroup, rhetoricalFunction: sk.rhetoricalFunction, applicability: sk.applicability, ...skeletonSource(sk) });
    }
  }
  const paragraphs = essay.paragraphs.map((p) => {
    const sentences = []; const sentenceSources = [];
    for (const block of p.sentenceBlocks) for (const sentence of splitSentences(block.text)) {
      const u = units.get(block.contentId); const b = byBind.get(block.contentId);
      const skeletonId = block.skeletonId || b?.skeletonId || null;
      // 优先用该 contentId 的绑定结果；id 不一致时按 id 回查，避免悬空引用
      const s = (b?.skeleton && b.skeleton.id === skeletonId) ? b.skeleton : (skeletonId ? byId.get(skeletonId) ?? b?.skeleton ?? null : null);
      sentences.push(sentence);
      sentenceSources.push({
        contentId: block.contentId, contentUnit: u || null,
        contentSource: { sourceType: u?.sourceType ?? null, evidence: u?.evidence ?? [], factIds: arr(u?.evidence).map((e) => e.factId).filter(Boolean) },
        skeletonId, skeleton: s || null, sourceInfo: s?.sourceInfo || null,
        usage: block.usage ?? 'none',
        polished: Boolean(block.polished),
        fallback: Boolean(block.fallback),
      });
    }
    return { name: p.name, sentences, sentenceSources, sentenceBlocks: p.sentenceBlocks };
  });
  return { ...essay, paragraphs, sentenceSources: paragraphs.flatMap((p) => p.sentenceSources) };
}

/* ------------------------------ 检查与守卫 ------------------------------ */

function repeatedPhrases(value) {
  const tokens = text(value).toLowerCase().match(/[a-z']+/g) ?? [];
  const counts = new Map();
  for (let size = 6; size <= 9; size += 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      const phrase = tokens.slice(i, i + size).join(' ');
      if (!tokens.slice(i, i + size).some((word) => word.length >= 6)) continue;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[0].split(' ').length - a[0].split(' ').length || b[1] - a[1])
    .filter(([phrase], index, all) => !all.slice(0, index).some(([longer]) => longer.includes(phrase)))
    .slice(0, 5)
    .map(([phrase, count]) => `${phrase}（${count}次）`);
}

const DANGLING_TAIL = /\b(?:to|of|and|but|or|with|for|in|on|at|by|as|that|which|who|whom|whose|because|although|while|if|the|a|an|is|are|was|were|be|been|being|will|would|can|could|may|might|must|should|has|have|had|do|does|did|not|very|more|most|than|from|into|onto|about|over|under|between|among|during|after|before|since|until|so|such|their|its|his|her|our|your|my)["'”’]?[.!?]$/i;

/** 断裂特征：句尾没有终止标点，或终止标点前是悬挂的功能词 / 标点。 */
function danglingTail(value) {
  const s = text(value);
  if (!s) return false;
  const trimmed = s.replace(/[)\]}"'”’]+$/, '').trim();
  if (!/[.!?]$/.test(trimmed)) return true;
  if (/[,;:—–-][.!?]$/.test(trimmed)) return true;
  if (DANGLING_TAIL.test(trimmed)) return true;
  if (/[{}\[\]]/.test(s)) return false; // 占位符单独报，不重复计断裂
  return false;
}

/** 终稿守卫：中文残留 / 占位符 / 断裂句尾。 */
function purityViolations(essay) {
  const out = [];
  const inspect = (value, where, contentId, { tail = true } = {}) => {
    const s = text(value);
    if (!s) return;
    if (hasCjk(s)) out.push({ contentId: contentId ?? null, where, type: 'cjk', text: s });
    if (hasPlaceholder(s)) out.push({ contentId: contentId ?? null, where, type: 'placeholder', text: s });
    if (tail && danglingTail(s)) out.push({ contentId: contentId ?? null, where, type: 'broken-tail', text: s });
  };
  for (const paragraph of arr(essay?.paragraphs)) for (const block of arr(paragraph.sentenceBlocks)) inspect(block.text, 'block', block.contentId);
  inspect(essay?.title, 'title', null, { tail: false });
  inspect(essay?.salutation, 'salutation', null, { tail: false });
  inspect(essay?.signature, 'signature', null, { tail: false });
  return out;
}

/** 句式开头重复统计（机械感信号）。 */
function openingStats(fullText) {
  const counts = new Map();
  for (const sentence of splitSentences(fullText)) {
    const tokens = text(sentence).toLowerCase().replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length < 4) continue;
    const key = tokens.slice(0, 3).join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = [...counts.entries()].filter(([, n]) => n >= 2);
  const heavy = groups.filter(([, n]) => n >= 3);
  const duplicates = groups.filter(([, n]) => n === 2).length;
  return {
    heavy: heavy.map(([key, n]) => `${key} 开头 ${n} 次`),
    duplicatePairs: duplicates,
    samples: groups.map(([key, n]) => `${key}（${n}次）`).slice(0, 4),
    pass: heavy.length === 0 && duplicates <= 2,
  };
}

function checkEssay(essay, plan, facts, question, bindings, options = {}) {
  const guardSentences = arr(options?.references?.guardSentences);
  const full = essay.paragraphs.flatMap((p) => p.sentences || p.sentenceBlocks?.map((b) => b.text) || []).join(' ');
  const count = words(full); const [low, high] = rangeFor(facts, question);
  const units = plan.units || plan.contentUnits || []; const used = new Set(essay.paragraphs.flatMap((p) => p.sentenceBlocks.map((b) => b.contentId))); const keys = units.map((u) => u.semanticKey);
  const groups = bindings.bindings.map((b) => b.conflictGroup).filter(Boolean); const duplicate = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);
  const hasChartFacts = facts.category === '图表作文' || Boolean(facts.chart?.hasFacts);
  const numberCheck = hasChartFacts ? inspectChartNumbers(full, facts.chart) : { unsupported: [] };
  const unsupported = numberCheck.unsupported;
  const visual = facts.category !== '大作文' || !facts.missingVisualFacts || !/(picture|image|scene|figure|drawing|cartoon|图|画面|人物|手机|phone|child|man|woman)/i.test(full);
  const repeats = repeatedPhrases(full);
  const violations = purityViolations(essay);
  const mechanical = openingStats(full);
  const overlaps = [];
  if (guardSentences.length) {
    for (const paragraph of essay.paragraphs) {
      for (const block of paragraph.sentenceBlocks ?? []) {
        const hit = longestOverlap(block.text, guardSentences);
        if (hit) overlaps.push({ contentId: block.contentId, length: hit.length, phrase: hit.phrase, source: hit.source, referenceId: hit.id });
      }
    }
  }
  const usageCounts = { direct: 0, adapted: 0, none: 0 };
  let fallbackCount = 0;
  for (const paragraph of essay.paragraphs) for (const block of paragraph.sentenceBlocks ?? []) {
    if (block.usage in usageCounts) usageCounts[block.usage] += 1;
    if (block.fallback) fallbackCount += 1;
  }
  const checks = [
    { name: '词数', pass: count >= low && count <= high, detail: `${count}（目标 ${low}-${high}）` },
    { name: '规划覆盖', pass: units.every((u) => used.has(u.contentId)), detail: `${used.size}/${units.length}` },
    { name: '无明显重复表达', pass: repeats.length === 0, detail: repeats.length ? repeats : '未发现重复的长短语' },
    { name: 'semanticKey重复', pass: duplicate(keys).length === 0, detail: duplicate(keys) },
    { name: 'conflictGroup重复', pass: duplicate(groups).length === 0, detail: duplicate(groups) },
    { name: '事实数字', pass: unsupported.length === 0, detail: unsupported },
    { name: '任务覆盖', pass: facts.category !== '小作文' || arr(facts.small?.tasks).every((t) => units.some((u) => arr(u.taskIds).includes(t.id) && used.has(u.contentId))), detail: '按 taskIds 检查' },
    { name: '视觉事实', pass: visual, detail: facts.missingVisualFacts ? '缺少视觉事实时不得写具体画面' : '通过' },
    { name: '段落数', pass: essay.paragraphs.length === 3, detail: essay.paragraphs.length },
    { name: '英文纯净', pass: violations.length === 0, detail: violations.length ? violations.slice(0, 4).map((v) => `${v.contentId ?? v.where}:${v.type}`) : '无中文 / 占位符 / 断句' },
    { name: '范文重合', pass: overlaps.length === 0, detail: overlaps.length ? overlaps.slice(0, 3).map((o) => `${o.contentId} 连续 ${o.length} 词与${o.source === 'modelEssay' ? '真题范文' : '讲义示例'}重合`) : `最长连续词 ≤${OVERLAP_LIMIT}` },
    { name: '机械化', pass: mechanical.pass, detail: mechanical.pass ? `句式开头重复 ${mechanical.duplicatePairs} 处；直接套用 ${usageCounts.direct} 句 / 改写 ${usageCounts.adapted} 句 / 自创 ${usageCounts.none} 句${fallbackCount ? `；自动补齐 ${fallbackCount} 句` : ''}` : [...mechanical.heavy, ...mechanical.samples] },
    { name: '双层来源', pass: essay.paragraphs.every((p) => (p.sentences?.length ?? 0) === p.sentenceSources.length && p.sentenceSources.every((s) => s.contentUnit && s.contentSource && s.skeletonId !== undefined && Object.hasOwn(s, 'skeleton') && USAGE_VALUES.has(s.usage))), detail: '每句 content + skeleton 来源与来源标注' },
  ];
  if (facts.category === '小作文') checks.push({ name: '小作文格式', pass: facts.small?.isNotice ? essay.title === 'Notice' && !essay.salutation && Boolean(essay.signature) : Boolean(essay.salutation) && Boolean(essay.signature), detail: '格式保留' });
  return {
    words: count, target: [low, high], checks, unsupportedNumbers: unsupported,
    violations, overlaps, mechanical, usageCounts, fallbackBlocks: essay.paragraphs.flatMap((p) => (p.sentenceBlocks ?? []).filter((b) => b.fallback).map((b) => b.contentId)),
    allPass: checks.every((c) => c.pass),
  };
}
function revisionCloser(before, after, target) { const d = (n) => n < target[0] ? target[0] - n : n > target[1] ? n - target[1] : 0; return d(after) < d(before); }

/* ------------------------------ 裁剪（整句 → 从句 → 词） ------------------------------ */

const CLAUSE_BOUNDARY = /(?<=[,;:—–])\s+|\s+(?=(?:and|but|or|which|who|that|because|although|while|when|if|so)\b)/i;
function clausePieces(value) {
  const s = text(value);
  if (!s) return [];
  return s.split(CLAUSE_BOUNDARY).map((piece) => piece.trim()).filter(Boolean);
}
const TRAILING_FUNCTION = /^(?:to|of|and|but|or|with|for|in|on|at|by|as|that|which|who|whom|whose|because|although|while|if|the|a|an|is|are|was|were|be|been|being|will|would|can|could|may|might|must|should|has|have|had|do|does|did|not|very|more|most|than|from|into|onto|about|over|under|between|among|during|after|before|since|until|so|such|their|its|his|her|our|your|my|also|then|thus|hence|therefore)$/i;
/** 去掉尾部悬挂的功能词与标点，避免 "...moving to." 这类断句。 */
function trimDanglingEnd(value) {
  const tokens = text(value).split(/\s+/).filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens.at(-1).replace(/[,;:—–]+$/, '');
    const bare = last.replace(/[^a-zA-Z']/g, '');
    if (!bare || TRAILING_FUNCTION.test(bare)) { tokens.pop(); continue; }
    tokens[tokens.length - 1] = last;
    break;
  }
  return tokens.join(' ');
}
function finalizeTrimmed(value) {
  const s = trimDanglingEnd(value).replace(/[\s,;:—–]+$/, '').trim();
  if (!s) return s;
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * 确定性收尾裁剪：① 删除完整尾句；② 从句级裁剪（逗号/分号/连词边界）；
 * ③ 最后才按词裁剪，且必须保持完整词、去掉悬挂尾词、补上正确终止标点。
 * 每个内容块至少保留十词，裁剪不得跌破下限。
 */
function trimEssayToLimit(essay, limit, minimum = 0) {
  const next = JSON.parse(JSON.stringify(essay));
  const total = () => essayWords(next);
  const trimmedIds = new Set();
  if (total() <= limit) return { essay: next, trimmed: false, trimmedContentIds: [] };

  // ① 优先删完整尾句，但不得一次删到目标下限以下。
  for (let guard = 0; guard < 60 && total() > limit; guard += 1) {
    let target = null;
    const currentTotal = total();
    for (const paragraph of next.paragraphs) {
      for (const block of paragraph.sentenceBlocks) {
        const sentences = splitSentences(block.text);
        if (sentences.length <= 1) continue;
        const removedWords = words(sentences.at(-1));
        if (currentTotal - removedWords < minimum) continue;
        const size = words(block.text);
        if (!target || removedWords <= currentTotal - limit || size > target.size) target = { block, sentences, size, removedWords };
      }
    }
    if (!target) break;
    target.block.text = target.sentences.slice(0, -1).join(' ').trim();
    trimmedIds.add(target.block.contentId);
  }

  // ② 从句级裁剪：从最后一个从句开始删，删完保证是完整子句。
  for (let guard = 0; guard < 60 && total() > limit; guard += 1) {
    const currentTotal = total();
    let target = null;
    for (const paragraph of next.paragraphs) {
      for (const block of paragraph.sentenceBlocks) {
        const pieces = clausePieces(block.text);
        if (pieces.length <= 1) continue;
        const removedWords = words(pieces.at(-1));
        if (currentTotal - removedWords < minimum) continue;
        const size = words(block.text);
        if (!target || removedWords <= currentTotal - limit || size > target.size) target = { block, pieces, size };
      }
    }
    if (!target) break;
    target.block.text = finalizeTrimmed(target.pieces.slice(0, -1).join(' '));
    trimmedIds.add(target.block.contentId);
  }

  // ③ 仍超限时只删除“当前超出量”，并修顺悬挂的词尾。
  for (let guard = 0; guard < 80 && total() > limit; guard += 1) {
    const excess = total() - limit;
    let target = null;
    for (const paragraph of next.paragraphs) {
      for (const block of paragraph.sentenceBlocks) {
        const size = words(block.text);
        const removable = Math.max(0, size - 10);
        if (removable > 0 && (!target || removable > target.removable)) target = { block, size, removable };
      }
    }
    if (!target) break;
    const removeCount = Math.min(excess, target.removable);
    const tokens = text(target.block.text).split(/\s+/).filter(Boolean);
    const kept = tokens.slice(0, Math.max(10, tokens.length - removeCount)).join(' ');
    target.block.text = finalizeTrimmed(kept);
    target.block.trimmed = true;
    trimmedIds.add(target.block.contentId);
  }
  return { essay: next, trimmed: true, trimmedContentIds: [...trimmedIds] };
}

function pruneOptionalContentPlan(plan, excessWords) {
  const next = JSON.parse(JSON.stringify(plan));
  const removedIds = [];
  let removedEstimate = 0;
  const candidates = [];
  for (let paragraphIndex = 0; paragraphIndex < (next.paragraphs ?? []).length; paragraphIndex += 1) {
    const paragraph = next.paragraphs[paragraphIndex];
    for (let unitIndex = 0; unitIndex < (paragraph.units ?? []).length; unitIndex += 1) {
      const unit = paragraph.units[unitIndex];
      if (unit.required === false && paragraph.units.length > 1) {
        candidates.push({ paragraphIndex, unitIndex, unit, estimatedWords: Number(unit.estimatedWords) || 20 });
      }
    }
  }
  candidates.sort((a, b) => b.unitIndex - a.unitIndex || b.estimatedWords - a.estimatedWords);
  for (const candidate of candidates) {
    if (removedEstimate >= Math.max(18, excessWords)) break;
    const paragraph = next.paragraphs[candidate.paragraphIndex];
    const index = paragraph.units.findIndex((unit) => unit.contentId === candidate.unit.contentId);
    if (index < 0 || paragraph.units.length <= 1) continue;
    paragraph.units.splice(index, 1);
    removedIds.push(candidate.unit.contentId);
    removedEstimate += candidate.estimatedWords;
  }
  next.units = (next.paragraphs ?? []).flatMap((paragraph) => paragraph.units ?? []);
  next.contentUnits = next.units;
  next.contracted = removedIds.length > 0;
  next.removedContentIds = removedIds;
  return next;
}

/* ------------------------------ AI 修正链 ------------------------------ */

/** 接受闸门：底线不退才接受新稿（词数在带内必须保持，带外必须更近）。 */
function acceptCandidate(currentCheck, candidateCheck) {
  const failing = (check) => check.checks.filter((item) => !item.pass).length;
  for (const name of ['规划覆盖', '事实数字', '英文纯净']) {
    const before = currentCheck.checks.find((item) => item.name === name);
    const after = candidateCheck.checks.find((item) => item.name === name);
    if (before?.pass && !after?.pass) return false;
  }
  if (failing(candidateCheck) > failing(currentCheck)) return false;
  const [low, high] = currentCheck.target;
  const inside = (n) => n >= low && n <= high;
  const distance = (n) => n < low ? low - n : n > high ? n - high : 0;
  if (inside(currentCheck.words) && !inside(candidateCheck.words)) return false;
  if (distance(candidateCheck.words) > distance(currentCheck.words)) return false;
  return true;
}

/** 把模型返回的块补丁合并进作文（只按 contentId 匹配，未知 id 一律忽略）。 */
function applyBlockPatch(essay, raw, { plan, bindings, markPolished = false, allowFallbackClear = true } = {}) {
  const units = unitMap(plan); const byBinding = new Map(bindings.bindings.map((b) => [b.contentId, b]));
  const patches = new Map();
  const collect = (block) => {
    const id = text(block?.contentId); const value = text(block?.text);
    if (!id || !value || !units.has(id)) return;
    patches.set(id, { text: value, skeletonId: text(block.skeletonId) || null, usage: text(block.usage) });
  };
  for (const paragraph of arr(raw?.paragraphs)) for (const block of arr(paragraph?.sentenceBlocks)) collect(block);
  for (const block of arr(raw?.blocks)) collect(block);
  const next = JSON.parse(JSON.stringify(essay));
  let applied = 0;
  for (const paragraph of next.paragraphs) {
    for (const block of paragraph.sentenceBlocks) {
      const patch = patches.get(block.contentId);
      if (!patch) continue;
      const changed = patch.text !== block.text;
      if (patch.skeletonId) block.skeletonId = patch.skeletonId;
      if (changed) {
        block.text = patch.text;
        block.usage = normalizeUsage(patch.usage, patch.text, byBinding.get(block.contentId));
        if (allowFallbackClear) delete block.fallback;
        if (markPolished) block.polished = true;
        delete block.trimmed;
      }
      if (changed) applied += 1;
    }
  }
  return { essay: next, applied };
}

/** 补写轮：只为缺失 contentId 定向补句，不给全文重写机会。 */
async function fillMissingBlocks(stage, essay, missingContentIds, plan, facts, bindings, references, injected) {
  const units = unitMap(plan); const choices = new Map(arr(bindings.choices).map((choice) => [choice.contentId, choice]));
  const blocks = essay.paragraphs.flatMap((paragraph) => paragraph.sentenceBlocks.map((block) => ({ paragraph: paragraph.name, block })));
  const targets = missingContentIds.map((contentId) => {
    const unit = units.get(contentId) || {};
    const index = blocks.findIndex((item) => item.block.contentId === contentId);
    const neighbors = [
      index > 0 ? blocks[index - 1].block.text : null,
      index >= 0 && index + 1 < blocks.length ? blocks[index + 1].block.text : null,
    ].filter(Boolean);
    return {
      contentId,
      claim: unit.claim ?? '',
      rhetoricalFunction: unit.rhetoricalFunction ?? '',
      evidence: arr(unit.evidence).map((item) => text(item?.text)).filter(Boolean).slice(0, 3),
      candidateSkeletons: arr(choices.get(contentId)?.candidates).slice(0, 4).map(({ skeleton }) => ({ skeletonId: skeleton.id, en: skeleton.en })),
      neighbors,
    };
  });
  let raw = null;
  try {
    raw = await callJson(stage, {
      tier: 'fast', system: FILL_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ promptFacts: facts, missingUnits: targets, references: { modelEssay: references?.modelEssay ?? null } }) }],
      temperature: 0.1, maxTokens: 4000,
    }, injected);
  } catch { return { essay, filled: [] }; }
  const { essay: patched, applied } = applyBlockPatch(essay, raw, { plan, bindings });
  const filled = applied ? missingContentIds.filter((id) => !patched.paragraphs.flatMap((p) => p.sentenceBlocks).find((b) => b.contentId === id)?.fallback) : [];
  return { essay: patched, filled };
}

/**
 * 润色轮（语言 / 范文对照）：整稿逐句润色，返回的块按 contentId 合并。
 * focus === 'reference' 时强调用真题范文与示例校准表达质量。
 */
async function polishPass(stage, essay, plan, facts, bindings, references, injected, { grammarIssues = [], notes = [], focus = 'language', tier = 'reasoning' } = {}) {
  const budget = wordBudget(plan, facts);
  const instruction = focus === 'reference'
    ? '本轮是范文对照润色：用 references 中的真题范文与讲义示例校准表达质量（用词、句式、衔接），重点修掉 polishNotes 指出的机械腔。'
    : '本轮是语言润色：修正 grammarIssues 给出的语法可疑点，并让行文更自然。';
  let raw = null;
  try {
    raw = await callJson(stage, {
      tier, system: POLISH_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          promptFacts: facts,
          contentPlan: planPayload(plan),
          bindings,
          references,
          lengthGuidance: lengthGuidance(budget, facts),
          currentEssay: { words: essayWords(essay), paragraphs: paragraphsSnapshot(essay) },
          polishNotes: arr(notes).map(text).filter(Boolean).slice(0, 8),
          grammarIssues: arr(grammarIssues).slice(0, 12).map((item) => ({ rule: item.rule, quote: item.quote, replacement: item.replacement, why: item.why, confidence: item.confidence })),
          instruction,
        }),
      }],
      temperature: 0.3,
      maxTokens: 12000,
    }, injected);
  } catch { return { essay, applied: 0 }; }
  return applyBlockPatch(essay, raw, { plan, bindings, markPolished: true });
}

/** 缝合润色：裁剪后修补删痕（只能变短或相等，不得跌破下限）。 */
async function stitchTrimmedBlocks(stage, essay, facts, references, injected, { low, high } = {}) {
  const targets = essay.paragraphs.flatMap((paragraph) => paragraph.sentenceBlocks.filter((block) => block.trimmed))
    .map((block) => ({ contentId: block.contentId, text: block.text, words: words(block.text) }));
  if (!targets.length) return { essay, applied: 0 };
  let raw = null;
  try {
    raw = await callJson(stage, {
      tier: 'fast', system: STITCH_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ promptFacts: facts, blocks: targets, limitWords: high, references: { modelEssay: references?.modelEssay ?? null } }) }],
      temperature: 0, maxTokens: 4000,
    }, injected);
  } catch { return { essay, applied: 0 }; }
  const patched = new Map(arr(raw?.blocks).map((block) => [text(block?.contentId), text(block?.text)]));
  const next = JSON.parse(JSON.stringify(essay));
  let applied = 0;
  for (const paragraph of next.paragraphs) {
    for (const block of paragraph.sentenceBlocks) {
      const patchedText = patched.get(block.contentId);
      if (!patchedText || !block.trimmed) continue;
      const before = words(block.text); const after = words(patchedText);
      // 缝合只允许极小的补全增量（≤2 词），并保持信息量；明显变长会破坏裁剪结果。
      if (after > before + 2 || after < Math.floor(before * 0.6)) continue;
      block.text = patchedText;
      delete block.trimmed;
      block.polished = true;
      applied += 1;
    }
  }
  return { essay: next, applied, low, high };
}

/** 终稿守卫修复：定向重写命中守卫的块。 */
async function repairPurityViolations(stage, essay, violations, plan, facts, bindings, references, injected) {
  const byContentId = new Map();
  for (const violation of violations) {
    if (!violation.contentId) continue;
    const entry = byContentId.get(violation.contentId) ?? { contentId: violation.contentId, text: '', issues: new Set() };
    entry.issues.add(violation.type);
    byContentId.set(violation.contentId, entry);
  }
  const blockText = new Map(essay.paragraphs.flatMap((paragraph) => paragraph.sentenceBlocks.map((block) => [block.contentId, block.text])));
  const targets = [...byContentId.values()].map((entry) => ({ contentId: entry.contentId, text: blockText.get(entry.contentId) ?? '', issues: [...entry.issues] }));
  const fieldTargets = violations.filter((violation) => !violation.contentId && violation.where !== 'block').map((violation) => ({ where: violation.where, text: text(essay[violation.where]), issues: [violation.type] }));
  if (!targets.length && !fieldTargets.length) return { essay, applied: 0 };
  let raw = null;
  try {
    raw = await callJson(stage, {
      tier: 'fast', system: GUARD_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ promptFacts: facts, blocks: targets, fields: fieldTargets, references: { modelEssay: references?.modelEssay ?? null } }) }],
      temperature: 0, maxTokens: 4000,
    }, injected);
  } catch { return { essay, applied: 0 }; }
  const next = JSON.parse(JSON.stringify(essay));
  const patches = new Map(arr(raw?.blocks).map((block) => [text(block?.contentId), text(block?.text)]));
  let applied = 0;
  for (const paragraph of next.paragraphs) {
    for (const block of paragraph.sentenceBlocks) {
      const patchedText = patches.get(block.contentId);
      if (!patchedText || patchedText === block.text) continue;
      if (hasCjk(patchedText) || hasPlaceholder(patchedText)) continue; // 修复结果本身不干净则丢弃
      block.text = patchedText;
      const binding = bindings.bindings.find((item) => item.contentId === block.contentId);
      block.usage = normalizeUsage(null, patchedText, binding);
      delete block.fallback;
      block.polished = true;
      applied += 1;
    }
  }
  for (const field of arr(raw?.fields)) {
    const where = text(field?.where); const value = text(field?.text);
    if (!['title', 'salutation', 'signature'].includes(where) || !value) continue;
    if (hasCjk(value) || hasPlaceholder(value)) continue;
    next[where] = value;
    applied += 1;
  }
  return { essay: next, applied };
}

/** 确定性守卫兜底：删掉中文与占位符，修不顺就整块换成英文安全填充。 */
function deterministicPurityFix(essay, plan, facts) {
  const pickFallback = createFallbackPicker(facts);
  const units = unitMap(plan);
  const next = JSON.parse(JSON.stringify(essay));
  const repaired = [];
  const strip = (value) => text(value)
    .replace(/\{[^{}]{1,40}\}|\[[^\[\]]{1,40}\]/g, ' ')
    .replace(/[\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  for (const paragraph of next.paragraphs) {
    for (const block of paragraph.sentenceBlocks) {
      if (!hasCjk(block.text) && !hasPlaceholder(block.text) && !danglingTail(block.text)) continue;
      const cleaned = finalizeTrimmed(strip(block.text));
      if (words(cleaned) >= 8 && !hasCjk(cleaned) && !hasPlaceholder(cleaned) && !danglingTail(cleaned)) {
        block.text = cleaned;
        block.polished = true;
        repaired.push({ contentId: block.contentId, mode: 'stripped' });
        continue;
      }
      block.text = pickFallback(units.get(block.contentId) ?? {});
      block.usage = 'none';
      block.fallback = true;
      repaired.push({ contentId: block.contentId, mode: 'safe-fallback' });
    }
  }
  for (const field of ['title', 'salutation', 'signature']) {
    if (!text(next[field])) continue;
    if (hasCjk(next[field]) || hasPlaceholder(next[field])) { next[field] = null; repaired.push({ where: field, mode: 'cleared' }); }
  }
  return { essay: next, repaired };
}

/* ------------------------------ 编排 ------------------------------ */

async function loadExamEssay(examId) {
  if (!examId) return null;
  try {
    const exam = await examDetail(String(examId));
    if (!exam) return null;
    const raw = Array.isArray(exam.modelEssay) ? exam.modelEssay : arr(exam.modelEssay?.paragraphs);
    const paragraphs = raw.map((paragraph) => Array.isArray(paragraph?.sentences)
      ? paragraph.sentences.map((sentence) => text(sentence?.text ?? sentence)).filter(Boolean).join(' ')
      : text(paragraph?.text ?? paragraph)).filter(Boolean);
    if (!paragraphs.length) return null;
    return { examId: String(exam.id ?? examId), title: text(exam.title ?? exam.prompt ?? exam.directions) || null, paragraphs };
  } catch { return null; }
}

async function maybeDumpDebug(payload) {
  const dir = process.env.EEA_COMPOSE_DEBUG_DIR;
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `compose-v3-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    process.env.EEA_COMPOSE_DEBUG_LAST = file;
  } catch { /* 调试转储失败不影响出稿 */ }
}

export async function composeV3(questionText, { imageAnalysis, onStep, onRound, chatJsonImpl, examId } = {}) {
  const question = text(questionText); if (!question) throw error('题目内容为空。', 400, 'question_required');
  const steps = []; const record = (key, data) => { const step = { key, data }; steps.push(step); onStep?.(step); return step; };
  const diagnostics = { rounds: [], guards: [], fallbackBlocks: [], references: null, calls: 0, aiErrors: 0, aiError: null };
  // 轮次既进诊断（供复盘）也回调（供流式进度显示人话）。
  const note = (name, info = {}) => { diagnostics.rounds.push({ name, ...info }); onRound?.({ name, ...info }); };
  const baseImpl = chatJsonImpl ?? deepseekChatJson;
  // AI 不可用时链路仍要出稿（降级为确定性路径），但必须留下痕迹：
  // 界面据此提示“本次为兜底稿”，诊断 JSON 也能一眼看出是 Key/网络问题而不是内容问题。
  const counted = async (options) => {
    diagnostics.calls += 1;
    try {
      return await baseImpl(options);
    } catch (err) {
      diagnostics.aiErrors += 1;
      diagnostics.aiError ??= { code: err?.code ?? null, status: err?.status ?? null, message: err?.message ?? String(err) };
      throw err;
    }
  };

  const classification = await classifyV3(question, counted);
  const visual = imageAnalysis?.raw ?? imageAnalysis ?? {};
  // 题图/题库校对事实比仅凭 Directions 或模型猜出的题型、主题更可靠。
  const visualCategory = visualCategoryOf(visual);
  if (visualCategory) classification.final.category = visualCategory;
  if (text(visual.themeGuess)) classification.final.keyPhrase = text(visual.themeGuess);
  if (text(visual.subType)) classification.final.subType = text(visual.subType);
  record('classify', { final: classification.final, rules: classification.rules, ai: classification.ai, conflicts: classification.conflicts });
  const facts = buildPromptFacts(question, classification.final, imageAnalysis);
  facts.targetWords = targetFor(facts, question);
  facts.wordBand = acceptedWordBand(facts.targetWords);
  if (lacksVerifiablePictureFacts(facts) || lacksVerifiableChartFacts(facts)) {
    const code = 'visual_facts_required';
    record('facts', { facts, validation: { valid: false, code } });
    throw error(facts.category === '图表作文' ? '图表作文缺少可核验视觉数据，不能猜测图表。' : '图画作文缺少可核验视觉事实，不能猜图。', 422, code);
  }
  record('facts', { facts, validation: { valid: true, warnings: facts.warnings } });
  let plan = await buildContentPlan(facts, classification.final, { chatJson: (opts) => callJson('plan', opts, counted) });
  plan = normalizePlanPriorities(plan, facts);
  plan.targetWords = facts.targetWords; plan.wordBand = facts.wordBand;
  let planValidation = validateContentPlan(plan, facts, classification.final);
  record('plan', { paragraphs: plan.paragraphs, validation: planValidation });
  let bindings = await bindSkeletons(plan, facts, classification.final, counted);
  record('skeletons', { bindings: bindings.bindings, candidateCounts: bindings.candidateCounts });

  // 参考素材层：任何失败都不阻断成文，只是少一层借鉴素材。
  const examEssay = await loadExamEssay(examId);
  let references = null;
  let guardSentences = [];
  try {
    references = await buildReferenceKit(facts, classification.final, {
      examId, choices: bindings.choices, examEssay,
      applicabilityTokens: applicabilityTokens(facts, classification.final),
    });
    const usedSkeletonIds = bindings.bindings.map((binding) => binding.skeletonId).filter(Boolean);
    guardSentences = collectGuardSentences(references, { usedSkeletonIds });
  } catch {
    references = null;
    guardSentences = [];
  }
  diagnostics.references = references ? referenceKitSummary(references) : null;
  record('references', { references: diagnostics.references, examId: examId ?? null });

  const checkOptions = { references: { guardSentences } };
  const referencePayload = references ? {
    policy: references.policy, units: references.units, examples: references.examples,
    methods: references.methods, warnings: references.warnings, modelEssay: references.modelEssay,
  } : null;

  note('write', { tier: 'reasoning' });
  const written = await writeDraft('essay', plan, facts, bindings, referencePayload, counted, { tier: 'reasoning' });
  let out = written.essay;

  // 补写轮：漏块 / 空块定向补写；失败时保留英文安全填充。
  if (written.missingContentIds.length) {
    note('makeup', { missing: written.missingContentIds });
    const filled = await fillMissingBlocks('essay-missing-repair', out, written.missingContentIds, plan, facts, bindings, referencePayload, counted);
    out = filled.essay;
    note('makeup-result', { filled: filled.filled });
  }

  let sourced = buildSources(out, plan, bindings); let check = checkEssay(sourced, plan, facts, question, bindings, checkOptions);
  let expanded = false;
  if (check.words < check.target[0]) {
    let expandedPlan = expandContentPlan(plan, facts, classification.final);
    // 模型规划的 estimatedWords 可能乐观：实际成文仍偏短时，强制增加新的内容维度，
    // 而不是增加同义模板或在原句里空泛重复。
    if ((expandedPlan.units || []).length === (plan.units || []).length) {
      expandedPlan = expandContentPlan(plan, facts, classification.final, {
        force: true,
        minimumAdditionalWords: Math.ceil((check.target[0] - check.words) * 1.6),
      });
    }
    if ((expandedPlan.units || []).length > (plan.units || []).length) {
      plan = expandedPlan;
      plan.targetWords = facts.targetWords;
      plan.wordBand = facts.wordBand;
      planValidation = validateContentPlan(plan, facts, classification.final);
      expanded = true;
      bindings = await bindSkeletons(plan, facts, classification.final, counted);
      note('expand', { units: (plan.units || []).length });
      const rewritten = await writeDraft('essay-expanded', plan, facts, bindings, referencePayload, counted, { tier: 'reasoning' });
      out = rewritten.essay;
      if (rewritten.missingContentIds.length) {
        out = (await fillMissingBlocks('essay-expanded-missing-repair', out, rewritten.missingContentIds, plan, facts, bindings, referencePayload, counted)).essay;
      }
      sourced = buildSources(out, plan, bindings);
      check = checkEssay(sourced, plan, facts, question, bindings, checkOptions);
    }
  }
  if (check.words > check.target[1]) {
    const contractedPlan = pruneOptionalContentPlan(plan, check.words - check.target[1]);
    if ((contractedPlan.units ?? []).length < (plan.units ?? []).length) {
      plan = contractedPlan;
      plan.targetWords = facts.targetWords;
      plan.wordBand = facts.wordBand;
      planValidation = validateContentPlan(plan, facts, classification.final);
      bindings = await bindSkeletons(plan, facts, classification.final, counted);
      note('contract', { removed: plan.removedContentIds ?? [] });
      const rewritten = await writeDraft('essay-contracted', plan, facts, bindings, referencePayload, counted, { tier: 'reasoning' });
      out = rewritten.essay;
      if (rewritten.missingContentIds.length) {
        out = (await fillMissingBlocks('essay-contracted-missing-repair', out, rewritten.missingContentIds, plan, facts, bindings, referencePayload, counted)).essay;
      }
      sourced = buildSources(out, plan, bindings);
      check = checkEssay(sourced, plan, facts, question, bindings, checkOptions);
    }
  }

  let chartNumberRepair = null;
  if (facts.category === '图表作文' && check.unsupportedNumbers.length) {
    const before = [...check.unsupportedNumbers];
    const repaired = await writeDraft('essay-chart-number-revise', plan, facts, bindings, referencePayload, counted, {
      tier: 'fast',
      currentEssay: out,
      notes: ['把未验证数字改为图表原始数据或明确的定性比较', '不要新增任何阿拉伯数字'],
      chartNumberRepair: {
        unsupportedNumbers: before,
        allowedNumbers: chartNumberGuide(facts.chart),
        instruction: '只改写列出的未验证数字所在句子。保留原 contentId、段落和主要含义；将无法由图表数据证明的数字改为原始数据或定性比较。不要新增任何阿拉伯数字。',
      },
    });
    const repairedOut = repaired.essay;
    const repairedSourced = buildSources(repairedOut, plan, bindings);
    const repairedCheck = checkEssay(repairedSourced, plan, facts, question, bindings, checkOptions);
    if (repairedCheck.unsupportedNumbers.length === 0) {
      out = repairedOut;
      sourced = repairedSourced;
      check = repairedCheck;
      chartNumberRepair = { from: before, to: [] };
    }
  }

  // 表格被扁平化时，模型偶尔会把 40.0% 与 41—50 岁拼成 40.41%。
  // 只对“整数部分命中 .0 原始值、后缀命中标签数字”的伪小数做确定性修复。
  // 必须在守卫清理之前执行：终稿守卫的“断裂句尾”兜底会从句尾整块删词，
  // 若数字落在句尾就会连带删掉图表事实，反而制造残句。
  const applyArtifactRepair = () => {
    if (facts.category !== '图表作文' || !check.unsupportedNumbers.length) return false;
    const artifactRepair = repairMergedChartArtifacts(out, facts.chart);
    if (!artifactRepair.replacements.length) return false;
    const artifactSourced = buildSources(artifactRepair.essay, plan, bindings);
    const artifactCheck = checkEssay(artifactSourced, plan, facts, question, bindings, checkOptions);
    if (artifactCheck.unsupportedNumbers.length >= check.unsupportedNumbers.length) return false;
    out = artifactRepair.essay;
    sourced = artifactSourced;
    check = artifactCheck;
    chartNumberRepair = {
      ...(chartNumberRepair ?? {}),
      from: artifactRepair.replacements.map((item) => item.from),
      to: artifactRepair.replacements.map((item) => item.to),
      mode: 'merged-label-value-artifact',
    };
    note('chart-artifact-repair', {
      from: artifactRepair.replacements.map((item) => item.from),
      to: artifactRepair.replacements.map((item) => item.to),
    });
    return true;
  };
  applyArtifactRepair();

  const failedChecks = (result) => result.checks.filter((item) => !item.pass).length;
  // 字数或重复不达标时最多定向修订两轮。每轮都携带当前草稿与明确问题，
  // 只接受更接近目标区间或减少失败项的结果。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const needsRevision = check.words < check.target[0]
      || check.words > check.target[1]
      || check.checks.some((item) => item.name === '无明显重复表达' && !item.pass);
    if (!needsRevision) break;
    const notes = [];
    if (check.words < check.target[0]) notes.push(`当前偏短，需要补充到 ${check.target[0]}-${check.target[1]} 词`);
    if (check.words > check.target[1]) notes.push(`当前偏长，需要压缩到 ${check.target[0]}-${check.target[1]} 词`);
    if (check.checks.some((item) => item.name === '无明显重复表达' && !item.pass)) notes.push('消除重复表达');
    const revised = await writeDraft(`essay-revise-${attempt}`, plan, facts, bindings, referencePayload, counted, { tier: 'fast', currentEssay: out, notes });
    const revisedOut = revised.essay;
    const revisedSourced = buildSources(revisedOut, plan, bindings);
    const revisedCheck = checkEssay(revisedSourced, plan, facts, question, bindings, checkOptions);
    note(`revise-${attempt}`, { words: revisedCheck.words, accepted: acceptCandidate(check, revisedCheck) });
    if (acceptCandidate(check, revisedCheck) && (revisionCloser(check.words, revisedCheck.words, check.target) || failedChecks(revisedCheck) < failedChecks(check))) {
      sourced = revisedSourced; check = revisedCheck; out = revisedOut;
    } else {
      break;
    }
  }

  // 语言润色轮（reasoning）：有离线语法问题、重复表达或机械腔时触发。
  const grammarIssues = (() => {
    try { return checkGrammar(sourced.paragraphs.flatMap((paragraph) => paragraph.sentences).join(' ')); } catch { return []; }
  })();
  const mechanicalFailing = () => check.checks.some((item) => item.name === '机械化' && !item.pass);
  const repeatsFailing = () => check.checks.some((item) => item.name === '无明显重复表达' && !item.pass);
  const polishNotes = () => {
    const notes = [];
    if (repeatsFailing()) notes.push(`消除重复表达：${check.checks.find((item) => item.name === '无明显重复表达').detail.join('；')}`);
    if (mechanicalFailing()) notes.push(`消除机械腔：${check.mechanical.heavy.join('；') || check.mechanical.samples.join('；')}`);
    if (check.fallbackBlocks.length) notes.push(`自动补齐的句子（${check.fallbackBlocks.join('、')}）要改写得更自然`);
    return notes;
  };
  const highConfidenceGrammar = arr(grammarIssues).filter((item) => item.confidence === 'high').slice(0, 6);

  if (highConfidenceGrammar.length || repeatsFailing() || mechanicalFailing()) {
    note('polish-language', { grammarIssues: highConfidenceGrammar.length, repeats: repeatsFailing(), mechanical: mechanicalFailing() });
    const polished = await polishPass('essay-polish-language', out, plan, facts, bindings, referencePayload, counted, {
      grammarIssues: highConfidenceGrammar, notes: polishNotes(), focus: 'language',
    });
    const polishedSourced = buildSources(polished.essay, plan, bindings);
    const polishedCheck = checkEssay(polishedSourced, plan, facts, question, bindings, checkOptions);
    const accepted = polished.applied > 0 && acceptCandidate(check, polishedCheck);
    note('polish-language-result', { applied: polished.applied, accepted, words: polishedCheck.words });
    if (accepted) { out = polished.essay; sourced = polishedSourced; check = polishedCheck; }
  }

  // 范文对照润色轮（reasoning）：有素材时不只做得更"对"，还要更像好范文。
  if (referencePayload && (repeatsFailing() || mechanicalFailing() || referencePayload.modelEssay)) {
    note('polish-reference', { hasModelEssay: Boolean(referencePayload.modelEssay), repeats: repeatsFailing(), mechanical: mechanicalFailing() });
    const polished = await polishPass('essay-polish-reference', out, plan, facts, bindings, referencePayload, counted, {
      grammarIssues: highConfidenceGrammar, notes: polishNotes(), focus: 'reference',
    });
    const polishedSourced = buildSources(polished.essay, plan, bindings);
    const polishedCheck = checkEssay(polishedSourced, plan, facts, question, bindings, checkOptions);
    const accepted = polished.applied > 0 && acceptCandidate(check, polishedCheck);
    note('polish-reference-result', { applied: polished.applied, accepted, words: polishedCheck.words });
    if (accepted) { out = polished.essay; sourced = polishedSourced; check = polishedCheck; }
  }

  // 最后一道确定性保障：模型多轮压缩仍超上限时，按整句 → 从句 → 词三级裁剪到区间内。
  let trimmedToLimit = false;
  if (check.words > check.target[1]) {
    const { essay: trimmed, trimmed: didTrim, trimmedContentIds } = trimEssayToLimit(out, check.target[1], check.target[0]);
    if (didTrim) {
      const trimmedSourced = buildSources(trimmed, plan, bindings);
      const trimmedCheck = checkEssay(trimmedSourced, plan, facts, question, bindings, checkOptions);
      if (trimmedCheck.words <= check.target[1] && trimmedCheck.words >= check.target[0]) {
        out = trimmed; sourced = trimmedSourced; check = trimmedCheck; trimmedToLimit = true;
        note('trim', { words: trimmedCheck.words, blocks: trimmedContentIds });
        // 缝合润色：把删痕修顺；只接受不超上限、不跌破下限的结果。
        const stitched = await stitchTrimmedBlocks('essay-stitch', out, facts, referencePayload, counted, { low: check.target[0], high: check.target[1] });
        if (stitched.applied > 0) {
          const stitchedSourced = buildSources(stitched.essay, plan, bindings);
          const stitchedCheck = checkEssay(stitchedSourced, plan, facts, question, bindings, checkOptions);
          note('stitch-result', { applied: stitched.applied, words: stitchedCheck.words });
          if (acceptCandidate(check, stitchedCheck) && stitchedCheck.words <= check.target[1]) {
            out = stitched.essay; sourced = stitchedSourced; check = stitchedCheck;
          }
        }
      }
    }
  }

  // 终稿守卫：中文残留 / 占位符 / 断裂句尾 → 定向修复（≤2 次）→ 确定性兜底。
  for (let attempt = 1; attempt <= 2 && check.violations.length; attempt += 1) {
    note(`guard-fix-${attempt}`, { violations: check.violations.map((violation) => `${violation.contentId ?? violation.where}:${violation.type}`) });
    const repaired = await repairPurityViolations('essay-guard-fix', out, check.violations, plan, facts, bindings, referencePayload, counted);
    if (!repaired.applied) break;
    const repairedSourced = buildSources(repaired.essay, plan, bindings);
    const repairedCheck = checkEssay(repairedSourced, plan, facts, question, bindings, checkOptions);
    const improved = repairedCheck.violations.length < check.violations.length
      && repairedCheck.words >= check.target[0]
      && repairedCheck.words <= check.target[1];
    if (improved || repairedCheck.violations.length === 0) {
      out = repaired.essay; sourced = repairedSourced; check = repairedCheck;
    } else {
      break;
    }
  }
  if (check.violations.length) {
    const deterministic = deterministicPurityFix(out, plan, facts);
    const fixedSourced = buildSources(deterministic.essay, plan, bindings);
    const fixedCheck = checkEssay(fixedSourced, plan, facts, question, bindings, checkOptions);
    note('guard-deterministic', { repaired: deterministic.repaired, remaining: fixedCheck.violations.length });
    out = deterministic.essay; sourced = fixedSourced; check = fixedCheck;
  }
  diagnostics.guards = check.violations.map((violation) => `${violation.contentId ?? violation.where}:${violation.type}`);
  diagnostics.fallbackBlocks = check.fallbackBlocks;

  // 后续修订轮可能重新引入扁平化伪小数，收尾时再确定性修复一次。
  applyArtifactRepair();

  if (check.unsupportedNumbers.length) throw error(`作文使用了未经图表事实支持的数字：${check.unsupportedNumbers.join(', ')}`, 422, 'unsupported_chart_number');

  record('essay', {
    essay: sourced, check, expandedContentPlan: expanded, trimmedToLimit, chartNumberRepair,
    diagnostics: {
      rounds: diagnostics.rounds,
      guards: diagnostics.guards,
      fallbackBlocks: diagnostics.fallbackBlocks,
      calls: diagnostics.calls,
      aiErrors: diagnostics.aiErrors,
      aiError: diagnostics.aiError,
    },
  });
  const result = {
    question,
    classification: classification.final,
    steps,
    facts,
    plan: { ...plan, validation: planValidation },
    bindings,
    references: diagnostics.references,
    essay: sourced,
    check,
    diagnostics: {
      rounds: diagnostics.rounds,
      guards: diagnostics.guards,
      fallbackBlocks: diagnostics.fallbackBlocks,
      calls: diagnostics.calls,
      aiErrors: diagnostics.aiErrors,
      aiError: diagnostics.aiError,
      references: diagnostics.references,
    },
  };
  await maybeDumpDebug({
    question, classification: classification.final, facts, plan, bindings: bindings.bindings,
    references, essay: sourced, check, diagnostics: result.diagnostics,
  });
  return result;
}

export { checkEssay };
export default { composeV3 };
