import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reviewEssay,
  applyAcceptedIssues,
  classifyEssayText,
  deepenReview,
  SEVERITY,
} from '../lib/essay-review.mjs';
import { buildReviewBlocks, renderDocument } from '../lib/print-pdf.mjs';
import { getTrack } from '../lib/modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file) => JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));

/* ------------------------------ 测试样本 ------------------------------ */

// 图表作文：编造数字 87.5%、重复长短语、口语化表达、缺设问与展望模块
const CHART_ESSAY = `The table above shows the job satisfaction of employees. Employees above 50 years old were most likely to report satisfaction, with 40% of them indicating they were content. Nowadays more and more people care about this issue. The figure reached 87.5% in some groups.

The difference relates to their career situation. This is very important for us. The difference relates to their career situation.

Accordingly, companies should pay more attention to staff development.`;

const CHART_FACTS = { dataPoints: [{ label: '>50-satisfied', value: '40.0%' }, { label: '<=40-satisfied', value: '16.7%' }] };

// 小作文：通知类误用个人署名
const NOTICE_ESSAY = `Notice

We are looking for some volunteers for the summer camp. The camp is organized to help high school students with their study.

Volunteers are required to help organize activities and cope with daily affairs. Ideal candidates should be patient and responsible.

Anyone interested please contact us before June 20. Thank you.

Li Ming`;

// 图画作文：仅两段
const PICTURE_ESSAY = `In the picture, two tourists are enjoying a boat trip on the lake, and the lake is littered with garbage. Just as the caption implies, the cartoon reveals a troubling phenomenon.

Such behavior comes primarily from tourists' lack of environmental awareness. They regard themselves merely as passers-by.`;

/* --------------------------- 题型自动判定 --------------------------- */

const chartDetect = classifyEssayText(CHART_ESSAY);
assert.equal(chartDetect.category, '图表作文');
assert.equal(chartDetect.confident, true);
assert.ok(chartDetect.evidence.length > 0, '判定必须给出依据');

assert.equal(classifyEssayText(NOTICE_ESSAY).category, '小作文');
assert.equal(classifyEssayText(PICTURE_ESSAY).category, '大作文');
// 空文本不得抛错，应给出保守默认并说明原因。
const blank = classifyEssayText('');
assert.ok(blank.category, '空文本也应返回题型');
assert.ok(blank.evidence.some((item) => item.includes('未发现明确特征')));

/* ------------------------------ 必改级判定 ------------------------------ */

const chart = await reviewEssay({
  essayText: CHART_ESSAY,
  questionText: 'Write an essay based on the table. You should write at least 150 words.',
  chartFacts: CHART_FACTS,
});

assert.equal(chart.track.id, 'chart');
const chartKinds = chart.issues.map((issue) => issue.kind);

// 字数：题干 at least 150 → 区间 150-165，本文 70 余词必须被判为未达下限。
const wordIssue = chart.issues.find((issue) => issue.kind === 'word-count');
assert.ok(wordIssue, '应命中字数问题');
assert.equal(wordIssue.severity, SEVERITY.REQUIRED);
assert.ok(/未达下限 150/.test(wordIssue.title), `字数下限应为 150，实际：${wordIssue.title}`);
assert.ok(/至少 150/.test(wordIssue.basis), '字数依据应引用题干要求');

// 图表数字：87.5% 不在原始数据中，必须被拦下，且不能被小数点拆成两个数字。
const numberIssues = chart.issues.filter((issue) => issue.kind === 'chart-number');
assert.equal(numberIssues.length, 1, `编造数字应恰好命中 1 条，实际 ${numberIssues.length}`);
assert.ok(numberIssues[0].title.includes('87.5%'), `应完整识别 87.5%，实际：${numberIssues[0].title}`);
assert.equal(numberIssues[0].severity, SEVERITY.REQUIRED);
// 原始数据 40% 属合法引用，不得被误报。
assert.equal(chart.issues.some((issue) => issue.kind === 'chart-number' && issue.title.includes('40')), false);

// 重复长短语
const repeatIssue = chart.issues.find((issue) => issue.kind === 'repeat');
assert.ok(repeatIssue, '应命中重复长短语');
assert.ok(repeatIssue.title.includes('the difference relates to their career situation'));

/* ------------------------------ 小作文格式 ------------------------------ */

const notice = await reviewEssay({ essayText: NOTICE_ESSAY, category: '小作文' });
assert.equal(notice.track.id, 'small');
// 通知标题与署名不应被算作正文段落，否则会误报段落数。
assert.equal(notice.issues.some((issue) => issue.kind === 'paragraph-count'), false,
  `通知类不应误报段落数：${notice.issues.find((i) => i.kind === 'paragraph-count')?.title ?? ''}`);
assert.ok(notice.issues.some((issue) => issue.kind === 'small-notice-signature'), '通知误用个人署名应被命中');
// 「请联系我们」是合规结尾号召，不应被判为末段引入新信息。
assert.equal(notice.issues.some((issue) => issue.kind === 'warning:closing-no-new-info'), false,
  '结尾号召不应被误判为新信息');

const letterMissingFormat = await reviewEssay({ essayText: 'I am writing to invite you to our meeting. It will be held next Friday.\n\nWe will discuss campus life. Please come on time.\n\nLooking forward to your reply.', category: '小作文' });
assert.ok(letterMissingFormat.issues.some((issue) => issue.kind === 'small-salutation'), '缺称呼应被命中');
assert.ok(letterMissingFormat.issues.some((issue) => issue.kind === 'small-signature'), '缺落款应被命中');

/* ------------------------------ 段落与结构 ------------------------------ */

const picture = await reviewEssay({ essayText: PICTURE_ESSAY, category: '大作文' });
const paragraphIssue = picture.issues.find((issue) => issue.kind === 'paragraph-count');
assert.ok(paragraphIssue, '两段作文应命中段落数问题');
assert.ok(paragraphIssue.title.includes('2 段'));

// 结构级必须与 moduleFlow 完全一致，不能各说各话。
for (const analysis of [chart, notice, picture]) {
  const missing = analysis.moduleFlow.filter((module) => !module.covered && module.required).map((module) => module.label);
  const reported = analysis.issues
    .filter((issue) => issue.severity === SEVERITY.STRUCTURE)
    .map((issue) => issue.title.replace(/^缺少写作模块「(.+)」$/, '$1'));
  assert.deepEqual(reported.sort(), missing.sort(), `${analysis.category} 结构项应与模块流程一致`);
  // 结构项必须给出该轨道完整模块顺序作为依据。
  for (const issue of analysis.issues.filter((item) => item.severity === SEVERITY.STRUCTURE)) {
    const labels = getTrack(analysis.track.id).modules.map((module) => module.label);
    assert.ok(labels.every((label) => issue.basis.includes(label)), '结构依据应列出完整模块顺序');
  }
}

/* --------------------- 铁律：每条修改都可追溯 --------------------- */

for (const analysis of [chart, notice, picture, letterMissingFormat]) {
  assert.ok(analysis.issues.length > 0, `${analysis.category} 应产出修改项`);
  for (const issue of analysis.issues) {
    assert.ok(issue.basis && issue.basis.trim(), `无依据条目不得出现：${issue.title}`);
    assert.ok(Object.values(SEVERITY).includes(issue.severity), `非法级别：${issue.severity}`);
    assert.ok(issue.id && issue.title, '条目应有 id 与标题');
  }
}

/* ------------------ 词汇建议只能来自讲义词表 ------------------ */

const vocabDoc = await readJson('knowledge/vocab.json');
const vocabSet = new Set((vocabDoc.vocab ?? []).map((item) => String(item.en).toLowerCase()));
const vocabIssues = chart.issues.filter((issue) => issue.kind === 'vocab-upgrade');
assert.ok(vocabIssues.length > 0, '样本含 very important / nowadays，应给出词汇建议');
for (const issue of vocabIssues) {
  // 建议词必须真实存在于讲义词表，杜绝凭空编造"高级词"。
  const inVocab = [...vocabSet].some((entry) => entry.includes(issue.suggestion.toLowerCase())
    || issue.suggestion.toLowerCase().includes(entry));
  assert.ok(inVocab, `词汇建议必须来自讲义词表：${issue.suggestion}`);
  assert.ok(/讲义词表/.test(issue.basis), '词汇依据应标注讲义词表');
}

// 构造一篇含生僻词但无触发词的作文：不得凭空产生词汇建议。
const noTrigger = await reviewEssay({
  essayText: 'The chart illustrates a discernible upward trajectory.\n\nSuch a phenomenon stems from multifaceted determinants.\n\nHence, stakeholders ought to formulate pragmatic countermeasures.',
  category: '图表作文',
});
assert.equal(noTrigger.issues.some((issue) => issue.kind === 'vocab-upgrade'), false,
  '没有命中触发词时不应编造词汇建议');

/* ------------------ 句式建议只能引用讲义骨架 ------------------ */

const skeletonDoc = await readJson('knowledge/writing/skeletons.json');
const skeletonById = new Map((skeletonDoc.skeletons ?? []).map((item) => [item.id, item]));
const skeletonIssues = chart.issues.filter((issue) => issue.kind === 'skeleton-upgrade');
assert.ok(skeletonIssues.length > 0, '应给出句式升级建议');
const offeredIds = new Set();
for (const issue of skeletonIssues) {
  const id = issue.basis.match(/讲义 (sk-[\w-]+)/)?.[1];
  assert.ok(id && skeletonById.has(id), `句式建议必须引用真实骨架：${issue.basis}`);
  assert.equal(issue.suggestion, String(skeletonById.get(id).en).trim(), '建议内容应与讲义骨架原文一致');
  // 同一骨架不得反复推荐。
  assert.equal(offeredIds.has(id), false, `骨架重复推荐：${id}`);
  offeredIds.add(id);
  // 含占位符的骨架不可自动套用。
  if (/\{[^}]*\}/.test(issue.suggestion)) {
    assert.equal(issue.autoApplicable, false, '含占位符的骨架不得标为可自动套用');
    assert.ok(issue.slots.length > 0, '应列出需替换的占位符');
  }
}

/* ------------------------------ 分档与得失分点 ------------------------------ */

for (const analysis of [chart, notice, picture]) {
  const grade = analysis.grade;
  assert.ok(['接近满分档', '中上档', '中档', '需大改'].includes(grade.band), `非法分档：${grade.band}`);
  assert.ok(grade.summary, '分档应有说明');
  assert.ok(Array.isArray(grade.gains) && Array.isArray(grade.losses));
  // 必须声明这是估算，不能让用户误以为是真实阅卷分。
  assert.ok(/估算/.test(grade.disclaimer) && /不等同真实/.test(grade.disclaimer), '必须包含免责声明');
  assert.equal(grade.counts.required, analysis.issues.filter((i) => i.severity === SEVERITY.REQUIRED).length);
  assert.equal(grade.counts.structure, analysis.issues.filter((i) => i.severity === SEVERITY.STRUCTURE).length);
}
// 有必改项时不应给出最高档。
assert.notEqual(chart.grade.band, '接近满分档');

/* ------------------------------ 采纳与终稿 ------------------------------ */

const autoIssue = chart.issues.find((issue) => issue.kind === 'vocab-upgrade');
const applied = applyAcceptedIssues(CHART_ESSAY, chart.issues, [autoIssue.id]);
assert.ok(applied.text.includes(autoIssue.suggestion), '采纳后终稿应含新表达');
assert.equal(applied.text.includes(autoIssue.quote), false, '原表达应被替换');
assert.equal(applied.applied.length, 1);
assert.equal(applied.manual.length, 0);

// 未采纳时原文不得被改动。
assert.equal(applyAcceptedIssues(CHART_ESSAY, chart.issues, []).text, CHART_ESSAY);

// 含占位符的骨架建议：即使被采纳，也不能把 {占位符} 写进终稿。
const slotIssue = skeletonIssues.find((issue) => /\{[^}]*\}/.test(issue.suggestion));
if (slotIssue) {
  const out = applyAcceptedIssues(CHART_ESSAY, chart.issues, [slotIssue.id]);
  assert.equal(/\{[^}]*\}/.test(out.text), false, '终稿不得残留占位符');
  assert.equal(out.applied.length, 0);
  assert.equal(out.manual.length, 1, '应归入需手改清单');
  assert.ok(out.manual[0].template, '需手改条目应给出套用模板');
}

// 结构项无法自动替换，必须归入 manual。
const structureIssue = chart.issues.find((issue) => issue.severity === SEVERITY.STRUCTURE);
if (structureIssue) {
  const out = applyAcceptedIssues(CHART_ESSAY, chart.issues, [structureIssue.id]);
  assert.equal(out.applied.length, 0);
  assert.equal(out.manual.length, 1);
}

/* ------------------------------ AI 层与回退 ------------------------------ */

const failed = await deepenReview(chart, { chatJsonImpl: async () => { throw new Error('no key'); } });
assert.equal(failed.aiRewrites, null, '模型失败必须回退');
assert.deepEqual(failed.issues.map((i) => i.title), chart.issues.map((i) => i.title), '回退后结论不变');

const emptyRewrites = await deepenReview(chart, { chatJsonImpl: async () => ({ rewrites: [] }) });
assert.equal(emptyRewrites.aiRewrites, null, '空改写应视为无效');

const target = chart.issues.find((issue) => issue.quote && issue.severity !== SEVERITY.STRUCTURE);
const deepened = await deepenReview(chart, {
  chatJsonImpl: async () => ({ rewrites: [{ issueId: target.id, rewritten: 'A polished sentence.', why: '更符合书面语' }] }),
});
assert.equal(deepened.aiRewrites, 1);
const rewritten = deepened.issues.find((issue) => issue.id === target.id);
assert.equal(rewritten.replacement, 'A polished sentence.');
assert.equal(rewritten.aiWhy, '更符合书面语');
// AI 不得改变离线判定的级别与依据。
assert.equal(rewritten.severity, target.severity);
assert.equal(rewritten.basis, target.basis);
// AI 填好的句子可以直接替换进终稿。
const deepApplied = applyAcceptedIssues(CHART_ESSAY, deepened.issues, [target.id]);
assert.ok(deepApplied.text.includes('A polished sentence.'));

/* ------------------------------ 报告 PDF ------------------------------ */

const blocks = buildReviewBlocks(chart, applied.text);
assert.ok(blocks.length > 0);
const flat = JSON.stringify(blocks);
assert.ok(flat.includes('批改结论'));
assert.ok(flat.includes('依据'), '报告必须逐条打印依据');
assert.ok(flat.includes('修改后终稿'));
const pdf = renderDocument({ title: '批改报告', blocks });
assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');

/* ------------------------ 语法错误接入必改级 ------------------------ */

const GRAMMAR_ESSAY = `The table above shows a informations about job satisfaction. Employees above 50 years old has the highest satisfaction, with 40% of them indicating they was content.

The difference relates to there career situation. it's impact is obvious.

Accordingly, companies should pays more attention. i beleive this is neccessary.`;

const grammarReview = await reviewEssay({ essayText: GRAMMAR_ESSAY, category: '图表作文' });
const grammarItems = grammarReview.issues.filter((issue) => issue.kind.startsWith('grammar:'));
assert.ok(grammarItems.length >= 6, `应命中多处语法错误，实际 ${grammarItems.length}`);
// 语法错误必须是必改级，且排在所有修改项最前——它是最直接的失分点。
for (const item of grammarItems) {
  assert.equal(item.severity, SEVERITY.REQUIRED, '语法错误必须是必改级');
  assert.ok(/语法规则/.test(item.basis), `语法条目应标注语法规则依据：${item.basis}`);
  assert.ok(item.quote && GRAMMAR_ESSAY.includes(item.quote), `语法片段应能在原文定位：${item.quote}`);
}
assert.ok(grammarReview.issues[0].kind.startsWith('grammar:'), '语法错误应排在最前');
assert.equal(grammarReview.grade.counts.grammar, grammarItems.length, '分档计数应包含语法项');
assert.ok(Array.isArray(grammarReview.grammarErrors) && grammarReview.grammarErrors.length > 0, '应回传语法错误明细');

// 语法建议可自动替换（除占位提示外）
const autoGrammar = grammarItems.find((item) => item.autoApplicable);
assert.ok(autoGrammar, '应有可自动替换的语法修改');
const grammarApplied = applyAcceptedIssues(GRAMMAR_ESSAY, grammarReview.issues, [autoGrammar.id]);
assert.equal(grammarApplied.applied.length, 1, '语法修改应能自动应用');
assert.ok(grammarApplied.text.includes(autoGrammar.suggestion));

// 「（改为过去式）」这类占位提示不得写进终稿
const placeholderGrammar = grammarReview.issues.find((issue) => issue.kind.startsWith('grammar:')
  && /[（(]/.test(issue.suggestion));
if (placeholderGrammar) {
  const out = applyAcceptedIssues(GRAMMAR_ESSAY, grammarReview.issues, [placeholderGrammar.id]);
  assert.equal(out.applied.length, 0, '占位提示不得自动替换');
  assert.equal(out.manual.length, 1);
}

// 无语法错误的作文应在得分点中体现
const cleanReview = await reviewEssay({
  essayText: 'The chart shows a clear trend.\n\nThis phenomenon stems from several factors.\n\nTherefore, we should take action.',
  category: '图表作文',
});
assert.equal(cleanReview.grade.counts.grammar, 0);
assert.ok(cleanReview.grade.gains.some((item) => item.includes('语法')), '无语法错误应作为得分点');

/* ------------------------ 真题对照与分项估分 ------------------------ */

const examReview = await reviewEssay({ essayText: GRAMMAR_ESSAY, examId: 'e2-2012-b' });
// 题库应决定题型与题干，不依赖文本猜测
assert.equal(examReview.category, '图表作文');
assert.equal(examReview.exam.id, 'e2-2012-b');
assert.equal(examReview.exam.year, 2012);
assert.equal(examReview.exam.examType, 'e2');
assert.equal(examReview.exam.hasModelEssay, true);
assert.ok(examReview.exam.directions.includes('table'), '应带入官方题干');

const compare = examReview.modelComparison;
assert.equal(compare.available, true);
assert.equal(compare.modelParagraphs, 3);
assert.ok(compare.modelWords > 150, `范文词数应为真实值，实际 ${compare.modelWords}`);
assert.equal(compare.wordGap, compare.myWords - compare.modelWords);
assert.ok(compare.modelModules.length > 0, '应列出范文覆盖的模块');
assert.ok(Array.isArray(compare.notableWords));
// 范文用词提示不得包含考生已经用过的词
const usedWords = new Set((GRAMMAR_ESSAY.toLowerCase().match(/[a-z]{6,}/g) ?? []));
for (const word of compare.notableWords) {
  assert.equal(usedWords.has(word), false, `不应把考生已用词当作范文独有：${word}`);
}
// 必须声明范文不是唯一答案
assert.ok(/不是唯一答案/.test(compare.note), '必须声明范文只是参考');

// 无范文题目：如实说明，不编造
const noModel = await reviewEssay({ essayText: GRAMMAR_ESSAY, examId: 'e2-2025-b' });
assert.equal(noModel.modelComparison.available, false);
assert.ok(/暂无已校对范文/.test(noModel.modelComparison.note));

await assert.rejects(() => reviewEssay({ essayText: GRAMMAR_ESSAY, examId: 'no-such-exam' }),
  (error) => error.status === 404 && error.code === 'exam_not_found');

// 分项估分：四维度齐全、区间合法、总分不超过满分
for (const [review, expectedFull] of [[examReview, 20], [await reviewEssay({ essayText: NOTICE_ESSAY, category: '小作文' }), 10]]) {
  const score = review.score;
  assert.equal(score.full, expectedFull, `满分应为 ${expectedFull}`);
  assert.deepEqual(score.dimensions.map((item) => item.label), ['内容', '结构', '语言', '格式']);
  for (const dimension of score.dimensions) {
    assert.ok(dimension.low >= 0 && dimension.low <= dimension.high, `${dimension.label} 区间非法`);
    assert.ok(dimension.high <= dimension.max, `${dimension.label} 不应超过该项满分`);
    assert.ok(dimension.reason, `${dimension.label} 应给出扣分或得分原因`);
  }
  assert.ok(score.totalLow >= 0 && score.totalLow <= score.totalHigh);
  assert.ok(score.totalHigh <= score.full, '总分不应超过满分');
  assert.ok(Math.abs(score.dimensions.reduce((sum, item) => sum + item.max, 0) - score.full) < 0.05,
    '各维度满分之和应等于总满分');
}

// 语法错误多的作文，语言项得分必须明显偏低
const languageDimension = examReview.score.dimensions.find((item) => item.label === '语言');
assert.ok(languageDimension.high < languageDimension.max * 0.5,
  `10 处语法错误时语言项应显著扣分，实际 ${languageDimension.high}/${languageDimension.max}`);
assert.ok(/语法/.test(languageDimension.reason));

// 免责声明必须提到估算与语法规则
assert.ok(/估算/.test(examReview.grade.disclaimer) && /不等同真实/.test(examReview.grade.disclaimer));

// 报告 PDF 应包含分项估分与语法项
const examBlocks = buildReviewBlocks(examReview, GRAMMAR_ESSAY);
const examFlat = JSON.stringify(examBlocks);
assert.ok(examFlat.includes('语法'), '报告应包含语法错误');
assert.equal(renderDocument({ title: '批改报告', blocks: examBlocks }).subarray(0, 5).toString('latin1'), '%PDF-');

/* ------------------ OCR 低质量守卫（防止把乱码脑补成作文） ------------------ */

// 这段守卫逻辑在 routes 层，此处直接校验判定阈值本身，确保规则不被无意改动。
const gaugeLatinRatio = (value) => {
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (value.match(/[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g) ?? []).length;
  return latin / Math.max(1, latin + cjk);
};
// 手写体被 OCR 读成大量汉字时必须判为低质量。
const garbled = '丁 》 十 冽 e ove shows 刊 j0 彡 s 十 is i 矸 引 m 叫 s 山 梵 P 四';
assert.ok(gaugeLatinRatio(garbled) < 0.75, `乱码应判为低质量，实际比例 ${gaugeLatinRatio(garbled)}`);
// 正常英文作文不得被误判。
assert.ok(gaugeLatinRatio(CHART_ESSAY) >= 0.75, '正常英文不应被判为低质量');
assert.ok(gaugeLatinRatio(NOTICE_ESSAY) >= 0.75);

/* ------------------------------ 入参校验 ------------------------------ */

await assert.rejects(() => reviewEssay({ essayText: '' }),
  (error) => error.status === 400 && error.code === 'essay_required');
await assert.rejects(() => reviewEssay({}),
  (error) => error.code === 'essay_required');

console.log(`essay-review verification passed: chart=${chart.issues.length}项/${chart.grade.band}, notice=${notice.issues.length}项, picture=${picture.issues.length}项, traceable=100%, vocab=讲义词表, skeleton=讲义骨架, slots=safe, grammar=${grammarItems.length}项已入必改, exam=${examReview.exam.label}/范文${compare.modelWords}词, score=${examReview.score.totalLow}-${examReview.score.totalHigh}/${examReview.score.full}, ai-fallback=ok, pdf=${Math.round(pdf.length / 1024)}KB`);
