import assert from 'node:assert/strict';
import { analyzeExamEssay, analyzeComposedEssay, deepenAnalysis, PARAGRAPH_BLUEPRINT } from '../lib/essay-analysis.mjs';
import { list as listExams, detail as examDetail } from '../lib/exams.mjs';
import { getTrack } from '../lib/modules.mjs';

/* --------------------------- 三种题型的结构解析 --------------------------- */

const chart = await analyzeExamEssay('e2-2012-b');
assert.equal(chart.track.id, 'chart');
assert.equal(chart.hasModelEssay, true);
assert.equal(chart.paragraphs.length, 3);
assert.equal(chart.blueprint.length, 3);
assert.ok(chart.totalWords > 100, `图表范文词数异常：${chart.totalWords}`);

// 图表题：首段描述数据，第二段归因，第三段建议或展望。
const chartRoles = chart.paragraphs.map((paragraph) => paragraph.sentences.map((sentence) => sentence.role));
assert.ok(chartRoles[0].includes('data-point'), '图表首段应含数据描述句');
assert.ok(chartRoles[1].some((role) => role === 'cause-analysis' || role === 'impact-analysis'), '图表第二段应含原因或影响分析');
assert.ok(chartRoles[2].some((role) => role === 'advice' || role === 'outlook'), '图表第三段应含建议或展望');
// 年龄等标签数字不得被当成图表数据引用。
const chartFactNotes = chart.paragraphs.flatMap((p) => p.sentences.map((s) => s.factNote)).filter(Boolean);
assert.ok(chartFactNotes.some((note) => note.includes('%')), '数据句应标注引用到的百分比');

const picture = await analyzeExamEssay('e1-2011-b');
assert.equal(picture.track.id, 'picture');
const pictureRoles = picture.paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.role));
assert.ok(pictureRoles.includes('scene-description'), '图画题应识别客观描图句');
assert.ok(pictureRoles.includes('caption-reading'), '图画题应识别图中文字解读句');
assert.ok(pictureRoles.includes('theme-statement'), '图画题应识别寓意点题句');
assert.ok(pictureRoles.at(-1) === 'outlook', `图画题末句应为展望收束，实际 ${pictureRoles.at(-1)}`);

const small = await analyzeExamEssay('e2-2015-a');
assert.equal(small.track.id, 'small');
const smallRoles = small.paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.role));
assert.ok(smallRoles.includes('purpose'), '小作文应识别写作目的句');
assert.ok(smallRoles.includes('requirement-detail'), '小作文应识别事项说明句');
assert.ok(smallRoles.includes('signature'), '小作文应识别格式落款');

/* ------------------------------ 逐句解析质量 ------------------------------ */

for (const analysis of [chart, picture, small]) {
  const blueprint = PARAGRAPH_BLUEPRINT[analysis.track.id];
  assert.ok(blueprint?.length === 3, `${analysis.track.id} 缺少段落骨架`);
  for (const paragraph of analysis.paragraphs) {
    assert.ok(paragraph.name, '段落缺少名称');
    assert.ok(paragraph.purpose, '段落缺少任务说明');
    assert.ok(paragraph.sentences.length > 0, '段落没有句子');
    assert.equal(paragraph.words, paragraph.sentences.reduce((sum, item) => sum + item.words, 0), '段落词数应等于句子之和');
    for (const sentence of paragraph.sentences) {
      assert.ok(sentence.text, '句子文本为空');
      assert.ok(sentence.roleLabel, `${sentence.text.slice(0, 20)} 缺少功能标签`);
      assert.ok(sentence.why && sentence.why.length >= 10, `${sentence.text.slice(0, 20)} 缺少行文解释`);
      assert.ok(Array.isArray(sentence.skeletons), '骨架引用应为数组');
      // 骨架引用必须可追溯到讲义来源。
      for (const skeleton of sentence.skeletons) {
        assert.ok(skeleton.skeletonId, '骨架引用缺少 id');
        assert.ok(skeleton.en, '骨架引用缺少原句');
        assert.ok(skeleton.source && 'page' in skeleton.source, '骨架引用缺少来源页');
      }
    }
  }
  // 字数分配百分比之和应接近 100。
  const percentSum = analysis.wordDistribution.reduce((sum, item) => sum + item.percent, 0);
  assert.ok(Math.abs(percentSum - 100) <= 2, `字数分配百分比异常：${percentSum}`);
  // 模块覆盖必须覆盖该轨道的全部模块项。
  const trackModules = getTrack(analysis.track.id).modules.map((module) => module.id);
  assert.deepEqual(analysis.moduleCoverage.map((item) => item.id), trackModules, '模块覆盖应列出该轨道全部模块');
}

/* ------------------------------ 无范文降级 ------------------------------ */

const noEssay = await analyzeExamEssay('e1-2025-b');
assert.equal(noEssay.hasModelEssay, false);
assert.equal(noEssay.paragraphs.length, 0, '无范文时不得生成段落');
assert.ok(noEssay.blueprint.length === 3, '无范文时仍应给出行文骨架');
assert.ok(noEssay.notes.some((note) => note.includes('暂无已校对范文')), '无范文应给出明确提示');

await assert.rejects(() => analyzeExamEssay('not-a-real-exam'), (error) => error.status === 404 && error.code === 'exam_not_found');

/* ------------------------------ AI 深化与回退 ------------------------------ */

// 模型不可用时必须静默回退到离线结论。
const failed = await deepenAnalysis(chart, { chatJsonImpl: async () => { throw new Error('no key'); } });
assert.equal(failed.aiInsight, null);
assert.equal(failed.paragraphs.length, chart.paragraphs.length);

// 返回空 summary 视为无效结果，同样回退。
const emptySummary = await deepenAnalysis(chart, { chatJsonImpl: async () => ({ summary: '', paragraphNotes: [] }) });
assert.equal(emptySummary.aiInsight, null);

const deepened = await deepenAnalysis(chart, {
  chatJsonImpl: async () => ({
    summary: '先描述数据，再归因，最后给建议并展望。',
    paragraphNotes: [{ index: 2, note: '原因段用了对比结构。' }, { index: 99, note: '越界段落应被忽略。' }],
    pitfalls: ['不要在首段分析原因'],
  }),
});
assert.equal(deepened.aiInsight.summary, '先描述数据，再归因，最后给建议并展望。');
assert.deepEqual(deepened.aiInsight.pitfalls, ['不要在首段分析原因']);
assert.equal(deepened.paragraphs[1].aiNote, '原因段用了对比结构。');
assert.equal(deepened.paragraphs[0].aiNote, null, '未提供备注的段落应为 null');
// AI 层不得篡改离线的功能判定。
assert.deepEqual(
  deepened.paragraphs.map((p) => p.sentences.map((s) => s.role)),
  chart.paragraphs.map((p) => p.sentences.map((s) => s.role)),
  'AI 深化不得改变离线功能判定',
);
// 无范文题目不做 AI 深化，避免凭空生成范文。
assert.equal((await deepenAnalysis(noEssay, { chatJsonImpl: async () => ({ summary: '不应生效' }) })).aiInsight, null);

/* ------------------------------ 全库稳定性 ------------------------------ */

const exams = await listExams({ limit: 1000 });
let withModel = 0;
let withoutModel = 0;
for (const item of exams) {
  const analysis = await analyzeExamEssay(item.id);
  const exam = await examDetail(item.id);
  const expected = (exam.modelEssay?.paragraphs ?? []).length > 0;
  assert.equal(analysis.hasModelEssay, expected, `${item.id} 范文标记与题库不一致`);
  if (expected) withModel += 1; else withoutModel += 1;
  for (const paragraph of analysis.paragraphs) {
    for (const sentence of paragraph.sentences) {
      assert.ok(sentence.roleLabel && sentence.why, `${item.id} 存在未解析的句子`);
    }
  }
}
assert.equal(withModel + withoutModel, exams.length);
assert.ok(withModel >= 60, `有范文题目偏少：${withModel}`);

/* --------------------------- 模块流程条（组装思想） --------------------------- */

for (const analysis of [chart, picture, small]) {
  const flow = analysis.moduleFlow;
  const trackModules = getTrack(analysis.track.id).modules;
  assert.equal(flow.length, trackModules.length, `${analysis.track.id} 模块流程条应覆盖全部模块`);
  assert.deepEqual(flow.map((item) => item.id), trackModules.map((item) => item.id), '模块顺序应与写作顺序一致');
  for (const module of flow) {
    assert.equal(typeof module.covered, 'boolean');
    assert.ok(Array.isArray(module.sentences));
    // 已覆盖的模块必须能指出由哪几句承担；未覆盖的必须给出可执行建议。
    if (module.covered) assert.ok(module.sentences.length > 0 && !module.suggestion);
    else assert.ok(module.suggestion.includes(module.label), `${module.id} 缺失时应给出补写建议`);
  }
  assert.ok(flow.some((module) => module.covered), `${analysis.track.id} 至少应有模块被覆盖`);
}

/* --------------------------- 成文后解析（复盘入口） --------------------------- */

await assert.rejects(() => analyzeComposedEssay({ essay: { paragraphs: [] } }),
  (error) => error.status === 400 && error.code === 'essay_required');

// 用已校对范文伪装成成文结果，验证与真题解析共用同一套判定。
const boundSkeletonId = 'sk-slp-chart-open-e2-02';
const composedInput = {
  essay: {
    paragraphs: chart.paragraphs.map((paragraph, paragraphIndex) => ({
      name: paragraph.name,
      sentences: paragraph.sentences.map((sentence) => sentence.text),
      // 第一段第一句给出精确绑定，其余留空以验证"未套模板"的如实标注。
      sentenceSources: paragraph.sentences.map((_, index) => ({
        skeletonId: paragraphIndex === 0 && index === 0 ? boundSkeletonId : null,
      })),
    })),
  },
  classification: { category: '图表作文' },
  facts: { chart: { dataPoints: [{ label: '>50岁-满意', value: '40.0%' }, { label: '≤40岁-满意', value: '16.7%' }], trend: [] } },
  question: 'Write an essay based on the following table.',
};
const composed = await analyzeComposedEssay(composedInput);
assert.equal(composed.source, 'composedEssay');
assert.equal(composed.track.id, 'chart');
assert.equal(composed.paragraphs.length, chart.paragraphs.length);
assert.equal(composed.totalWords, chart.totalWords, '成文解析词数应与同一文本一致');
// 与真题解析共用判定：同一文本的功能序列必须相同。
assert.deepEqual(
  composed.paragraphs.map((p) => p.sentences.map((s) => s.role)),
  chart.paragraphs.map((p) => p.sentences.map((s) => s.role)),
  '成文解析与真题解析应共用同一套功能判定',
);
// 精确绑定优先：有 skeletonId 时必须标记 exact 并引用该骨架。
const boundSentence = composed.paragraphs[0].sentences[0];
assert.equal(boundSentence.skeletons[0].skeletonId, boundSkeletonId);
assert.equal(boundSentence.skeletons[0].exact, true);
assert.equal(boundSentence.skeletons[0].similarity, 100);
assert.equal(boundSentence.templateNote, '', '精确命中不应再加提示');
assert.deepEqual(composed.usedSkeletonIds, [boundSkeletonId]);
// 未绑定骨架的句子必须如实说明，不虚构来源。
const unbound = composed.paragraphs[0].sentences[1];
assert.equal(unbound.skeletons[0]?.exact ?? false, false);
assert.ok(unbound.templateNote.includes('未套用讲义模板') || unbound.templateNote.includes('相似'), `未绑定句应如实标注：${unbound.templateNote}`);
// 每句都应映射到写作模块，体现"按模块组装"。
for (const paragraph of composed.paragraphs) {
  for (const sentence of paragraph.sentences) {
    assert.ok(sentence.moduleId, `${sentence.text.slice(0, 18)} 缺少模块映射`);
    assert.ok(sentence.moduleLabel, '缺少模块名称');
  }
}
assert.ok(composed.moduleFlow.some((module) => module.covered));
assert.ok(composed.blueprint.length === 3);

// 图画与小作文轨道同样可用。
const composedPicture = await analyzeComposedEssay({
  essay: { paragraphs: picture.paragraphs.map((p) => ({ name: p.name, sentences: p.sentences.map((s) => s.text), sentenceSources: [] })) },
  classification: { category: '大作文' },
  facts: {},
});
assert.equal(composedPicture.track.id, 'picture');
assert.ok(composedPicture.moduleFlow.length === 6);
const composedSmall = await analyzeComposedEssay({
  essay: { paragraphs: small.paragraphs.map((p) => ({ name: p.name, sentences: p.sentences.map((s) => s.text), sentenceSources: [] })) },
  classification: { category: '小作文' },
  facts: {},
});
assert.equal(composedSmall.track.id, 'small');

// AI 深化对成文解析同样适用且可回退。
assert.equal((await deepenAnalysis(composed, { chatJsonImpl: async () => { throw new Error('no key'); } })).aiInsight, null);
const composedDeep = await deepenAnalysis(composed, {
  chatJsonImpl: async () => ({ summary: '先描述数据再归因。', paragraphNotes: [{ index: 1, note: '首段只挑关键数据。' }], pitfalls: ['不要罗列全部数字'] }),
});
assert.equal(composedDeep.aiInsight.summary, '先描述数据再归因。');
assert.equal(composedDeep.paragraphs[0].aiNote, '首段只挑关键数据。');

console.log(`essay-analysis verification passed: exams=${exams.length}, withModel=${withModel}, withoutModel=${withoutModel}, moduleFlow=ok, composed=ok, ai-fallback=ok`);
