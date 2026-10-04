/**
 * 学习卡片派生与固定学习计划。
 *
 * 卡片完全由写作知识库派生，不引入任何讲义之外的内容：
 * 每张卡片 = 一个可用于生产的骨架 + 它的替换值、示例、易错提醒和讲义出处。
 * 卡片顺序沿用 lib/modules.mjs 的轨道与模块顺序，保证背诵顺序等于实际写作顺序。
 */

import { loadWritingKnowledge } from './writing-kb.mjs';
import { TEMPLATE_TRACKS, getModule, normalizeSourceInfo } from './modules.mjs';
import {
  scopeOfSkeleton,
  SCOPE_LABELS,
  cardVisibleFor,
  visibleTracksFor,
  coreTracksFor,
  priorityOf,
  normalizeExamType,
} from './exam-scope.mjs';

const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];

export const TRACK_ORDER = ['chart', 'picture', 'small'];
export const DEFAULT_DAILY_COUNT = 8;
export const MIN_DAILY_COUNT = 3;
export const MAX_DAILY_COUNT = 30;
const CARD_STATUSES = new Set(['new', 'mastered', 'review']);

function conflictParts(skeleton) {
  const parts = text(skeleton?.conflictGroup).split(':');
  return {
    track: parts[0] ?? '',
    position: parts[1] ?? '',
    function: parts[2] ?? '',
    topic: parts[3] ?? '',
    polarity: parts[4] ?? '',
  };
}

function trackOf(skeleton) {
  const { track } = conflictParts(skeleton);
  if (TRACK_ORDER.includes(track)) return track;
  const applicability = array(skeleton?.applicability).map(text);
  if (applicability.includes('small')) return 'small';
  if (applicability.includes('chart')) return 'chart';
  if (applicability.includes('picture')) return 'picture';
  const prefix = text(skeleton?.semanticKey).split('.')[0];
  return TRACK_ORDER.includes(prefix) ? prefix : null;
}

// 展望句的判定依据是句子本身的语义标记（预测、条件收束、号召牢记），
// 而不是页面标题，因为多数尾段骨架的标题只写「尾段骨架」。
const OUTLOOK_PATTERN = /(?:will\s+be\s+promising|will\s+continue|in\s+the\s+years\s+to\s+come|bear\s+in\s+mind|to\s+conclude|in\s+a\s+nutshell|in\s+this\s+manner|competitive\s+edge|can\s+be\s+likened\s+to|merely|never\s+can\s+we|final(?:ly)?\s+analysis)/i;
// 原因设问句的语义标记是「承接数据 + 抛出疑问」，讲义里统一用 what resulted/result in。
const QUESTION_PATTERN = /(?:what\s+(?:has\s+)?results?(?:ed)?\s+in|what\s+caused|why\s*\?)/i;
// 寓意点题句的标记是从画面转向主题与寓意，而非继续描述画面细节。
const THEME_PATTERN = /(?:message\s+it\s+conveys|implied\s+meaning|thought-provoking|enlightening|ridiculous|significance\s+of|reminding\s+us)/i;

function moduleIdOf(skeleton, track) {
  const { position, function: rhetorical } = conflictParts(skeleton);
  const id = text(skeleton?.id).toLowerCase();
  const title = text(array(skeleton?.sourceRefs)[0]?.pageTitle);
  const en = text(skeleton?.en);

  if (track === 'chart') {
    if (position === 'closing') return OUTLOOK_PATTERN.test(en) ? 'chart-outlook' : 'chart-advice';
    if (QUESTION_PATTERN.test(en)) return 'chart-question';
    if (rhetorical === 'reason') return 'chart-reasons';
    if (rhetorical === 'advice') return 'chart-advice';
    if (position === 'opening') return /首段|首句|引入|第一段/.test(title) || /-open-/.test(id) ? 'chart-introduction' : 'chart-data';
    return 'chart-data';
  }

  if (track === 'picture') {
    if (position === 'closing') return OUTLOOK_PATTERN.test(en) ? 'picture-outlook' : 'picture-advice';
    if (rhetorical === 'advice') return 'picture-advice';
    if (position === 'opening' && THEME_PATTERN.test(en)) return 'picture-theme';
    if (rhetorical === 'introduction') return 'picture-introduction';
    if (rhetorical === 'description') return 'picture-scene';
    if (position === 'opening') return 'picture-theme';
    return 'picture-argument';
  }

  if (position === 'closing') return 'small-politeness';
  if (position === 'opening') return /身份|寒暄|自我介绍|背景/.test(title) ? 'small-identity' : 'small-purpose';
  if (/理由|益处|好处|请求|请教|必要性/.test(title)) return 'small-support';
  return 'small-details';
}

function warningTextsFor(skeleton, warnings) {
  const pages = new Set(array(skeleton?.sourceRefs).map((ref) => `${ref.source}#${ref.page}`));
  return array(warnings)
    .filter((warning) => array(warning.sourceRefs).some((ref) => pages.has(`${ref.source}#${ref.page}`)))
    .map((warning) => text(warning.text))
    .filter(Boolean);
}

function buildCard(skeleton, { track, moduleId, variants, examples, warnings }) {
  const primaryRef = array(skeleton.sourceRefs)[0] ?? {};
  const sourceInfo = normalizeSourceInfo({ source: primaryRef.source, page: primaryRef.page, origin: primaryRef.pageTitle });
  const examScope = scopeOfSkeleton(skeleton);
  return {
    cardId: `card-${skeleton.id}`,
    skeletonId: skeleton.id,
    examScope,
    scopeLabel: SCOPE_LABELS[examScope] ?? examScope,
    track,
    moduleId,
    moduleLabel: getModule(moduleId)?.label ?? moduleId,
    moduleOrder: getModule(moduleId)?.order ?? 99,
    rhetoricalFunction: text(skeleton.rhetoricalFunction),
    en: text(skeleton.en),
    zh: text(skeleton.zh),
    slots: array(skeleton.slots).map(text).filter(Boolean),
    constraints: array(skeleton.constraints).map(text).filter(Boolean),
    // 讲义中确实存在个别条目没有中文译文，如实标注而不是编造翻译。
    zhMissing: !text(skeleton.zh),
    estimatedWords: Number(skeleton.estimatedWords) || 0,
    applicability: array(skeleton.applicability).map(text).filter(Boolean),
    variants: variants.map((variant) => ({ value: text(variant.value), constraint: text(variant.constraint) })).filter((item) => item.value),
    examples: examples.map((example) => ({ label: text(example.label), zh: text(example.zh), en: text(example.en) })),
    warnings,
    source: {
      label: sourceInfo.sourceLabel,
      page: sourceInfo.page,
      pageTitle: text(primaryRef.pageTitle),
      href: sourceInfo.href,
    },
  };
}

/** 派生全部学习卡片，按轨道与模块顺序排序。 */
export async function buildStudyCards() {
  const kb = await loadWritingKnowledge();
  const variantsBySkeleton = new Map();
  for (const variant of kb.variants) {
    if (!variantsBySkeleton.has(variant.skeletonId)) variantsBySkeleton.set(variant.skeletonId, []);
    variantsBySkeleton.get(variant.skeletonId).push(variant);
  }
  const examplesBySkeleton = new Map();
  for (const example of kb.examples) {
    for (const skeletonId of array(example.skeletonIds)) {
      if (!examplesBySkeleton.has(skeletonId)) examplesBySkeleton.set(skeletonId, []);
      examplesBySkeleton.get(skeletonId).push(example);
    }
  }

  const cards = [];
  for (const skeleton of kb.skeletons) {
    if (skeleton.productionEligible !== true) continue;
    const track = trackOf(skeleton);
    if (!track) continue;
    const moduleId = moduleIdOf(skeleton, track);
    cards.push(buildCard(skeleton, {
      track,
      moduleId,
      variants: variantsBySkeleton.get(skeleton.id) ?? [],
      examples: examplesBySkeleton.get(skeleton.id) ?? [],
      warnings: warningTextsFor(skeleton, kb.warnings),
    }));
  }

  cards.sort((a, b) => TRACK_ORDER.indexOf(a.track) - TRACK_ORDER.indexOf(b.track)
    || a.moduleOrder - b.moduleOrder
    || a.skeletonId.localeCompare(b.skeletonId));
  return cards;
}

/** 按备考方向过滤卡片，并标注主线/拓展；examType 为空时返回全部。 */
export function filterCardsByExamType(cards, examType) {
  const normalized = normalizeExamType(examType);
  if (!normalized) return cards.map((card) => ({ ...card, priority: 'core' }));
  return cards
    .filter((card) => cardVisibleFor(card, normalized))
    .map((card) => ({ ...card, priority: priorityOf(card, normalized) }));
}

/** 轨道与模块的卡片数量概览，供前端渲染筛选器。只统计当前备考方向可见的卡片。 */
export async function studyCardOutline(examType) {
  const normalized = normalizeExamType(examType);
  const cards = filterCardsByExamType(await buildStudyCards(), normalized);
  const tracks = normalized ? visibleTracksFor(normalized) : TEMPLATE_TRACKS.map((track) => track.id);
  return TEMPLATE_TRACKS.filter((track) => tracks.includes(track.id)).map((track) => ({
    id: track.id,
    label: track.label,
    description: track.description,
    count: cards.filter((card) => card.track === track.id).length,
    modules: track.modules.map((module) => ({
      id: module.id,
      label: module.label,
      description: module.description,
      order: module.order,
      required: module.required,
      count: cards.filter((card) => card.moduleId === module.id).length,
    })),
  }));
}

export function normalizePlanOptions(options = {}) {
  const requested = array(options.tracks).map(text).filter((id) => TRACK_ORDER.includes(id));
  const tracks = requested.length ? TRACK_ORDER.filter((id) => requested.includes(id)) : [...TRACK_ORDER];
  const rawDaily = Number(options.dailyCount);
  const dailyCount = Number.isFinite(rawDaily)
    ? Math.min(MAX_DAILY_COUNT, Math.max(MIN_DAILY_COUNT, Math.round(rawDaily)))
    : DEFAULT_DAILY_COUNT;
  return {
    tracks,
    dailyCount,
    includeOptional: options.includeOptional !== false,
    // 默认只背主线；打开后把拓展轨道（如英语一的图表）一并纳入计划。
    includeExtended: options.includeExtended === true,
  };
}

/**
 * 固定学习计划：按轨道与模块顺序线性铺开，再按每日数量切成单元。
 * examType 限定备考方向，使进度可以真正背满 100%。
 */
export async function buildStudyPlan(options = {}, examType = null) {
  const plan = normalizePlanOptions(options);
  const normalized = normalizeExamType(examType);
  const allCards = filterCardsByExamType(await buildStudyCards(), normalized);
  // 未显式指定轨道时，计划范围默认只含主线轨道，保证进度可以背满。
  const scopeTracks = normalized
    ? (plan.includeExtended ? visibleTracksFor(normalized) : coreTracksFor(normalized))
    : TRACK_ORDER;
  const requestedTracks = array(options.tracks).length ? plan.tracks : scopeTracks;
  const selected = allCards.filter((card) => {
    if (!scopeTracks.includes(card.track)) return false;
    if (!requestedTracks.includes(card.track)) return false;
    if (plan.includeOptional) return true;
    return getModule(card.moduleId)?.required !== false;
  });
  const units = [];
  for (let index = 0; index < selected.length; index += plan.dailyCount) {
    const slice = selected.slice(index, index + plan.dailyCount);
    units.push({
      unitIndex: units.length + 1,
      cardIds: slice.map((card) => card.cardId),
      tracks: [...new Set(slice.map((card) => card.track))],
      modules: [...new Set(slice.map((card) => card.moduleLabel))],
      estimatedWords: slice.reduce((sum, card) => sum + card.estimatedWords, 0),
    });
  }
  return { options: plan, examType: normalized, totalCards: selected.length, totalUnits: units.length, units, cards: selected };
}

export function isCardStatus(value) {
  return CARD_STATUSES.has(text(value));
}

/** 按 skeletonId 反查卡片，供成文后关联"本次用到的模板句"。 */
export async function cardsBySkeletonIds(skeletonIds = []) {
  const wanted = new Set(array(skeletonIds).map(text).filter(Boolean));
  if (!wanted.size) return [];
  const cards = await buildStudyCards();
  return cards.filter((card) => wanted.has(card.skeletonId));
}

export default {
  TRACK_ORDER,
  DEFAULT_DAILY_COUNT,
  MIN_DAILY_COUNT,
  MAX_DAILY_COUNT,
  buildStudyCards,
  studyCardOutline,
  buildStudyPlan,
  normalizePlanOptions,
  filterCardsByExamType,
  cardsBySkeletonIds,
  isCardStatus,
};
