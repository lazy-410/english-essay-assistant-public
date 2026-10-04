// 第 3 步：跑「产品真实识图链路」analyzeImage，与标准答案 exam-truth.json 比对，统计误读。
// 这里刻意调用线上产品实际使用的 analyzeImage（含 VISION_SYSTEM_PROMPT），
// 而不是建标准答案时的转录提示词 —— 测的就是用户实际遇到的识图质量。
//
// 判对错用模型做裁判，但给死规则并喂标准答案作为唯一真相，降低裁判自身幻觉：
//   - sceneMatch：产品识出的画面主体/场景是否与标准答案一致（张冠李戴即 false）
//   - captionMatch：图中关键原文是否读到且没读错
//   - chartMatch：图表数据是否与标准答案逐项一致
//   - themeDirection：产品推断的寓意方向是否与标准答案一致（决定成文方向对不对）
//   - errorType：scene-wrong / caption-missing / caption-wrong / chart-wrong / theme-wrong / none
//
// 用法：node scripts/exam-vision-audit.mjs [examId ...] [--force]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImage } from '../lib/vision.mjs';
import { chatJson } from '../lib/deepseek.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(path.dirname(ROOT), 'tmp');
const OUT = path.join(TMP, 'exam-vision-audit.json');

const JUDGE = `你是识图质量评审。给你一道考研作文题图的「标准答案」（已人工/多源核定，视为唯一真相）和「产品识图结果」，判断产品识图是否会导致作文写偏。

严格按规则判定，只依据标准答案，不要自行想象题图：
- sceneMatch：产品识出的画面主体与场景，和标准答案是否指同一幅画面。主体张冠李戴（如把登山读成看书、把两人读成一人）判 false。
- captionMatch：标准答案 captionTexts 里的关键文字，产品是否读到且没读错别字；标准答案无 caption 时判 null。
- chartMatch：图表题的数据是否与标准答案逐项一致（数值/标签），非图表题判 null。
- themeDirection：产品推断的寓意/主题方向，是否与标准答案一致（这决定作文立意对不对）。标准答案无 theme 时，依据 scene 能否支持同方向立意来判。
- errorType：从 ["none","scene-wrong","caption-missing","caption-wrong","chart-wrong","theme-wrong"] 选最主要的一类（可多选，数组）。
- severity：high（会导致整篇跑偏）/ medium（局部细节错）/ low（无伤大雅）。
- note：一句话说明差异。

只返回 JSON：{"sceneMatch":bool,"captionMatch":bool|null,"chartMatch":bool|null,"themeDirection":bool,"errorType":[],"severity":"","note":""}`;

async function judge(truth, product) {
  const payload = {
    standard: { essayType: truth.essayType, captionTexts: truth.captionTexts, scene: truth.scene, theme: truth.theme, chart: truth.chart },
    product: {
      category: product.category, chineseText: product.chineseText, sceneDescription: product.sceneDescription,
      objectsSeen: product.objectsSeen, themeGuess: product.themeGuess, themeBasis: product.themeBasis,
      chartData: product.chartData,
    },
  };
  const out = await chatJson({ tier: 'reasoning', system: JUDGE, messages: [{ role: 'user', content: JSON.stringify(payload) }], temperature: 0, maxTokens: 900 });
  return out.data ?? out;
}

const truthStore = JSON.parse(await readFile(path.join(ROOT, 'knowledge', 'exam-truth.json'), 'utf8')).exams;
const exams = JSON.parse(await readFile(path.join(ROOT, 'knowledge', 'exams.json'), 'utf8'));
const list = (Array.isArray(exams) ? exams : exams.exams).filter((e) => e.section === 'big');

let store = {};
try { store = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 首次 */ }

const args = process.argv.slice(2);
const force = args.includes('--force');
const wanted = args.filter((a) => !a.startsWith('--'));
const targets = (wanted.length ? list.filter((e) => wanted.includes(e.id)) : list);

for (const exam of targets) {
  if (store[exam.id] && !force && !store[exam.id].error) { console.log(`${exam.id}  已有，跳过`); continue; }
  const truth = truthStore[exam.id];
  if (!truth) { console.log(`${exam.id}  无标准答案，跳过`); continue; }
  try {
    const buf = await readFile(path.join(ROOT, exam.image));
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    const vision = await analyzeImage(dataUrl);
    const verdict = await judge(truth, vision.raw);
    store[exam.id] = { examId: exam.id, essayType: truth.essayType, product: vision.raw, verdict, model: vision.model };
    const flags = [verdict.sceneMatch ? '' : 'scene', verdict.captionMatch === false ? 'caption' : '', verdict.chartMatch === false ? 'chart' : '', verdict.themeDirection ? '' : 'theme'].filter(Boolean).join(',');
    console.log(`${exam.id}  ${verdict.sceneMatch && verdict.themeDirection && verdict.chartMatch !== false && verdict.captionMatch !== false ? '✓ 正确' : '✗ ' + (verdict.severity || '') + ' [' + flags + ']'}  ${verdict.note ?? ''}`);
  } catch (err) {
    store[exam.id] = { examId: exam.id, error: String(err.message).slice(0, 200) };
    console.log(`${exam.id}  ✗ 调用失败 ${String(err.message).slice(0, 120)}`);
  }
  await writeFile(OUT, JSON.stringify(store, null, 1) + '\n', 'utf8');
}

// 汇总
const all = Object.values(store).filter((x) => x.verdict);
const bad = all.filter((x) => !(x.verdict.sceneMatch && x.verdict.themeDirection && x.verdict.chartMatch !== false && x.verdict.captionMatch !== false));
const byType = {};
for (const x of bad) for (const t of x.verdict.errorType ?? []) byType[t] = (byType[t] ?? 0) + 1;
console.log(`\n===== 已判 ${all.length} 题，疑似误读 ${bad.length} 题 =====`);
console.log('误读类型分布:', JSON.stringify(byType));
console.log('high 严重:', bad.filter((x) => x.verdict.severity === 'high').map((x) => x.examId).join(', ') || '无');
console.log('written', OUT);
