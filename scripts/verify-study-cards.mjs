import assert from 'node:assert/strict';
import { existsSync, rmSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildStudyCards,
  studyCardOutline,
  buildStudyPlan,
  normalizePlanOptions,
  filterCardsByExamType,
  cardsBySkeletonIds,
  isCardStatus,
  TRACK_ORDER,
  MIN_DAILY_COUNT,
  MAX_DAILY_COUNT,
} from '../lib/study-cards.mjs';
import {
  readProgress,
  readScope,
  setCardStatus,
  setCardStatuses,
  setPlanOptions,
  setCurrentUnit,
  resetProgress,
  summarizeProgress,
  PROGRESS_FILE,
} from '../lib/study-progress.mjs';
import { TEMPLATE_TRACKS, getModule } from '../lib/modules.mjs';
import {
  scopeOfSkeleton,
  visibleTracksFor,
  coreTracksFor,
  priorityOf,
  normalizeExamType,
  SCOPE_SHARED,
} from '../lib/exam-scope.mjs';

// 进度文件是用户数据，验收期间先备份再还原，避免破坏真实背诵记录。
const backup = existsSync(PROGRESS_FILE) ? `${PROGRESS_FILE}.verify-backup` : null;
if (backup) renameSync(PROGRESS_FILE, backup);
const restore = () => {
  if (existsSync(PROGRESS_FILE)) rmSync(PROGRESS_FILE);
  if (backup) renameSync(backup, PROGRESS_FILE);
};

try {
  /* ------------------------------ 卡片派生 ------------------------------ */

  const cards = await buildStudyCards();
  assert.ok(cards.length >= 370, `卡片数量偏少：${cards.length}`);
  assert.equal(new Set(cards.map((card) => card.cardId)).size, cards.length, 'cardId 必须唯一');

  for (const card of cards) {
    assert.ok(card.en, `${card.cardId} 缺少英文骨架`);
    // 讲义原文中有个别条目没有译文，只要如实标注 zhMissing 即可，不得编造翻译。
    assert.equal(Boolean(card.zh) || card.zhMissing === true, true, `${card.cardId} 中文缺失但未标注`);
    assert.ok(TRACK_ORDER.includes(card.track), `${card.cardId} 轨道非法：${card.track}`);
    assert.ok(getModule(card.moduleId), `${card.cardId} 模块非法：${card.moduleId}`);
    assert.ok(Array.isArray(card.slots) && Array.isArray(card.constraints) && Array.isArray(card.variants));
    assert.ok(card.source && typeof card.source === 'object', `${card.cardId} 缺少来源`);
  }

  // 卡片顺序必须等于「轨道顺序 → 模块顺序」，这是按写作顺序背诵的前提。
  for (let index = 1; index < cards.length; index += 1) {
    const previous = cards[index - 1];
    const current = cards[index];
    const trackDelta = TRACK_ORDER.indexOf(current.track) - TRACK_ORDER.indexOf(previous.track);
    assert.ok(trackDelta >= 0, `轨道顺序错乱：${previous.cardId} -> ${current.cardId}`);
    if (trackDelta === 0) {
      assert.ok(current.moduleOrder >= previous.moduleOrder, `模块顺序错乱：${previous.cardId} -> ${current.cardId}`);
    }
  }

  /* ------------------------------ 轨道概览 ------------------------------ */

  const outline = await studyCardOutline();
  assert.equal(outline.length, TEMPLATE_TRACKS.length);
  assert.equal(outline.reduce((sum, track) => sum + track.count, 0), cards.length, '概览计数应等于卡片总数');
  for (const track of outline) {
    const moduleSum = track.modules.reduce((sum, module) => sum + module.count, 0);
    assert.equal(moduleSum, track.count, `${track.id} 模块计数之和应等于轨道计数`);
  }
  // small-format 只讲格式检查、不提供正文模板，允许为 0；其余必需模块必须有卡片。
  for (const track of outline) {
    for (const module of track.modules) {
      if (module.id === 'small-format' || !module.required) continue;
      assert.ok(module.count > 0, `必需模块无卡片：${module.id}`);
    }
  }

  /* ------------------------------ 计划切分 ------------------------------ */

  assert.deepEqual(normalizePlanOptions({}).tracks, [...TRACK_ORDER]);
  assert.equal(normalizePlanOptions({ dailyCount: 1 }).dailyCount, MIN_DAILY_COUNT, '每日量应被钳制到下限');
  assert.equal(normalizePlanOptions({ dailyCount: 999 }).dailyCount, MAX_DAILY_COUNT, '每日量应被钳制到上限');
  assert.equal(normalizePlanOptions({ dailyCount: 'x' }).dailyCount, 8, '非法每日量应回落到默认值');
  // 轨道顺序由实现固定，不受传入顺序影响。
  assert.deepEqual(normalizePlanOptions({ tracks: ['small', 'chart'] }).tracks, ['chart', 'small']);

  const plan = await buildStudyPlan({ dailyCount: 8 });
  assert.equal(plan.totalCards, cards.length);
  assert.equal(plan.totalUnits, Math.ceil(cards.length / 8));
  assert.equal(plan.units.flatMap((unit) => unit.cardIds).length, cards.length, '所有卡片都应落入某个单元');
  assert.equal(new Set(plan.units.flatMap((unit) => unit.cardIds)).size, cards.length, '卡片不得重复出现在多个单元');
  for (const unit of plan.units.slice(0, -1)) {
    assert.equal(unit.cardIds.length, 8, `单元 ${unit.unitIndex} 数量应为 8`);
  }

  const chartOnly = await buildStudyPlan({ tracks: ['chart'], dailyCount: 5 });
  assert.ok(chartOnly.cards.every((card) => card.track === 'chart'), '轨道过滤失效');
  assert.equal(chartOnly.totalUnits, Math.ceil(chartOnly.totalCards / 5));

  const requiredOnly = await buildStudyPlan({ includeOptional: false });
  assert.ok(requiredOnly.totalCards <= plan.totalCards, '排除可选模块后数量不应增加');
  assert.ok(requiredOnly.cards.every((card) => getModule(card.moduleId)?.required !== false), '可选模块未被排除');

  // 缺译文属已知讲义缺口，数量必须可控，防止未来批量丢译文而无人察觉。
  const missingZh = cards.filter((card) => card.zhMissing);
  assert.ok(missingZh.length <= 1, `缺中文译文的卡片过多：${missingZh.map((card) => card.cardId).join(', ')}`);

  assert.ok(isCardStatus('new') && isCardStatus('mastered') && isCardStatus('review'));
  assert.ok(!isCardStatus('unknown') && !isCardStatus(''));

  /* --------------------------- 英一/英二/公共归属 --------------------------- */

  // 归属完全由讲义来源决定，数量必须与题库勘查结果一致，防止来源变动后静默错分。
  const scopeCounts = cards.reduce((acc, card) => {
    acc[card.examScope] = (acc[card.examScope] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(scopeCounts, { shared: 220, e1: 80, e2: 72 }, `归属数量异常：${JSON.stringify(scopeCounts)}`);
  for (const card of cards) {
    assert.ok(['e1', 'e2', 'shared'].includes(card.examScope), `${card.cardId} 归属非法`);
    assert.ok(card.scopeLabel, `${card.cardId} 缺少归属标签`);
  }

  const e1Cards = filterCardsByExamType(cards, 'e1');
  const e2Cards = filterCardsByExamType(cards, 'e2');
  // 英语一看不到英语二专属，反之亦然；公共部分两边都能看到。
  assert.ok(e1Cards.every((card) => card.examScope !== 'e2'), '英语一不应出现英语二专属卡片');
  assert.ok(e2Cards.every((card) => card.examScope !== 'e1'), '英语二不应出现英语一专属卡片');
  assert.equal(e1Cards.filter((card) => card.examScope === SCOPE_SHARED).length > 0, true);
  // 英语二从未考图画大作文，因此不应出现图画卡片。
  assert.equal(e2Cards.some((card) => card.track === 'picture'), false, '英语二不应出现图画轨道');
  // 英语一 2024 混合题、2025 图表题真实考过，图表卡片必须保留可见。
  assert.ok(e1Cards.some((card) => card.track === 'chart'), '英语一应保留图表轨道');
  assert.deepEqual(visibleTracksFor('e2'), ['chart', 'small']);
  assert.deepEqual(coreTracksFor('e1'), ['picture', 'small']);

  // 主线/拓展：英语一的图表属拓展，默认不进计划，从而进度可以真正背满。
  assert.ok(e1Cards.filter((card) => card.priority === 'extended').every((card) => card.track === 'chart'));
  assert.equal(e2Cards.some((card) => card.priority === 'extended'), false, '英语二不应有拓展卡片');
  assert.equal(priorityOf({ track: 'chart' }, 'e1'), 'extended');
  assert.equal(priorityOf({ track: 'chart' }, 'e2'), 'core');

  const e1Plan = await buildStudyPlan({ dailyCount: 8 }, 'e1');
  const e1PlanExtended = await buildStudyPlan({ dailyCount: 8, includeExtended: true }, 'e1');
  assert.ok(e1Plan.cards.every((card) => card.track !== 'chart'), '默认计划不应含拓展轨道');
  assert.ok(e1PlanExtended.totalCards > e1Plan.totalCards, '开启拓展后计划应变大');
  assert.equal(e1Plan.examType, 'e1');
  const e2Plan = await buildStudyPlan({ dailyCount: 8 }, 'e2');
  assert.equal(e2Plan.totalCards, e2Cards.length, '英语二计划应覆盖全部可见卡片');

  // 概览也必须按方向收敛。
  const e2Outline = await studyCardOutline('e2');
  assert.equal(e2Outline.some((track) => track.id === 'picture'), false, '英语二概览不应含图画轨道');
  assert.equal(e2Outline.reduce((sum, track) => sum + track.count, 0), e2Cards.length);

  assert.equal(scopeOfSkeleton({ sourceRefs: [{ source: 'slp-big-e1' }] }), 'e1');
  assert.equal(scopeOfSkeleton({ sourceRefs: [{ source: 'scan-handout' }] }), 'shared');
  // 来源缺失时按通用兜底，避免卡片凭空消失。
  assert.equal(scopeOfSkeleton({}), 'shared');
  assert.equal(normalizeExamType('bogus'), null);

  /* --------------------------- 成文关联反查 --------------------------- */

  const sample = cards.slice(0, 3).map((card) => card.skeletonId);
  const linked = await cardsBySkeletonIds([...sample, 'not-a-skeleton']);
  assert.equal(linked.length, sample.length, '反查应忽略不存在的骨架');
  assert.deepEqual(linked.map((card) => card.skeletonId).sort(), [...sample].sort());
  assert.deepEqual(await cardsBySkeletonIds([]), [], '空输入应返回空数组');

  /* ------------------------------ 进度持久化 ------------------------------ */

  const empty = await readScope('e1');
  assert.deepEqual(empty.cards, {});
  assert.equal(empty.currentUnit, 1);

  const [firstCard, secondCard] = e1Plan.cards;
  await setCardStatus(firstCard.cardId, 'mastered', 'e1');
  await setCardStatus(secondCard.cardId, 'review', 'e1');
  let scope = await readScope('e1');
  assert.equal(scope.cards[firstCard.cardId].status, 'mastered');
  assert.equal(scope.cards[secondCard.cardId].status, 'review');
  assert.ok(scope.cards[firstCard.cardId].reviewedAt, '应记录复习时间');
  assert.ok((await readProgress()).updatedAt, '应记录更新时间');

  const summary = summarizeProgress(scope, e1Plan.cards);
  assert.equal(summary.total, e1Plan.cards.length);
  assert.equal(summary.mastered, 1);
  assert.equal(summary.review, 1);
  assert.equal(summary.new, e1Plan.cards.length - 2);

  // 两个方向的进度必须互不干扰，这样各自都能背满 100%。
  await setCardStatus(e2Plan.cards[0].cardId, 'mastered', 'e2');
  assert.equal(Object.keys((await readScope('e1')).cards).length, 2, '英语二的操作不应影响英语一');
  assert.equal(Object.keys((await readScope('e2')).cards).length, 1, '英语一的操作不应影响英语二');
  assert.equal(summarizeProgress(await readScope('e2'), e2Plan.cards).total, e2Plan.cards.length);

  // 批量标记：成文后一次性写入本篇用到的模板句。
  const batch = e1Plan.cards.slice(2, 6).map((card) => ({ cardId: card.cardId, status: 'mastered' }));
  await setCardStatuses(batch, 'e1');
  assert.equal(summarizeProgress(await readScope('e1'), e1Plan.cards).mastered, 1 + batch.length);
  await assert.rejects(() => setCardStatuses([], 'e1'), /没有可更新的卡片状态/);
  await assert.rejects(() => setCardStatuses([{ cardId: 'x', status: 'bogus' }], 'e1'), /没有可更新的卡片状态/);

  // 切换计划参数必须保留已有背诵状态。
  const beforePlanSwitch = Object.keys((await readScope('e1')).cards).length;
  await setPlanOptions({ tracks: ['picture'], dailyCount: 5, includeOptional: false }, 'e1');
  scope = await readScope('e1');
  assert.deepEqual(scope.plan, { tracks: ['picture'], dailyCount: 5, includeOptional: false, includeExtended: false });
  assert.equal(Object.keys(scope.cards).length, beforePlanSwitch, '切换计划不应丢失卡片状态');

  scope = (await setCurrentUnit(3, 'e1')).scopes.e1;
  assert.equal(scope.currentUnit, 3);
  scope = (await setCurrentUnit(-5, 'e1')).scopes.e1;
  assert.equal(scope.currentUnit, 1, '非法单元应回落为 1');

  // status=new 视为清除记录
  await setCardStatus(firstCard.cardId, 'new', 'e1');
  scope = await readScope('e1');
  assert.equal(scope.cards[firstCard.cardId], undefined);
  assert.equal(scope.cards[secondCard.cardId].status, 'review');

  await assert.rejects(() => setCardStatus('', 'mastered', 'e1'), /缺少 cardId/);
  await assert.rejects(() => setCardStatus(firstCard.cardId, 'bogus', 'e1'), /未知的卡片状态/);

  // 重置只影响当前方向。
  await resetProgress({ keepPlan: true, examType: 'e1' });
  assert.deepEqual((await readScope('e1')).cards, {});
  assert.deepEqual((await readScope('e1')).plan.tracks, ['picture'], '重置应保留计划');
  assert.equal(Object.keys((await readScope('e2')).cards).length, 1, '重置英语一不应影响英语二');
  await resetProgress({ keepPlan: false, examType: 'e1' });
  assert.deepEqual((await readScope('e1')).plan.tracks, [...TRACK_ORDER], '不保留计划时应回到默认');

  // 进度文件被外部改坏时必须降级为空进度，而不是让功能崩掉。
  writeFileSync(PROGRESS_FILE, '{ not json', 'utf8');
  assert.deepEqual((await readScope('e1')).cards, {});
  // 非法状态与非法字段应在读取时被过滤。
  writeFileSync(PROGRESS_FILE, JSON.stringify({ version: 2, scopes: { e1: { cards: { a: { status: 'bogus' }, b: { status: 'mastered' } }, currentUnit: 'x' } } }), 'utf8');
  const filtered = await readScope('e1');
  assert.deepEqual(Object.keys(filtered.cards), ['b']);
  assert.equal(filtered.currentUnit, 1);

  // 旧版 v1 文件必须迁移到默认方向，不丢已有背诵记录。
  writeFileSync(PROGRESS_FILE, JSON.stringify({
    version: 1,
    plan: { tracks: ['chart'], dailyCount: 12 },
    currentUnit: 3,
    cards: { 'card-legacy-1': { status: 'mastered' }, 'card-legacy-2': { status: 'review' } },
  }), 'utf8');
  const migrated = await readProgress();
  assert.equal(migrated.version, 2);
  assert.deepEqual(Object.keys(migrated.scopes.e1.cards).sort(), ['card-legacy-1', 'card-legacy-2']);
  assert.equal(migrated.scopes.e1.plan.dailyCount, 12, '迁移应保留旧计划');
  assert.equal(migrated.scopes.e1.currentUnit, 3);
  assert.deepEqual(migrated.scopes.e2.cards, {}, '迁移不应污染另一个方向');

  // 原子写入：写完后文件应是合法 JSON。
  await resetProgress({ keepPlan: false, examType: 'e1' });
  await setCardStatus(secondCard.cardId, 'mastered', 'e1');
  JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));

  console.log(`study-cards verification passed: cards=${cards.length}, scope=shared220/e1-80/e2-72, e1=${e1Plan.totalCards}(+${e1PlanExtended.totalCards - e1Plan.totalCards}拓展), e2=${e2Plan.totalCards}, progress=isolated+migrated`);
} finally {
  restore();
}
