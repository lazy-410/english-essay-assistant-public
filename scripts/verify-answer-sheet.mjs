/**
 * 答题卡排版 / 真实背景渲染验证。
 *
 *   node scripts/verify-answer-sheet.mjs
 *
 * 验证素材、字体、逐槽位排版、SVG 背景图片和 PDF Image XObject。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FONT_ID,
  FONTS_DIR,
  getDefaultFontId,
  listFonts,
  loadFont,
} from '../lib/fonts.mjs';
import {
  COLORS,
  DEFAULT_FONT_ID as SHEET_DEFAULT_FONT_ID,
  getFonts,
  getTemplates,
  layout,
  loadTemplate,
  renderPdf,
  renderSvg,
  resolveColor,
  tips,
} from '../lib/answer-sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS_DIR = path.join(ROOT, 'assets', 'answer-sheets');
const EXPECTED_LINES = { english1_a: 24, english1_b: 24, english2_a: 23, english2_b: 23 };
const FONT_SIZE = 16;
const notes = [];

function log(message) {
  notes.push(message);
  console.log(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assetTemplate(key) {
  return readJson(path.join(SHEETS_DIR, `${key}.json`));
}

function lineItems(template) {
  if (Array.isArray(template.lines?.items)) return template.lines.items;
  return (template.lines?.baselines ?? []).map((baseline, index) => ({
    baseline,
    startX: index === 0 ? template.column?.x0 + template.column?.firstLineIndent : template.column?.x0,
    endX: template.column?.x1,
  }));
}

function nonOverflowLines(result) {
  return result.lines.filter((line) => !line.overflow);
}

function bodyTextLines(result) {
  return nonOverflowLines(result).filter((line) => line.text);
}

function assertLineGeometry(result, template, label) {
  const items = lineItems(template);
  assert.equal(result.availableLines, items.length, `${label} 可用行数异常`);
  for (const line of result.lines) {
    if (line.overflow) {
      assert.equal(line.baseline, null, `${label} 溢出行不应有基线`);
      continue;
    }
    const item = items[line.row];
    assert.ok(item, `${label} 缺少第 ${line.row} 行素材`);
    assert.equal(line.baseline, item.baseline, `${label} 第 ${line.row} 行基线与素材不一致`);
    assert.equal(line.startX, item.startX, `${label} 第 ${line.row} 行 startX 与素材不一致`);
    assert.equal(line.endX, item.endX, `${label} 第 ${line.row} 行 endX 与素材不一致`);
  }
}

function assertWidth(result, font, label) {
  for (const line of bodyTextLines(result)) {
    const available = line.endX - line.startX - 2 - line.indent;
    assert.ok(Math.abs(line.availableWidth - Math.max(1, available)) < 1e-9, `${label} 第 ${line.row} 行可用宽度异常`);
    assert.ok(line.width <= available + 1e-6, `${label} 第 ${line.row} 行宽度超出逐行槽位`);
    assert.ok(font.widthOf(line.text, result.fontSize) <= available + 1e-6, `${label} 字体实测宽度超出逐行槽位`);
  }
}

function pdfObjects(pdf) {
  const text = pdf.toString('latin1');
  const start = Number(text.match(/startxref\s+(\d+)/)?.[1]);
  assert.ok(Number.isInteger(start) && start > 0, 'PDF 缺少有效 startxref');
  assert.equal(text.slice(start, start + 4), 'xref', 'startxref 未指向 xref 表');
  const match = text.slice(start).match(/xref\s+0 (\d+)\s+([\s\S]*?)trailer/);
  assert.ok(match, 'PDF 缺少 xref/trailer');
  const size = Number(match[1]);
  const entries = match[2].trim().split(/\r?\n/).map((row) => row.trim());
  assert.equal(entries.length, size, 'xref 条目数与 Size 不一致');
  for (let id = 1; id < size; id += 1) {
    assert.match(entries[id], /^\d{10} \d{5} n$/, `xref ${id} 格式异常`);
    const offset = Number(entries[id].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${id} 0 obj`.length), `${id} 0 obj`, `xref ${id} 偏移错误`);
  }
  return { text, size };
}

function expectedBackground(template, key) {
  const meta = template.background;
  assert.ok(meta, `${key} 缺少 background 元数据`);
  assert.equal(meta.url, `/answer-sheet-assets/${key}.png`);
  assert.equal(meta.colorSpace, 'DeviceRGB');
  assert.equal(meta.bitsPerComponent, 8);
  assert.equal(meta.dpi, 400);
  assert.ok(meta.width > 3000 && meta.height > 4000, `${key} 背景像素尺寸异常`);

  const png = path.join(ROOT, meta.png);
  const rgb = path.join(ROOT, meta.rgbDeflate);
  assert.ok(fs.existsSync(png), `${key} 背景 PNG 不存在`);
  assert.ok(fs.existsSync(rgb), `${key} rgb.deflate 不存在`);
  const pngBuffer = fs.readFileSync(png);
  const rgbBuffer = fs.readFileSync(rgb);
  assert.equal(pngBuffer.length, meta.pngBytes, `${key} PNG 字节数变化`);
  assert.equal(rgbBuffer.length, meta.rgbDeflateBytes, `${key} rgb.deflate 字节数变化`);
  assert.equal(sha256(pngBuffer), meta.pngSha256, `${key} PNG 哈希变化`);
  assert.equal(sha256(rgbBuffer), meta.rgbDeflateSha256, `${key} rgb.deflate 哈希变化`);
  assert.ok(pngBuffer.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary')), `${key} 不是 PNG`);
  return { png, rgb, rgbBuffer };
}

/* ---------------------- 1. 四份真实素材与模板 ---------------------- */

const index = readJson(path.join(SHEETS_DIR, 'index.json'));
assert.equal(index.source, 'D:/Dome/answer_sheet_generator.py');
assert.deepEqual(index.a4Target, [28, 30, 567, 811]);
assert.equal(index.backgroundDpi, 400);
assert.equal(index.templates.length, 4);

const templates = getTemplates();
assert.equal(templates.length, 4, '应有 4 个写作区模板');

for (const [key, count] of Object.entries(EXPECTED_LINES)) {
  const asset = assetTemplate(key);
  const entry = templates.find((item) => item.key === key);
  assert.ok(entry, `index.json 缺少模板 ${key}`);
  assert.equal(entry.lineCount, count, `${key} 行数应为 ${count}`);
  assert.equal(entry.backgroundUrl, `/answer-sheet-assets/${key}.png`);
  assert.equal(asset.lines.count, count);
  assert.equal(asset.page.width, 595.28);
  assert.equal(asset.page.height, 841.89);
  assert.equal(asset.lines.items.length, count);
  assert.ok(asset.lines.items[0].startX > asset.lines.items[1].startX + 20, `${key} 首行应明显避开题号`);
  assert.ok(asset.lines.items.every((item) => item.endX > item.startX), `${key} 行槽位宽度异常`);
  expectedBackground(asset, key);

  const template = loadTemplate(key);
  const items = lineItems(template);
  assert.equal(items.length, count, `${key} loadTemplate 行素材数量异常`);
  assert.ok(template.background, `${key} loadTemplate 应带背景缓存`);
  const dataUri = template.background.pngDataUri ?? template.backgroundPngDataUri ?? template.pngDataUri;
  assert.match(String(dataUri), /^data:image\/png;base64,/, `${key} 缺少背景 PNG data URI`);
  const rgbDeflate = template.background.rgbDeflateBuffer ?? template.rgbDeflateBuffer;
  assert.ok(Buffer.isBuffer(rgbDeflate), `${key} 缺少 rgb.deflate Buffer 缓存`);
  assert.equal(rgbDeflate.length, asset.background.rgbDeflateBytes ?? rgbDeflate.length);

  for (let indexLine = 1; indexLine < items.length; indexLine += 1) {
    const gap = items[indexLine].baseline - items[indexLine - 1].baseline;
    assert.ok(gap > 0, `${key} 第 ${indexLine} 行基线必须递增`);
  }
  log(`素材 ${key}: ${count} 行，首行槽位 ${items[0].startX.toFixed(4)}..${items[0].endX.toFixed(4)}`);
}

/* ------------------------- 2. 字体完整扫描 ------------------------- */

const fonts = listFonts();
assert.ok(fonts.length >= 23, `字体总数应至少 23，实际 ${fonts.length}`);
assert.equal(fonts.filter((font) => font.source === 'dome').length, 21, 'Dome 字体应精确 21 个');
assert.equal(fonts.filter((font) => font.source === 'builtin').length, fonts.length - 21);
assert.ok(fonts.every((font) => font.id && font.label && font.family && font.file && font.url));
assert.equal(new Set(fonts.map((font) => font.id)).size, fonts.length, '字体 id 必须唯一');
assert.equal(new Set(fonts.map((font) => font.file)).size, fonts.length, '字体文件必须逐个列出');
assert.equal(fonts.filter((font) => font.recommended).length, 1, '应只有一个推荐字体');
const recommended = fonts.find((font) => font.recommended);
assert.ok(recommended, '缺少推荐字体');
assert.match(`${recommended.label} ${recommended.family} ${recommended.file}`, /舒窈英文衡水体/);
assert.equal(getDefaultFontId(), recommended.id, '默认字体应选择推荐字体');
assert.equal(DEFAULT_FONT_ID, recommended.id, 'DEFAULT_FONT_ID 应选择推荐字体');
assert.equal(SHEET_DEFAULT_FONT_ID, recommended.id, '答题卡默认字体应选择推荐字体');

for (const descriptor of fonts) {
  const relative = path.relative(FONTS_DIR, descriptor.file).split(path.sep).join('/');
  const expectedUrl = `/fonts/${relative.split('/').map(encodeURIComponent).join('/')}`;
  assert.equal(descriptor.url, expectedUrl, `${descriptor.id} URL 未正确编码`);
  if (/\/static\//i.test(relative) && /-(Bold|Medium|Regular|SemiBold)\.ttf$/i.test(relative)) {
    assert.match(descriptor.label, /Bold|Medium|Regular|SemiBold/, `${descriptor.id} 标签缺少静态字重`);
  }
  const font = loadFont(descriptor.id);
  assert.equal(font.id, descriptor.id);
  assert.ok(font.asciiPdfName && /^[A-Za-z0-9-]+$/.test(font.asciiPdfName), `${descriptor.id} 缺少 ASCII PDF 名称`);
  assert.ok(font.glyphIdFor('A') > 0, `${descriptor.id} cmap 无法解析 A`);
  assert.ok(font.widthOf('Practice makes progress.', 16) > 0, `${descriptor.id} 度量失败`);
}
log(`字体校验通过：${fonts.length} 个文件（Dome ${fonts.filter((font) => font.source === 'dome').length} 个），默认 ${recommended.label}`);

/* --------------------------- 3. 排版与边界 --------------------------- */

const sampleEssay = {
  salutation: 'Dear Sir or Madam,',
  paragraphs: [
    { sentences: ['I am writing to express my sincere apology for the inconvenience caused by the delayed delivery of the books you ordered last week.'] },
    { sentences: ['The unexpected shortage in our warehouse was the direct reason for this regrettable situation.'] },
    { sentences: ['To make up for the trouble, we have arranged an express shipment that will reach you within three working days.'] },
    { sentences: ['Thank you for your understanding, and I would appreciate it if you could accept our arrangement.'] },
  ],
  signature: 'Yours sincerely,\nLi Ming',
};

for (const key of Object.keys(EXPECTED_LINES)) {
  const template = loadTemplate(key);
  const font = loadFont(recommended.id);
  for (const style of ['block', 'indent']) {
    for (const size of [12, 16, 20]) {
      const result = layout(sampleEssay, { template: key, fontId: recommended.id, fontSize: size, style });
      assertLineGeometry(result, template, `${key}/${style}/${size}`);
      assertWidth(result, font, `${key}/${style}/${size}`);
    }
  }
}
log('逐槽位宽度校验通过：4 模板 × 2 版式 × 3 字号');

const longWord = 'A'.repeat(400);
const longResult = layout({ paragraphs: [{ text: longWord }] }, { template: 'english1_a', fontId: recommended.id, fontSize: FONT_SIZE });
assert.ok(longResult.lines.length > 1, '超长单词应被断开');
assert.equal(longResult.lines.map((line) => line.text).join(''), longWord, '断词不应丢字符');
assertWidth(longResult, loadFont(recommended.id), '超长单词');
log(`超长单词断开：${longWord.length} 个字符拆成 ${longResult.lines.length} 行且无字符丢失`);

// D:\\Dome wrap_text 回归：无称呼前缀的第一个逻辑块固定使用首行短线宽度，
// 后续物理行不会切换到当前槽位宽度；原工具应稳定得到以下 6 行。
const legacyWrapText = 'people remember remember with because must We bring people care help needs life of always needs families people We help society that a can needs and our because better hard must mind, respect hope hard bring all values remember must families Only in this way should others in friends bring because because better future.';
const legacyWrap = layout({ paragraphs: [{ text: legacyWrapText }] }, {
  template: 'english1_a',
  fontId: recommended.id,
  fontSize: FONT_SIZE,
  style: 'block',
});
assert.deepEqual(legacyWrap.lines.filter((line) => !line.overflow).map((line) => line.text), [
  'people remember remember with because must We bring people',
  'care help needs life of always needs families people We help',
  'society that a can needs and our because better hard must mind,',
  'respect hope hard bring all values remember must families Only in',
  'this way should others in friends bring because because better',
  'future.',
], 'Dome 固定 first_width/regular_width 换行结果不一致');
assert.equal(legacyWrap.usedLines, 6, 'Dome 回归样本应为 6 行');
log('Dome wrap_text 回归通过：固定首行/正文宽度得到 6 行，mind,/Only in/this way/better/future. 断点一致');

function fillExactly(templateKey) {
  const limit = loadTemplate(templateKey).lines.count;
  const build = (count) => ({ paragraphs: [{ text: Array.from({ length: count }, () => 'alpha').join(' ') }] });
  const linesFor = (count) => layout(build(count), {
    template: templateKey,
    fontId: recommended.id,
    fontSize: FONT_SIZE,
    style: 'indent',
  }).usedLines;
  let low = 1;
  let high = 2;
  while (linesFor(high) <= limit) {
    low = high;
    high *= 2;
    assert.ok(high < 100000, `${templateKey} 无法找到溢出点`);
  }
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (linesFor(mid) <= limit) low = mid;
    else high = mid;
  }
  assert.equal(linesFor(low), limit, `${templateKey} 未构造出恰好 ${limit} 行`);
  return { words: low, limit, build };
}

for (const [key, count] of Object.entries(EXPECTED_LINES)) {
  const { words, build } = fillExactly(key);
  const exact = layout(build(words), { template: key, fontId: recommended.id, fontSize: FONT_SIZE, style: 'indent' });
  assert.equal(exact.usedLines, count);
  assert.equal(exact.availableLines, count);
  assert.equal(exact.overflowLines, 0);
  assert.equal(exact.fits, true);
  assert.equal(exact.overflowText, '');
  const over = layout({ paragraphs: [...build(words).paragraphs, { text: 'One more sentence pushes the text past the last ruled line.' }] }, {
    template: key,
    fontId: recommended.id,
    fontSize: FONT_SIZE,
    style: 'indent',
  });
  assert.ok(over.overflowLines > 0, `${key} 追加段落后应溢出`);
  assert.equal(over.fits, false);
  assert.ok(over.overflowText.length > 0);
  assert.equal(over.usedLines, count + over.overflowLines);
  assert.equal(over.placedLines, count);
  log(`${key}: ${words} 个词恰好写满 ${count} 行，追加段落后 overflowLines=${over.overflowLines}`);
}

/* --------------------------- 4. baselineAdjust --------------------------- */

const baselineZero = layout(sampleEssay, { template: 'english1_b', fontId: recommended.id, fontSize: 16, baselineAdjust: 0 });
const baselinePlus = layout(sampleEssay, { template: 'english1_b', fontId: recommended.id, fontSize: 16, baselineAdjust: 2 });
assert.equal(baselineZero.baselineAdjust, 0);
assert.equal(baselinePlus.baselineAdjust, 2);
for (let index = 0; index < baselineZero.lines.length; index += 1) {
  const a = baselineZero.lines[index];
  const b = baselinePlus.lines[index];
  if (a.baseline === null || b.baseline === null) continue;
  assert.equal(b.baseline - a.baseline, 2, `第 ${index} 行 baselineAdjust 未平移 2`);
}
assert.equal(layout(sampleEssay, { template: 'english1_b', baselineAdjust: 9 }).baselineAdjust, 4);
assert.equal(layout(sampleEssay, { template: 'english1_b', baselineAdjust: -9 }).baselineAdjust, -4);
log('baselineAdjust 校验通过：+2 平移全部正文基线，且输入钳制范围为 -4..4');

/* --------------------------- 5. 版式规则 --------------------------- */

const blockResult = layout(sampleEssay, { template: 'english1_b', fontId: recommended.id, fontSize: 14, style: 'block' });
assert.ok(blockResult.lines.some((line) => line.blank), '齐头式应有段间空行');
assert.ok(blockResult.lines.filter((line) => line.text).every((line) => line.indent === 0), '齐头式不应缩进');
assert.equal(blockResult.lines[0].text, 'Dear Sir or Madam,');
assert.equal(blockResult.lines[0].align, 'left');
assert.equal(blockResult.lines.filter((line) => line.text === 'Yours sincerely,').length, 1);
assert.equal(blockResult.lines.find((line) => line.text === 'Yours sincerely,').align, 'left');

const indentResult = layout(sampleEssay, { template: 'english1_b', fontId: recommended.id, fontSize: 14, style: 'indent' });
assert.ok(indentResult.lines.filter((line) => line.indent > 0).length >= 3, '缩进式各段首行应缩进');
assert.ok(Math.abs(indentResult.lines.find((line) => line.indent > 0).indent - 14 * 2.4) < 1e-9);
assert.equal(indentResult.lines.filter((line) => line.blank).length, 1, '缩进式仅落款前空一行');
assert.equal(indentResult.lines.find((line) => line.text === 'Yours sincerely,').align, 'right');

const notice = layout({
  title: 'Notice',
  paragraphs: [{ text: 'The Students Union will hold a volunteer teaching program this summer vacation.' }],
  signature: 'The Students Union',
  date: 'June 20, 2025',
}, { template: 'english2_a', fontId: recommended.id, fontSize: 16, style: 'block', kind: 'notice' });
assert.equal(notice.lines[0].text, 'Notice');
assert.equal(notice.lines[0].align, 'center');
assert.equal(notice.lines.find((line) => line.text === 'The Students Union').align, 'right');
assert.equal(notice.lines.find((line) => line.text === 'June 20, 2025').align, 'right');
assert.equal(notice.lines.at(-1).text, 'June 20, 2025');
log('版式校验通过：齐头、缩进、通知标题与右对齐落款日期');

/* --------------------------- 6. SVG 背景与字体 --------------------------- */

const svgLayout = layout(sampleEssay, {
  template: 'english1_b',
  fontId: recommended.id,
  fontSize: 16,
  slant: 10,
  style: 'block',
  color: 'blue',
});
const svgResult = renderSvg(sampleEssay, {
  template: 'english1_b',
  fontId: recommended.id,
  fontSize: 16,
  slant: 10,
  style: 'block',
  color: 'blue',
  layout: svgLayout,
});
assert.ok(svgResult.svg.startsWith('<svg'));
assert.ok(svgResult.svg.endsWith('</svg>'));
assert.equal((svgResult.svg.match(/<image\b/g) || []).length, 1, 'SVG 应只有一个背景 image');
assert.equal((svgResult.svg.match(/<line\b/g) || []).length, 0, 'SVG 不应程序绘制横线');
assert.match(svgResult.svg, /href="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
assert.match(svgResult.svg, /@font-face[\s\S]*data:[^;]+;base64,[A-Za-z0-9+/=]+/);
assert.equal(svgResult.usedLines, svgLayout.usedLines);
assert.equal(svgResult.lines.length, svgLayout.lines.length);
const svgTextCount = (svgResult.svg.match(/<text\b/g) || []).length;
assert.equal(svgTextCount, bodyTextLines(svgLayout).length, 'SVG 文字应只包含正文行，标题题号来自背景');
assert.ok(svgResult.svg.includes('transform="matrix(1 0 -0.17633'), '右倾应通过斜切矩阵实现');
const svgNoSlant = renderSvg(sampleEssay, { template: 'english1_b', fontId: recommended.id, fontSize: 16 });
assert.ok(!svgNoSlant.svg.includes('matrix('), '不倾斜时不应输出 transform');
log(`SVG 校验通过：1 个 PNG image + 内嵌 TTF，${svgTextCount} 行正文，无程序横线`);

/* --------------------------- 7. PDF 背景 XObject --------------------------- */

const pdf = renderPdf(sampleEssay, {
  template: 'english1_b',
  fontId: recommended.id,
  fontSize: 16,
  slant: 10,
  style: 'block',
  color: 'blue',
  layout: svgLayout,
});
assert.ok(Buffer.isBuffer(pdf));
assert.ok(pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-'));
const { text: pdfText, size: pdfSize } = pdfObjects(pdf);
assert.ok(pdfText.includes('/Subtype /Image'), 'PDF 应包含真实背景 Image XObject');
assert.ok(pdfText.includes('/Width 3308') && pdfText.includes('/Height 4678'), 'Image 尺寸应来自素材');
assert.ok(pdfText.includes('/ColorSpace /DeviceRGB'));
assert.ok(pdfText.includes('/BitsPerComponent 8'));
assert.ok(pdfText.includes('/Filter /FlateDecode'));
assert.ok(pdfText.includes('/Im1 Do'), '内容流应绘制 /Im1 背景');
assert.ok(pdfText.includes('/MediaBox [0 0 595.28 841.89]'));
assert.ok(pdfText.includes('/FontFile2'));
assert.ok(pdfText.includes(`/BaseFont /${loadFont(recommended.id).asciiPdfName}`));
assert.ok(!/\/BaseFont \/[^A-Za-z0-9-]/.test(pdfText), 'PDF BaseFont 必须是 ASCII');
assert.ok(!/\d+(?:\.\d+)? \d+(?:\.\d+)? m \d+(?:\.\d+)? \d+(?:\.\d+)? l S/.test(pdfText), 'PDF 不应程序绘制横线');
assert.ok(pdfText.trimEnd().endsWith('%%EOF'));
const widthsMatch = pdfText.match(/\/Widths \[([^\]]+)\]/);
assert.ok(widthsMatch, 'PDF 缺少 Widths');
const widths = widthsMatch[1].trim().split(/\s+/).map(Number);
assert.equal(widths.length, 224);
assert.ok(widths.every((width) => Number.isInteger(width) && width >= 0));

const tricky = '“It’s fine” — she said… café';
const trickyLayout = layout({ paragraphs: [{ text: tricky }] }, { template: 'english2_b', fontId: recommended.id, fontSize: 16 });
assert.equal(trickyLayout.lines[0].text, '"It\'s fine" - she said... café');
assert.ok(renderPdf({ paragraphs: [{ text: tricky }] }, { template: 'english2_b', fontId: recommended.id }).subarray(0, 5).toString('latin1') === '%PDF-');
assert.ok(renderPdf({ paragraphs: [{ text: 'hello 中文 world' }] }, { template: 'english2_b', fontId: recommended.id }).subarray(0, 5).toString('latin1') === '%PDF-');
log(`PDF 校验通过：${pdf.length} 字节，${pdfSize - 1} 个 xref 条目，背景 Image XObject 与 FontFile2 均存在`);

/* ----------------------- 8. 全部 Dome 字体渲染 ----------------------- */

const domeFonts = fonts.filter((font) => font.source === 'dome');
for (const descriptor of domeFonts) {
  const shortEssay = { paragraphs: [{ text: 'Practice makes progress.' }] };
  const shortSvg = renderSvg(shortEssay, { template: 'english2_a', fontId: descriptor.id, fontSize: 14 });
  const shortPdf = renderPdf(shortEssay, { template: 'english2_a', fontId: descriptor.id, fontSize: 14 });
  assert.match(shortSvg.svg, /<svg/);
  assert.ok(Buffer.isBuffer(shortPdf) && shortPdf.subarray(0, 5).toString('latin1') === '%PDF-');
}
log(`Dome 字体渲染通过：${domeFonts.length} 个字体均成功生成 SVG/PDF`);

/* ------------------------------- 9. 颜色与 tips ------------------------------- */

assert.deepEqual(resolveColor('black'), COLORS.black);
assert.deepEqual(resolveColor('red'), COLORS.red);
assert.deepEqual(resolveColor('blue'), COLORS.blue);
assert.deepEqual(resolveColor('darkgray'), COLORS.darkgray);
assert.deepEqual(resolveColor('深灰色'), COLORS.darkgray);
assert.deepEqual(resolveColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
assert.deepEqual(resolveColor([2, -1, 0.5]), [1, 0, 0.5]);
assert.deepEqual(resolveColor('不存在的颜色'), COLORS.black);

const guide = tips();
assert.equal(guide.recommended, 'block');
assert.ok(guide.styles.find((style) => style.key === 'block')?.recommended);
assert.ok(guide.answerSheet?.some((text) => /完整原版答题卡背景|英语一.*24|英语二.*23/.test(text)));
assert.ok(guide.overflow?.length >= 2);
const guideText = JSON.stringify(guide);
assert.match(guideText, /模拟考场|红字字帖|完整原版答题卡背景/);
assert.ok(Array.isArray(guide.colors));
assert.deepEqual(guide.colors, Object.keys(COLORS));
assert.ok(guide.fonts?.some((font) => font.recommended));
assert.equal(getFonts().length, fonts.length);
log('颜色与 tips 校验通过：真实答题卡背景、模拟考场提示与颜色接口均存在');

/* -------------------------------- 汇总 -------------------------------- */

const summary = Object.entries(EXPECTED_LINES)
  .map(([key, count]) => `${key}=${count}行`)
  .join(' ');
console.log(`PASS 答题卡验证全部通过 | ${summary} | 字体 ${fonts.length}（Dome ${domeFonts.length}） | 默认字体 ${recommended.label} | PDF ${pdf.length}B | SVG ${svgResult.svg.length}B | xref ${pdfSize} 项`);
