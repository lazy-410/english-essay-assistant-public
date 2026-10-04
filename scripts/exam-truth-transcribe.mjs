// 用千问视觉对每张大作文题图做「逐字转录 + 客观罗列」，作为标准答案的图像侧证据。
// 只要求转录可见文字与可见元素，禁止推断寓意 —— 寓意由范文/讲义等文字证据给出。
// 每张图跑两次（不同措辞），两次不一致的字段标为待人工确认，不自动采信。
//
// 用法：node scripts/exam-truth-transcribe.mjs [examId ...]
// 输出：../tmp/exam-truth-vision.json
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { DASHSCOPE_BASE } from '../lib/vision.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(path.dirname(ROOT), 'tmp', 'exam-truth-vision.json');

const PROMPTS = [
  `你在为考研英语作文题图建立校对档案。只做两件事，不要推测寓意或主题：
1. 逐字转录图中所有可见文字：标题、对话气泡、人物身上/物品上的字、图下方说明、图表标题/图例/坐标轴/每个数据标签与数值。保持原样（中文就写中文，英文就写英文），看不清的字用□代替。
2. 客观罗列画面元素：有几幅分图、每幅里有几个人、各自的动作与表情、关键物品、场景。
严格返回 JSON：{"panels":数字,"texts":[{"where":"位置","text":"原文"}],"people":[{"panel":1,"who":"","doing":""}],"objects":["物品"],"scene":"场景","chart":{"type":"pie/bar/line/table/null","title":"","unit":"","points":[{"label":"","value":""}]},"unclear":["看不清的部分"]}`,
  `请仔细查看这张考试题图，像校对员一样记录事实，不要解释含义。
- texts：图里出现的每一处文字，照抄原文并注明位置（如"左图气泡""图下方标题""柱子上方数值"）
- people：每个人物在做什么（按分图编号）
- objects：画面里能看见的物品
- chart：若是图表，逐项列出标签和数值（含单位）；不是图表则 type 为 null
- unclear：看不清或拿不准的地方
只返回 JSON：{"panels":数字,"texts":[{"where":"","text":""}],"people":[{"panel":1,"who":"","doing":""}],"objects":[],"scene":"","chart":{"type":null,"title":"","unit":"","points":[]},"unclear":[]}`,
];

async function callVision(key, model, dataUrl, prompt) {
  const res = await fetch(DASHSCOPE_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const raw = (json.choices?.[0]?.message?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(raw);
}

const normalize = (s) => String(s ?? '').replace(/[\s"'“”‘’。，,.!！?？:：]/g, '').toLowerCase();

/** 两次转录的文字取交集：只有两次都读到的才算稳定。 */
function agreeTexts(a, b) {
  const bs = (b?.texts ?? []).map((t) => normalize(t.text));
  const stable = [];
  const unstable = [];
  for (const t of a?.texts ?? []) {
    const n = normalize(t.text);
    if (!n) continue;
    (bs.some((x) => x && (x.includes(n) || n.includes(x))) ? stable : unstable).push(t.text);
  }
  for (const t of b?.texts ?? []) {
    const n = normalize(t.text);
    if (n && !(a?.texts ?? []).some((x) => { const m = normalize(x.text); return m && (m.includes(n) || n.includes(m)); })) unstable.push(t.text);
  }
  return { stable, unstable };
}

// 数值只比数字本身：两次转录常一次带 % 一次不带（"40%" vs "40"），不能因此判为不一致
const numberOf = (s) => (String(s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/) ?? [''])[0];

/**
 * 模型返回的数据点格式不固定：{label,value}、{x,y,series}、{label,values:[{x,y}]}，
 * 统一展平成 {label,value}。
 */
function normalizePoints(points) {
  const out = [];
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || typeof p !== 'object') continue;
    if (Array.isArray(p.values)) {
      for (const v of p.values) out.push({ label: [v?.x, p.label ?? p.series].filter(Boolean).join(' '), value: String(v?.y ?? v?.value ?? '') });
      continue;
    }
    if (p.label != null || p.value != null) { out.push({ label: String(p.label ?? ''), value: String(p.value ?? '') }); continue; }
    out.push({ label: [p.x, p.series].filter((v) => v != null && v !== '').join(' '), value: p.y == null ? '' : String(p.y) });
  }
  return out;
}

/**
 * 一次转录里出现的全部数据数值，用于格式不同时的兜底比对。
 * 年份是坐标而非数据（"68.1% (2013年)" 里的 2013），先剔掉再取数。
 */
function numberBag(run) {
  const bag = [];
  const collect = (s) => {
    const cleaned = String(s ?? '').replace(/,(?=\d{3}\b)/g, '').replace(/[（(]?\s*(?:19|20)\d{2}\s*年?\s*[)）]?/g, ' ');
    for (const m of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) bag.push(String(Number(m[0])));
  };
  // value 里可能是 "空调: 75.2, 洗衣机: 83.7" 或 "68.1% (2013年), 60.7% (2018年)"，
  // 剔掉年份后逐个取数即可；label 是坐标/系列名，不参与
  for (const p of normalizePoints(run?.chart?.points)) collect(p.value);
  return bag;
}

function agreePoints(a, b) {
  const bagA = numberBag(a);
  const bagB = numberBag(b);
  // 两次都读到数值、且数值多重集合完全相同：只是格式不同，视为一致
  if (bagA.length && bagA.length === bagB.length && [...bagA].sort().join('|') === [...bagB].sort().join('|')) {
    return { stable: normalizePoints(a?.chart?.points).map((p) => `${p.label}=${p.value}`), unstable: [], byValueSet: true };
  }
  const pa = normalizePoints(a?.chart?.points);
  const pb = normalizePoints(b?.chart?.points);
  const stable = [];
  const unstable = [];
  const used = new Set();
  for (const p of pa) {
    const index = pb.findIndex((q, i) => !used.has(i) && numberOf(q.value) && numberOf(q.value) === numberOf(p.value)
      && (normalize(q.label).includes(normalize(p.label)) || normalize(p.label).includes(normalize(q.label))));
    if (index >= 0) { used.add(index); stable.push(`${p.label}=${p.value}`); } else unstable.push(`${p.label}=${p.value}`);
  }
  pb.forEach((q, i) => { if (!used.has(i)) unstable.push(`${q.label}=${q.value}`); });
  return { stable, unstable };
}

const cfg = await loadConfig();
const key = cfg.vision?.apiKey || process.env.DASHSCOPE_API_KEY;
const model = cfg.vision?.model || 'qwen3.7-plus';
if (!key) throw new Error('未配置千问视觉 Key');

const exams = JSON.parse(await readFile(path.join(ROOT, 'knowledge', 'exams.json'), 'utf8'));
const list = (Array.isArray(exams) ? exams : exams.exams).filter((e) => e.section === 'big');
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const targets = wanted.length ? list.filter((e) => wanted.includes(e.id)) : list;

let store = {};
try { store = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 首次运行 */ }

const force = process.argv.includes('--force');
for (const exam of targets) {
  const cached = store[exam.id];
  const cachedOk = cached && cached.runs?.length === PROMPTS.length && cached.runs.every((r) => !r.error);
  let runs;
  if (cachedOk && !force) {
    runs = cached.runs; // 已转录的题不重复调用，只重算一致性
  } else {
    const buf = await readFile(path.join(ROOT, exam.image));
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    runs = [];
    for (const prompt of PROMPTS) {
      try { runs.push(await callVision(key, model, dataUrl, prompt)); } catch (err) { runs.push({ error: err.message }); }
    }
  }
  const [a, b] = runs;
  const texts = agreeTexts(a, b);
  const points = agreePoints(a, b);
  store[exam.id] = { model, runs, agreement: { texts, points, panels: [a?.panels ?? null, b?.panels ?? null] } };
  console.log(`${exam.id}  文字 稳定${texts.stable.length}/不稳${texts.unstable.length}  数据 稳定${points.stable.length}/不稳${points.unstable.length}  分图 ${a?.panels ?? '?'}/${b?.panels ?? '?'}${a?.error || b?.error ? '  ⚠ ' + (a?.error || b?.error) : ''}`);
  await writeFile(OUT, JSON.stringify(store, null, 1), 'utf8');
}
console.log('written', OUT);
