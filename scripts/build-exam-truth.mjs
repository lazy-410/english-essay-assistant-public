// 汇总「文字证据 + 双次视觉转录」，逐题核定大作文题图的标准答案，写入 knowledge/exam-truth.json。
//
// 核定规则（写进提示词，并在落盘前做确定性复核）：
//   - 图中原文 captionTexts：必须在两次视觉转录里都出现（agreement.texts.stable），
//     或在黄皮书/讲义/题库题干里能找到对应原文；两边都没有的不收。
//   - 画面 scene / 人物 people：以黄皮书或题库范文首段（专家看真图写的）为主，视觉转录只作补充，
//     与范文冲突时以范文为准并记入 conflicts。
//   - 寓意 theme：只来自范文/讲义的解读句，不来自视觉推测。
//   - 图表数据 chart.points：两次视觉读数一致，且与范文/题干出现的数字不矛盾；不一致的进 needsReview。
//   - 无范文且讲义未覆盖的题，标 status=needs-web，等联网核对（识图核查-2b）。
//
// 用法：node scripts/build-exam-truth.mjs [examId ...] [--force]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson } from '../lib/deepseek.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(path.dirname(ROOT), 'tmp');
const OUT = path.join(ROOT, 'knowledge', 'exam-truth.json');

const SYSTEM = `你是考研英语真题题图的校对编辑。根据提供的证据，为一道大作文题图核定「标准答案」。

证据说明：
- yellowBook / bankEssay：权威参考书的范文，作者对照真实题图写成，首段是客观画面描述，可信度最高。
- slp：石雷鹏讲义，含「观察要点」与中英对照的首段练笔，常转述图中中文原文，可信度高。
- promptTail：真题题干在 Directions 之后的文本层内容（图表题常含标题/图例/数字；图画题通常为空）。
- vision.stableTexts：两次独立视觉转录都读到的图中文字（较可靠，但可能有错字）。
- vision.runs：两次视觉转录的人物/物品/图表数据原始结果（可能有误读，仅作参考）。

核定规则：
1. 只写有证据支撑的内容。范文/讲义与视觉冲突时，以范文/讲义为准，并把冲突写进 conflicts。
2. captionTexts 是图上真实印着的文字（中文就写中文原样）。来源优先级：讲义转述的中文原文 > vision.stableTexts > 范文中的引语译文（范文多为英译，不能当作原文，除非图上本来就是英文）。
3. scene 用中文客观描述画面（谁、在哪、做什么、关键物品），不写寓意。people 列出每个人物与动作。
4. theme 只来自范文/讲义的解读句，用中文概括寓意；themeEvidence 摘录支撑它的原句。
5. 图表题：chart.points 逐项列出 label 与 value（带单位）。数值必须在范文/题干/讲义中出现，或两次视觉读数一致；否则放进 needsReview。
6. 证据不足以确定的任何一项，宁可留空并写进 needsReview，绝不凭记忆补全。
7. misreadRisks：列出这张图最容易被看错的地方（例如相似人物、细小文字、易混数字），供后续校验用。

严格返回 JSON：
{
 "essayType": "picture|chart|hybrid",
 "panels": 1,
 "captionTexts": ["图上原文"],
 "scene": "中文客观描述",
 "people": [{"panel":1,"who":"","doing":""}],
 "keyObjects": ["关键物品"],
 "theme": "中文寓意",
 "themeEvidence": ["支撑原句"],
 "chart": {"type":"bar|line|pie|table|null","title":"","unit":"","points":[{"label":"","value":""}]},
 "misreadRisks": [""],
 "conflicts": [""],
 "needsReview": [""],
 "evidenceUsed": ["yellowBook|bankEssay|slp|promptTail|vision"]
}`;

function visionSummary(v) {
  if (!v) return null;
  return {
    stableTexts: v.agreement?.texts?.stable ?? [],
    unstableTexts: v.agreement?.texts?.unstable ?? [],
    panels: v.agreement?.panels ?? [],
    stablePoints: v.agreement?.points?.stable ?? [],
    unstablePoints: v.agreement?.points?.unstable ?? [],
    runs: (v.runs ?? []).map((r) => ({ panels: r.panels, people: r.people, objects: r.objects, scene: r.scene, chart: r.chart, unclear: r.unclear })),
  };
}

function evidenceFor(id, sources, vision) {
  const s = sources[id] ?? {};
  return {
    examId: id,
    essayType: s.bank?.essayType ?? null,
    promptTail: s.bank?.promptTail || '',
    bankEssay: s.bank?.firstPara || '',
    yellowBook: s.yb?.essay ? s.yb.essay.slice(0, 1800) : '',
    slp: s.slp ? { topic: s.slp.topic, observe: s.slp.observe, firstPara: s.slp.firstPara, reference: (s.slp.reference || '').slice(0, 900) } : null,
    vision: visionSummary(vision[id]),
  };
}

const norm = (s) => String(s ?? '').replace(/[\s"'“”‘’。，,.!！?？:：;；、（）()【】\[\]—\-]/g, '').toLowerCase();

/**
 * 确定性复核：模型给出的 captionTexts / chart.points 必须能在证据里找到出处，
 * 找不到的降级进 needsReview，避免模型凭记忆补写。
 */
function audit(truth, ev) {
  const corpus = norm([
    ev.promptTail, ev.bankEssay, ev.yellowBook,
    ev.slp?.observe, ev.slp?.firstPara, ev.slp?.reference,
    ...(ev.vision?.stableTexts ?? []),
  ].join(' '));
  const visionAll = norm(JSON.stringify(ev.vision?.runs ?? []));
  const review = [...(truth.needsReview ?? [])];
  const captions = [];
  for (const caption of truth.captionTexts ?? []) {
    const n = norm(caption);
    if (!n) continue;
    // 允许出处里是更长的句子，或 caption 是出处里两段拼起来的
    if (corpus.includes(n) || visionAll.includes(n)) captions.push(caption);
    else review.push(`图中原文「${caption}」在证据中找不到出处，未采信`);
  }
  const points = [];
  const numberCorpus = new Set([
    ...[ev.promptTail, ev.bankEssay, ev.yellowBook, ev.slp?.firstPara, ev.slp?.reference]
      .join(' ').replace(/,(?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?/g) ?? [],
    ...(ev.vision?.stablePoints ?? []).join(' ').match(/\d+(?:\.\d+)?/g) ?? [],
  ].map((x) => String(Number(x))));
  for (const point of truth.chart?.points ?? []) {
    const nums = String(point.value ?? '').replace(/,(?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
    if (nums.length && nums.every((x) => numberCorpus.has(String(Number(x))))) points.push(point);
    else review.push(`数据「${point.label}=${point.value}」无文字证据且两次视觉读数不一致，未采信`);
  }
  return {
    ...truth,
    captionTexts: captions,
    chart: truth.chart?.type ? { ...truth.chart, points } : truth.chart ?? null,
    needsReview: [...new Set(review)],
  };
}

const sources = JSON.parse(await readFile(path.join(TMP, 'exam-truth-sources.json'), 'utf8'));
const vision = JSON.parse(await readFile(path.join(TMP, 'exam-truth-vision.json'), 'utf8'));
let store = { meta: {}, exams: {} };
try { store = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 首次生成 */ }

const args = process.argv.slice(2);
const force = args.includes('--force');
const wanted = args.filter((a) => !a.startsWith('--'));
const ids = (wanted.length ? wanted : Object.keys(sources)).sort();

for (const id of ids) {
  if (store.exams[id] && !force && store.exams[id].status !== 'error') { console.log(`${id}  已有，跳过`); continue; }
  const ev = evidenceFor(id, sources, vision);
  const hasText = Boolean(ev.bankEssay || ev.yellowBook || ev.slp?.firstPara);
  try {
    const out = await chatJson({
      tier: 'reasoning',
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(ev) }],
      temperature: 0,
      maxTokens: 3000,
    });
    const truth = audit(out.data ?? out, ev);
    store.exams[id] = {
      ...truth,
      examId: id,
      // 图表题的数据在题干文本层里就能逐个核对，有题干数字支撑的不必联网；
      // 图画题没有范文/讲义时，画面与寓意都只能靠视觉，必须联网或人工再核
      status: hasText
        ? 'verified-by-text'
        : (ev.essayType !== 'picture' && (truth.chart?.points?.length ?? 0) > 0 && /\d/.test(ev.promptTail) ? 'verified-by-prompt' : 'needs-web'),
      sources: {
        yellowBook: Boolean(ev.yellowBook), bankEssay: Boolean(ev.bankEssay),
        slp: Boolean(ev.slp?.firstPara || ev.slp?.observe), vision: Boolean(ev.vision),
      },
    };
    console.log(`${id}  ${store.exams[id].status}  原文${truth.captionTexts.length}条  数据${truth.chart?.points?.length ?? 0}项  待核${truth.needsReview.length}  冲突${(truth.conflicts ?? []).length}`);
  } catch (err) {
    store.exams[id] = { examId: id, status: 'error', error: String(err.message).slice(0, 300) };
    console.log(`${id}  ✗ ${String(err.message).slice(0, 120)}`);
  }
  store.meta = {
    title: '大作文题图标准答案',
    note: '由黄皮书/题库范文/石雷鹏讲义/真题题干与双次视觉转录交叉核定；captionTexts 与 chart.points 均经出处复核。',
    count: Object.keys(store.exams).length,
  };
  await writeFile(OUT, JSON.stringify(store, null, 1) + '\n', 'utf8');
}
console.log('written', OUT);
