const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

/**
 * 题库题图的校对数据优先于视觉模型的自由识读。
 * 视觉结果只补标题/坐标轴等展示信息，不能覆盖 dataPoints、labelNumbers 或关键对比。
 *
 * 图画题同理：画面描述与主题来自已校对范文（专家对照真图写的），视觉自由识读
 * 曾把 2019 年「两人登山」读成「沙发上看书」，整篇作文方向随之跑偏。
 * 但范文是描述而非转录，图中原文（如「途中」二字）范文常不写，这部分仍保留视觉读数。
 */
export function mergeExamChartAnalysis(visual, reference) {
  if (!reference) return visual ?? null;
  if (reference.category !== '图表作文') return mergeExamPictureAnalysis(visual, reference);
  const visualChart = visual?.chartData && typeof visual.chartData === 'object' ? visual.chartData : {};
  const referenceChart = reference.chartData && typeof reference.chartData === 'object' ? reference.chartData : {};
  const referencePoints = array(referenceChart.dataPoints);
  const visualPoints = array(visualChart.dataPoints);
  const authoritativePoints = referencePoints.length ? referencePoints.map((point, index) => {
    const visualPoint = visualPoints[index];
    const syntheticLabel = /^(?:图中项目|图中数值)[A-Z\d]+$/i.test(text(point?.label));
    return {
      ...point,
      label: syntheticLabel && text(visualPoint?.label) ? text(visualPoint.label) : text(point?.label),
      value: text(point?.value),
      source: 'examReference',
    };
  }) : visualPoints;
  const chartData = {
    ...visualChart,
    ...referenceChart,
    title: text(referenceChart.title) || text(visualChart.title) || null,
    chartType: text(referenceChart.chartType) || text(visualChart.chartType) || null,
    xAxis: text(referenceChart.xAxis) || text(visualChart.xAxis) || null,
    yAxis: text(referenceChart.yAxis) || text(visualChart.yAxis) || null,
    dataPoints: authoritativePoints,
    labelNumbers: array(referenceChart.labelNumbers).length ? referenceChart.labelNumbers : array(visualChart.labelNumbers),
    keyContrasts: array(referenceChart.keyContrasts).length ? referenceChart.keyContrasts : array(visualChart.keyContrasts),
    chartAuthority: 'examReference',
  };
  return {
    ...(visual ?? {}),
    category: '图表作文',
    subType: text(reference.subType) || text(visual?.subType) || '静态',
    chartData,
    chartAuthority: 'examReference',
    sourceType: 'examReference',
    examReference: reference,
    uncertain: unique([...array(visual?.uncertain), ...array(reference.uncertain)]),
  };
}

/**
 * 图画题合并：场景与主题以题库校对数据为准，图中原文与可见元素保留视觉结果。
 * 视觉结果缺失时直接返回题库数据（离线兜底路径不变）。
 */
export function mergeExamPictureAnalysis(visual, reference) {
  if (!reference) return visual ?? null;
  if (!visual) return reference;
  const visualText = text(visual.chineseText);
  const referenceText = text(reference.chineseText);
  const sceneFromReference = Boolean(text(reference.sceneDescription));
  // 图中原文：题库标注为已核实（exam-truth）时以题库为准；否则题库字段只是范文引语
  // （多为英文译句，不是图上的字），只有含中文时才采信，其余用视觉转录。
  const chineseText = reference.chineseTextVerified
    ? referenceText
    : (visualText || (/[\u4e00-\u9fff]/.test(referenceText) ? referenceText : '')) || null;
  return {
    ...visual,
    category: text(reference.category) || text(visual.category) || '大作文',
    subType: text(reference.subType) || text(visual.subType) || null,
    sceneDescription: text(reference.sceneDescription) || text(visual.sceneDescription),
    // 视觉的主题是从它自己读到的场景推出来的；场景改用题库后，不能再沿用视觉主题
    themeGuess: sceneFromReference ? (text(reference.themeGuess) || null) : (text(visual.themeGuess) || text(reference.themeGuess) || null),
    themeBasis: sceneFromReference ? (text(reference.themeBasis) || null) : (text(visual.themeBasis) || text(reference.themeBasis) || null),
    chineseText,
    objectsSeen: unique([...array(reference.objectsSeen), ...(sceneFromReference ? [] : array(visual.objectsSeen))]),
    sceneAuthority: sceneFromReference ? 'examReference' : 'imageAnalysis',
    sourceType: 'examReference',
    examReference: reference,
    visualReading: {
      sceneDescription: text(visual.sceneDescription) || null,
      themeGuess: text(visual.themeGuess) || null,
      chineseText: visualText || null,
      objectsSeen: array(visual.objectsSeen),
    },
    uncertain: unique([...array(visual.uncertain), ...array(reference.uncertain)]),
  };
}

/** 将“年龄组-满意度”这类视觉扁平标签还原为可读的表格行。 */
export function deriveChartRows(chartData = {}) {
  const rows = new Map();
  for (const point of array(chartData.dataPoints)) {
    const label = text(point?.label);
    const value = text(point?.value);
    if (!label || !value) continue;
    const match = label.match(/^(.+?)\s*[-—–]\s*(.+)$/);
    const row = match ? match[1].trim() : label;
    const column = match ? match[2].trim() : 'value';
    if (!rows.has(row)) rows.set(row, { label: row, values: [] });
    rows.get(row).values.push({ label: column, value, source: point?.source ?? 'chart' });
  }
  return [...rows.values()];
}

export default { mergeExamChartAnalysis, mergeExamPictureAnalysis, deriveChartRows };
