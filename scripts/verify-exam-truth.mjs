// 回归：识图标准答案（exam-truth.json）接入成文链后，必须用校对数据校正视觉误读。
// 锁住识图核查-4a/4b 的成果，防止回退。
import assert from 'node:assert/strict';
import { truthAnalysis, loadExamTruth } from '../lib/exams.mjs';
import { mergeExamChartAnalysis, mergeExamPictureAnalysis } from '../lib/chart-facts.mjs';

const passed = [];

async function main() {
  const truth = await loadExamTruth();
  assert.ok(Object.keys(truth).length >= 35, `标准答案应覆盖至少 35 题，实际 ${Object.keys(truth).length}`);

  /* 1. 图画题：视觉把守门员误读成两人、寓意偏 → 标准答案覆盖画面与主体，视觉原值留档 */
  {
    const t = await truthAnalysis('e1-2007-b');
    assert.equal(t.category, '大作文');
    assert.match(t.sceneDescription, /守门员/);
    const misread = { category: '大作文', sceneDescription: 'A goalkeeper and a striker, each with a bubble', themeGuess: '竞争对抗', objectsSeen: ['守门员', '射门者'] };
    const merged = mergeExamChartAnalysis(misread, t);
    assert.match(merged.sceneDescription, /守门员/, '画面应被标准答案覆盖');
    assert.equal(merged.sceneAuthority, 'examReference');
    assert.equal(merged.visualReading.sceneDescription, misread.sceneDescription, '视觉误读留档');
    assert.deepEqual(merged.objectsSeen, t.objectsSeen, '物品以标准答案为准，不含误读的射门者');
    passed.push('picture-scene-corrected');
  }

  /* 2. 图画题：图中原文已核定，视觉错字不得覆盖 */
  {
    const t = await truthAnalysis('e1-2019-b');
    assert.equal(t.chineseTextVerified, true);
    const misread = { category: '大作文', sceneDescription: 'wrong scene', chineseText: '涂中', themeGuess: 'x' };
    const merged = mergeExamPictureAnalysis(misread, t);
    assert.match(merged.chineseText, /途中/, '已核定原文压过视觉错字');
    passed.push('picture-caption-verified');
  }

  /* 3. 图表题：视觉数值误读 → 标准答案数据点权威覆盖 */
  {
    const t = await truthAnalysis('e2-2010-b');
    assert.equal(t.category, '图表作文');
    assert.equal(t.chartData.chartAuthority, 'examTruth');
    assert.ok(t.chartData.dataPoints.length >= 4);
    const misread = { category: '图表作文', chartData: { chartType: 'bar', dataPoints: [{ label: 'Developing countries 2008', value: '30 billion' }] } };
    const merged = mergeExamChartAnalysis(misread, t);
    const key = merged.chartData.dataPoints.find((p) => /Developing countries 2008/i.test(p.label));
    assert.ok(key && /4\s*billion/.test(key.value), `2008 年发展中国家应为 4 billion，实际 ${key?.value}`);
    passed.push('chart-value-authoritative');
  }

  /* 4. needs-web 题（无范文）仍返回可用场景，置信度降低但不为空 */
  {
    const t = await truthAnalysis('e1-2005-b');
    assert.ok(t && t.sceneDescription, 'needs-web 题仍应有视觉兜底的场景');
    assert.ok(t.confidence <= 0.75, 'needs-web 题置信度应偏低');
    passed.push('needs-web-fallback');
  }

  /* 5. 无标准答案的 id 返回 null（回退到旧 referenceAnalysis 的前提） */
  {
    assert.equal(await truthAnalysis('e1-2099-b'), null);
    passed.push('missing-returns-null');
  }

  console.log(`exam-truth verification passed: ${passed.join(', ')}`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
