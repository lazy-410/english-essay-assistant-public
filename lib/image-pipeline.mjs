import { recognizeImage } from './ocr.mjs';
import { analyzeImage, transcribeText } from './vision.mjs';

/**
 * 图片识别管线（统一千问视觉）：
 * 步骤 1: analyzeImage 并行 transcribeText —— 画面/图表结构化理解 + 题面文字原样转录
 * 步骤 2: 合成「丰富题干」（composedQuestion）供后续分类与模板引擎使用
 *
 * 视觉不可用（未配置 Key / 调用失败）时，桌面发行允许用系统内置离线识别兜底印刷体；
 * 非桌面（Android App）不配视觉即直接报错，引导用户配置或手动粘贴题干。
 */
export async function processImagePipeline(imageDataUrl, { skipVision = false } = {}) {
  const t0 = Date.now();
  let visionResult = null;
  let visionError = null;
  let textResult = null;
  let textError = null;

  if (!skipVision) {
    // 结构理解与文字转录是两个独立职责，并行调用互不拖累。
    [visionResult, textResult] = await Promise.all([
      analyzeImage(imageDataUrl).catch((err) => { visionError = err.message; return null; }),
      transcribeText(imageDataUrl).catch((err) => { textError = err.message; return null; }),
    ]);
  }

  // 主通道成功（至少一项）：以视觉结构化结果为主，转录文字作为题面原文附注。
  if (visionResult) {
    const composedQuestion = composeFromVision(visionResult.raw, textResult?.text);
    return {
      vision: {
        raw: visionResult.raw,
        model: visionResult.model,
        latencyMs: visionResult.latencyMs,
      },
      visionError: textError || null,
      ocr: null,
      conflicts: [],
      composedQuestion,
      fallback: null,
      totalLatencyMs: Date.now() - t0,
    };
  }

  // 视觉不可用/失败 → 离线兜底（仅桌面）：至少保住题面原文。
  try {
    const out = await recognizeImage(imageDataUrl);
    return {
      vision: null,
      visionError: textError || visionError || null,
      ocr: { text: out.text, backend: out.backend, lines: out.lines },
      conflicts: [],
      composedQuestion: out.text,
      fallback: out.backend === 'windows' ? 'desktop-local-ocr' : 'vision-text-only',
      totalLatencyMs: Date.now() - t0,
    };
  } catch (err) {
    // 未配置识别 + 非桌面：recognizeImage 已给出配置引导错误；这里保留视觉侧细节。
    if (err?.code === 'vision_required') throw err;
    throw Object.assign(
      new Error(`图片处理失败：画面理解（${visionError ?? '未执行'}）；文字转录（${textError ?? '未执行'}）→ ${err.message}`),
      { status: 502 },
    );
  }
}

/**
 * 把视觉结构化结果 + 题面原文转录合成「丰富题干」，喂给后段分类与模板引擎。
 */
function composeFromVision(visRaw, transcript) {
  const original = transcript ? `\n题面原文（逐字转录）:\n${transcript}` : '';
  if (visRaw.category === '图表作文' && visRaw.chartData) {
    const cd = visRaw.chartData;
    return `【图表作文】标题: ${cd.title || '无'}
图表类型: ${cd.chartType || '图表'}
数据项:
${(cd.dataPoints || []).map((dp) => `- ${dp.label}: ${dp.value}`).join('\n')}
关键对比/趋势:
${(cd.keyContrasts || []).map((k) => `- ${k}`).join('\n')}${original}`;
  }
  if (visRaw.category === '大作文') {
    return `【图画作文】
画面描述: ${visRaw.sceneDescription || '图画描述已自动分析'}
${visRaw.chineseText ? `中文标注: ${visRaw.chineseText}` : ''}
主题推断: ${visRaw.themeGuess || '尚未推出'}
推断依据: ${visRaw.themeBasis || '无'}${original}`;
  }
  return (transcript || visRaw.sceneDescription || '无法识别题意');
}
