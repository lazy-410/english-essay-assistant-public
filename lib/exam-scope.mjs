/**
 * 骨架的备考方向归属：英语一专属 / 英语二专属 / 两者通用。
 *
 * 判定完全依据讲义来源，不做语义猜测：
 * - slp-big-e1 / slp-small-e1 → 英语一笔记，仅英语一
 * - slp-big-e2 / slp-small-e2 → 英语二笔记，仅英语二
 * - scan-handout            → 原扫描讲义，两者通用
 *
 * 轨道可见性按真题实际考查情况确定，而不是"英一只考图画"的简化印象：
 * 英语一 2024 年考混合题、2025 年考图表题，因此英语一必须保留图表轨道；
 * 英语二从未考过图画大作文，因此英语二不出图画轨道。
 */

const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];

export const EXAM_TYPES = ['e1', 'e2'];
export const SCOPE_E1 = 'e1';
export const SCOPE_E2 = 'e2';
export const SCOPE_SHARED = 'shared';

const SOURCE_SCOPE = new Map([
  ['slp-big-e1', SCOPE_E1],
  ['slp-small-e1', SCOPE_E1],
  ['slp-big-e2', SCOPE_E2],
  ['slp-small-e2', SCOPE_E2],
  ['scan-handout', SCOPE_SHARED],
]);

export const EXAM_TYPE_LABELS = { e1: '英语一', e2: '英语二' };
export const SCOPE_LABELS = { e1: '英语一专属', e2: '英语二专属', shared: '英语一二通用' };

/** 英语一保留图表：2024 混合题与 2025 图表题都真实考过。 */
const VISIBLE_TRACKS = {
  e1: ['picture', 'chart', 'small'],
  e2: ['chart', 'small'],
};

/**
 * 每个备考方向的"主线轨道"：真题里高频考查、必须背满的部分。
 * 英语一大作文 21 篇中 19 篇是图画，图表与混合题各 1 篇，
 * 因此图表对英语一属于"拓展"：卡片仍然可见可背，但不计入主线进度，
 * 这样进度条能真正背满，同时不隐瞒考点。
 */
const CORE_TRACKS = {
  e1: ['picture', 'small'],
  e2: ['chart', 'small'],
};

/** 卡片是主线还是拓展。拓展卡片默认不进学习计划，可在页面上一键加入。 */
export function priorityOf(card, examType) {
  const normalized = normalizeExamType(examType);
  if (!normalized) return 'core';
  return CORE_TRACKS[normalized].includes(card?.track) ? 'core' : 'extended';
}

export function coreTracksFor(examType) {
  const normalized = normalizeExamType(examType);
  if (!normalized) return ['chart', 'picture', 'small'];
  return [...CORE_TRACKS[normalized]];
}

export function isExamType(value) {
  return EXAM_TYPES.includes(text(value));
}

export function normalizeExamType(value) {
  return isExamType(value) ? text(value) : null;
}

/** 骨架归属；来源缺失或未知时按通用处理，避免卡片凭空消失。 */
export function scopeOfSkeleton(skeleton) {
  const source = text(array(skeleton?.sourceRefs)[0]?.source);
  return SOURCE_SCOPE.get(source) ?? SCOPE_SHARED;
}

export function scopesForExamType(examType) {
  const normalized = normalizeExamType(examType);
  if (!normalized) return [SCOPE_E1, SCOPE_E2, SCOPE_SHARED];
  return [normalized, SCOPE_SHARED];
}

export function visibleTracksFor(examType) {
  const normalized = normalizeExamType(examType);
  if (!normalized) return ['chart', 'picture', 'small'];
  return [...VISIBLE_TRACKS[normalized]];
}

/** 某张卡片在指定备考方向下是否应当出现。 */
export function cardVisibleFor(card, examType) {
  const normalized = normalizeExamType(examType);
  if (!normalized) return true;
  if (!scopesForExamType(normalized).includes(card?.examScope ?? SCOPE_SHARED)) return false;
  return visibleTracksFor(normalized).includes(card?.track);
}

/** 备考方向说明，用于页面上如实交代范围规则。 */
export const SCOPE_NOTES = {
  e1: '英语一：主线为图画大作文与小作文。图表与混合题（2024、2025 年真题）作为拓展保留，可随时加入计划。',
  e2: '英语二：主线为图表大作文与小作文。英语二从未考查图画大作文，因此不显示图画模板。',
};

export default {
  EXAM_TYPES,
  EXAM_TYPE_LABELS,
  SCOPE_LABELS,
  SCOPE_NOTES,
  SCOPE_E1,
  SCOPE_E2,
  SCOPE_SHARED,
  isExamType,
  normalizeExamType,
  scopeOfSkeleton,
  scopesForExamType,
  visibleTracksFor,
  coreTracksFor,
  priorityOf,
  cardVisibleFor,
};
