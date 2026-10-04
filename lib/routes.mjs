import { loadConfig, saveConfig, maskConfig } from './config.mjs';
import { testConnection } from './deepseek.mjs';
import { recognizeImage } from './ocr.mjs';
import { queryTemplates, queryModules, queryVocab, getStats, isBuilt, loadKnowledge } from './kb.mjs';
import { classify } from './classify.mjs';
import { composeFull } from './compose.mjs';
import { composeV2 } from './compose-v2.mjs';
import { composeV3 } from './compose-v3.mjs';
import {
  getWritingStats,
  queryWritingMethods,
  queryWritingSkeletons,
  queryWritingWarnings,
  queryWritingExamples,
} from './writing-kb.mjs';
import {
  getTemplates,
  renderSvg as renderSheetSvg,
  renderPdf as renderSheetPdf,
  tips as sheetTips,
} from './answer-sheet.mjs';
import { listFonts } from './fonts.mjs';
import { chat } from './deepseek.mjs';
import { processImagePipeline } from './image-pipeline.mjs';
import { analyzeImage } from './vision.mjs';
import { mergeExamChartAnalysis } from './chart-facts.mjs';
import { buildStudyPlan, studyCardOutline, normalizePlanOptions, cardsBySkeletonIds } from './study-cards.mjs';
import {
  readScope,
  setCardStatus,
  setCardStatuses,
  setPlanOptions,
  setCurrentUnit,
  resetProgress,
  summarizeProgress,
} from './study-progress.mjs';
import {
  EXAM_TYPE_LABELS,
  SCOPE_NOTES,
  normalizeExamType,
  visibleTracksFor,
  coreTracksFor,
} from './exam-scope.mjs';
import { platformLabel, hasLocalOcr } from './platform.mjs';
import { analyzeExamEssay, analyzeComposedEssay, deepenAnalysis } from './essay-analysis.mjs';
import { reviewEssay, deepenReview, applyAcceptedIssues, classifyEssayText, collectGrammarErrors } from './essay-review.mjs';
import { transcribeHandwriting, assessTranscript } from './handwriting-ocr.mjs';
import { renderDocument, buildCardBlocks, buildAnalysisBlocks, buildReviewBlocks } from './print-pdf.mjs';
import { TEMPLATE_TRACKS } from './modules.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { stats as examStats, listExams, detail as examDetail, referenceAnalysis as examReferenceAnalysis, truthAnalysis } from './exams.mjs';
import { activateWithCode, licenseStatus, guard, isActivated as isActivatedLocal, deviceIdentity } from './license.mjs';

/** 归一化答题卡排版参数，并兼容旧版 font/showRuling 字段。 */
const TRACK_LABELS = new Map(TEMPLATE_TRACKS.map((track) => [track.id, track.label]));

/** 给卡片补上轨道中文名，供前端与打印稿直接显示。 */
function decorateCards(cards, scope) {
  return cards.map((card) => ({
    ...card,
    trackLabel: TRACK_LABELS.get(card.track) ?? card.track,
    status: scope?.cards?.[card.cardId]?.status ?? 'new',
    reviewedAt: scope?.cards?.[card.cardId]?.reviewedAt ?? null,
  }));
}

/**
 * 给 OCR 结果打质量分，用于在四个旋转方向中挑出真正读对的那个。
 *
 * 旋转错误时，Windows OCR 会把笔画当成汉字或孤立符号，输出大量单字符行；
 * 方向正确时才会出现成串的英文单词。因此以「英文单词数 + 拉丁字母占比」为主。
 */
function scoreOcrText(value) {
  const raw = String(value ?? '');
  const letters = (raw.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (raw.match(/[\u3400-\u9FFF]/g) ?? []).length;
  // 长度 ≥3 的纯字母串才算作可信单词，排除 O/E/9 这类噪声。
  const words = (raw.match(/\b[A-Za-z]{3,}\b/g) ?? []).length;
  const total = letters + cjk;
  const latinRatio = total ? letters / total : 0;
  return {
    words,
    letters,
    cjk,
    latinRatio: Number(latinRatio.toFixed(3)),
    // 单词数为主、拉丁占比为辅，便于直接比较大小。
    score: Number((words + latinRatio * 10).toFixed(2)),
  };
}

/** 当前备考方向：请求参数优先，其次读配置；未选择时返回 null。 */
async function resolveExamType(explicit) {
  const requested = normalizeExamType(explicit);
  if (requested) return requested;
  const cfg = await loadConfig();
  return normalizeExamType(cfg.study?.examType);
}

/** 按 unit / track / module / status 过滤卡片。 */
function filterCards(cards, query = {}) {
  const unit = Number(query.unit);
  return cards.filter((card) => {
    if (query.track && card.track !== String(query.track)) return false;
    if (query.module && card.moduleId !== String(query.module)) return false;
    if (query.status && card.status !== String(query.status)) return false;
    if (Number.isFinite(unit) && unit >= 1 && card.unitIndex !== Math.floor(unit)) return false;
    return true;
  });
}

/** 计划 + 进度的组合视图：给每张卡片标记所属单元，并算出今日任务。 */
async function studyOverview(planOverride, examTypeInput) {
  const examType = await resolveExamType(examTypeInput);
  const scope = await readScope(examType);
  const options = planOverride ? normalizePlanOptions(planOverride) : scope.plan;
  const plan = await buildStudyPlan(options, examType);
  const unitByCardId = new Map();
  for (const unit of plan.units) {
    for (const cardId of unit.cardIds) unitByCardId.set(cardId, unit.unitIndex);
  }
  const cards = decorateCards(plan.cards, scope).map((card) => ({ ...card, unitIndex: unitByCardId.get(card.cardId) ?? null }));
  const currentUnit = Math.min(Math.max(1, scope.currentUnit), Math.max(1, plan.totalUnits));
  return {
    examType,
    examTypeLabel: examType ? EXAM_TYPE_LABELS[examType] : null,
    scopeNote: examType ? SCOPE_NOTES[examType] : null,
    visibleTracks: visibleTracksFor(examType),
    coreTracks: coreTracksFor(examType),
    plan: { ...plan, cards: undefined, options: plan.options },
    options: plan.options,
    currentUnit,
    totalUnits: plan.totalUnits,
    totalCards: plan.totalCards,
    summary: summarizeProgress(scope, cards),
    units: plan.units.map((unit) => ({
      ...unit,
      mastered: unit.cardIds.filter((id) => scope.cards[id]?.status === 'mastered').length,
      review: unit.cardIds.filter((id) => scope.cards[id]?.status === 'review').length,
    })),
    cards,
  };
}

function sheetOptions(body = {}) {
  return {
    template: body.template ?? body.templateKey ?? 'english1_b',
    fontId: body.fontId ?? body.font,
    fontSize: body.fontSize ?? body.size,
    slant: body.slant ?? body.slantDegrees ?? 0,
    baselineAdjust: body.baselineAdjust ?? body.baseline_adjust ?? 0,
    color: body.color,
    style: body.style,
    kind: body.kind,
  };
}

/**
 * 归一化成文请求的输入：题图分析、延迟识图与题库图表校准。
 * /api/compose 与 /api/compose/stream 共用同一份事实来源，避免两条链路判断不一致。
 */
async function resolveComposeInput(body = {}) {
  let analysis = body.imageAnalysis ?? body.currentImageAnalysis ?? null;
  // image/analyze 管线返回 { vision.raw, ocr:null, conflicts:[] }；视觉 raw 是唯一事实来源。
  if (analysis?.vision?.raw) analysis = {
    ...analysis.vision.raw,
    ocr: analysis.ocr ?? null,
    conflicts: Array.isArray(analysis.conflicts) ? analysis.conflicts : [],
    sourceType: 'imagePipeline',
  };
  else if (analysis?.raw) analysis = analysis.raw;
  // 题库带图练习会延迟识图；在真正成文前由后端保证完成分析。
  // 若外部视觉 Key 不可用，则仅对题库内已有校对范文的题目使用离线事实摘要兜底。
  let imageError = null;
  if (!analysis && body.image) {
    try {
      const pipeline = await processImagePipeline(String(body.image));
      analysis = pipeline.vision?.raw ? {
        ...pipeline.vision.raw,
        ocr: pipeline.ocr ?? null,
        conflicts: Array.isArray(pipeline.conflicts) ? pipeline.conflicts : [],
        sourceType: 'imagePipeline',
      } : null;
    } catch (err) {
      imageError = err;
    }
  }
  let examReference = null;
  if (body.examId) {
    try {
      // 标准答案（多源核定）优先；没有时回退到范文首段正则抽取的旧逻辑
      examReference = await truthAnalysis(String(body.examId));
      if (!examReference) {
        const exam = await examDetail(String(body.examId));
        examReference = examReferenceAnalysis(exam);
      }
    } catch {
      examReference = null;
    }
  }
  if (examReference) analysis = mergeExamChartAnalysis(analysis, examReference);
  return { analysis, imageError };
}

/* -------------------- 成文进度（流式接口专用） -------------------- */

/** 步骤中文名：Android 端直接显示，避免客户端维护一份 key → 文案映射。 */
const COMPOSE_STEP_LABELS = {
  classify: '判定题型',
  facts: '校核题目事实',
  plan: '构建内容计划',
  skeletons: '挑选骨架句',
  references: '准备参考素材',
  essay: '生成作文',
  'essay-missing-repair': '补写缺失信息点',
  'essay-expanded': '扩写不足段落',
  'essay-contracted': '压缩超长段落',
  'essay-polish-language': '语言润色',
  'essay-polish-reference': '范文对照润色',
  'essay-stitch': '裁剪后缝合',
  'essay-guard-fix': '终稿守卫修复',
  'essay-chart-number-revise': '图表数字修订',
};

function composeStepLabel(key) {
  const text = String(key ?? '');
  if (COMPOSE_STEP_LABELS[text]) return COMPOSE_STEP_LABELS[text];
  const revise = /^essay-revise-(\d+)$/.exec(text);
  if (revise) return `定向修订（第 ${revise[1]} 轮）`;
  return text || '处理中';
}

/** 轮次中文名：诊断里用的是内部名（revise-1 / trim…），进度条要显示人话。 */
const COMPOSE_ROUND_LABELS = {
  write: '首次成文',
  makeup: '补写缺失信息点',
  'makeup-result': '补写结果',
  expand: '扩写不足段落',
  contract: '压缩超长段落',
  'chart-artifact-repair': '修复表格合并伪小数',
  'polish-language': '语言润色',
  'polish-language-result': '语言润色结果',
  'polish-reference': '范文对照润色',
  'polish-reference-result': '范文对照润色结果',
  trim: '超长裁剪',
  'stitch-result': '裁剪后缝合结果',
  'guard-deterministic': '守卫兜底修复',
};

function composeRoundLabel(name) {
  const text = String(name ?? '');
  if (COMPOSE_ROUND_LABELS[text]) return COMPOSE_ROUND_LABELS[text];
  const revise = /^revise-(\d+)$/.exec(text);
  if (revise) return `定向修订（第 ${revise[1]} 轮）`;
  const guard = /^guard-fix-(\d+)$/.exec(text);
  if (guard) return `终稿守卫修复（第 ${guard[1]} 次）`;
  return text || '处理中';
}

/** 长数组（逐块 id / 违例清单）在进度事件里截断，完整数据随 done 事件一次性返回。 */
function compactRoundInfo(info = {}) {
  const out = {};
  for (const [key, value] of Object.entries(info ?? {})) {
    out[key] = Array.isArray(value) && value.length > 8 ? [...value.slice(0, 8), `…等 ${value.length} 项`] : value;
  }
  return out;
}

/** 步骤摘要：只带 UI 需要展示的少量字段，避免流式事件重复传输大对象。 */
function streamStepSummary(key, data = {}) {
  if (!data || typeof data !== 'object') return {};
  if (key === 'classify') return {
    category: data.final?.category ?? null,
    subType: data.final?.subType ?? null,
    conflicts: Array.isArray(data.conflicts) ? data.conflicts.length : 0,
  };
  if (key === 'facts') return {
    category: data.facts?.category ?? null,
    targetWords: data.facts?.targetWords ?? null,
    valid: data.validation?.valid !== false,
  };
  if (key === 'plan') return {
    units: (data.paragraphs ?? []).reduce((sum, paragraph) => sum + (paragraph.units?.length ?? 0), 0),
    valid: data.validation?.valid !== false,
  };
  if (key === 'skeletons') return { bound: Array.isArray(data.bindings) ? data.bindings.length : 0 };
  if (key === 'references') return {
    skeletonCandidates: data.references?.stats?.skeletonCandidates ?? null,
    examples: data.references?.stats?.examples ?? null,
    hasModelEssay: data.references?.hasModelEssay === true,
  };
  if (key === 'essay') return {
    words: data.check?.words ?? null,
    target: data.check?.target ?? null,
    fallbackBlocks: data.check?.fallbackBlocks ?? [],
    rounds: data.diagnostics?.rounds?.length ?? 0,
  };
  return {};
}

/**
 * 成文响应外壳：任何引擎都带上 engine；V3 的诊断（轮次 / 守卫 / 兜底块）随响应回传，
 * 供桌面“复制诊断 JSON”与问题复盘使用。单点收口，避免回退分支漏字段。
 */
export function composeResponse(result, engine, diagnostics = null) {
  return {
    ...(result ?? {}),
    engine,
    diagnostics: diagnostics ?? result?.diagnostics ?? null,
  };
}

/**
 * 路由表：'METHOD /api/path' -> async ({ body, query, req, res }) => data
 * 各功能模块在后续步骤里逐个挂载进来。
 */
export const routes = {
  'GET /api/health': async () => {
    const cfg = await loadConfig();
    return {
      status: 'ok',
      node: process.version,
      platform: platformLabel(),
      // 桌面发行是否有系统内置离线识别（Windows.Media.Ocr），仅供前端提示与兜底判断。
      localOcrAvailable: hasLocalOcr(),
      hasApiKey: Boolean(cfg.deepseek.apiKey),
      // 图片识别统一走千问视觉：是否已配置视觉 Key。
      visionReady: Boolean(cfg.vision?.apiKey || process.env.DASHSCOPE_API_KEY),
      knowledgeBuilt: await isBuilt(),
      activated: isActivatedLocal(),
    };
  },

  // 授权状态（未激活时的白名单接口，激活页轮询用）
  'GET /api/license-status': async () => ({
    activated: isActivatedLocal(),
    ...licenseStatus(),
  }),

  // 提交激活码。纯离线：验签通过即写盘；云端模式：云端确认成功（登记+绑机）才写盘。
  'POST /api/activate': async ({ body }) => {
    const code = String(body?.code ?? '').trim();
    if (!code) throw Object.assign(new Error('请输入激活码。'), { status: 400, code: 'MISSING_CODE' });
    const r = await activateWithCode(code);
    if (!r.ok) {
      if (r.reason && r.reason.startsWith('cloud:')) {
        throw Object.assign(new Error(r.message || '云端校验失败，请稍后重试。'), {
          status: 400,
          code: r.reason.toUpperCase(),
        });
      }
      const expired = r.reason === 'expired';
      throw Object.assign(new Error(expired ? '激活码已过期，请联系作者获取新码。' : '激活码无效，请核对后重新粘贴。'), {
        status: 400,
        code: expired ? 'CODE_EXPIRED' : 'CODE_INVALID',
      });
    }
    let deviceName = '';
    try {
      deviceName = (await deviceIdentity()).name;
    } catch {
      /* 设备名仅展示用 */
    }
    return { activated: true, deviceName, ...r };
  },

  'POST /api/deepseek/test': async () => testConnection(),

  // 千问视觉连通性测试：用一张极小的内置图片做真实识读，避免只校验 Key 格式。
  'POST /api/vision/test': async ({ body }) => {
    const started = Date.now();
    // 用题库真实题图作探针；千问会拒绝过小的占位图片。
    let probe = body?.image ? String(body.image) : '';
    if (!probe) {
      const exam = await examDetail('e1-2007-b');
      const relative = String(exam?.image ?? '').replace(/^\/+/, '');
      if (!relative) throw Object.assign(new Error('缺少可用于测试的题图，请在写作文页上传一张图片后再测试。'), { status: 400 });
      const file = path.join(ROOT, relative);
      probe = `data:image/png;base64,${(await readFile(file)).toString('base64')}`;
    }
    const out = await analyzeImage(probe, {
      apiKey: body?.apiKey ? String(body.apiKey).trim() : undefined,
      model: body?.model ? String(body.model).trim() : undefined,
    });
    return {
      model: out.model,
      latencyMs: Date.now() - started,
      category: out.raw?.category ?? null,
      objectsSeen: Array.isArray(out.raw?.objectsSeen) ? out.raw.objectsSeen.slice(0, 4) : [],
      usage: out.usage,
    };
  },

  'POST /api/ocr': async ({ body }) => {
    // 仅供桌面离线兜底的方向探测：先试各旋转方向、挑出质量最好的再走正式流程。
    const out = await recognizeImage(body.image);
    return {
      backend: out.backend,
      language: out.language,
      fallback: out.fallback,
      attempts: out.attempts,
      lines: out.lines,
      text: out.text,
      // 供前端比较不同旋转方向的识别效果，选出最佳方向。
      quality: scoreOcrText(out.text),
    };
  },

  'GET /api/kb/stats': async () => {
    const [knowledge, exams] = await Promise.all([getStats(), examStats()]);
    return { ...knowledge, exams: exams.exams, examEssays: exams.withEssay };
  },

  'GET /api/writing/stats': async () => getWritingStats(),

  'GET /api/writing/methods': async ({ query }) => ({
    methods: await queryWritingMethods({
      category: query.category,
      keyword: query.keyword,
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  }),

  'GET /api/writing/skeletons': async ({ query }) => ({
    skeletons: await queryWritingSkeletons({
      task: query.task,
      function: query.function,
      applicability: query.applicability,
      keyword: query.keyword,
      productionOnly: query.productionOnly !== 'false',
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  }),

  'GET /api/writing/warnings': async ({ query }) => ({
    warnings: await queryWritingWarnings({
      keyword: query.keyword,
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  }),

  'GET /api/writing/examples': async ({ query }) => ({
    examples: await queryWritingExamples({
      task: query.task,
      applicability: query.applicability,
      year: query.year,
      keyword: query.keyword,
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  }),

  'GET /api/exams/stats': async () => examStats(),

  'GET /api/exams': async ({ query }) => {
    const exams = await listExams({
      examType: query.examType,
      year: query.year,
      section: query.section,
      essayType: query.essayType,
      keyword: query.keyword,
      hasEssay: query.hasEssay,
      random: query.random,
      page: query.page,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return { count: exams.length, exams };
  },

  'GET /api/exams/detail': async ({ query }) => {
    const id = query.id;
    if (!id) throw Object.assign(new Error('缺少题目 id。'), { status: 400 });
    const exam = await examDetail(id);
    if (!exam) throw Object.assign(new Error(`未找到题目：${id}`), { status: 404, code: 'exam_not_found' });
    return exam;
  },

  'GET /api/kb/modules': async ({ query }) => {
    const tracks = await queryModules({
      track: query.track,
      module: query.module,
      letterType: query.letterType,
    });
    // tracks 始终返回全部轨道摘要，前端才能渲染完整的轨道下拉；
    // track 只在指定单轨道时返回该轨道的模块明细。
    const allTracks = query.track || query.module
      ? await queryModules({ letterType: query.letterType })
      : tracks;
    return {
      count: tracks.reduce((sum, track) => sum + track.count, 0),
      tracks: allTracks.map(({ modules, ...trackInfo }) => trackInfo),
      track: query.track ? (tracks[0] ?? null) : null,
    };
  },

  'GET /api/kb/templates': async ({ query }) => {
    const list = await queryTemplates({
      kind: query.kind,
      kinds: query.kinds ? String(query.kinds).split(',').filter(Boolean) : undefined,
      track: query.track,
      module: query.module,
      letterType: query.letterType,
      page: query.page,
      keyword: query.keyword,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return { count: list.length, templates: list };
  },

  'GET /api/kb/vocab': async ({ query }) => {
    const list = await queryVocab({
      keyword: query.keyword,
      page: query.page,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return { count: list.length, vocab: list };
  },

  'GET /api/kb/pages': async () => {
    const kb = await loadKnowledge();
    return {
      pages: kb.pages.map((p) => ({
        page: p.page,
        title: p.title,
        kind: p.kind,
        entryCount: p.entries.length,
        vocabCount: p.vocab.length,
        hasLayout: Boolean(p.layoutSpec),
      })),
    };
  },

  // 步骤一：图片识别（千问视觉：画面/图表结构化理解 + 题面文字转录）
  'POST /api/image/analyze': async ({ body }) => {
    const img = String(body.image ?? '').trim();
    if (!img) throw Object.assign(new Error('未传入图片数据。'), { status: 400 });
    return processImagePipeline(img, { skipVision: Boolean(body.skipVision) });
  },

  // 步骤一分支：OCR 粗文本 → AI 清洗还原题干
  'POST /api/question/clean': async ({ body }) => {
    const raw = String(body.text ?? '').trim();
    if (!raw) throw Object.assign(new Error('没有需要清洗的文本。'), { status: 400 });

    const out = await chat({
      tier: 'fast',
      system:
        '你是 OCR 结果清洗助手，处理的是考研英语作文题目。任务：修正 OCR 识别错误，还原题干原文。\n' +
        '常见错误：英文大小写混乱（tO→to）、单词被空格切断（writin g→writing）、中文字之间多余空格、' +
        '数字与字母混淆（0/O、1/l）、行序错乱。\n' +
        '规则：只做修正，不要翻译、不要解释、不要补充题目没有的内容、不要写作文。直接输出清洗后的题干纯文本。',
      messages: [{ role: 'user', content: raw }],
      temperature: 0,
      maxTokens: 2048,
    });
    return { raw, cleaned: out.content.trim(), model: out.model };
  },

  // 步骤二：单独调用题型判定
  'POST /api/classify': async ({ body }) => {
    guard();
    return classify(String(body.text ?? ''), { skipAI: Boolean(body.skipAI) });
  },

  // 内容计划优先的完整成文链。题图必须进入视觉事实层，不能只在前端预览。
  'POST /api/compose': async ({ body }) => {
    guard();
    const text = String(body.text ?? '').trim();
    if (!text) throw Object.assign(new Error('题目内容为空。'), { status: 400 });
    const { analysis, imageError } = await resolveComposeInput(body);
    if (!analysis && imageError) throw imageError;

    // v1 / v2 仅用于紧急回滚与影子对比；日常前端默认使用 V3：
    // 骨架作为参考 + AI 成文 + 多轮 AI 修正（补写 / 润色 / 范文对照 / 缝合）。
    if (process.env.EEA_COMPOSE_V1 === '1' || body.version === 'v1') return composeResponse(await composeFull(text), 'v1');
    if (process.env.EEA_COMPOSE_ENGINE === 'v2' || body.version === 'v2') return composeResponse(await composeV2(text, { imageAnalysis: analysis }), 'v2');
    return composeResponse(await composeV3(text, { imageAnalysis: analysis, examId: body.examId ?? null }), 'v3');
  },

  // 成文流式接口：NDJSON 事件（start / step / round / error / done），供 Android 原生端显示真实进度。
  // 桌面端仍走 /api/compose 单次调用；两者共用同一套输入归一化与生成链。
  'POST /api/compose/stream': async ({ body, res }) => {
    guard();
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    // 一旦开始流式输出，就必须由本处理器收尾：server.mjs 只在 res 未结束时补发 JSON 响应，
    // 所以错误也要转成 error 事件，不能抛出去。
    const emit = (event) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
    try {
      const text = String(body.text ?? '').trim();
      if (!text) throw Object.assign(new Error('题目内容为空。'), { status: 400 });
      const { analysis, imageError } = await resolveComposeInput(body);
      if (!analysis && imageError) throw imageError;
      const useV2 = process.env.EEA_COMPOSE_ENGINE === 'v2' || body.version === 'v2';
      emit({ type: 'start', engine: useV2 ? 'v2' : 'v3' });
      const result = useV2
        ? await composeV2(text, { imageAnalysis: analysis })
        : await composeV3(text, {
          imageAnalysis: analysis,
          examId: body.examId ?? null,
          onStep: (step) => emit({
            type: 'step',
            key: step.key,
            label: composeStepLabel(step.key),
            summary: streamStepSummary(step.key, step.data),
          }),
          onRound: (round) => emit({
            type: 'round',
            name: round.name,
            label: composeRoundLabel(round.name),
            info: compactRoundInfo(Object.fromEntries(Object.entries(round).filter(([key]) => key !== 'name'))),
          }),
        });
      emit({ type: 'done', engine: useV2 ? 'v2' : 'v3', diagnostics: result?.diagnostics ?? null, data: result });
    } catch (err) {
      emit({ type: 'error', error: err?.message ?? String(err), code: err?.code ?? null, status: err?.status ?? 500 });
    } finally {
      if (!res.writableEnded) res.end();
    }
  },

  /* ------------------------------ 学习卡片 ------------------------------ */

  'GET /api/study/outline': async ({ query }) => {
    const examType = await resolveExamType(query.examType);
    return { examType, tracks: await studyCardOutline(examType) };
  },

  'GET /api/study/plan': async ({ query }) => {
    const overview = await studyOverview(null, query.examType);
    // 计划视图默认只回今日单元的卡片，避免一次传几百张。
    const todayCards = overview.cards.filter((card) => card.unitIndex === overview.currentUnit);
    return { ...overview, cards: undefined, todayCards };
  },

  'POST /api/study/plan': async ({ body }) => {
    guard();
    const examType = await resolveExamType(body.examType);
    await setPlanOptions({
      tracks: body.tracks,
      dailyCount: body.dailyCount,
      includeOptional: body.includeOptional,
      includeExtended: body.includeExtended,
      currentUnit: body.currentUnit,
    }, examType);
    const overview = await studyOverview(null, examType);
    const todayCards = overview.cards.filter((card) => card.unitIndex === overview.currentUnit);
    return { ...overview, cards: undefined, todayCards };
  },

  'GET /api/study/cards': async ({ query }) => {
    const overview = await studyOverview(null, query.examType);
    const filtered = filterCards(overview.cards, query);
    const limit = Number(query.limit);
    return {
      examType: overview.examType,
      count: filtered.length,
      summary: overview.summary,
      cards: Number.isFinite(limit) && limit > 0 ? filtered.slice(0, Math.floor(limit)) : filtered,
    };
  },

  'POST /api/study/progress': async ({ body }) => {
    const examType = await resolveExamType(body.examType);
    // 支持单张与批量：批量用于成文后一次性标记本篇用到的模板句。
    if (Array.isArray(body.entries) && body.entries.length) await setCardStatuses(body.entries, examType);
    else await setCardStatus(body.cardId, body.status, examType);
    const overview = await studyOverview(null, examType);
    return { examType, summary: overview.summary, units: overview.units, currentUnit: overview.currentUnit };
  },

  'POST /api/study/unit': async ({ body }) => {
    const examType = await resolveExamType(body.examType);
    await setCurrentUnit(body.unit, examType);
    const overview = await studyOverview(null, examType);
    const todayCards = overview.cards.filter((card) => card.unitIndex === overview.currentUnit);
    return { ...overview, cards: undefined, todayCards };
  },

  'POST /api/study/reset': async ({ body }) => {
    const examType = await resolveExamType(body.examType);
    await resetProgress({ keepPlan: body?.keepPlan !== false, examType });
    const overview = await studyOverview(null, examType);
    const todayCards = overview.cards.filter((card) => card.unitIndex === overview.currentUnit);
    return { ...overview, cards: undefined, todayCards };
  },

  /**
   * 成文后关联：把本篇实际套用的骨架映射回学习卡片。
   * 入参可以是 sentenceSources（前端直接转发成文结果）或 skeletonIds。
   */
  'POST /api/study/link-essay': async ({ body }) => {
    const examType = await resolveExamType(body.examType);
    const sources = Array.isArray(body.sentenceSources) ? body.sentenceSources : [];
    const fromSources = sources.map((item) => String(item?.skeletonId ?? '').trim()).filter(Boolean);
    const explicit = Array.isArray(body.skeletonIds) ? body.skeletonIds.map((id) => String(id ?? '').trim()).filter(Boolean) : [];
    const skeletonIds = [...new Set([...fromSources, ...explicit])];
    const scope = await readScope(examType);
    const matched = decorateCards(await cardsBySkeletonIds(skeletonIds), scope);
    // 有多少句没有套用讲义模板，如实告知而不是悄悄忽略。
    const unmatched = sources.filter((item) => !String(item?.skeletonId ?? '').trim()).length;
    return {
      examType,
      requested: skeletonIds.length,
      matched: matched.length,
      unmatchedSentences: unmatched,
      cards: matched,
    };
  },

  /* ------------------------------ 作文批改 ------------------------------ */

  /**
   * 第一步：识别手写作文照片。
   *
   * 手写体优先走视觉模型：Windows 内置 OCR 是为印刷体设计的，对连笔手写几乎读不出，
   * 也读不了旋转照片；视觉模型两者都能处理，且能自行纠正方向。
   * 视觉不可用（无 Key / 请求失败）时回退本地 OCR，功能不中断。
   *
   * 无论走哪条通道，都只转写不改写——批改必须发生在用户确认文本之后。
   */
  'POST /api/review/ocr': async ({ body }) => {
    guard();
    if (!body?.image) throw Object.assign(new Error('缺少作文照片。'), { status: 400 });

    const cfg = await loadConfig();
    let visionError = null;
    const visionUsable = cfg.vision?.enabled !== false && Boolean(cfg.vision?.apiKey);
    if (visionUsable) {
      try {
        const out = await transcribeHandwriting(body.image);
        const quality = assessTranscript(out.text);
        return {
          raw: out.text,
          cleaned: out.text,
          cleanedBy: 'none',
          channel: 'vision',
          channelLabel: `视觉模型（${out.model}）`,
          backend: 'vision',
          fallback: false,
          rotationDetected: out.rotationDetected,
          unreadableCount: out.unreadableCount,
          confidence: out.confidence,
          latinRatio: quality.latinRatio,
          lowQuality: quality.lowQuality,
          warning: quality.lowQuality
            ? `转写质量偏低（${quality.words} 个可辨认单词${quality.unreadable ? `，${quality.unreadable} 处无法辨认` : ''}）。`
              + '请核对下方文本并补全，或换更清晰、正面平铺的照片重拍。'
            : '',
          lines: out.text.split(/\n+/).filter(Boolean),
          detection: classifyEssayText(out.text),
        };
      } catch (error) {
        // 视觉失败不阻塞：记下原因，继续走离线识别兜底（仅桌面 Windows 内置 OCR）。
        visionError = error.message;
      }
    }

    const out = await recognizeImage(body.image);
    const raw = String(out.text ?? '').trim();
    if (!raw) throw Object.assign(new Error('未识别出任何文字，请换更清晰的照片，或直接手动输入作文。'), { status: 502 });

    // 手写体识别质量差时，OCR 结果里会混入大量非拉丁字符。
    // 此时绝不能交给模型"清洗"——它会把乱码脑补成通顺英文，用户将被批改一篇自己没写过的作文。
    const latinCount = (raw.match(/[A-Za-z]/g) ?? []).length;
    const cjkCount = (raw.match(/[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g) ?? []).length;
    const latinRatio = latinCount / Math.max(1, latinCount + cjkCount);
    const lowQuality = latinRatio < 0.75;

    let cleaned = raw;
    let cleanedBy = 'none';
    if (lowQuality) {
      return {
        raw,
        cleaned: raw,
        cleanedBy: 'none',
        lowQuality: true,
        latinRatio: Number(latinRatio.toFixed(2)),
        warning: '手写内容识别质量较低（大量字符无法辨认）。为避免把识别错误"脑补"成通顺英文，'
          + '这里保留原始识别结果，未做任何清洗。建议：换正面平铺、光线均匀的照片重拍，'
          + '或直接在下方手动输入你写的作文——手动输入同样可以批改。',
        lines: Array.isArray(out.lines) ? out.lines.map((line) => String(line)) : [],
        backend: out.backend,
        fallback: out.fallback,
        detection: classifyEssayText(raw),
      };
    }
    try {
      const fixed = await chat({
        tier: 'fast',
        system:
          '你是 OCR 结果清洗助手，处理的是学生手写的考研英语作文。任务：只修正 OCR 识别错误，还原学生的原始作文。\n'
          + '常见错误：大小写混乱（tO→to）、单词被空格切断（writin g→writing）、字母数字混淆（0/O、1/l、rn/m）、行末连字符断词、段落被拆行。\n'
          + '严格规则：不要改写句子、不要修语法、不要替换用词、不要补写内容、不要翻译、不要评价。\n'
          + '保留学生原有的表达和错误（那是后续批改要处理的）。用空行分隔段落。直接输出清洗后的作文纯文本。',
        messages: [{ role: 'user', content: raw }],
        temperature: 0,
        maxTokens: 2048,
      });
      const candidate = String(fixed.content ?? '').trim();
      // 双重守卫：长度剧变说明模型擅自改写或截断；词汇重合度过低说明它重写了内容。
      const sameLength = candidate && Math.abs(candidate.length - raw.length) <= raw.length * 0.4;
      const rawWords = new Set((raw.toLowerCase().match(/[a-z]{4,}/g) ?? []));
      const newWords = (candidate.toLowerCase().match(/[a-z]{4,}/g) ?? []);
      const kept = newWords.filter((word) => rawWords.has(word)).length;
      const overlap = newWords.length ? kept / newWords.length : 0;
      if (sameLength && (rawWords.size === 0 || overlap >= 0.6)) {
        cleaned = candidate;
        cleanedBy = fixed.model ?? 'deepseek';
      }
    } catch {
      // 无 Key 或调用失败：直接给原始 OCR 文本，功能不受阻。
    }

    return {
      raw,
      cleaned,
      cleanedBy,
      channel: 'local-ocr',
    // 标签如实区分：视觉转录 vs 桌面离线兜底
    channelLabel: out.backend === 'qwen-vision'
      ? `视觉转录（${out.model ?? '千问'}）`
      : '本地离线识别',
    // 视觉通道为何没用上，如实告知，便于用户判断是否去配置视觉 Key。
    visionError,
    // 只转写不改写：批改必须发生在用户确认文本之后。
    lines: Array.isArray(out.lines) ? out.lines.map((line) => String(line)) : [],
    backend: out.backend,
    fallback: out.fallback,
    detection: classifyEssayText(cleaned),
  };
},

  /** 第二步：题型自动判定，供用户确认或改选。 */
  'POST /api/review/classify': async ({ body }) => {
    const essayText = String(body?.essayText ?? '').trim();
    if (!essayText) throw Object.assign(new Error('请先提供作文内容。'), { status: 400 });
    return classifyEssayText(essayText, String(body?.questionText ?? ''));
  },

  /** 第三步：用户确认文本后才执行批改。examId 会带入官方题干、图表数据与范文。 */
  'POST /api/review/analyze': async ({ body }) => {
    guard();
    // 语法检查：离线规则始终执行；勾选 AI 复核时叠加，且模型编造的片段会被丢弃。
    const grammarErrors = await collectGrammarErrors(body?.essayText, { useAi: body?.aiGrammar === true });
    const review = await reviewEssay({
      essayText: body?.essayText,
      category: body?.category,
      questionText: body?.questionText ?? '',
      chartFacts: body?.chartFacts ?? null,
      examId: body?.examId ?? null,
      grammarErrors,
    });
    return body?.ai === true ? deepenReview(review) : review;
  },

  /** 按采纳的修改项生成终稿。 */
  'POST /api/review/apply': async ({ body }) => {
    guard();
    const essayText = String(body?.essayText ?? '').trim();
    if (!essayText) throw Object.assign(new Error('请先提供作文内容。'), { status: 400 });
    return applyAcceptedIssues(essayText, body?.issues ?? [], body?.acceptedIds ?? []);
  },

  /* ------------------------------ 行文解析 ------------------------------ */

  'GET /api/analysis/exam': async ({ query }) => {
    guard();
    if (!query.id) throw Object.assign(new Error('缺少题目 id。'), { status: 400 });
    const analysis = await analyzeExamEssay(String(query.id));
    // ai=1 时叠加深化讲解；无 Key 或失败会自动回退到离线结论。
    return query.ai === '1' || query.ai === 'true' ? deepenAnalysis(analysis) : analysis;
  },

  /** 解析刚生成的作文：行文复盘本就属于成文之后的环节。 */
  'POST /api/analysis/essay': async ({ body }) => {
    guard();
    const analysis = await analyzeComposedEssay({
      essay: body?.essay,
      classification: body?.classification,
      facts: body?.facts,
      question: body?.question,
    });
    return body?.ai === true ? deepenAnalysis(analysis) : analysis;
  },

  /* ------------------------------ 打印导出 ------------------------------ */

  'POST /api/print/cards': async ({ body, res }) => {
    const overview = await studyOverview(null, body?.examType);
    const selected = Array.isArray(body?.cardIds) && body.cardIds.length
      ? overview.cards.filter((card) => body.cardIds.includes(card.cardId))
      : filterCards(overview.cards, body ?? {});
    if (!selected.length) throw Object.assign(new Error('没有符合条件的卡片可导出。'), { status: 400 });
    const hideChinese = body?.hideChinese === true;
    const scope = Number.isFinite(Number(body?.unit)) && Number(body.unit) >= 1
      ? `第 ${Math.floor(Number(body.unit))} 单元`
      : body?.track ? (TRACK_LABELS.get(String(body.track)) ?? '') : '全部轨道';
    const examLabel = overview.examTypeLabel ? `${overview.examTypeLabel} · ` : '';
    const pdf = renderDocument({
      title: '考研英语作文 · 背诵卡片',
      subtitle: `${examLabel}${scope} · 共 ${selected.length} 张${hideChinese ? ' · 自测模式（隐藏中文）' : ''}`,
      blocks: buildCardBlocks(selected, { hideChinese }),
    });
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `背诵卡片-${scope}-${stamp}.pdf`;
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="study-cards-${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  },

  'POST /api/print/review': async ({ body, res }) => {
    if (!body?.review) throw Object.assign(new Error('缺少批改结果。'), { status: 400 });
    const review = body.review;
    const pdf = renderDocument({
      title: '考研英语作文 · 批改报告',
      subtitle: `${String(review.category ?? '')}｜${String(review.grade?.band ?? '')}｜共 ${Array.isArray(review.issues) ? review.issues.length : 0} 项修改建议`,
      blocks: buildReviewBlocks(review, String(body.finalText ?? '')),
    });
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `批改报告-${String(review.category ?? '作文')}-${stamp}.pdf`;
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="essay-review-${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  },

  'POST /api/print/analysis': async ({ body, res }) => {
    if (!body?.examId) throw Object.assign(new Error('缺少题目 id。'), { status: 400 });
    const base = await analyzeExamEssay(String(body.examId));
    const analysis = body.ai === true ? await deepenAnalysis(base) : base;
    const label = `${analysis.exam.year} ${analysis.exam.examType === 'e1' ? '英语一' : '英语二'}${analysis.exam.section === 'small' ? '小作文' : '大作文'}`;
    const pdf = renderDocument({
      title: `${label} · 行文精讲`,
      subtitle: analysis.track.label,
      blocks: buildAnalysisBlocks(analysis),
    });
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `行文精讲-${label}-${stamp}.pdf`;
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="essay-analysis-${analysis.exam.id}-${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  },

  'GET /api/handwrite/templates': async () => ({ templates: await getTemplates() }),

  'GET /api/handwrite/fonts': async () => ({ fonts: await listFonts() }),

  'POST /api/handwrite': async ({ body }) => {
    if (!body.essay) throw Object.assign(new Error('缺少作文内容。'), { status: 400 });
    return renderSheetSvg(body.essay, sheetOptions(body));
  },

  'POST /api/handwrite/pdf': async ({ body, res }) => {
    if (!body.essay) throw Object.assign(new Error('缺少作文内容。'), { status: 400 });
    const options = sheetOptions(body);
    // renderPdf 直接返回 Buffer；文件名由模板与当天日期推导。
    const pdf = await renderSheetPdf(body.essay, options);
    const templates = await getTemplates();
    const template = templates.find((item) => item.key === options.template) ?? templates[0];
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `答题卡-${template?.exam ?? '英语一'}-Part${template?.part ?? 'B'}-${stamp}.pdf`;
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="answer-sheet-${stamp}.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  },

  'GET /api/handwrite/tips': async () => sheetTips(),

  'GET /api/config': async () => {
    const cfg = await loadConfig({ force: true });
    return maskConfig(cfg);
  },

  'POST /api/config': async ({ body }) => {
    const patch = {};
    if (body.deepseek) {
      patch.deepseek = {};
      // 空字符串代表「不修改」，null 代表「清除」
      if (body.deepseek.apiKey !== undefined && body.deepseek.apiKey !== '') {
        patch.deepseek.apiKey = body.deepseek.apiKey === null ? '' : String(body.deepseek.apiKey).trim();
      }
      for (const k of ['baseUrl', 'modelReasoning', 'modelFast']) {
        if (body.deepseek[k]) patch.deepseek[k] = String(body.deepseek[k]).trim();
      }
      if (body.deepseek.temperature !== undefined) {
        const t = Number(body.deepseek.temperature);
        if (Number.isFinite(t) && t >= 0 && t <= 2) patch.deepseek.temperature = t;
      }
    }
    if (body.vision) {
      patch.vision = {};
      // 与 DeepSeek 一致：空字符串代表不修改，null 代表清除。
      if (body.vision.apiKey !== undefined && body.vision.apiKey !== '') {
        patch.vision.apiKey = body.vision.apiKey === null ? '' : String(body.vision.apiKey).trim();
      }
      if (body.vision.model) patch.vision.model = String(body.vision.model).trim();
      if (body.vision.enabled !== undefined) patch.vision.enabled = Boolean(body.vision.enabled);
    }
    if (body.study) {
      patch.study = {};
      // null 表示清除已选方向，重新进入引导。
      if (body.study.examType !== undefined) {
        patch.study.examType = body.study.examType === null ? null : normalizeExamType(body.study.examType);
      }
    }
    const next = await saveConfig(patch);
    return maskConfig(next);
  },

  /** 备考方向：单独提供便于首屏引导一键选择。 */
  'GET /api/study/exam-type': async () => {
    const cfg = await loadConfig({ force: true });
    const examType = normalizeExamType(cfg.study?.examType);
    return {
      examType,
      label: examType ? EXAM_TYPE_LABELS[examType] : null,
      chosen: Boolean(examType),
      options: Object.entries(EXAM_TYPE_LABELS).map(([id, label]) => ({ id, label, note: SCOPE_NOTES[id] })),
    };
  },

  'POST /api/study/exam-type': async ({ body }) => {
    const examType = normalizeExamType(body?.examType);
    if (!examType) throw Object.assign(new Error('备考方向只能是 e1 或 e2。'), { status: 400 });
    await saveConfig({ study: { examType } });
    const overview = await studyOverview(null, examType);
    const todayCards = overview.cards.filter((card) => card.unitIndex === overview.currentUnit);
    return { ...overview, cards: undefined, todayCards };
  },
};
