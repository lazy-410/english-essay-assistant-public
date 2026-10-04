import assert from 'node:assert/strict';
import {
  acceptedWordBand,
  buildPromptFacts,
  buildContentPlan,
  validateContentPlan,
  expandContentPlan,
} from '../lib/content-plan.mjs';

const classification = (category, extra = {}) => ({ category, ...extra });

function unitKeys(plan) {
  return plan.units.map((item) => item.semanticKey);
}

function assertShape(plan, facts, classificationValue) {
  const report = validateContentPlan(plan, facts, classificationValue);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.equal(plan.paragraphs.length, 3);
  assert.equal(new Set(plan.units.map((item) => item.contentId)).size, plan.units.length);
  assert.equal(new Set(unitKeys(plan)).size, plan.units.length);
  for (const item of plan.units) {
    for (const field of ['contentId', 'paragraph', 'rhetoricalFunction', 'claim', 'evidence', 'required', 'semanticKey', 'estimatedWords', 'sourceType']) {
      assert.ok(Object.hasOwn(item, field), `${field} missing from ${item.contentId}`);
    }
  }
}

async function main() {
  assert.deepEqual(acceptedWordBand('160-200 词'), [162, 198]);
  assert.deepEqual(acceptedWordBand('180-220'), [180, 220]);
  assert.deepEqual(acceptedWordBand('约100词'), [90, 110]);

  const phoneClassification = classification('大作文', { subType: '图画类', polarity: '负面', keyPhrase: '过度使用手机' });
  const phoneFacts = buildPromptFacts('Directions: Write an essay of 160-200 words. The picture shows a student using a mobile phone while ignoring people around him.', phoneClassification, {
    sceneDescription: 'A student looks at a mobile phone while people around him are ignored.',
    characters: ['a student', 'people around him'],
    actions: ['looking at a mobile phone', 'ignoring people'],
    caption: '手机沉迷',
    uncertain: [],
  });
  const phonePlan = await buildContentPlan(phoneFacts, phoneClassification);
  assertShape(phonePlan, phoneFacts, phoneClassification);
  assert.ok(phonePlan.units.some((item) => item.semanticKey === 'picture.observation'));

  const dragonFacts = buildPromptFacts('The picture depicts a rural dragon-boat race and asks for an essay of 160-200 words.', phoneClassification, {
    sceneDescription: 'Several dragon boats compete on a river in a rural setting.',
    characters: ['rowers'],
    actions: ['rowing'],
    caption: '乡村龙舟',
    uncertain: [],
  });
  const dragonPlan = await buildContentPlan(dragonFacts, phoneClassification);
  assertShape(dragonPlan, dragonFacts, phoneClassification);
  assert.ok(dragonPlan.units.some((item) => item.evidence.some((entry) => entry.text.includes('dragon boats'))));

  const hybridFacts = buildPromptFacts('Write an essay of 160-200 words based on the picture and chart.', classification('大作文', { subType: '混合图表' }), {
    sourceType: 'examReference',
    sceneDescription: 'A resident praises a new park near home. The number of parks rose from 406 in 2020 to 670 in 2022.',
    chartData: { chartType: 'hybrid', dataPoints: [{ label: '2020', value: '406' }, { label: '2022', value: '670' }] },
  });
  assert.equal(hybridFacts.picture.hasFacts, true);
  assert.equal(hybridFacts.chart.hasFacts, true);
  assert.equal(hybridFacts.chart.source, 'examReference');

  for (const chartType of ['line', 'bar']) {
    const chartClassification = classification('图表作文', { subType: chartType === 'line' ? '动态' : '动态', keyPhrase: '变化趋势' });
    const chartFacts = buildPromptFacts(`The ${chartType} chart shows annual ownership from 2018 to 2022, in percent.`, chartClassification, {
      chartData: {
        chartType,
        unit: '%',
        dataPoints: [{ label: '2018', value: '35' }, { label: '2022', value: '68' }],
        keyContrasts: ['an upward trend'],
      },
    });
    const chartPlan = await buildContentPlan(chartFacts, chartClassification);
    assertShape(chartPlan, chartFacts, chartClassification);
    assert.ok(chartPlan.units.some((item) => item.evidence.some((entry) => entry.text.includes('35'))));
    assert.equal(chartPlan.units.some((item) => /99|100|2017|2023/.test(JSON.stringify(item))), false);
  }

  const inviteClassification = classification('小作文', { letterType: '邀请类' });
  const inviteFacts = buildPromptFacts('Write a letter to your friend Tom to invite him to attend the campus reading festival. Explain the time and place, and express your expectation.', inviteClassification);
  assert.ok(inviteFacts.small.tasks.length >= 2, 'invitation directions should produce task list');
  const invitePlan = await buildContentPlan(inviteFacts, inviteClassification);
  assertShape(invitePlan, inviteFacts, inviteClassification);
  for (const task of inviteFacts.small.tasks) assert.ok(invitePlan.units.some((item) => item.taskIds.includes(task.id)), `missing ${task.id}`);
  const examInviteFacts = buildPromptFacts('Directions:\nWrite an e-mail to a professor, inviting him/her to be a judge for the upcoming English speech contest. You should include the details you think necessary. Do not sign your own name at the end of the e-mail. Use “Li Ming” instead. Write about 100 words. (10 points)', inviteClassification);
  assert.equal(examInviteFacts.small.tasks.some((task) => /directions|do not sign|li ming|100 words/i.test(task.text)), false, 'exam meta instructions must not become communication tasks');
  assert.equal(examInviteFacts.small.tasks.filter((task) => /invit/i.test(task.text)).length, 1, 'invitation action should occur once in task plan');

  const noticeClassification = classification('小作文', { letterType: '通知类' });
  const noticeFacts = buildPromptFacts('Write a notice to inform students of a volunteer activity. State the time, place and registration method.', noticeClassification);
  const noticePlan = await buildContentPlan(noticeFacts, noticeClassification);
  assertShape(noticePlan, noticeFacts, noticeClassification);
  assert.match(noticeFacts.small.format, /通知/);
  for (const task of noticeFacts.small.tasks) assert.ok(noticePlan.units.some((item) => item.taskIds.includes(task.id)), `notice missing ${task.id}`);

  const missingFacts = buildPromptFacts('Write an essay of 160-200 words based on the picture.', phoneClassification);
  const directionsOnlyFacts = buildPromptFacts('52. Directions: Write an essay based on the picture below. In your essay, you should 1) describe the picture briefly, 2) interpret the implied meaning, and 3) give your comments. Write your answer in 160-200 words.', phoneClassification);
  assert.equal(directionsOnlyFacts.missingVisualFacts, true, 'Directions must never count as picture facts');
  const missingPlan = await buildContentPlan(missingFacts, phoneClassification);
  assert.equal(missingFacts.missingVisualFacts, true);
  assert.ok(missingFacts.warnings.length > 0);
  assertShape(missingPlan, missingFacts, phoneClassification);
  assert.equal(missingPlan.units.some((item) => /手机|phone|computer|电脑|child|学生|人物|画面中有/.test(JSON.stringify(item.evidence))), false);

  const fabricatedChart = structuredClone((await buildContentPlan(buildPromptFacts('A line chart.', classification('图表作文'), { chartData: { chartType: 'line', unit: '%', dataPoints: [{ label: 'A', value: '10' }] } }), classification('图表作文'))));
  fabricatedChart.units[0].claim += ' The value reached 999.';
  const fabricatedReport = validateContentPlan(fabricatedChart, buildPromptFacts('A line chart.', classification('图表作文'), { chartData: { chartType: 'line', unit: '%', dataPoints: [{ label: 'A', value: '10' }] } }), classification('图表作文'));
  assert.equal(fabricatedReport.valid, false);
  assert.ok(fabricatedReport.errors.some((error) => error.includes('999')));

  const shortPlan = structuredClone(phonePlan);
  shortPlan.units.forEach((item) => { item.estimatedWords = 5; });
  shortPlan.paragraphs.forEach((paragraph) => paragraph.units.forEach((item) => { item.estimatedWords = 5; }));
  const expanded = expandContentPlan(shortPlan, phoneFacts, phoneClassification);
  assert.ok(expanded.units.length > shortPlan.units.length);
  assert.equal(new Set(expanded.units.map((item) => item.semanticKey)).size, expanded.units.length);
  assert.ok(expanded.units.some((item) => item.semanticKey === 'picture.concrete-example'));
  const forced = expandContentPlan(phonePlan, phoneFacts, phoneClassification, { force: true, minimumAdditionalWords: 45 });
  assert.ok(forced.units.length > phonePlan.units.length, 'actual short draft must force new content dimensions even when estimates look sufficient');
  assert.equal(new Set(forced.units.map((item) => item.semanticKey)).size, forced.units.length);

  // 100 词小作文的任务规划不能被当作大作文的内容充分证明。
  const oneHundred = invitePlan.units.reduce((sum, item) => sum + item.estimatedWords, 0);
  assert.ok(oneHundred < acceptedWordBand('160-200')[0], '100-word application plan must not satisfy big-essay content budget');

  const injected = await buildContentPlan(phoneFacts, phoneClassification, {
    chatJson: async () => ({ data: { paragraphs: phonePlan.paragraphs } }),
  });
  assert.equal(injected.source, 'model');

  console.log(`content-plan verification passed: ${phonePlan.units.length + dragonPlan.units.length + invitePlan.units.length} core units`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
