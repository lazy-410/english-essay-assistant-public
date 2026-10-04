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
async function classifyV2(questionText, injected) {
  const rules = classifyByRules(questionText);
  let ai = null;
  try {
    ai = await callJson('classify', {
      tier: 'reasoning', system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: `题目：\n${questionText}` }],
      temperature: 0, maxTokens: 2048,
    }, injected);
  } catch { /* 规则结论仍可工作 */ }
  const final = ai && ['大作文', '图表作文', '小作文'].includes(ai.category)
    ? { ...rules, ...ai }
    : { ...rules, topicClass: ai?.topicClass ?? null, keyPhrase: ai?.keyPhrase ?? null, reason: ai?.reason ?? null };
  if (!final.category) throw error('无法判定作文题型。', 400, 'classification_required');
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

async function bindSkeletons(plan, facts, classification, injected) {
  const all = await queryWritingSkeletons({ task: applicabilityTokens(facts, classification)[0], productionOnly: true, limit: 2000 });
  const extra = await queryWritingSkeletons({ productionOnly: true, limit: 2000 });
  // 与 v3 同口径：extra 兜底池不带 task，需按大小作文隔离并剔掉缺 zh/en 的骨架
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
    return { contentId: unit.contentId, candidates };
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
  return { bindings, candidateCounts: choices.map((x) => ({ contentId: x.contentId, count: x.candidates.length })) };
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
const WRITE_SYSTEM = `你是考研英语作文成文器。输入 PromptFacts、ContentPlan 和 skeleton bindings。内容只能来自 content unit 的 claim/evidence；骨架仅为表达参考，可以受控改写。绝不引入题面不存在的视觉事实、图表数字、真题专属人物活动；不得同义重复。

图表数字规则：图表作文只能使用 promptFacts.chart.dataPoints / rows / numericPolicy.rawValues 中能核验的原始数字。表格的行列标签与单元值是不同字段：年龄、年份等 labelNumbers 只能用于说明类别，绝不能与相邻百分比拼成新小数（例如不得把 40.0% 和 41—50 岁写成 40.41）。40.0% 与 40% 属于同一数字；由两个数据点计算出的差值只有在句子明确表达 higher/lower/increase/gap/percentage points 等比较关系时才可使用；约数或上下界必须明确写 about/nearly/no more than 等限定。除此之外不要自行创造、四舍五入或补写阿拉伯数字；无法确认时改用定性表达，如 a marked increase 或 a substantial gap。

字数是硬约束：必须严格服从输入中的 wordBudget。全文必须位于 low-high，每段必须位于其 minWords-maxWords，每个内容块也必须位于对应 unitBudgets 的 minWords-maxWords，并尽量接近 targetWords。每个内容单元只表达一个新信息点，不重复主题句，不为了保留骨架而照抄整段模板。返回前必须逐词计数；偏短时补充该内容单元内部的具体因果、例证或影响，偏长时删掉套话、重复意义、冗余例证和过长修饰。

严格返回 JSON：{"title":null,"salutation":null,"signature":null,"paragraphs":[{"name":"","sentenceBlocks":[{"contentId":"","skeletonId":"","text":""}]}]}。每个内容单元至多一个 block，contentId 必须来自输入且唯一。`;
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
function fallbackText(unit, facts, ordinal = 0) {
  const evidence = arr(unit.evidence).map((e) => text(e.text)).filter(Boolean).join('; ');
  if (facts.category === '小作文') return `I am writing to address the following matter: ${evidence || unit.claim}.`;
  if (facts.category === '图表作文') return evidence
    ? `The available chart evidence shows ${evidence}. This point deserves careful analysis.`
    : CHART_FALLBACKS[ordinal % CHART_FALLBACKS.length];
  return evidence ? `The picture offers a basis for discussing ${evidence}. Beyond this observation, ${unit.claim}.` : `This issue deserves attention because ${unit.claim}.`;
}
function unitMap(plan) { return new Map((plan.units || plan.contentUnits || plan.paragraphs?.flatMap((p) => p.units) || []).map((u) => [u.contentId, u])); }
function normalizeGenerated(raw, plan, bindings, facts) {
  const units = unitMap(plan); const byBinding = new Map(bindings.bindings.map((b) => [b.contentId, b]));
  const sourceParagraphs = arr(raw?.paragraphs); const seen = new Set(); const paragraphs = [];
  for (let i = 0; i < Math.max(3, sourceParagraphs.length, plan.paragraphs?.length || 0); i += 1) {
    const source = sourceParagraphs[i] || {}; const planPara = plan.paragraphs?.[i];
    const blocks = arr(source.sentenceBlocks).length ? source.sentenceBlocks : [];
    const normalized = [];
    for (const block of blocks) {
      const id = text(block.contentId); const blockText = text(block.text);
      if (!id || !blockText || seen.has(id) || !units.has(id)) continue;
      const binding = byBinding.get(id); const skeletonId = text(block.skeletonId) || binding?.skeletonId || null;
      seen.add(id); normalized.push({ contentId: id, skeletonId, text: blockText });
    }
    paragraphs.push({ name: text(source.name) || planPara?.name || `第${i + 1}段`, sentenceBlocks: normalized });
  }
  // 模型漏块时只补内容单元，不补模板句；不同块使用不同安全表达，避免兜底本身制造重复。
  let fallbackOrdinal = 0;
  for (const unit of units.values()) if (!seen.has(unit.contentId)) {
    const index = Math.max(0, (plan.paragraphs || []).findIndex((p) => p.units?.some((u) => u.contentId === unit.contentId)));
    while (paragraphs.length <= index) paragraphs.push({ name: `第${paragraphs.length + 1}段`, sentenceBlocks: [] });
    const b = byBinding.get(unit.contentId); paragraphs[index].sentenceBlocks.push({ contentId: unit.contentId, skeletonId: b?.skeletonId || null, text: fallbackText(unit, facts, fallbackOrdinal) });
    fallbackOrdinal += 1;
  }
  const out = { title: raw?.title ?? null, date: raw?.date ?? null, salutation: raw?.salutation ?? null, signature: raw?.signature ?? null, paragraphs };
  if (facts.category === '小作文') {
    if (facts.small?.isNotice) { out.title = 'Notice'; out.salutation = null; out.signature = /学生会|Students'? Union/i.test(facts.questionText) ? "The Students' Union" : (out.signature || "The Students' Union"); if (/Yours sincerely|Li Ming/i.test(out.signature)) out.signature = "The Students' Union"; }
    else { out.salutation = out.salutation || `Dear ${facts.addressee || 'Sir or Madam'},`; out.signature = out.signature || 'Yours sincerely,\nLi Ming'; }
  }
  return out;
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

async function writeOnce(stage, plan, facts, bindings, injected, currentEssay = null, repair = null) {
  const budget = wordBudget(plan, facts);
  let raw = null;
  const revision = currentEssay ? {
    currentWords: essayWords(currentEssay),
    currentEssay: currentEssay.paragraphs.map((paragraph) => ({
      name: paragraph.name,
      sentenceBlocks: paragraph.sentenceBlocks,
    })),
    instruction: `当前草稿共 ${essayWords(currentEssay)} 词。请在不删 contentId、不增加事实、不增加内容单元的前提下，严格调整到 ${budget.low}-${budget.high} 词，目标约 ${budget.target} 词。逐块遵守 wordBudget.unitBudgets 的 minWords/targetWords/maxWords；偏短时在对应 claim 内补充具体解释、因果或影响，偏长时删套话。禁止重复任何已有句意。`,
  } : null;
  const chartNumberRepair = repair?.unsupportedNumbers?.length ? {
    unsupportedNumbers: repair.unsupportedNumbers,
    allowedNumbers: chartNumberGuide(facts.chart),
    instruction: '只改写列出的未验证数字所在句子。保留原 contentId、段落和主要含义；将无法由图表数据证明的数字改为原始数据或定性比较。不要新增任何阿拉伯数字。',
  } : null;
  try {
    raw = await callJson(stage, {
      tier: 'fast',
      system: WRITE_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          promptFacts: facts,
          contentPlan: planPayload(plan),
          bindings,
          wordBudget: budget,
          revision,
          chartNumberRepair,
        }),
      }],
      temperature: 0.1,
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
  const paragraphs = essay.paragraphs.map((p) => {
    const sentences = []; const sentenceSources = [];
    for (const block of p.sentenceBlocks) for (const sentence of splitSentences(block.text)) {
      const u = units.get(block.contentId); const b = byBind.get(block.contentId); const s = b?.skeleton;
      sentences.push(sentence); sentenceSources.push({ contentId: block.contentId, contentUnit: u || null, contentSource: { sourceType: u?.sourceType ?? null, evidence: u?.evidence ?? [], factIds: arr(u?.evidence).map((e) => e.factId).filter(Boolean) }, skeletonId: block.skeletonId || b?.skeletonId || null, skeleton: s || null, sourceInfo: s?.sourceInfo || null });
    }
    return { name: p.name, sentences, sentenceSources, sentenceBlocks: p.sentenceBlocks };
  });
  return { ...essay, paragraphs, sentenceSources: paragraphs.flatMap((p) => p.sentenceSources) };
}
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
function checkEssay(essay, plan, facts, question, bindings) {
  const full = essay.paragraphs.flatMap((p) => p.sentences || p.sentenceBlocks?.map((b) => b.text) || []).join(' '); const count = words(full); const [low, high] = rangeFor(facts, question);
  const units = plan.units || plan.contentUnits || []; const used = new Set(essay.paragraphs.flatMap((p) => p.sentenceBlocks.map((b) => b.contentId))); const keys = units.map((u) => u.semanticKey);
  const groups = bindings.bindings.map((b) => b.conflictGroup).filter(Boolean); const duplicate = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);
  const hasChartFacts = facts.category === '图表作文' || Boolean(facts.chart?.hasFacts);
  const numberCheck = hasChartFacts ? inspectChartNumbers(full, facts.chart) : { unsupported: [] };
  const unsupported = numberCheck.unsupported;
  const visual = facts.category !== '大作文' || !facts.missingVisualFacts || !/(picture|image|scene|figure|drawing|cartoon|图|画面|人物|手机|phone|child|man|woman)/i.test(full);
  const repeats = repeatedPhrases(full);
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
    { name: '双层来源', pass: essay.paragraphs.every((p) => p.sentences.length === p.sentenceSources.length && p.sentenceSources.every((s) => s.contentUnit && s.contentSource && s.skeletonId !== undefined && Object.hasOwn(s, 'skeleton'))), detail: '每句 content + skeleton 来源' },
  ];
  if (facts.category === '小作文') checks.push({ name: '小作文格式', pass: facts.small?.isNotice ? essay.title === 'Notice' && !essay.salutation && Boolean(essay.signature) : Boolean(essay.salutation) && Boolean(essay.signature), detail: '格式保留' });
  return { words: count, target: [low, high], checks, unsupportedNumbers: unsupported, allPass: checks.every((c) => c.pass) };
}
function revisionCloser(before, after, target) { const d = (n) => n < target[0] ? target[0] - n : n > target[1] ? n - target[1] : 0; return d(after) < d(before); }

/**
 * 确定性收尾裁剪：模型压缩仍超出上限时，先删除不会低于下限的完整尾句，
 * 再按实际超出的词数精确缩短最长内容块。每个内容块至少保留十词。
 */
function trimEssayToLimit(essay, limit, minimum = 0) {
  const next = JSON.parse(JSON.stringify(essay));
  const total = () => essayWords(next);
  if (total() <= limit) return { essay: next, trimmed: false };

  // 优先删完整尾句，但不得一次删到目标下限以下。
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
  }

  // 仍超限时只删除“当前超出量”，避免按整个逗号从句裁剪后跌破下限。
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
    const kept = tokens.slice(0, Math.max(10, tokens.length - removeCount)).join(' ').replace(/[,;:.!?\s]+$/, '');
    target.block.text = `${kept}.`;
  }
  return { essay: next, trimmed: true };
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

export async function composeV2(questionText, { imageAnalysis, onStep, chatJsonImpl } = {}) {
  const question = text(questionText); if (!question) throw error('题目内容为空。', 400, 'question_required');
  const steps = []; const record = (key, data) => { const step = { key, data }; steps.push(step); onStep?.(step); return step; };
  const classification = await classifyV2(question, chatJsonImpl);
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
  let plan = await buildContentPlan(facts, classification.final, { chatJson: (opts) => callJson('plan', opts, chatJsonImpl) });
  plan = normalizePlanPriorities(plan, facts);
  plan.targetWords = facts.targetWords; plan.wordBand = facts.wordBand;
  let planValidation = validateContentPlan(plan, facts, classification.final);
  record('plan', { paragraphs: plan.paragraphs, validation: planValidation });
  let bindings = await bindSkeletons(plan, facts, classification.final, chatJsonImpl);
  record('skeletons', bindings);
  let essay = await writeOnce('essay', plan, facts, bindings, chatJsonImpl);
  let sourced = buildSources(essay, plan, bindings); let check = checkEssay(sourced, plan, facts, question, bindings);
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
      bindings = await bindSkeletons(plan, facts, classification.final, chatJsonImpl);
      essay = await writeOnce('essay-expanded', plan, facts, bindings, chatJsonImpl);
      sourced = buildSources(essay, plan, bindings);
      check = checkEssay(sourced, plan, facts, question, bindings);
    }
  }
  if (check.words > check.target[1]) {
    const contractedPlan = pruneOptionalContentPlan(plan, check.words - check.target[1]);
    if ((contractedPlan.units ?? []).length < (plan.units ?? []).length) {
      plan = contractedPlan;
      plan.targetWords = facts.targetWords;
      plan.wordBand = facts.wordBand;
      planValidation = validateContentPlan(plan, facts, classification.final);
      bindings = await bindSkeletons(plan, facts, classification.final, chatJsonImpl);
      essay = await writeOnce('essay-contracted', plan, facts, bindings, chatJsonImpl);
      sourced = buildSources(essay, plan, bindings);
      check = checkEssay(sourced, plan, facts, question, bindings);
    }
  }

  let chartNumberRepair = null;
  if (facts.category === '图表作文' && check.unsupportedNumbers.length) {
    const before = [...check.unsupportedNumbers];
    const repaired = await writeOnce('essay-chart-number-revise', plan, facts, bindings, chatJsonImpl, essay, {
      unsupportedNumbers: before,
    });
    const repairedSourced = buildSources(repaired, plan, bindings);
    const repairedCheck = checkEssay(repairedSourced, plan, facts, question, bindings);
    if (repairedCheck.unsupportedNumbers.length === 0) {
      essay = repaired;
      sourced = repairedSourced;
      check = repairedCheck;
      chartNumberRepair = { from: before, to: [] };
    }
  }

  const failedChecks = (result) => result.checks.filter((item) => !item.pass).length;
  // 字数或重复不达标时最多定向修订两轮。每轮都携带当前草稿和逐块预算，
  // 只接受更接近目标区间或减少失败项的结果。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const needsRevision = check.words < check.target[0]
      || check.words > check.target[1]
      || check.checks.some((item) => item.name === '无明显重复表达' && !item.pass);
    if (!needsRevision) break;
    const revised = await writeOnce(`essay-revise-${attempt}`, plan, facts, bindings, chatJsonImpl, essay);
    const revisedSourced = buildSources(revised, plan, bindings);
    const revisedCheck = checkEssay(revisedSourced, plan, facts, question, bindings);
    if (revisionCloser(check.words, revisedCheck.words, check.target) || failedChecks(revisedCheck) < failedChecks(check)) {
      sourced = revisedSourced; check = revisedCheck; essay = revised;
    } else {
      break;
    }
  }

  // 表格被扁平化时，模型偶尔会把 40.0% 与 41—50 岁拼成 40.41。
  // 只对“整数部分命中 .0 原始值、后缀命中标签数字”的伪小数做确定性修复。
  if (facts.category === '图表作文' && check.unsupportedNumbers.length) {
    const artifactRepair = repairMergedChartArtifacts(essay, facts.chart);
    if (artifactRepair.replacements.length) {
      const artifactSourced = buildSources(artifactRepair.essay, plan, bindings);
      const artifactCheck = checkEssay(artifactSourced, plan, facts, question, bindings);
      if (artifactCheck.unsupportedNumbers.length < check.unsupportedNumbers.length) {
        essay = artifactRepair.essay;
        sourced = artifactSourced;
        check = artifactCheck;
        chartNumberRepair = {
          ...(chartNumberRepair ?? {}),
          from: artifactRepair.replacements.map((item) => item.from),
          to: artifactRepair.replacements.map((item) => item.to),
          mode: 'merged-label-value-artifact',
        };
      }
    }
  }

  // 最后一道确定性保障：模型多轮压缩仍超上限时，按整句裁剪到区间内。
  let trimmedToLimit = false;
  if (check.words > check.target[1]) {
    const { essay: trimmed, trimmed: didTrim } = trimEssayToLimit(essay, check.target[1], check.target[0]);
    if (didTrim) {
      const trimmedSourced = buildSources(trimmed, plan, bindings);
      const trimmedCheck = checkEssay(trimmedSourced, plan, facts, question, bindings);
      if (trimmedCheck.words <= check.target[1] && trimmedCheck.words >= check.target[0]) {
        essay = trimmed; sourced = trimmedSourced; check = trimmedCheck; trimmedToLimit = true;
      }
    }
  }
  if (check.unsupportedNumbers.length) throw error(`作文使用了未经图表事实支持的数字：${check.unsupportedNumbers.join(', ')}`, 422, 'unsupported_chart_number');
  record('essay', { essay: sourced, check, expandedContentPlan: expanded, trimmedToLimit, chartNumberRepair });
  return { question, classification: classification.final, steps, facts, plan: { ...plan, validation: planValidation }, bindings, essay: sourced, check };
}

export { checkEssay };
export default { composeV2 };
