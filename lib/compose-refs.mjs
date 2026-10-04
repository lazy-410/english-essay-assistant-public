/**
 * 参考素材层（compose v3）。
 *
 * 把讲义知识库里真正可用的表达素材整理成“有界的参考素材包”：
 * 骨架候选（含槽位替换建议）、讲义英文示例、写作方法与提醒、真题已校对范文。
 * 它只是表达参考，不改变事实层与内容规划层的职责划分。
 *
 * 约定：
 * - 素材只收录可用英文（示例），骨架保留 {...} / [...] 槽位（由写作模型替换）；
 * - 输出为有界 JSON（每单元 ≤8 条候选、全局 ≤24 条骨架、≤6 条示例、≤4 方法、≤3 提醒）；
 * - `collectGuardSentences` 从真题范文与“未被本篇使用骨架”的示例里生成查重语料，
 *   用于“范文重合”检查；被本篇骨架绑定的示例属于有意复用，不参与查重。
 */

import { getWritingVariants, queryWritingExamples, queryWritingMethods } from './writing-kb.mjs';

const text = (value) => value == null ? '' : String(value).trim();
const arr = (value) => Array.isArray(value) ? value : [];
const clip = (value, max) => {
  const s = text(value);
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
};

/** 连续词重合的允许上限：≤7 词视为正常复用，≥8 词触发改写。 */
export const OVERLAP_LIMIT = 7;

const CJK_PATTERN = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]/;
const PLACEHOLDER_PATTERN = /\{[^{}]{1,40}\}|\[[^\[\]]{1,40}\]/;

export function hasCjk(value) { return CJK_PATTERN.test(text(value)); }
export function hasPlaceholder(value) { return PLACEHOLDER_PATTERN.test(text(value)); }
/** 句子是否可直接作为英文素材：有英文、无中文、无占位符。 */
export function isUsableEnglish(value) {
  const s = text(value);
  return Boolean(s) && /[a-zA-Z]{3}/.test(s) && !hasCjk(s) && !hasPlaceholder(s);
}

function normalizeTokens(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9'\-\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * 计算 value 与查重语料中最长的连续词重合。
 * 返回 { length, phrase, source, id } 或 null；不做同义词归并，只抓逐字照抄。
 */
export function longestOverlap(value, corpus = [], { minRun = OVERLAP_LIMIT + 1 } = {}) {
  const a = normalizeTokens(value);
  if (a.length < minRun) return null;
  let best = null;
  for (const item of arr(corpus)) {
    const source = text(item?.source) || 'reference';
    const id = text(item?.id) || null;
    const b = normalizeTokens(item?.text);
    if (b.length < minRun) continue;
    const index = new Map();
    for (let i = 0; i + minRun <= b.length; i += 1) {
      const key = b.slice(i, i + minRun).join(' ');
      if (!index.has(key)) index.set(key, i);
    }
    for (let i = 0; i + minRun <= a.length; i += 1) {
      const j = index.get(a.slice(i, i + minRun).join(' '));
      if (j === undefined) continue;
      let run = minRun;
      while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run += 1;
      let lead = 0;
      while (i - lead - 1 >= 0 && j - lead - 1 >= 0 && a[i - lead - 1] === b[j - lead - 1]) lead += 1;
      const length = run + lead;
      if (!best || length > best.length) best = { length, phrase: a.slice(i - lead, i + run).join(' '), source, id };
    }
  }
  return best && best.length >= minRun ? best : null;
}

const GUIDANCE_RULES = [
  // 与具体题型无关、但直接决定成文质量的提醒。
  { re: /不引入新信息|不要再引入|结尾段功能|收束/, weight: 6 },
  { re: /占位符|题目相关词|方括号|蓝色/, weight: 5 },
  { re: /换.*词|改.*词|同义|替换|僵硬|生硬/, weight: 4 },
  { re: /照抄|跑题|错误|误导|过度解读/, weight: 4 },
  { re: /背下来|句子架构|功能句/, weight: 3 },
  { re: /简单表达|不会写|替换为/, weight: 3 },
];
const CATEGORY_RULES = {
  大作文: [{ re: /图画|大作文|首段|尾段|中间段|漫画/, weight: 6 }, { re: /思路|原因|意义|危害|建议|展望|观点/, weight: 3 }],
  图表作文: [{ re: /图表|数据|趋势|图形|折线|柱状|饼图|表格/, weight: 6 }, { re: /分析|对比|原因|影响/, weight: 3 }],
  小作文: [{ re: /小作文|书信|通知|公告|称呼|落款|目的句|应用文/, weight: 6 }, { re: /语域|得体|正式|交流任务/, weight: 3 }],
};

function scoreGuidance(entry, facts, category) {
  const value = text(entry?.text);
  if (!value) return 0;
  let score = 0;
  for (const rule of GUIDANCE_RULES) if (rule.re.test(value)) score += rule.weight;
  for (const rule of arr(CATEGORY_RULES[category])) if (rule.re.test(value)) score += rule.weight;
  if (entry.category === 'method') score += 1;
  if (category === '小作文' && /小作文|书信|通知/.test(value)) score += 2;
  return score;
}

/**
 * 构建参考素材包。
 *
 * @param {object} facts          buildPromptFacts 的产物（提供题型与主题词）
 * @param {object} classification 最终分类（category / keyPhrase / polarity …）
 * @param {object} options
 *   - choices: bindSkeletons 的候选池 [{ contentId, candidates: [{ skeleton, score }] }]
 *   - examEssay: { examId, title, paragraphs: [英文段落] } | null（真题已校对范文）
 *   - task/applicabilityTokens: 知识库 applicability 值（如 picture / negative）
 */
export async function buildReferenceKit(facts = {}, classification = {}, {
  examId = null, choices = [], examEssay = null, applicabilityTokens = [],
  limitPerUnit = 8, maxSkeletons = 24, maxExamples = 6, maxMethods = 4, maxWarnings = 3,
} = {}) {
  const category = text(classification?.category) || text(facts?.category) || '大作文';
  const units = [];
  const seenSkeletonIds = new Set();
  const usedSkeletonIds = new Set();
  let skeletonBudget = maxSkeletons;
  for (const choice of arr(choices)) {
    const skeletons = [];
    for (const item of arr(choice?.candidates)) {
      if (skeletons.length >= limitPerUnit || skeletonBudget <= 0) break;
      const skeleton = item?.skeleton ?? item;
      const skeletonId = text(skeleton?.id);
      const en = text(skeleton?.en);
      if (!skeletonId || !en || seenSkeletonIds.has(skeletonId)) continue;
      seenSkeletonIds.add(skeletonId);
      skeletonBudget -= 1;
      let variants = [];
      try {
        variants = arr(await getWritingVariants(skeletonId))
          .map((variant) => clip(variant?.value, 24))
          .filter((value) => value && !hasPlaceholder(value))
          .slice(0, 3);
      } catch { /* 变体缺失不影响骨架可用性 */ }
      skeletons.push({ skeletonId, en, slotFills: variants });
    }
    units.push({ contentId: text(choice?.contentId), rhetoricalFunction: text(choice?.rhetoricalFunction), skeletons });
    for (const skeleton of skeletons) usedSkeletonIds.add(skeleton.skeletonId);
  }

  // 示例：按题型/适用性取候选，再按“命中本单元骨架 / 主题词 / 结构化”排序。
  const examplePool = new Map();
  const tasks = [...new Set([...arr(applicabilityTokens).map(text).filter(Boolean), text(classification?.letterType)].filter(Boolean))];
  for (const task of tasks.slice(0, 3)) {
    try {
      for (const example of await queryWritingExamples({ task, limit: 80 })) examplePool.set(example.id, example);
    } catch { /* 知识库缺失时素材层整体降级 */ }
  }
  if (!examplePool.size) {
    try {
      for (const example of await queryWritingExamples({ limit: 40 })) examplePool.set(example.id, example);
    } catch { /* 同上 */ }
  }
  const topic = text(classification?.keyPhrase);
  const seenExampleIds = new Set();
  const candidates = [];
  for (const example of examplePool.values()) {
    const en = text(example.en);
    if (!isUsableEnglish(en) || seenExampleIds.has(example.id)) continue;
    seenExampleIds.add(example.id);
    const skeletonIds = arr(example.skeletonIds).map(text).filter(Boolean);
    let score = example.structured ? 3 : 1;
    if (skeletonIds.some((id) => usedSkeletonIds.has(id))) score += 3;
    if (topic && (`${text(example.label)}${text(example.zh)}`.includes(topic))) score += 2;
    if (example.year) score += 1;
    candidates.push({ exampleId: text(example.id), en, skeletonIds, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.exampleId.localeCompare(b.exampleId));
  const perUnitExamples = new Map(units.map((unit) => [unit.contentId, []]));
  const globalExamples = [];
  let exampleBudget = maxExamples;
  for (const candidate of candidates) {
    if (exampleBudget <= 0) break;
    const host = units.find((unit) => unit.skeletons.some((skeleton) => candidate.skeletonIds.includes(skeleton.skeletonId)));
    const bucket = host ? perUnitExamples.get(host.contentId) : globalExamples;
    if (!bucket || bucket.length >= (host ? 3 : maxExamples)) continue;
    bucket.push({ exampleId: candidate.exampleId, en: candidate.en, skeletonIds: candidate.skeletonIds });
    exampleBudget -= 1;
  }
  for (const unit of units) unit.examples = perUnitExamples.get(unit.contentId) ?? [];

  let guidance = { methods: [], warnings: [] };
  try {
    const [methodList, warningList] = await Promise.all([
      queryWritingMethods({ category: 'method', limit: 200 }),
      queryWritingMethods({ category: 'warning', limit: 200 }),
    ]);
    const scoreAll = (list, limit, bonus) => arr(list)
      .map((entry) => ({ entry, score: scoreGuidance(entry, facts, category) + bonus }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)))
      .slice(0, limit)
      .map((item) => ({ id: text(item.entry.id), text: clip(item.entry.text, 150) }));
    guidance = {
      methods: scoreAll(methodList.filter((entry) => entry.category === 'method'), maxMethods, 1),
      warnings: scoreAll(warningList, maxWarnings, 1),
    };
  } catch { /* 方法与提醒缺失不影响成文 */ }

  const modelEssay = (() => {
    if (!examEssay) return null;
    const paragraphs = arr(examEssay.paragraphs)
      .map((paragraph) => clip(paragraph, 260))
      .filter((paragraph) => isUsableEnglish(paragraph))
      .slice(0, 3);
    if (!paragraphs.length) return null;
    return { examId: text(examEssay.examId ?? examId) || null, title: text(examEssay.title) || null, paragraphs };
  })();

  const stats = {
    skeletonCandidates: units.reduce((sum, unit) => sum + unit.skeletons.length, 0),
    variantSuggestions: units.reduce((sum, unit) => sum + unit.skeletons.reduce((n, skeleton) => n + skeleton.slotFills.length, 0), 0),
    examples: units.reduce((sum, unit) => sum + unit.examples.length, globalExamples.length),
    methods: guidance.methods.length,
    warnings: guidance.warnings.length,
    hasModelEssay: Boolean(modelEssay),
  };
  return {
    policy: '参考素材是表达库而不是填空模板：可整句套用、改写、换词、拆句或并句；其中的事实与数字属于别人的题目，绝不可搬用；禁止整句照抄范文。',
    units,
    examples: globalExamples,
    methods: guidance.methods,
    warnings: guidance.warnings,
    modelEssay,
    stats,
  };
}

function collectExamples(kit) {
  return [
    ...arr(kit?.units).flatMap((unit) => arr(unit.examples)),
    ...arr(kit?.examples),
  ];
}

/** 参考素材包摘要（写进 steps，供界面复盘“本篇用了哪些素材”）。 */
export function referenceKitSummary(kit) {
  if (!kit) return null;
  return {
    policy: kit.policy,
    stats: kit.stats,
    methodIds: arr(kit.methods).map((item) => item.id),
    warningIds: arr(kit.warnings).map((item) => item.id),
    exampleIds: collectExamples(kit).map((item) => item.exampleId),
    skeletonIds: arr(kit.units).flatMap((unit) => arr(unit.skeletons).map((skeleton) => skeleton.skeletonId)),
    hasModelEssay: Boolean(kit.modelEssay),
  };
}

/**
 * 查重语料：真题范文全部参与；示例只收录“未被本篇骨架绑定”的部分。
 */
export function collectGuardSentences(kit, { usedSkeletonIds = [] } = {}) {
  const used = new Set(arr(usedSkeletonIds).map(text));
  const sentences = [];
  for (const paragraph of arr(kit?.modelEssay?.paragraphs)) {
    if (isUsableEnglish(paragraph)) sentences.push({ text: paragraph, source: 'modelEssay', id: kit.modelEssay.examId ?? null });
  }
  for (const example of collectExamples(kit)) {
    if (arr(example.skeletonIds).some((id) => used.has(text(id)))) continue;
    if (isUsableEnglish(example.en)) sentences.push({ text: example.en, source: 'example', id: example.exampleId });
  }
  return sentences;
}

export default { buildReferenceKit, collectGuardSentences, longestOverlap, referenceKitSummary, isUsableEnglish, hasCjk, hasPlaceholder, OVERLAP_LIMIT };
