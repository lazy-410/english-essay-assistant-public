import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'knowledge');
const OUT = path.join(DIR, 'writing');
const RAW_FILES = ['raw-01-12.json', 'raw-13-24.json', 'raw-25-36.json', 'raw-37-47.json'];
const SLP_FILES = ['slp-big-e1.json', 'slp-big-e2.json', 'slp-small-e1.json', 'slp-small-e2.json'];
const SOURCE_FILES = [...RAW_FILES, ...SLP_FILES];
const sourceIds = {
  'raw-01-12.json': 'scan-handout', 'raw-13-24.json': 'scan-handout', 'raw-25-36.json': 'scan-handout', 'raw-37-47.json': 'scan-handout',
  'slp-big-e1.json': 'slp-big-e1', 'slp-big-e2.json': 'slp-big-e2', 'slp-small-e1.json': 'slp-small-e1', 'slp-small-e2.json': 'slp-small-e2',
};
const labels = {
  'scan-handout': ['考研英语作文扫描讲义', 47], 'slp-big-e1': ['26 石雷鹏大作文笔记 - 英语一', 70], 'slp-big-e2': ['26 石雷鹏大作文笔记 - 英语二', 64],
  'slp-small-e1': ['26 石雷鹏小作文笔记 - 英语一', 62], 'slp-small-e2': ['26 石雷鹏小作文笔记 - 英语二', 58],
};
const readJson = async (f) => JSON.parse(await readFile(path.join(DIR, f), 'utf8'));
const docs = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (f) => [f, await readJson(f)])));
const rawPages = SOURCE_FILES.flatMap((file) => docs[file].pages.map((page) => ({ ...page, source: sourceIds[file], sourceFile: file })));
const rawEntries = rawPages.flatMap((page) => (page.entries ?? []).map((entry, index) => ({
  ...entry, source: page.source, sourceFile: page.sourceFile, pageTitle: page.title, kind: page.kind, entryIndex: index,
})));
const slpEntries = rawEntries.filter((e) => e.source.startsWith('slp-'));
const allEntryIds = new Set(rawEntries.map((e) => e.id));
const ref = (entry) => ({ source: entry.source, sourceFile: entry.sourceFile, page: entry.page, entryId: entry.id, pageTitle: entry.pageTitle, originalText: entry.originalText ?? entry.en });
const clean = (v) => typeof v === 'string' ? v.trim() : v;
const words = (entry) => `${entry.id}\n${entry.section ?? ''}\n${entry.origin ?? ''}\n${entry.en ?? ''}\n${entry.zh ?? ''}`;
const suspicious = (entry) => Array.isArray(entry.uncertain) && entry.uncertain.length > 0 || /笔误|draying|constituted|sucessful|foe |approimately|excceddingly|adpt |climat|Uniowho|betwee|he Great Wall|may constituted|⟨\?⟩/i.test(words(entry));
function trackOf(entry) {
  if (entry.source === 'slp-big-e2' || entry.kind === 'chart-essay' || /chart/.test(entry.id)) return 'chart';
  if (entry.kind?.startsWith('small-') || entry.source.startsWith('slp-small') || entry.letterType || entry.id.startsWith('small-')) return 'small';
  return 'picture';
}
function positionOf(entry) {
  // entry.section 描述具体句子的段落位置，优先于所在页面 kind；
  // 同一讲解页可能同时收录首段和主体段句子。
  const section = String(entry.section ?? '');
  if (/第一段|首段/.test(section)) return 'opening';
  if (/第三段|尾段/.test(section)) return 'closing';
  if (/第二段|中间段|主体段/.test(section)) return 'body';
  const fallback = `${entry.kind ?? ''} ${entry.id ?? ''}`;
  if (/opening|open-|para1|p1-/.test(fallback)) return 'opening';
  if (/closing|close-|para3|p3-/.test(fallback)) return 'closing';
  return 'body';
}
function functionOf(entry) {
  // section 与稳定 ID 描述实际句子功能；pageTitle 常含“建议 160-200 词”等全页说明，
  // 不能据此把开头描述句误判成 advice。
  const core = `${entry.section ?? ''} ${entry.kind ?? ''} ${entry.id ?? ''}`;
  const position = positionOf(entry);
  if (position === 'closing' || /总结|收尾|展望|期待|致谢|尾段/.test(core)) return 'closing';
  if (/警示|危害|批判/.test(core)) return 'warning';
  if (/建议|措施|行动|解决/.test(core)) return 'advice';
  if (/原因|理由|解释|论证|意义|影响|现象评价/.test(core)) return 'reason';
  if (/描述|数据|排序|趋势|场景|图表|画面|文字说明/.test(core)) return 'description';
  if (position === 'opening' || /引入|首句|开头|自我介绍|寒暄|身份|目的/.test(core)) return 'introduction';
  return 'development';
}
function applicabilityOf(entry) {
  const s = `${entry.section ?? ''} ${entry.pageTitle ?? ''} ${entry.letterType ?? ''}`;
  const values = [];
  if (trackOf(entry) === 'small') values.push('small', ...(entry.letterType ? [entry.letterType] : []));
  if (/图表|chart|数据|排序|趋势/.test(s)) values.push('chart');
  if (/图画|漫画|picture|品质|现象/.test(s)) values.push('picture');
  if (/静态|饼图|柱状图/.test(s)) values.push('static-chart');
  if (/动态|折线|趋势|变化/.test(s)) values.push('dynamic-chart');
  if (/双图|双图|two photos|两幅/.test(s)) values.push('double-picture');
  if (/单图|single|一幅/.test(s)) values.push('single-picture');
  if (/正面|积极|益处|好处|品质/.test(s)) values.push('positive');
  if (/反面|负面|危害|批判/.test(s)) values.push('negative');
  return [...new Set(values.length ? values : [trackOf(entry)])];
}
function conflictGroup(entry) {
  const s = `${entry.section ?? ''} ${entry.pageTitle ?? ''} ${entry.id}`;
  const polarity = /反面|负面|危害|批判|negative|倒装警示/.test(s) ? 'negative' : /正面|积极|益处|好处|品质|positive/.test(s) ? 'positive' : 'neutral';
  const mode = /双图|双图|two photos|两幅/.test(s) ? 'double' : /单图|single|一幅/.test(s) ? 'single' : /动态|折线|趋势|变化/.test(s) ? 'dynamic' : /静态|饼图|柱状图/.test(s) ? 'static' : 'general';
  const fn = functionOf(entry);
  return `${trackOf(entry)}:${positionOf(entry)}:${fn}:${mode}:${polarity}`;
}
function estimatedWords(entry) { return Math.max(4, Math.round(String(entry.en ?? '').split(/\s+/).filter(Boolean).length * 1.15)); }
function sourceMetadata() { return Object.entries(labels).map(([source, [sourceLabel, totalPages]]) => ({ source, sourceLabel, totalPages, scope: source === 'scan-handout' ? '扫描讲义' : '石雷鹏笔记' })); }

const methods = [];
const pageMap = [];
for (const page of rawPages) {
  pageMap.push({ source: page.source, sourceFile: page.sourceFile, page: page.page, title: page.title, kind: page.kind, entryIds: (page.entries ?? []).map((e) => e.id), pageNotes: page.pageNotes ?? [], coverage: docs[page.sourceFile].coverage ?? null });
  for (const [index, note] of (page.pageNotes ?? []).entries()) {
    const text = String(note);
    const category = /注意|易错|误区|警示|避免|不要|不能|错误|规范/.test(text) ? 'warning' : /方法|技巧|策略|建议|写作|替换|选写|组合|结构/.test(text) ? 'method' : 'study';
    methods.push({ id: `method-${page.source}-p${page.page}-${String(index + 1).padStart(2, '0')}`, category, text, sourceRefs: [{ source: page.source, sourceFile: page.sourceFile, page: page.page, pageTitle: page.title }] });
  }
}
const skeletons = rawEntries.map((entry) => {
  const eligible = !suspicious(entry) && Boolean(entry.en?.trim());
  return {
    id: `sk-${entry.id}`, semanticKey: `${trackOf(entry)}.${functionOf(entry)}.${entry.id}`, rhetoricalFunction: functionOf(entry), conflictGroup: conflictGroup(entry),
    applicability: applicabilityOf(entry), slots: entry.slots ?? [], en: entry.en ?? '', zh: entry.zh ?? '', swappable: entry.swappable ?? [],
    constraints: (entry.notes ?? []).filter((n) => /必须|只能|专用|对应|成对|不要|不可|不能|注意/.test(n)), sourceRefs: [ref(entry)], status: eligible ? 'production' : 'draft', productionEligible: eligible, estimatedWords: estimatedWords(entry), sourceEntryId: entry.id,
  };
});
const variants = rawEntries.flatMap((entry) => (entry.swappable ?? []).map((value, index) => ({ id: `var-${entry.id}-${String(index + 1).padStart(2, '0')}`, skeletonId: `sk-${entry.id}`, value, constraint: (entry.notes ?? []).find((n) => /正面|反面|动态|静态|必须|只能|对应|成对/.test(n)) ?? '仅在保持原句语义与语法一致时替换', sourceRefs: [ref(entry)] })));
const yearOf = (text) => {
  const match = String(text ?? '').match(/(?<!\d)(?:(?:19|20)\d{2}|\d{2})\s*年/);
  if (!match) return null;
  const digits = match[0].match(/\d+/)[0];
  return digits.length === 2 ? `20${digits}` : digits;
};
const examples = [];
for (const entry of rawEntries) for (const [index, ex] of (entry.examples ?? []).entries()) examples.push({ id: `ex-${entry.id}-${String(index + 1).padStart(2, '0')}`, label: ex.label, en: ex.en, zh: ex.zh, year: yearOf(ex.label), sourceRefs: [ref(entry)], skeletonIds: [`sk-${entry.id}`], structured: true, needsVerification: suspicious(entry) });
const coverage = Object.fromEntries(SLP_FILES.map((file) => [sourceIds[file], docs[file].coverage ?? { included: [], mergedAsDuplicate: [] }]));
for (const [source, data] of Object.entries(coverage)) for (const text of data.mergedAsDuplicate ?? []) examples.push({ id: `ex-coverage-${source}-${examples.length + 1}`, label: text, en: null, zh: null, year: yearOf(text), sourceRefs: [{ source, sourceFile: `${source}.json` }], skeletonIds: [], structured: false, needsVerification: true, restoredFromCoverage: true });

/**
 * 提取 4 份石雷鹏讲义 PDF 的逐页正文。
 *
 * 早期实现把整页文本截成 t[:180] 塞进 label 并把 en/zh 写死 null，导致 219 条 example
 * 只剩「页眉+页码+半句话」的残片，中英对照全部丢失。这里改为：
 *   1. 保留整页正文（不截断），并剥掉固定页眉与末尾页码；
 *   2. 跳过只有页眉的空白页（原先会为它们生成无意义条目）；
 *   3. 按讲义排版切出中英对照：优先「参考译文：」段，其次「中文句 + 紧随的英文句」。
 * 所有内容均来自讲义原文，不做任何改写或生成。
 */
function pdfCatalog() {
  const script = String.raw`
import fitz, glob, os, json, re, sys
sys.stdout.reconfigure(encoding='utf-8')
p = r'C:/Users/懒将军/.narrafork/attached'
HDR = re.compile(r'^26\s*石雷鹏[^）]*）\s*公众号【学长小谭考研】免费分享\s*关注获取更多考研的干货资料\s*\d*\s*')
TAIL_PAGE = re.compile(r'\s+\d{1,3}$')
# 「参考译文：」后整段中文为译文；对应英文是该标记之前的连续英文句，全部拼接才与整篇译文对等。
# 只认这一种排版：讲义里其他中英混排（体裁总结、词汇表等）不是对照关系，强行切分会造出错误对照。
REF = re.compile(r'参考译文[:：]\s*(.+)$')
EN_RUN = re.compile(r'[A-Z][A-Za-z0-9,;:\'"()\-\s]{40,}[.!?]')
out = []
for f in sorted(glob.glob(p + '/*石雷鹏*.pdf')):
    d = fitz.open(f)
    for i in range(len(d)):
        raw = ' '.join(d[i].get_text().split())
        body = TAIL_PAGE.sub('', HDR.sub('', raw)).strip()
        if len(body) < 20:
            continue  # 仅页眉的空白页不生成条目
        m = re.search(r'(?<!\d)(20\d{2})(?!\d)', body)
        en = zh = None
        ref = REF.search(body)
        if ref:
            zh = ref.group(1).strip()
            runs = [r.strip() for r in EN_RUN.findall(body[:ref.start()])]
            if runs:
                en = ' '.join(runs)
            else:
                zh = None  # 找不到对应英文就不单独留中文，避免半截对照
        out.append({
            'pdf': os.path.basename(f), 'pdfPage': i + 1,
            'title': body, 'en': en, 'zh': zh,
            'year': m.group(1) if m else None,
        })
print(json.dumps(out, ensure_ascii=False))
`;
  try { return JSON.parse(execFileSync('python', ['-c', script], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 })); } catch { return []; }
}
const structuredPages = new Map(rawPages.filter((p) => p.source.startsWith('slp-')).map((p) => [`${p.source}:${p.page}`, true]));
const slpOf = (pdf) => pdf.includes('大作文笔记 - 英语一') ? 'slp-big-e1'
  : pdf.includes('大作文笔记 - 英语二') ? 'slp-big-e2'
  : pdf.includes('小作文笔记 - 英语一') ? 'slp-small-e1' : 'slp-small-e2';
for (const item of pdfCatalog()) {
  if (structuredPages.has(`${slpOf(item.pdf)}:${item.pdfPage}`)) continue;
  const text = String(item.title ?? '').trim();
  examples.push({
    id: `ex-catalog-${item.pdfPage}-${Buffer.from(item.pdf).toString('hex').slice(0, 12)}`,
    // label 只做列表摘要，完整正文放 pageText，避免再次丢失原文
    label: text.length > 120 ? `${text.slice(0, 120)}…` : (text || `PDF 第 ${item.pdfPage} 页`),
    pageText: text || null,
    en: item.en ?? null,
    zh: item.zh ?? null,
    year: item.year,
    sourceRefs: [{ source: Object.keys(labels).find((s) => labels[s][0].includes(item.pdf.split('【')[0])) ?? 'pdf-attachment', pdfPage: item.pdfPage, pdf: item.pdf }],
    skeletonIds: [],
    structured: false,
    // 已切出中英对照的条目不再需要人工核对译文
    needsVerification: !(item.en && item.zh),
    catalogOnly: true,
  });
}

const warnings = methods.filter((m) => m.category === 'warning').map((m) => ({ ...m, id: `warning-${m.id}` }));
const aliases = { task: { chart: ['图表作文', 'chart-essay'], picture: ['图画作文', 'big-essay'], small: ['小作文', '应用文'] }, function: { introduction: ['引入', '开头', '首段'], description: ['描述', '数据', '趋势'], reason: ['原因', '理由'], advice: ['建议', '措施'], closing: ['结尾', '收束', '尾段'] }, applicability: { 'static-chart': ['静态图', '静态图表'], 'dynamic-chart': ['动态图', '动态图表'], 'single-picture': ['单图'], 'double-picture': ['双图'] } };
const relations = { conflictGroups: Object.fromEntries([...new Set(skeletons.map((s) => s.conflictGroup))].sort().map((g) => [g, skeletons.filter((s) => s.conflictGroup === g).map((s) => s.id)])), skeletonToVariants: Object.fromEntries(skeletons.map((s) => [s.id, variants.filter((v) => v.skeletonId === s.id).map((v) => v.id)])), exampleToSkeletons: Object.fromEntries(examples.map((e) => [e.id, e.skeletonIds])) };
const sources = sourceMetadata();
const audit = { version: 2, migration: { sourceFiles: SOURCE_FILES, rawEntryCount: rawEntries.length, slpEntryCount: slpEntries.length, expectedSlpEntries: 158, pageNoteCount: methods.length, coverage, sourceEntryIds: rawEntries.map((e) => e.id), mergedYears: examples.filter((e) => e.restoredFromCoverage).map((e) => e.year) }, sourceRecords: docs };
const meta = { version: 2, title: '写作知识库 V2', generatedAt: 'deterministic', sources, counts: { pages: pageMap.length, methods: methods.length, warnings: warnings.length, entries: rawEntries.length, skeletons: skeletons.length, productionSkeletons: skeletons.filter((s) => s.productionEligible).length, variants: variants.length, examples: examples.length, structuredExamples: examples.filter((e) => e.structured).length, catalogExamples: examples.filter((e) => e.catalogOnly).length, slpEntries: slpEntries.length } };
await mkdir(OUT, { recursive: true });
const outputs = { 'sources.json': { meta, sources }, 'page-map.json': { meta, pages: pageMap }, 'methods.json': { meta, methods }, 'skeletons.json': { meta, skeletons }, 'variants.json': { meta, variants }, 'examples.json': { meta, examples }, 'warnings.json': { meta, warnings }, 'relations.json': { meta, relations }, 'aliases.json': { meta, aliases }, 'audit.json': { meta, audit } };
for (const [file, value] of Object.entries(outputs)) await writeFile(path.join(OUT, file), JSON.stringify(value, null, 2) + '\n', 'utf8');
console.log(`writing-kb V2 已构建：${rawEntries.length} entries（SLP ${slpEntries.length}）/ ${skeletons.length} skeletons（生产 ${meta.counts.productionSkeletons}）/ ${methods.length} pageNotes / ${examples.length} examples`);
