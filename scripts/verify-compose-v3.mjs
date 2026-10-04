/**
 * compose v3 回归验证（mock AI，全离线）。
 *
 * 覆盖 A7 要求的 6 类场景：
 * 1. 中文残渣注入 → 必须清洗；
 * 2. 占位符注入 → 必须替换；
 * 3. 漏块 → 补写轮生效；
 * 4. 超长 + 多从句成文 → 整句/从句/词三级裁剪 + 缝合轮；
 * 5. 照抄真题范文 → 范文对照润色轮改掉；
 * 6. 图表数字底线：可修复数字被修订、顽固数字 422。
 *
 * 另外验证 A4 底线：确定性兜底只产出干净英文（不再拼接中文规划文本），
 * 并如实标记 fallback 块。
 */
import assert from 'node:assert/strict';
import { composeV3 } from '../lib/compose-v3.mjs';
import { inspectChartNumbers, repairMergedChartNumbers } from '../lib/chart-numbers.mjs';
import { detail as examDetail, referenceAnalysis } from '../lib/exams.mjs';
import { mergeExamChartAnalysis } from '../lib/chart-facts.mjs';
import { acceptedWordBand, buildPromptFacts } from '../lib/content-plan.mjs';
import { hasCjk, hasPlaceholder } from '../lib/compose-refs.mjs';

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]/;
const PLACEHOLDER = /\{[^{}]{1,40}\}|\[[^\[\]]{1,40}\]/;
const CLEAN_FILL = 'Many students now spend long hours on their phones, and this habit quietly crowds out face-to-face communication.';
const POLISH_OPENINGS = ['This scene highlights', 'Such habitual behavior reveals', 'We can observe', 'It is evident that', 'What stands out is'];
const POLISH_REPLACEMENT = 'In recent years this tendency has attracted growing attention from both the public and researchers.';

function classificationFor(question) {
  if (/chart|图表/i.test(question)) return { category: '图表作文', subType: '动态', polarity: null, keyPhrase: '变化趋势' };
  return { category: '大作文', subType: '图画类', polarity: '负面', keyPhrase: '过度使用手机' };
}

function uniqueWord(value) {
  let n = value + 1;
  let suffix = '';
  while (n > 0) { n -= 1; suffix = String.fromCharCode(97 + (n % 26)) + suffix; n = Math.floor(n / 26); }
  return `detail${suffix}`;
}

/**
 * mock AI：
 * - 只实现 classify / plan / skeletons / 写作阶段；
 * - 修订、润色、缝合、补写阶段按场景注入可控行为；
 * - 默认所有句子用互不相同的 detailN 词，保证“重复表达 / 机械腔”检查在干净场景下通过。
 */
function fakeChatJson({
  essayWords = 174,
  followupWords = 174,
  stubborn = false,
  unsupportedNumber = false,
  stubbornNumber = false,
  artifactNumber = false,
  stubbornArtifact = false,
  densePlan = false,
  compactSentences = false,
  clauseStyle = false,
  omitContentIds = [],
  cjkContentIds = [],
  stubbornCjk = false,
  placeholderContentIds = [],
  modelCopy = null,
  uniformOpening = null,
  makeupStubborn = false,
  stitch = null,
} = {}) {
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
      const plan = payload.contentPlan;
      const units = plan.units || plan.paragraphs.flatMap((paragraph) => paragraph.units);
      const isFirst = essayCalls === 1;
      const target = stubborn ? essayWords : (isFirst ? essayWords : followupWords);
      const each = Math.max(4, Math.floor(target / Math.max(1, units.length)));
      let used = 0;
      const paragraphs = plan.paragraphs.map((paragraph) => ({
        name: paragraph.name,
        sentenceBlocks: paragraph.units
          .filter((unit) => !(isFirst && omitContentIds.includes(unit.contentId)))
          .map((unit) => {
            const n = Math.max(1, Math.min(each, target - used));
            used += n;
            const tokens = Array.from({ length: n }, (_, index) => uniqueWord(used - n + index));
            let generated;
            if (compactSentences && tokens.length >= 9) {
              const first = Math.floor(tokens.length / 3); const second = Math.floor(tokens.length * 2 / 3);
              generated = `${tokens.slice(0, first).join(' ')}.${tokens.slice(first, second).join(' ')}.${tokens.slice(second).join(' ')}.`;
            } else if (clauseStyle && tokens.length >= 9) {
              const first = Math.floor(tokens.length / 3); const second = Math.floor(tokens.length * 2 / 3);
              generated = `${tokens.slice(0, first).join(' ')}, and ${tokens.slice(first, second).join(' ')} because ${tokens.slice(second).join(' ')}.`;
            } else {
              generated = `${tokens.join(' ')}.`;
            }
            if (uniformOpening) generated = `${uniformOpening} ${generated}`;
            if (isFirst && modelCopy && unit.contentId === modelCopy.contentId) generated = `${modelCopy.text} ${generated}`;
            if (isFirst && cjkContentIds.includes(unit.contentId)) generated = `${generated} 手机沉迷`;
            if (isFirst && placeholderContentIds.includes(unit.contentId)) generated = `${generated} Only {device-here} can explain it.`;
            const firstBlock = used === n;
            const injectNumber = (unsupportedNumber && isFirst && firstBlock) || stubbornNumber;
            const injectArtifact = artifactNumber && (stubbornArtifact || isFirst);
            const number = injectNumber
              ? ' The figure rose by 999 in total.'
              : injectArtifact ? ' The figure was 40.41% in the survey.' : '';
            return { contentId: unit.contentId, skeletonId: null, text: `${generated}${number}` };
          }),
      }));
      return { paragraphs, title: null, salutation: null, signature: null };
    }
    if (stage === 'essay-missing-repair') {
      if (makeupStubborn) return {};
      const payload = JSON.parse(messages[0].content);
      return { blocks: payload.missingUnits.map((unit, index) => ({ contentId: unit.contentId, text: index === 0 ? CLEAN_FILL : `${CLEAN_FILL} This pattern deserves closer attention from everyone involved.` })) };
    }
    if (stage === 'essay-guard-fix') {
      if (stubbornCjk) return {};
      const payload = JSON.parse(messages[0].content);
      const clean = (value) => String(value)
        .replace(/手机沉迷/g, 'excessive phone use.')
        .replace(/\{[^{}]{1,40}\}/g, 'smartphones')
        .replace(/\[[^\[\]]{1,40}\]/g, 'smartphones');
      return {
        blocks: payload.blocks.map((block) => ({ contentId: block.contentId, text: clean(block.text) })),
        fields: [],
      };
    }
    if (stage === 'essay-stitch') {
      if (!stitch) return {};
      const payload = JSON.parse(messages[0].content);
      return { blocks: payload.blocks.map((block) => ({ contentId: block.contentId, text: block.text.replace(/(\S+)\s*\.?$/, stitch) })) };
    }
    if (stage === 'essay-polish-language' || stage === 'essay-polish-reference') {
      if (!uniformOpening && !modelCopy) return {};
      const payload = JSON.parse(messages[0].content);
      const paragraphs = payload.currentEssay.paragraphs.map((paragraph, paragraphIndex) => ({
        name: paragraph.name,
        sentenceBlocks: paragraph.sentenceBlocks.map((block, blockIndex) => {
          let text = block.text;
          if (uniformOpening && text.startsWith(uniformOpening)) {
            text = `${POLISH_OPENINGS[(paragraphIndex * 3 + blockIndex) % POLISH_OPENINGS.length]}${text.slice(uniformOpening.length)}`;
          }
          if (modelCopy && text.includes(modelCopy.text)) text = text.replace(modelCopy.text, POLISH_REPLACEMENT).replace(/\s{2,}/g, ' ').trim();
          return { contentId: block.contentId, skeletonId: block.skeletonId, usage: block.usage, text };
        }),
      }));
      return { paragraphs };
    }
    return {};
  };
}

/* ------------------------------ 断言工具 ------------------------------ */

const essayText = (result) => result.essay.paragraphs.flatMap((paragraph) => paragraph.sentenceBlocks.map((block) => block.text)).join(' ');
const checkOf = (result, name) => result.check.checks.find((item) => item.name === name);
const roundNames = (result) => result.diagnostics.rounds.map((round) => round.name);
const hasRound = (result, name) => roundNames(result).includes(name);
const roundOf = (result, name) => result.diagnostics.rounds.find((round) => round.name === name);

const pictureQuestion = 'The picture shows a social problem. Write an essay of 160-200 words.';
const pictureAnalysis = {
  sceneDescription: 'A student looks at a mobile phone while ignoring people around him.',
  characters: ['a student', 'people around him'],
  actions: ['looking at a mobile phone', 'ignoring people'],
  caption: '手机沉迷',
};
const chartAnalysis = { category: '图表作文', chartData: { chartType: 'line', unit: '%', dataPoints: [{ label: '2018', value: '10' }, { label: '2022', value: '20' }] } };

async function main() {
  const passed = [];

  /* 场景 0：干净成文基线（不应触发任何修正轮）。 */
  {
    const result = await composeV3(pictureQuestion, { imageAnalysis: pictureAnalysis, chatJsonImpl: fakeChatJson({ essayWords: 174 }) });
    assert.equal(checkOf(result, '英文纯净').pass, true, JSON.stringify(result.check.checks));
    assert.equal(result.check.words >= 162 && result.check.words <= 198, true, `基线词数 ${result.check.words}`);
    assert.equal(result.diagnostics.fallbackBlocks.length, 0);
    assert.equal(hasRound(result, 'makeup-result'), false);
    assert.ok(result.references && result.references.stats, '参考素材层摘要必须随响应返回');
    passed.push(`baseline=${result.check.words}词`);
  }

  /* 场景 1：中文残渣注入 → 终稿守卫必须清洗。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 174, cjkContentIds: ['picture-p2-meaning'] }),
    });
    assert.equal(CJK.test(essayText(result)), false, `终稿不得残留中文：${essayText(result)}`);
    assert.equal(hasRound(result, 'guard-fix-1'), true);
    assert.equal(checkOf(result, '英文纯净').pass, true, JSON.stringify(result.check.violations));
    assert.equal(result.diagnostics.guards.length, 0);
    passed.push('cjk-cleaned');
  }

  /* 场景 1b：模型拒绝清洗中文 → 确定性兜底仍须产出干净英文。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 174, cjkContentIds: ['picture-p1-observation'], stubbornCjk: true }),
    });
    assert.equal(CJK.test(essayText(result)), false, `兜底后仍残留中文：${essayText(result)}`);
    assert.equal(hasRound(result, 'guard-deterministic'), true);
    assert.equal(checkOf(result, '英文纯净').pass, true);
    assert.equal(result.check.words >= 162 && result.check.words <= 198, true, `兜底不得破坏词数：${result.check.words}`);
    passed.push('cjk-deterministic');
  }

  /* 场景 2：占位符注入 → 必须替换成具体内容。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 170, placeholderContentIds: ['picture-p2-meaning'] }),
    });
    assert.equal(PLACEHOLDER.test(essayText(result)), false, `终稿不得残留占位符：${essayText(result)}`);
    assert.equal(hasRound(result, 'guard-fix-1'), true);
    assert.equal(checkOf(result, '英文纯净').pass, true, JSON.stringify(result.check.violations));
    assert.ok(/smartphones/.test(essayText(result)), '占位符必须被替换为具体内容');
    passed.push('placeholder-replaced');
  }

  /* 场景 3：漏块 → 补写轮生效（补写结果进入终稿，且不再标记 fallback）。 */
  {
    const omitted = 'dense-2-1';
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      // 密集规划下单块占比小：漏一块后总词数仍在区间内，终稿就是补写轮的结果。
      chatJsonImpl: fakeChatJson({ densePlan: true, essayWords: 174, omitContentIds: [omitted] }),
    });
    assert.equal(hasRound(result, 'makeup'), true);
    assert.deepEqual(roundOf(result, 'makeup-result')?.filled, [omitted], JSON.stringify(roundOf(result, 'makeup-result')));
    assert.ok(essayText(result).includes(CLEAN_FILL), '补写轮产出的句子必须进入终稿');
    assert.equal(checkOf(result, '规划覆盖').pass, true);
    assert.deepEqual(result.check.fallbackBlocks, []);
    assert.equal(checkOf(result, '英文纯净').pass, true);
    passed.push('missing-block-filled');
  }

  /* 场景 3b：补写轮失败 → 英文安全填充顶上，绝不拼接中文，且如实标记。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ densePlan: true, essayWords: 174, omitContentIds: ['dense-2-1'], makeupStubborn: true }),
    });
    assert.equal(CJK.test(essayText(result)), false, '安全填充必须是纯英文');
    assert.equal(checkOf(result, '规划覆盖').pass, true);
    assert.deepEqual(result.check.fallbackBlocks, ['dense-2-1']);
    assert.equal(checkOf(result, '英文纯净').pass, true);
    passed.push('fallback-english-only');
  }

  /* 场景 4a：超长多从句成文 → 从句级裁剪（删除完整从句，不留断句）。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 240, stubborn: true, clauseStyle: true }),
    });
    assert.equal(result.steps.find((step) => step.key === 'essay').data.trimmedToLimit, true, '超长稿必须走确定性裁剪');
    assert.equal(result.check.words <= 198, true, `裁剪后仍超上限：${result.check.words}`);
    assert.equal(result.check.words >= 162, true, `裁剪跌破下限：${result.check.words}`);
    assert.equal(checkOf(result, '词数').pass, true);
    assert.equal(checkOf(result, '英文纯净').pass, true, JSON.stringify(result.check.violations));
    assert.equal(checkOf(result, '规划覆盖').pass, true, '裁剪不得丢失内容单元');
    assert.equal(hasRound(result, 'trim'), true);
    assert.equal(essayText(result).includes(', and '), true, '从句级裁剪应保留完整从句边界');
    assert.equal(CJK.test(essayText(result)), false);
    passed.push(`clause-trim=${result.check.words}词`);
  }

  /* 场景 4b：单从句超长成文 → 词级裁剪 + 缝合轮修补删痕。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 240, stubborn: true, stitch: 'clearly.' }),
    });
    assert.equal(result.steps.find((step) => step.key === 'essay').data.trimmedToLimit, true, '超长稿必须走确定性裁剪');
    assert.equal(result.check.words <= 198, true, `裁剪后仍超上限：${result.check.words}`);
    assert.equal(result.check.words >= 162, true, `裁剪跌破下限：${result.check.words}`);
    assert.equal(checkOf(result, '词数').pass, true);
    assert.equal(checkOf(result, '英文纯净').pass, true, JSON.stringify(result.check.violations));
    assert.equal(checkOf(result, '规划覆盖').pass, true, '裁剪不得丢失内容单元');
    assert.equal(roundOf(result, 'stitch-result')?.applied >= 1, true, JSON.stringify(roundOf(result, 'stitch-result')));
    assert.ok(essayText(result).includes('clearly.'), '缝合结果必须被采纳');
    assert.equal(result.check.words <= 198, true, `缝合后不得超出上限：${result.check.words}`);
    passed.push(`token-trim+stitch=${result.check.words}词`);
  }

  /* 场景 4b：无空格句号成文（模型偶尔输出 sentence.Next）也必须裁剪到位。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 200, stubborn: true, compactSentences: true }),
    });
    assert.equal(result.check.words <= 198, true, `紧凑句号成文未裁剪：${result.check.words}`);
    assert.equal(result.check.words >= 162, true);
    passed.push('compact-sentence-trim');
  }

  /* 场景 5：照抄真题范文 → 范文对照润色轮改掉。 */
  {
    const exam = await examDetail('e1-2010-b');
    const copied = exam.modelEssay.paragraphs[0].sentences[0].text;
    assert.ok(copied.split(/\s+/).length >= 8, '范文首句需足够长才能触发重合检测');
    const result = await composeV3(exam.prompt ?? exam.directions, {
      imageAnalysis: { ...pictureAnalysis, sceneDescription: 'A cultural hotpot contains symbols of many cultures.' },
      chatJsonImpl: fakeChatJson({ essayWords: 170, modelCopy: { contentId: 'picture-p1-observation', text: copied } }),
      examId: exam.id,
    });
    assert.equal(hasRound(result, 'polish-reference'), true, '有范文时必须走范文对照润色轮');
    assert.equal(checkOf(result, '范文重合').pass, true, JSON.stringify(checkOf(result, '范文重合').detail));
    assert.equal(essayText(result).includes(copied), false, '终稿不得整句照抄范文');
    assert.ok(essayText(result).includes(POLISH_REPLACEMENT), '润色替换结果必须进入终稿');
    assert.equal(result.check.words >= result.check.target[0] && result.check.words <= result.check.target[1], true, `润色后词数越界：${result.check.words}`);
    assert.equal(result.references.hasModelEssay, true, '题库题必须带上真题范文摘要');
    passed.push('model-essay-overlap-polished');
  }

  /* 场景 5b：句式开头雷同（机械腔）→ 语言润色轮改掉。 */
  {
    const result = await composeV3(pictureQuestion, {
      imageAnalysis: pictureAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 174, uniformOpening: 'The picture shows' }),
    });
    assert.equal(hasRound(result, 'polish-language-result'), true);
    assert.equal(roundOf(result, 'polish-language-result')?.accepted, true, JSON.stringify(roundOf(result, 'polish-language-result')));
    assert.equal(checkOf(result, '机械化').pass, true, JSON.stringify(checkOf(result, '机械化').detail));
    passed.push('mechanical-polished');
  }

  /* 场景 6：图表未验证数字（可修复）→ 定向修订；顽固 → 422 底线。 */
  {
    const repaired = await composeV3('The line chart shows annual changes. Write an essay of 180-220 words.', {
      imageAnalysis: chartAnalysis,
      chatJsonImpl: fakeChatJson({ essayWords: 185, unsupportedNumber: true }),
    });
    assert.deepEqual(repaired.check.unsupportedNumbers, []);
    assert.deepEqual(repaired.steps.find((step) => step.key === 'essay').data.chartNumberRepair?.from, ['999']);

    await assert.rejects(
      composeV3('The line chart shows annual changes. Write an essay of 180-220 words.', {
        imageAnalysis: chartAnalysis,
        chatJsonImpl: fakeChatJson({ essayWords: 185, stubbornNumber: true }),
      }),
      (err) => err.status === 422 && err.code === 'unsupported_chart_number',
    );

    await assert.rejects(
      composeV3(pictureQuestion, { chatJsonImpl: fakeChatJson() }),
      (err) => err.status === 422 && err.code === 'visual_facts_required',
    );
    passed.push('chart-number-guard');
  }

  /* 场景 6b：题库图表（合并伪小数 40.41%）→ 确定性修复且不误杀合法比较。 */
  {
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
    const artifact = await composeV3(exam2012.prompt, {
      imageAnalysis: merged2012,
      chatJsonImpl: fakeChatJson({ essayWords: 158, artifactNumber: true, stubbornArtifact: true }),
      examId: exam2012.id,
    });
    assert.deepEqual(artifact.check.unsupportedNumbers, []);
    assert.equal(artifact.steps.find((step) => step.key === 'essay').data.chartNumberRepair.mode, 'merged-label-value-artifact');

    const structured2012 = buildPromptFacts(exam2012.prompt, { category: '图表作文' }, merged2012);
    assert.equal(structured2012.chart.rows.length, 3);
    assert.deepEqual(repairMergedChartNumbers('The figure was 40.41%.', merged2012.chartData).unsupported, []);
    passed.push('merged-artifact-repair');
  }

  /* 场景 6c：题库图画题 —— 视觉误读不得覆盖已校对的画面与主题，但图中原文保留视觉转录。 */
  {
    const exam2019 = await examDetail('e1-2019-b');
    const reference2019 = referenceAnalysis(exam2019);
    const misread = {
      category: '大作文',
      sceneDescription: 'A man is reading a book on the sofa.',
      themeGuess: '阅读的重要性',
      themeBasis: '图中男子在看书',
      chineseText: '途中',
      objectsSeen: ['沙发', '书'],
    };
    const merged2019 = mergeExamChartAnalysis(misread, reference2019);
    assert.match(merged2019.sceneDescription, /two climbers/, '画面应来自题库校对范文');
    assert.notEqual(merged2019.themeGuess, '阅读的重要性', '视觉主题基于误读场景，不能沿用');
    assert.equal(merged2019.chineseText, '途中', '范文引语是英文译句，图中原文用视觉转录');
    assert.deepEqual(merged2019.objectsSeen, [], '误读出的物品不得进入事实');
    assert.equal(merged2019.sceneAuthority, 'examReference');
    assert.equal(merged2019.visualReading.sceneDescription, misread.sceneDescription, '视觉原始读数留档备查');

    // 题库标注为已核实的图中原文优先于视觉转录
    const verified = mergeExamChartAnalysis(misread, { ...reference2019, chineseText: '途中', chineseTextVerified: true });
    assert.equal(verified.chineseText, '途中');
    const wrongVision = mergeExamChartAnalysis({ ...misread, chineseText: '涂中' }, { ...reference2019, chineseText: '途中', chineseTextVerified: true });
    assert.equal(wrongVision.chineseText, '途中', '已核实原文不被视觉错字覆盖');

    // 没有视觉结果时退回题库数据（离线兜底路径不变）
    assert.equal(mergeExamChartAnalysis(null, reference2019), reference2019);

    const facts2019 = buildPromptFacts(exam2019.prompt, { category: '大作文' }, merged2019);
    assert.match(facts2019.sceneDescription ?? facts2019.picture?.sceneDescription ?? '', /two climbers/);
    passed.push('picture-reference-authority');
  }

  /* 场景 7：题库最低字数带（至少150）不得被兜底流程放大。 */
  {
    const exam2012 = await examDetail('e2-2012-b');
    const analysis2012 = referenceAnalysis(exam2012);
    const result = await composeV3(exam2012.prompt, {
      imageAnalysis: analysis2012,
      chatJsonImpl: fakeChatJson({ essayWords: 155, followupWords: 155 }),
    });
    assert.deepEqual(result.check.target, [150, 165]);
    assert.equal(result.facts.targetWords, '150-165（至少150）');
    assert.deepEqual(result.facts.wordBand, [150, 165]);
    assert.equal(result.check.words >= 150 && result.check.words <= 165, true, `词数 ${result.check.words}`);
    passed.push('minimum-band');
  }

  /* 场景 8：全量漏块 + 密集规划 → 兜底只产出英文，规划覆盖仍然成立。 */
  {
    const exam2012 = await examDetail('e2-2012-b');
    const analysis2012 = referenceAnalysis(exam2012);
    const result = await composeV3(exam2012.prompt, {
      imageAnalysis: analysis2012,
      chatJsonImpl: fakeChatJson({ essayWords: 158, densePlan: true, omitContentIds: ['dense-1-1', 'dense-2-1', 'dense-3-1'] }),
    });
    assert.equal(checkOf(result, '规划覆盖').pass, true, JSON.stringify(result.check.checks));
    assert.equal(checkOf(result, '英文纯净').pass, true, JSON.stringify(result.check.violations));
    assert.equal(CJK.test(essayText(result)), false, '兜底链路不得出现中文');
    assert.deepEqual(result.check.target, [150, 165]);
    assert.equal(result.check.words >= 150 && result.check.words <= 165, true, `词数 ${result.check.words}`);
    passed.push('dense-fallback-english');
  }

  /* 词数带换算（与 v2 共用口径）。 */
  assert.deepEqual(acceptedWordBand('150-165（至少150）'), [150, 165]);
  assert.deepEqual(acceptedWordBand('160-200 words'), [162, 198]);
  assert.equal(hasCjk('中文'), true);
  assert.equal(hasPlaceholder('a {slot} here'), true);
  assert.deepEqual(inspectChartNumbers('The rate is 999% higher than a year ago.', chartAnalysis.chartData).unsupported, ['999%']);

  console.log(`compose-v3 verification passed: ${passed.join(', ')}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
