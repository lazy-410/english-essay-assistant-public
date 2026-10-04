/**
 * 学习进度持久化。
 *
 * 进度存在服务端 JSON 文件，换浏览器或清缓存都不会丢。
 * 写入采用「临时文件 + rename」的原子替换，避免并发写坏进度文件。
 *
 * 进度按备考方向分别隔离：英语一与英语二各自保存卡片状态、计划与当前单元，
 * 因此各自都能背满 100%，切换方向时两边成果都不丢。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DIR } from './paths.mjs';
import { normalizePlanOptions, isCardStatus } from './study-cards.mjs';
import { EXAM_TYPES, normalizeExamType } from './exam-scope.mjs';

const PROGRESS_FILE = path.join(KNOWLEDGE_DIR, 'study-progress.json');
const text = (value) => value == null ? '' : String(value).trim();
const DEFAULT_SCOPE = 'e1';

function emptyScope() {
  return { plan: normalizePlanOptions({}), currentUnit: 1, cards: {} };
}

function emptyProgress() {
  return {
    version: 2,
    scopes: Object.fromEntries(EXAM_TYPES.map((type) => [type, emptyScope()])),
    updatedAt: null,
  };
}

function normalizeCards(raw) {
  const cards = {};
  for (const [cardId, entry] of Object.entries(raw ?? {})) {
    const status = text(entry?.status);
    if (!text(cardId) || !isCardStatus(status)) continue;
    cards[cardId] = { status, reviewedAt: text(entry?.reviewedAt) || null };
  }
  return cards;
}

function normalizeScope(raw) {
  const unit = Number(raw?.currentUnit);
  return {
    plan: normalizePlanOptions(raw?.plan ?? {}),
    currentUnit: Number.isFinite(unit) && unit >= 1 ? Math.floor(unit) : 1,
    cards: normalizeCards(raw?.cards),
  };
}

/**
 * 归一化并迁移进度。
 * v1 结构（顶层 cards/plan）会被迁移到默认方向，不丢已有背诵记录。
 */
function normalizeProgress(raw) {
  const base = emptyProgress();
  if (!raw || typeof raw !== 'object') return base;

  const legacyCards = normalizeCards(raw.cards);
  const hasLegacy = Object.keys(legacyCards).length > 0 || (raw.plan && !raw.scopes);
  const scopes = {};
  for (const type of EXAM_TYPES) {
    scopes[type] = normalizeScope(raw.scopes?.[type]);
  }
  if (hasLegacy) {
    const target = normalizeExamType(raw.examType) ?? DEFAULT_SCOPE;
    const existing = scopes[target];
    // 只在目标方向还没有独立记录时迁移，避免覆盖新结构里的数据。
    if (!Object.keys(existing.cards).length) {
      scopes[target] = { plan: normalizePlanOptions(raw.plan ?? {}), currentUnit: normalizeScope(raw).currentUnit, cards: legacyCards };
    }
  }
  return { version: 2, scopes, updatedAt: text(raw.updatedAt) || null };
}

export async function readProgress() {
  if (!existsSync(PROGRESS_FILE)) return emptyProgress();
  try {
    return normalizeProgress(JSON.parse(await readFile(PROGRESS_FILE, 'utf8')));
  } catch {
    // 文件被外部编辑坏掉时不应让整个功能不可用；回退为空进度。
    return emptyProgress();
  }
}

async function writeProgress(progress) {
  const next = { ...normalizeProgress(progress), updatedAt: new Date().toISOString() };
  await mkdir(path.dirname(PROGRESS_FILE), { recursive: true });
  // 同目录临时文件保证 rename 是同一分区上的原子操作。
  const temporary = `${PROGRESS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, PROGRESS_FILE);
  return next;
}

function scopeKey(examType) {
  return normalizeExamType(examType) ?? DEFAULT_SCOPE;
}

/** 读取某个备考方向的进度分片。 */
export async function readScope(examType) {
  const progress = await readProgress();
  return progress.scopes[scopeKey(examType)] ?? emptyScope();
}

/** 更新单张卡片状态。status 为 new 时视为清除记录。 */
export async function setCardStatus(cardId, status, examType) {
  const id = text(cardId);
  if (!id) throw Object.assign(new Error('缺少 cardId。'), { status: 400 });
  if (!isCardStatus(status)) throw Object.assign(new Error(`未知的卡片状态：${status}`), { status: 400 });
  const progress = await readProgress();
  const scope = progress.scopes[scopeKey(examType)];
  if (status === 'new') delete scope.cards[id];
  else scope.cards[id] = { status, reviewedAt: new Date().toISOString() };
  return writeProgress(progress);
}

/** 批量更新，用于成文后一次性标记本篇用到的模板句。 */
export async function setCardStatuses(entries = [], examType) {
  const list = Array.isArray(entries) ? entries : [];
  const progress = await readProgress();
  const scope = progress.scopes[scopeKey(examType)];
  let changed = 0;
  for (const entry of list) {
    const id = text(entry?.cardId);
    const status = text(entry?.status);
    if (!id || !isCardStatus(status)) continue;
    if (status === 'new') delete scope.cards[id];
    else scope.cards[id] = { status, reviewedAt: new Date().toISOString() };
    changed += 1;
  }
  if (!changed) throw Object.assign(new Error('没有可更新的卡片状态。'), { status: 400 });
  return writeProgress(progress);
}

/** 切换计划参数时保留已有卡片状态，避免调整每日量就丢掉背诵成果。 */
export async function setPlanOptions(options = {}, examType) {
  const progress = await readProgress();
  const scope = progress.scopes[scopeKey(examType)];
  scope.plan = normalizePlanOptions(options);
  const unit = Number(options.currentUnit);
  if (Number.isFinite(unit) && unit >= 1) scope.currentUnit = Math.floor(unit);
  return writeProgress(progress);
}

export async function setCurrentUnit(unitIndex, examType) {
  const progress = await readProgress();
  const scope = progress.scopes[scopeKey(examType)];
  const unit = Number(unitIndex);
  scope.currentUnit = Number.isFinite(unit) && unit >= 1 ? Math.floor(unit) : 1;
  return writeProgress(progress);
}

/** 只重置当前备考方向，另一个方向的成果保持不变。 */
export async function resetProgress({ keepPlan = true, examType } = {}) {
  const progress = await readProgress();
  const key = scopeKey(examType);
  const previous = progress.scopes[key];
  progress.scopes[key] = keepPlan
    ? { ...emptyScope(), plan: previous.plan }
    : emptyScope();
  return writeProgress(progress);
}

/** 汇总进度统计，供页面顶部进度条使用。 */
export function summarizeProgress(scope, cards) {
  const counts = { total: cards.length, mastered: 0, review: 0, new: 0 };
  for (const card of cards) {
    const status = scope?.cards?.[card.cardId]?.status ?? 'new';
    if (status === 'mastered') counts.mastered += 1;
    else if (status === 'review') counts.review += 1;
    else counts.new += 1;
  }
  counts.percent = counts.total ? Math.round((counts.mastered / counts.total) * 100) : 0;
  return counts;
}

export { PROGRESS_FILE };

export default {
  readProgress,
  readScope,
  setCardStatus,
  setCardStatuses,
  setPlanOptions,
  setCurrentUnit,
  resetProgress,
  summarizeProgress,
  PROGRESS_FILE,
};
