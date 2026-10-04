import assert from 'node:assert/strict';
import { composeV2 } from '../lib/compose-v2.mjs';
import { inspectChartNumbers, repairMergedChartNumbers } from '../lib/chart-numbers.mjs';
import { detail as examDetail, referenceAnalysis } from '../lib/exams.mjs';
import { mergeExamChartAnalysis } from '../lib/chart-facts.mjs';
import { acceptedWordBand, buildPromptFacts } from '../lib/content-plan.mjs';

function classificationFor(question) {
  if (/chart|图表/i.test(question)) return { category: '图表作文', subType: '动态', polarity: null, keyPhrase: '变化趋势' };
  return { category: '大作文', subType: '图画类', polarity: '负面', keyPhrase: '过度使用手机' };
}

function fakeChatJson({ essayWords = 100, unsupportedNumber = false, stubborn = false, stubbornNumber = false, artifactNumber = false, stubbornArtifact = false, omitBlocks = false, densePlan = false, compactSentences = false } = {}) {
  let essayCalls = 0;
  return async ({ stage, messages }) => {
    if (stage === 'classify') return classificationFor(messages?.[0]?.content || '');
    if (stage === 'plan') {
      if (!densePlan) return {};
      return {
        paragraphs: Array.from({ length: 3 }, (_, paragraphIndex) => ({
          name: `第${paragraphIndex + 1}段`,
          units: Array.from({ length: 3 }, (_, unitIndex) => ({
            contentId: `dense-${paragraphIndex + 1}-${unitIndex + 1}`,
            paragraph: `第${paragraphIndex + 1}段`,
            rhetoricalFunction: ['data-description', 'cause-impact-analysis', 'recommendation-outlook'][paragraphIndex],
            claim: `完成第${paragraphIndex + 1}段第${unitIndex + 1}个不同信息点。`,
            evidence: [],
            required: true,
            semanticKey: `dense.${paragraphIndex + 1}.${unitIndex + 1}`,
            estimatedWords: 18,
            sourceType: 'reasoning',
            stance: 'neutral',
          })),
        })),
      };
    }
    if (stage === 'skeletons') {
      const payload = JSON.parse(messages[0].content);
      // 故意让模型重复候选；实现必须回退到确定性去重结果。
      const first = payload.choices[0]?.candidates?.[0]?.skeletonId;
      return { bindings: payload.choices.map((item) => ({ contentId: item.contentId, skeletonId: first })) };
    }
    if (stage === 'essay' || stage === 'essay-expanded' || stage === 'essay-contracted' || stage === 'essay-chart-number-revise' || stage.startsWith('essay-revise')) {
      essayCalls += 1;
      const payload = JSON.parse(messages[0].content);
      const units = payload.contentPlan.units || payload.contentPlan.paragraphs.flatMap((p) => p.units);
      // stubborn 模拟模型始终不肯压缩到区间内，用于验证确定性裁剪兜底。
      const target = stubborn ? essayWords : (stage === 'essay' && essayCalls === 1 ? essayWords : 174);
      const each = Math.max(4, Math.floor(target / Math.max(1, units.length)));
      let used = 0;
      const paragraphs = payload.contentPlan.paragraphs.map((paragraph) => ({
        name: paragraph.name,
        sentenceBlocks: omitBlocks ? [] : paragraph.units.map((unit) => {
          const n = Math.max(1, Math.min(each, target - used));
          used += n;
          const injectNumber = (unsupportedNumber && stage === 'essay' && used <= n) || stubbornNumber;
          const injectArtifact = artifactNumber && (stubbornArtifact || stage === 'essay') && used <= n;
          const number = injectNumber ? ' 999' : injectArtifact ? ' 40.41%' : '';
          const uniqueWord = (value) => {
            let n = value + 1;
            let suffix = '';
            while (n > 0) { n -= 1; suffix = String.fromCharCode(97 + (n % 26)) + suffix; n = Math.floor(n / 26); }
            return `detail${suffix}`;
          };
          const tokens = Array.from({ length: n }, (_, index) => uniqueWord(used - n + index));
          let generated;
          if (compactSentences && tokens.length >= 9) {
            const first = Math.floor(tokens.length / 3); const second = Math.floor(tokens.length * 2 / 3);
            generated = `${tokens.slice(0, first).join(' ')}.${tokens.slice(first, second).join(' ')}.${tokens.slice(second).join(' ')}.`;
          } else {
            generated = `${tokens.join(' ')}.`;
          }
          return { contentId: unit.contentId, skeletonId: null, text: `${generated}${number}` };
        }),
      }));
      return { paragraphs, title: null, salutation: null, signature: null };
    }
    return {};
  };
}

async function main() {
  const pictureQuestion = 'The picture shows a social problem. Write an essay of 160-200 words.';
  const imageAnalysis = {
    sceneDescription: 'A student looks at a mobile phone while ignoring people around him.',
    characters: ['a student', 'people around him'],
    actions: ['looking at a mobile phone', 'ignoring people'],
    caption: '手机沉迷',
  };

  const overlong = await composeV2(pictureQuestion, {
    imageAnalysis,
    chatJsonImpl: fakeChatJson({ essayWords: 260, stubborn: true }),
  });
  assert.equal(overlong.check.words <= 198, true, `超长必须被裁剪到上限内，实际 ${overlong.check.words}`);
  assert.equal(overlong.check.words >= 162, true, `裁剪不得低于下限，实际 ${overlong.check.words}`);
  assert.equal(overlong.check.checks.find((item) => item.name === '词数').pass, true);
  assert.equal(overlong.check.checks.find((item) => item.name === '规划覆盖').pass, true, '裁剪不得丢失内容单元');
  for (const paragraph of overlong.essay.paragraphs) {
    assert.equal(paragraph.sentences.length, paragraph.sentenceSources.length);
  }

  const expanded = await composeV2(pictureQuestion, {
    imageAnalysis,
    chatJsonImpl: fakeChatJson({ essayWords: 100 }),
  });
  assert.equal(expanded.check.words >= 162 && expanded.check.words <= 198, true, `扩展后词数 ${expanded.check.words}`);
  assert.equal(expanded.steps.find((step) => step.key === 'essay').data.expandedContentPlan, true);
  assert.equal(new Set(expanded.bindings.bindings.map((b) => b.conflictGroup).filter(Boolean)).size, expanded.bindings.bindings.filter((b) => b.conflictGroup).length, '冲突组重复');
  assert.equal(expanded.check.allPass, true, JSON.stringify(expanded.check.checks));
  for (const paragraph of expanded.essay.paragraphs) {
    assert.equal(paragraph.sentences.length, paragraph.sentenceSources.length);
    for (const source of paragraph.sentenceSources) {
      assert.ok(source.contentUnit && source.contentSource && source.skeletonId !== undefined && Object.hasOwn(source, 'skeleton'));
    }
  }

  await assert.rejects(
    composeV2(pictureQuestion, { chatJsonImpl: fakeChatJson() }),
    (err) => err.status === 422 && err.code === 'visual_facts_required',
  );

  const missingChart = await assert.rejects(
    composeV2('The line chart shows annual changes. Write an essay of 180-220 words.', { chatJsonImpl: fakeChatJson() }),
    (err) => err.status === 422 && err.code === 'visual_facts_required',
  );
  assert.equal(missingChart, undefined);

  const chartAnalysis = { category: '图表作文', chartData: { chartType: 'line', unit: '%', dataPoints: [{ label: '2018', value: '10' }, { label: '2022', value: '20' }] } };
  const visualOverride = await composeV2('Write an essay of 180-220 words.', {
    imageAnalysis: chartAnalysis,
    chatJsonImpl: fakeChatJson({ essayWords: 185 }),
  });
  assert.equal(visualOverride.classification.category, '图表作文', '明确 chartData 必须校正错误的图画分类');

  const repairedChart = await composeV2('The line chart shows annual changes. Write an essay of 180-220 words.', {
    imageAnalysis: chartAnalysis,
    chatJsonImpl: fakeChatJson({ essayWords: 185, unsupportedNumber: true }),
  });
  assert.deepEqual(repairedChart.check.unsupportedNumbers, []);
  assert.deepEqual(repairedChart.steps.find((step) => step.key === 'essay').data.chartNumberRepair?.from, ['999']);

  const chart = await assert.rejects(
    composeV2('The line chart shows annual changes. Write an essay of 180-220 words.', {
      imageAnalysis: chartAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 185, stubbornNumber: true }),
    }),
    (err) => err.status === 422 && err.code === 'unsupported_chart_number',
  );
  assert.equal(chart, undefined);

  assert.deepEqual(inspectChartNumbers('The rate is 40%.', { unit: '%', dataPoints: [{ label: 'group', value: '40.0%' }] }).unsupported, []);
  const e2013Chart = { unit: '%', dataPoints: [
    { label: 'freshmen', value: '67.77%' }, { label: 'sophomores', value: '71.13%' },
    { label: 'juniors', value: '71.93%' }, { label: 'seniors', value: '88.24%' },
  ] };
  assert.deepEqual(inspectChartNumbers('The rate is about 16 percentage points higher than a year ago.', e2013Chart).unsupported, []);
  assert.deepEqual(inspectChartNumbers('The rate is 999% higher than a year ago.', e2013Chart).unsupported, ['999%']);
  assert.deepEqual(inspectChartNumbers('No more than 16% play team sports.', { unit: '%', dataPoints: [{ label: 'team sports', value: '15.8%' }] }).unsupported, []);

  const offline2010 = referenceAnalysis(await examDetail('e2-2010-b'));
  const offline2013 = referenceAnalysis(await examDetail('e2-2013-b'));
  assert.ok(offline2010.chartData.dataPoints.length >= 4, '无百分号的英语二图表也应从已校对首段补足事实');
  assert.deepEqual(offline2013.chartData.dataPoints.map((point) => point.value), ['67.77%', '71.13%', '71.93%', '88.24%']);
  assert.deepEqual(inspectChartNumbers(offline2013.chartData.keyContrasts.join(' '), offline2013.chartData).unsupported, []);

  const exam2012 = await examDetail('e2-2012-b');
  const analysis2012 = referenceAnalysis(exam2012);
  const visual2012 = {
    category: '图表作文',
    subType: '静态图表',
    chartData: {
      ...analysis2012.chartData,
      dataPoints: analysis2012.chartData.dataPoints.map((point, index) => index === 6 ? { ...point, value: '40.41%' } : { ...point }),
    },
  };
  const merged2012 = mergeExamChartAnalysis(visual2012, analysis2012);
  assert.deepEqual(merged2012.chartData.dataPoints.map((point) => point.value), analysis2012.chartData.dataPoints.map((point) => point.value));
  assert.equal(merged2012.chartData.chartAuthority, 'examReference');
  assert.equal(merged2012.chartData.dataPoints[3].label.includes('41'), true);
  const structured2012 = buildPromptFacts(exam2012.prompt, { category: '图表作文' }, merged2012);
  assert.equal(structured2012.chart.rows.length, 3);
  assert.equal(structured2012.chart.numericPolicy.forbidLabelValueConcatenation, true);
  assert.deepEqual(repairMergedChartNumbers('The figure was 40.41%.', merged2012.chartData).unsupported, []);

  const artifactResult = await composeV2(exam2012.prompt, {
    imageAnalysis: merged2012,
    chatJsonImpl: fakeChatJson({ essayWords: 158, artifactNumber: true, stubbornArtifact: true }),
  });
  assert.deepEqual(artifactResult.check.unsupportedNumbers, []);
  assert.equal(artifactResult.steps.find((step) => step.key === 'essay').data.chartNumberRepair.mode, 'merged-label-value-artifact');

  const minimumResult = await composeV2(exam2012.prompt, {
    imageAnalysis: analysis2012,
    chatJsonImpl: fakeChatJson({ essayWords: 158 }),
  });
  assert.deepEqual(minimumResult.check.target, [150, 165]);
  assert.equal(minimumResult.facts.targetWords, '150-165（至少150）');
  assert.deepEqual(minimumResult.facts.wordBand, [150, 165]);

  const compactResult = await composeV2(exam2012.prompt, {
    imageAnalysis: analysis2012,
    chatJsonImpl: fakeChatJson({ essayWords: 169, stubborn: true, compactSentences: true }),
  });
  assert.equal(compactResult.check.words >= 150 && compactResult.check.words <= 165, true, `无空格句号成文仍须裁剪，实际 ${compactResult.check.words}`);
  assert.equal(compactResult.steps.find((step) => step.key === 'essay').data.trimmedToLimit, true);

  const fallbackResult = await composeV2(exam2012.prompt, {
    imageAnalysis: analysis2012,
    chatJsonImpl: fakeChatJson({ essayWords: 158, densePlan: true, omitBlocks: true }),
  });
  assert.equal(fallbackResult.check.checks.find((item) => item.name === '无明显重复表达').pass, true, JSON.stringify(fallbackResult.check.checks));
  assert.equal(fallbackResult.check.checks.find((item) => item.name === '规划覆盖').pass, true);
  assert.deepEqual(fallbackResult.check.target, [150, 165]);

  assert.deepEqual(acceptedWordBand('100-110（至少100）'), [100, 110]);
  assert.deepEqual(acceptedWordBand('150-165（至少150）'), [150, 165]);
  assert.deepEqual(acceptedWordBand('about 150 words'), [135, 165]);
  assert.deepEqual(acceptedWordBand('160-200 words'), [162, 198]);

  console.log(`compose-v2 verification passed: expanded=${expanded.check.words} words, minimum=150-165, fallback-repeat=ok, number-repair=ok, chart-guard=422`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
