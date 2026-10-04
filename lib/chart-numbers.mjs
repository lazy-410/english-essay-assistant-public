/**
 * 图表数字规范化与事实校验。
 *
 * 图表作文中的数字不应只按字符串比较：40.0% 与 40%、OCR 产生的
 * "68. 1%"，以及由两个原始数据点计算出的比较差值，都可能是同一个可核验事实。
 */

const text = (value) => value == null ? '' : String(value);
const EPSILON = 1e-6;

function normalizeNumericText(value) {
  return text(value)
    .replace(/[％]/g, '%')
    .replace(/(\d)\s*[-–—]\s*(?=\d)/g, '$1 ')
    .replace(/(\d+)\s*[.,]\s*(\d+)/g, '$1.$2')
    .replace(/(\d)\s*,\s*(\d)/g, '$1$2');
}

function numericValue(raw) {
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function numberTokens(value) {
  const normalized = normalizeNumericText(value);
  const regex = /(?<![A-Za-z-])([+-]?\d+(?:\.\d+)?)(\s*%|％)?/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(normalized))) {
    const numeric = numericValue(match[1]);
    if (numeric == null) continue;
    tokens.push({
      raw: match[0].trim(),
      value: numeric,
      percent: Boolean(match[2]),
      start: match.index,
      end: regex.lastIndex,
    });
  }
  return tokens;
}

function valueEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) <= EPSILON;
}

function decimalPlaces(value) {
  const raw = String(value).replace(/^[+-]/, '');
  const point = raw.indexOf('.');
  return point < 0 ? 0 : raw.length - point - 1;
}

function roundedEqual(actual, expected) {
  if (valueEqual(actual, expected)) return true;
  const places = Math.min(2, Math.max(0, decimalPlaces(actual)));
  const scale = 10 ** places;
  return Math.round(expected * scale) / scale === actual;
}

function sourceEntries(chart = {}) {
  const entries = [];
  for (const point of Array.isArray(chart.dataPoints) ? chart.dataPoints : []) {
    const valueText = text(point?.value);
    for (const token of numberTokens(valueText)) {
      entries.push({ ...token, role: 'value', source: valueText });
    }
    const labelText = text(point?.label);
    if (!labelText || /^(?:图中数值|data-)\d+$/i.test(labelText)) continue;
    for (const token of numberTokens(labelText)) {
      entries.push({ ...token, role: 'label', source: labelText });
    }
  }
  for (const labelNumber of Array.isArray(chart.labelNumbers) ? chart.labelNumbers : []) {
    const labelText = text(labelNumber);
    for (const token of numberTokens(labelText)) entries.push({ ...token, role: 'label', source: labelText });
  }
  return entries;
}

function sentenceContext(value, token) {
  const normalized = normalizeNumericText(value);
  const isBoundary = (index) => {
    const mark = normalized[index];
    if (mark !== '.' && mark !== '!' && mark !== '?') return false;
    return mark !== '.' || !(/\d/.test(normalized[index - 1] ?? '') && /\d/.test(normalized[index + 1] ?? ''));
  };
  let left = 0;
  for (let index = token.start - 1; index >= 0; index -= 1) {
    if (isBoundary(index)) { left = index + 1; break; }
  }
  let right = normalized.length;
  for (let index = token.end; index < normalized.length; index += 1) {
    if (isBoundary(index)) { right = index; break; }
  }
  return normalized.slice(left, right).trim();
}

function hasComparisonContext(value) {
  return /(?:higher|lower|more|less|increase|decrease|rise|rises|rose|fall|falls|fell|drop|decline|gap|difference|margin|exceed|exceeds|change|变化|上升|下降|差距|百分点|percentage\s*points?)/i.test(value);
}

function hasApproximationContext(value) {
  return /(?:about|approximately|around|roughly|nearly|almost|more\s+than|less\s+than|over|under|no\s+more\s+than|no\s+less\s+than|at\s+least|at\s+most|约|大约|超过|不超过|至少|至多)/i.test(value);
}

function chartIsPercent(chart, context = '') {
  return /%|percent|percentage|rate|proportion|share|ratio|百分点|比例|百分比/i.test(`${chart?.unit ?? ''} ${context}`);
}

function compatibleUnit(token, source, chart, context) {
  if (source.role === 'label') return true;
  if (token.percent === source.percent) return true;
  // 图表统一标明百分比时，英文常省略第二个百分号，例如 "40 higher"。
  if (chartIsPercent(chart, context) && (token.percent || source.percent)) return true;
  return false;
}

function directMatch(token, entries, chart, context) {
  return entries.some((source) => valueEqual(token.value, source.value) && compatibleUnit(token, source, chart, context));
}

function derivedDifferenceMatch(token, entries, chart, context) {
  if (!hasComparisonContext(context)) return false;
  const values = entries.filter((entry) => entry.role === 'value');
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      const difference = Math.abs(values[i].value - values[j].value);
      if (!roundedEqual(token.value, difference)) continue;
      if (!token.percent && !chartIsPercent(chart, context) && !/percentage\s*points?|percent/i.test(context)) continue;
      return true;
    }
  }
  return false;
}

function roundedSourceMatch(token, entries, chart, context) {
  if (!hasApproximationContext(context)) return false;
  return entries.some((source) => {
    if (!compatibleUnit(token, source, chart, context)) return false;
    const tolerance = Math.max(0.5, 0.5 * (10 ** -Math.min(2, decimalPlaces(source.value))));
    return Math.abs(token.value - source.value) <= tolerance;
  });
}

/**
 * 返回文本中无法由给定图表数据证明的数字。
 * 返回 raw 字符串并去重，便于直接展示给用户和传给修复提示。
 */
export function inspectChartNumbers(value, chart = {}) {
  const normalized = normalizeNumericText(value);
  const entries = sourceEntries(chart);
  const unsupported = [];
  const supported = [];
  for (const token of numberTokens(normalized)) {
    const context = sentenceContext(normalized, token);
    const ok = directMatch(token, entries, chart, context)
      || derivedDifferenceMatch(token, entries, chart, context)
      || roundedSourceMatch(token, entries, chart, context);
    if (ok) supported.push({ ...token, context });
    else unsupported.push(token.raw);
  }
  return {
    supported,
    unsupported: [...new Set(unsupported)],
    tokens: numberTokens(normalized),
  };
}

export function extractChartNumbers(value) {
  return numberTokens(value);
}

export function chartNumberGuide(chart = {}) {
  const direct = sourceEntries(chart)
    .filter((entry) => entry.role === 'value')
    .map((entry) => entry.raw);
  return [...new Set(direct)].join(', ');
}

function mergedArtifactReplacement(raw, chart = {}) {
  const match = normalizeNumericText(raw).match(/^([+-]?\d+)\.(\d{2,})(?:\s*%)?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const suffix = Number(match[2]);
  if (!Number.isFinite(whole) || !Number.isFinite(suffix) || Math.abs(suffix) < 10) return null;
  const valueTexts = (Array.isArray(chart.dataPoints) ? chart.dataPoints : []).map((point) => text(point?.value)).filter(Boolean);
  const labelTexts = [
    ...(Array.isArray(chart.dataPoints) ? chart.dataPoints.map((point) => text(point?.label)).filter(Boolean) : []),
    ...(Array.isArray(chart.labelNumbers) ? chart.labelNumbers.map(text) : []),
  ];
  const source = valueTexts.find((valueText) => numberTokens(valueText).some((entry) =>
    Number.isInteger(entry.value) && valueEqual(entry.value, whole) && /\.0+(?:\s*%|％)?$/.test(entry.raw)));
  const labelMatch = labelTexts.flatMap((labelText) => numberTokens(labelText)).some((entry) => valueEqual(entry.value, suffix));
  if (!source || !labelMatch) return null;
  return source;
}

/**
 * 修复表格扁平化后偶发的“数值 + 标签”拼接伪小数，例如 40.0% 与 41—50 岁被写成 40.41。
 * 只有整数部分能对应 .0 原始值、后缀能对应标签数字时才修复；任意数字不会被放行。
 */
export function repairMergedChartNumbers(value, chart = {}) {
  let output = text(value);
  const replacements = [];
  const unsupported = inspectChartNumbers(output, chart).unsupported;
  for (const raw of unsupported) {
    const replacement = mergedArtifactReplacement(raw, chart);
    if (!replacement) continue;
    const next = output.split(raw).join(replacement);
    if (next !== output) {
      replacements.push({ from: raw, to: replacement });
      output = next;
    }
  }
  return { text: output, replacements, unsupported: inspectChartNumbers(output, chart).unsupported };
}

export { normalizeNumericText };

export default {
  inspectChartNumbers,
  extractChartNumbers,
  chartNumberGuide,
  repairMergedChartNumbers,
  normalizeNumericText,
};
