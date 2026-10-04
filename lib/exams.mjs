import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DIR } from './paths.mjs';
import { extractChartNumbers } from './chart-numbers.mjs';

export const EXAMS_FILE = path.join(KNOWLEDGE_DIR, 'exams.json');

let cache = null;

export class ExamsMissingError extends Error {
  constructor() {
    super('题库尚未生成，缺少：knowledge/exams.json。请先准备符合约定 schema 的题库文件。');
    this.name = 'ExamsMissingError';
    this.status = 503;
    this.code = 'exams_not_built';
  }
}

function asText(value) {
  return value == null ? '' : String(value);
}

function normalizeExam(exam, index) {
  if (!exam || typeof exam !== 'object' || Array.isArray(exam)) {
    throw new TypeError(`exams[${index}] 必须是对象。`);
  }
  const normalized = {
    id: asText(exam.id).trim(),
    examType: asText(exam.examType).trim(),
    year: exam.year == null ? '' : exam.year,
    section: asText(exam.section).trim(),
    essayType: asText(exam.essayType).trim(),
    title: asText(exam.title),
    directions: asText(exam.directions),
    prompt: asText(exam.prompt),
    requirements: exam.requirements ?? '',
    image: exam.image ?? null,
    modelEssay: exam.modelEssay ?? null,
    sources: Array.isArray(exam.sources) ? exam.sources : [],
  };
  if (!normalized.id) throw new TypeError(`exams[${index}].id 不能为空。`);
  return normalized;
}

function readBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function hasEssay(exam) {
  return typeof exam.modelEssay === 'string'
    ? exam.modelEssay.trim().length > 0
    : Boolean(exam.modelEssay);
}

function summary(exam) {
  const { modelEssay, ...rest } = exam;
  return { ...rest, hasEssay: hasEssay(exam) };
}

function shuffle(items) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** 加载并规范化 knowledge/exams.json；缺失文件不会在模块导入时阻塞服务启动。 */
export async function loadExams({ force = false } = {}) {
  if (cache && !force) return cache;
  if (!existsSync(EXAMS_FILE)) throw new ExamsMissingError();

  let source;
  try {
    source = JSON.parse(await readFile(EXAMS_FILE, 'utf8'));
  } catch (err) {
    const wrapped = new Error(`题库文件无法读取或不是合法 JSON：${err.message}`);
    wrapped.status = 503;
    wrapped.code = 'exams_invalid';
    throw wrapped;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(source.exams)) {
    const err = new Error('题库文件格式无效：根对象必须包含 exams 数组。');
    err.status = 503;
    err.code = 'exams_invalid';
    throw err;
  }

  const exams = source.exams.map(normalizeExam);
  cache = {
    meta: source.meta ?? null,
    exams,
    byId: new Map(exams.map((exam) => [exam.id, exam])),
  };
  return cache;
}

/** 返回题库统计信息，字段值即使题库为空也保持稳定。 */
export async function stats() {
  const data = await loadExams();
  const countBy = (field) => data.exams.reduce((counts, exam) => {
    const value = exam[field] == null || exam[field] === '' ? 'unknown' : String(exam[field]);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
  return {
    meta: data.meta,
    exams: data.exams.length,
    withEssay: data.exams.filter(hasEssay).length,
    withoutEssay: data.exams.filter((exam) => !hasEssay(exam)).length,
    examTypes: countBy('examType'),
    years: countBy('year'),
    sections: countBy('section'),
    essayTypes: countBy('essayType'),
  };
}

/** 按题型、年份、章节、作文类型和关键词筛选；返回摘要，不泄漏完整 modelEssay。 */
export async function listExams({
  examType,
  year,
  section,
  essayType,
  keyword,
  hasEssay: hasEssayFilter,
  random = false,
  limit = 200,
  page,
} = {}) {
  const data = await loadExams();
  let list = data.exams;
  const exact = (field, value) => {
    if (value == null || String(value).trim() === '') return;
    const wanted = String(value).trim().toLowerCase();
    list = list.filter((exam) => String(exam[field]).toLowerCase() === wanted);
  };
  exact('examType', examType);
  exact('year', year);
  exact('section', section);
  exact('essayType', essayType);

  if (keyword != null && String(keyword).trim()) {
    const wanted = String(keyword).trim().toLowerCase();
    list = list.filter((exam) => [
      exam.id, exam.examType, exam.year, exam.section, exam.essayType,
      exam.title, exam.directions, exam.prompt,
      JSON.stringify(exam.requirements ?? ''), JSON.stringify(exam.modelEssay ?? ''), JSON.stringify(exam.sources ?? []),
      exam.image,
    ].join('\n').toLowerCase().includes(wanted));
  }
  if (hasEssayFilter !== undefined && hasEssayFilter !== null && String(hasEssayFilter) !== '') {
    const wanted = readBoolean(hasEssayFilter);
    list = list.filter((exam) => hasEssay(exam) === wanted);
  }

  if (readBoolean(random)) list = shuffle(list);
  const numericLimit = Number(limit);
  const safeLimit = Number.isFinite(numericLimit) && numericLimit >= 0 ? Math.floor(numericLimit) : 200;
  const numericPage = Number(page);
  const offset = Number.isFinite(numericPage) && numericPage > 1 ? (Math.floor(numericPage) - 1) * safeLimit : 0;
  return list.slice(offset, offset + safeLimit).map(summary);
}

/** 按 id 返回完整题目；详情不存在时返回 null，由路由转换为 404。 */
export async function detail(id) {
  const data = await loadExams();
  return data.byId.get(String(id ?? '')) ?? null;
}

function essayParagraphs(modelEssay) {
  if (Array.isArray(modelEssay)) return modelEssay;
  if (Array.isArray(modelEssay?.paragraphs)) return modelEssay.paragraphs;
  return [];
}

function normalizeReferenceText(value) {
  return asText(value)
    .replace(/^\s*\)\s*/, '')
    .replace(/(?<=\d)[lI](?=\.\d)/g, '1')
    .replace(/\s+/g, ' ')
    .trim();
}

function paragraphSentences(paragraph) {
  if (Array.isArray(paragraph?.sentences)) {
    return paragraph.sentences.map((item) => normalizeReferenceText(item?.text ?? item)).filter(Boolean);
  }
  return asText(paragraph?.text).split(/(?<=[.!?])\s+/).map(normalizeReferenceText).filter(Boolean);
}

/**
 * 外部视觉服务不可用时，为题库已校对题目提供离线事实摘要。
 * 只取范文首段中的客观描述和题干内原始数据，不复用后续论点或原因。
 */
export const EXAM_TRUTH_FILE = path.join(KNOWLEDGE_DIR, 'exam-truth.json');
let truthCache = null;

/** 读取并缓存识图标准答案（由 build-exam-truth 多源核定生成）。 */
export async function loadExamTruth({ force = false } = {}) {
  if (truthCache && !force) return truthCache;
  try {
    const parsed = JSON.parse(await readFile(EXAM_TRUTH_FILE, 'utf8'));
    truthCache = parsed.exams ?? {};
  } catch {
    truthCache = {};
  }
  return truthCache;
}

/**
 * 把标准答案转成与 referenceAnalysis 同构的分析对象，供成文链校正识图。
 * 与范文首段正则抽取相比，标准答案是多源核定 + 出处复核的结果，
 * 图中原文、画面主体、图表数值都更可靠，因此标 chineseTextVerified 让它压过视觉转录。
 */
export async function truthAnalysis(id) {
  const truth = (await loadExamTruth())[asText(id)];
  if (!truth || !truth.scene) return null;
  const essayType = asText(truth.essayType).toLowerCase();
  const isChart = essayType === 'chart' || essayType === 'table';
  const isHybrid = essayType === 'hybrid';
  const points = (truth.chart?.points ?? []).map((p) => ({ label: asText(p.label), value: asText(p.value), source: 'examTruth' }));
  const base = {
    sourceType: 'examReference',
    examTruthStatus: truth.status ?? null,
    sceneDescription: asText(truth.scene),
    chineseText: (truth.captionTexts ?? []).join(' / ') || null,
    chineseTextVerified: (truth.captionTexts ?? []).length > 0,
    themeGuess: asText(truth.theme) || null,
    themeBasis: (truth.themeEvidence ?? []).join(' ') || null,
    objectsSeen: truth.keyObjects ?? [],
    misreadRisks: truth.misreadRisks ?? [],
    uncertain: truth.needsReview ?? [],
    confidence: truth.status === 'needs-web' ? 0.6 : 0.9,
  };
  if (isChart || isHybrid) {
    return {
      ...base,
      category: '图表作文',
      subType: isHybrid ? '混合图表' : (truth.chart?.type === 'pie' || truth.chart?.type === 'table' ? '静态' : '动态'),
      chartData: {
        title: asText(truth.chart?.title) || null,
        chartType: asText(truth.chart?.type) || (isHybrid ? 'hybrid' : 'bar'),
        unit: asText(truth.chart?.unit) || null,
        dataPoints: points,
        labelNumbers: [],
        keyContrasts: points.length ? [truth.scene] : [],
        chartAuthority: 'examTruth',
      },
    };
  }
  return { ...base, category: '大作文', subType: '图画类' };
}

export function referenceAnalysis(exam) {
  if (!exam || !exam.modelEssay) return null;
  const first = essayParagraphs(exam.modelEssay)[0];
  const sentences = paragraphSentences(first);
  const objective = [];
  let themeSentence = '';
  const interpretationMarker = /(?:the\s+)?(?:picture|drawing|cartoon)\s+(?:demonstrates?|indicates?|reveals?|symbolizes?|implies?)\b/i;
  for (const sentence of sentences) {
    const marker = sentence.search(interpretationMarker);
    if (marker === 0 || /^nowadays\b/i.test(sentence)) {
      themeSentence = sentence.split(/nowadays\b/i)[0].trim();
      break;
    }
    if (marker > 0) {
      objective.push(sentence.slice(0, marker).trim());
      themeSentence = sentence.slice(marker).split(/nowadays\b/i)[0].trim();
      break;
    }
    objective.push(sentence);
    if (objective.length >= 3) break;
  }
  const essayType = asText(exam.essayType).toLowerCase();
  if (essayType === 'picture' || essayType === 'hybrid') {
    const sceneDescription = objective.join(' ') || sentences[0] || '';
    if (!sceneDescription) return null;
    const quote = sceneDescription.match(/[“\"]([^”\"]{2,160})[”\"]/);
    const themeMatch = themeSentence.match(/(?:interest|significance|importance|value)\s+(?:in|of)\s+(.+?)(?:[.!]|$)/i);
    const themeGuess = (themeMatch?.[1] ?? themeSentence.replace(interpretationMarker, '').replace(/^\s*(?:that\s+)?/i, '')).trim() || null;
    const hybridValues = essayType === 'hybrid'
      ? [...new Set(sceneDescription.match(/\d+(?:\.\d+)?%?/g) ?? [])]
      : [];
    return {
      sourceType: 'examReference',
      category: essayType === 'hybrid' ? '图表作文' : '大作文',
      subType: essayType === 'hybrid' ? '混合图表' : '图画类',
      sceneDescription,
      chineseText: quote?.[1] ?? null,
      themeGuess,
      themeBasis: themeSentence || null,
      objectsSeen: [],
      chartData: essayType === 'hybrid' ? {
        title: asText(exam.title) || null,
        chartType: 'hybrid',
        unit: null,
        dataPoints: hybridValues.map((value, index) => ({ label: `图中数值${index + 1}`, value })),
        keyContrasts: [sceneDescription],
      } : undefined,
      uncertain: ['外部视觉服务不可用；画面事实来自题库已校对范文首段的客观描述。'],
      confidence: 0.82,
    };
  }
  if (essayType === 'chart') {
    const raw = `${exam.directions}\n${exam.prompt}`;
    const chartBody = raw.split(/\(\s*15\s+points?\s*\)\.?/i).at(-1) ?? '';
    const rawPercentValues = extractChartNumbers(chartBody).filter((token) => token.percent).map((token) => token.raw);
    const promptPercentValues = extractChartNumbers(raw).filter((token) => token.percent).map((token) => token.raw);
    const percentValues = rawPercentValues.length ? rawPercentValues : [...new Set(promptPercentValues)];
    const labelNumbers = [...new Set(extractChartNumbers(chartBody).filter((token) => !token.percent).map((token) => token.raw))];
    // 有些英语二题目的图表数字只出现在原图，题干文本没有任何百分号。
    // 离线兜底改用已校对范文首段的客观描述，避免后续成文既拿不到事实又被数字校验拦截。
    const referenceValues = objective.flatMap((sentence) => extractChartNumbers(sentence).map((token) => token.raw));
    const values = percentValues.length ? percentValues : referenceValues;
    const ageLabels = [...new Set([...chartBody.matchAll(/(?:≤\s*40\s*岁|41\s*[—–-]\s*50\s*岁|>\s*50\s*岁)/g)].map((match) => match[0].replace(/\s+/g, '')) )];
    const columnLabels = ['满意', '不清楚', '不满意'].filter((label) => chartBody.includes(label));
    const pointLabels = ageLabels.length * columnLabels.length === values.length
      ? values.map((_, index) => `${ageLabels[Math.floor(index / columnLabels.length)]}-${columnLabels[index % columnLabels.length]}`)
      : values.map((_, index) => `图中项目${String.fromCharCode(65 + index)}`);
    const chartType = /pie\s+chart|饼图/i.test(raw) ? 'pie' : /line\s+(?:chart|graph)|折线/i.test(raw) ? 'line' : /table|表格/i.test(raw) ? 'table' : 'bar';
    return {
      sourceType: 'examReference',
      category: '图表作文',
      subType: chartType === 'pie' || chartType === 'table' ? '静态' : '动态',
      chartData: {
        title: asText(exam.title) || null,
        chartType,
        unit: rawPercentValues.length || referenceValues.some((value) => /%$/.test(value)) ? '%' : null,
        dataPoints: values.map((value, index) => ({ label: pointLabels[index], value, source: rawPercentValues.length ? 'examReference-prompt' : 'examReference-modelEssay' })),
        labelNumbers,
        keyContrasts: objective.length ? [objective.join(' ')] : [],
      },
      uncertain: ['外部视觉服务不可用；图表事实来自题干原始数据和题库已校对范文首段。'],
      confidence: 0.8,
    };
  }
  return null;
}

/** 按同样的筛选条件抽取一题；返回完整详情，供 random 查询使用。 */
export async function random(filters = {}) {
  const data = await loadExams();
  const candidates = await listExams({ ...filters, random: true, limit: Number.MAX_SAFE_INTEGER });
  if (!candidates.length) return null;
  return data.byId.get(candidates[0].id) ?? null;
}

// 语义化别名，方便路由和其他模块调用。
export const load = loadExams;
export const list = listExams;
export const getStats = stats;
export const queryExams = listExams;
export const getExam = detail;
export const getRandomExam = random;

export function examsFileExists() {
  return existsSync(EXAMS_FILE);
}
