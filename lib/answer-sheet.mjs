import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './paths.mjs';
import { DEFAULT_FONT_ID as FONT_DEFAULT_ID, loadFont, listFonts } from './fonts.mjs';

export const SHEETS_DIR = path.join(ROOT, 'assets', 'answer-sheets');
export const DEFAULT_FONT_ID = FONT_DEFAULT_ID;

const DEFAULT_FONT_SIZE = 16;
const INDENT_EM = 2.4;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;
const MAX_SLANT_DEG = 25;
const RIGHT_PADDING = 2;

// 与 D:\Dome\answer_sheet_generator.py 的 COLOR_MAP 完全一致。
export const COLORS = {
  black: [0.05, 0.05, 0.05],
  red: [0.85, 0.05, 0.05],
  blue: [0.04, 0.20, 0.72],
  darkgray: [0.28, 0.28, 0.28],
};

const COLOR_ALIASES = {
  黑色: 'black', 黑: 'black', 蓝色: 'blue', 蓝: 'blue', 红色: 'red', 红: 'red',
  深灰色: 'darkgray', 深灰: 'darkgray', gray: 'darkgray', grey: 'darkgray', 'dark-gray': 'darkgray',
};

export function resolveColor(input) {
  if (Array.isArray(input) && input.length >= 3) {
    return input.slice(0, 3).map((channel) => {
      const value = Number(channel);
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    });
  }
  const raw = String(input ?? '').trim();
  const key = raw.toLowerCase();
  const name = COLORS[key] ? key : COLOR_ALIASES[key] || COLOR_ALIASES[raw];
  return (COLORS[name] || COLORS.black).slice();
}

const templateCache = new Map();
let indexCache = null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readIndex() {
  if (!indexCache) indexCache = readJson(path.join(SHEETS_DIR, 'index.json'));
  return indexCache;
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function resolveAsset(relative, description) {
  if (typeof relative !== 'string' || !relative.trim()) throw new Error(`模板缺少 ${description} 路径`);
  const file = path.resolve(ROOT, relative);
  if (!fs.existsSync(file)) throw new Error(`${description} 不存在：${relative}`);
  return file;
}

function prepareTemplate(raw, expectedKey = raw?.key) {
  const id = String(expectedKey ?? '').trim();
  if (!raw || typeof raw !== 'object' || raw.key !== id) throw new Error(`答题卡模板结构异常：${id}`);
  if (!raw.page || !finite(raw.page.width) || !finite(raw.page.height)) throw new Error(`模板 ${id} 的 page 异常`);
  if (!raw.target || !['x0', 'y0', 'x1', 'y1'].every((key) => finite(raw.target[key]))) throw new Error(`模板 ${id} 的 target 异常`);
  const items = raw.lines?.items;
  if (!Number.isInteger(raw.lines?.count) || !Array.isArray(items) || items.length !== raw.lines.count) {
    throw new Error(`模板 ${id} 的 lines.items 数量与 count 不一致`);
  }
  for (const [index, item] of items.entries()) {
    if (!item || !finite(item.baseline) || !finite(item.startX) || !finite(item.endX) || Number(item.endX) <= Number(item.startX)) {
      throw new Error(`模板 ${id} 第 ${index + 1} 行槽位异常`);
    }
  }
  const background = raw.background;
  if (!background || !finite(background.width) || !finite(background.height) || background.colorSpace !== 'DeviceRGB' || Number(background.bitsPerComponent) !== 8) {
    throw new Error(`模板 ${id} 的 background 异常`);
  }
  if (background.pngDataUri && Buffer.isBuffer(background.rgbDeflateBuffer)) return raw;
  const pngFile = resolveAsset(background.png, '背景 PNG');
  const rgbDeflateFile = resolveAsset(background.rgbDeflate, '背景 RGB deflate');
  const pngBuffer = fs.readFileSync(pngFile);
  const rgbDeflateBuffer = fs.readFileSync(rgbDeflateFile);
  if (background.pngBytes && pngBuffer.length !== Number(background.pngBytes)) throw new Error(`模板 ${id} 的 PNG 字节数不一致`);
  if (background.rgbDeflateBytes && rgbDeflateBuffer.length !== Number(background.rgbDeflateBytes)) throw new Error(`模板 ${id} 的 RGB deflate 字节数不一致`);
  return {
    ...raw,
    page: { width: Number(raw.page.width), height: Number(raw.page.height) },
    target: Object.fromEntries(Object.entries(raw.target).map(([key, value]) => [key, Number(value)])),
    lines: { ...raw.lines, items: items.map((item) => ({ baseline: Number(item.baseline), startX: Number(item.startX), endX: Number(item.endX) })) },
    background: {
      ...background,
      width: Number(background.width),
      height: Number(background.height),
      bitsPerComponent: Number(background.bitsPerComponent),
      pngFile,
      rgbDeflateFile,
      pngBuffer,
      pngDataUri: `data:image/png;base64,${pngBuffer.toString('base64')}`,
      rgbDeflateBuffer,
    },
  };
}

export function loadTemplate(key) {
  if (key && typeof key === 'object') return prepareTemplate(key, key.key);
  const id = String(key ?? '').trim();
  if (!id) throw new Error('缺少答题卡模板 key');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`非法答题卡模板 key：${id}`);
  if (templateCache.has(id)) return templateCache.get(id);
  const file = path.join(SHEETS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`未找到答题卡模板：${id}`);
  const template = prepareTemplate(readJson(file), id);
  templateCache.set(id, template);
  return template;
}

export function getTemplates() {
  const { templates = [] } = readIndex();
  return templates.map((item) => {
    const template = loadTemplate(item.key);
    return {
      key: template.key, label: template.label, exam: template.exam, part: template.part,
      lineCount: template.lines.count, backgroundUrl: template.background.url,
    };
  });
}

export function getFonts() {
  return listFonts();
}

export function clearTemplateCache() {
  templateCache.clear();
  indexCache = null;
}

const REPLACEMENTS = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201A', "'"], ['\u201B', "'"], ['\u2032', "'"], ['\u00B4', "'"],
  ['\u201C', '"'], ['\u201D', '"'], ['\u201E', '"'], ['\u2033', '"'],
  ['\u2013', '-'], ['\u2014', '-'], ['\u2015', '-'], ['\u2212', '-'], ['\u2010', '-'], ['\u2011', '-'],
  ['\u2026', '...'], ['\u00A0', ' '], ['\u2007', ' '], ['\u2009', ' '], ['\u200A', ' '], ['\u202F', ' '],
  ['\u200B', ''], ['\uFEFF', ''], ['\u2022', '*'], ['\u00B7', '.'], ['\u2044', '/'],
  ['\uFF0C', ','], ['\u3002', '.'], ['\uFF1A', ':'], ['\uFF1B', ';'], ['\uFF1F', '?'], ['\uFF01', '!'],
  ['\uFF08', '('], ['\uFF09', ')'], ['\u3001', ','],
]);

const WINANSI_TO_UNICODE = (() => {
  const map = new Array(256).fill(-1);
  for (let code = 32; code <= 126; code += 1) map[code] = code;
  const high = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
    0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
    0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
    0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
    0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
  };
  for (const [code, unicode] of Object.entries(high)) map[Number(code)] = unicode;
  for (let code = 0xa0; code <= 0xff; code += 1) map[code] = code;
  return map;
})();

const UNICODE_TO_WINANSI = (() => {
  const map = new Map();
  for (let code = 0; code < 256; code += 1) {
    const unicode = WINANSI_TO_UNICODE[code];
    if (unicode >= 0 && !map.has(unicode)) map.set(unicode, code);
  }
  return map;
})();

export function sanitizeText(input) {
  let output = '';
  for (const ch of String(input ?? '').replace(/[\r\n\t]+/g, ' ')) {
    if (REPLACEMENTS.has(ch)) output += REPLACEMENTS.get(ch);
    else {
      const cp = ch.codePointAt(0);
      output += cp === 0x20 || (cp >= 0x21 && cp <= 0x7e) || UNICODE_TO_WINANSI.has(cp) ? ch : '?';
    }
  }
  return output;
}

function toWinAnsiBytes(text) {
  return Buffer.from(Array.from(String(text), (ch) => UNICODE_TO_WINANSI.get(ch.codePointAt(0)) ?? 0x3f));
}

function clamp(value, min, max, fallback = 0) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function normalizeOptions(options = {}) {
  const template = loadTemplate(options.template ?? 'english2_a');
  const fontId = String(options.fontId ?? options.font ?? DEFAULT_FONT_ID);
  const font = loadFont(fontId);
  const rawSize = Number(options.fontSize);
  return {
    template,
    font,
    fontId: font.id,
    fontSize: clamp(rawSize, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE),
    slant: clamp(options.slant, -MAX_SLANT_DEG, MAX_SLANT_DEG, 0),
    baselineAdjust: clamp(options.baselineAdjust, -4, 4, 0),
    style: options.style === 'indent' ? 'indent' : 'block',
    kind: options.kind === 'notice' ? 'notice' : 'letter',
    color: resolveColor(options.color ?? 'black'),
  };
}

function paragraphText(paragraph) {
  if (paragraph == null) return '';
  if (typeof paragraph === 'string') return paragraph;
  if (Array.isArray(paragraph)) return paragraph.join(' ');
  if (Array.isArray(paragraph.sentences)) return paragraph.sentences.filter((value) => value != null).join(' ');
  return String(paragraph.text ?? '');
}

export function layout(essay = {}, options = {}) {
  const config = normalizeOptions(options);
  const { template, font, fontSize, style, kind, baselineAdjust } = config;
  const slots = template.lines.items;
  const paragraphIndent = style === 'indent' ? fontSize * INDENT_EM : 0;
  const rows = [];
  const measure = (text) => font.widthOf(text, fontSize);
  const slotFor = (index) => slots[Math.min(index, slots.length - 1)];
  // D:\\Dome 的 wrap_text 按逻辑文本块选择宽度，而不是按当前物理行选择宽度。
  // 第一个逻辑块始终使用首行题号短线宽度，后续逻辑块始终使用第二槽位的正常宽度。
  const firstBlockWidth = Math.max(1, slots[0].endX - slots[0].startX - RIGHT_PADDING);
  const regularBlockWidth = Math.max(1, slots[Math.min(1, slots.length - 1)].endX - slots[Math.min(1, slots.length - 1)].startX - RIGHT_PADDING);
  const usableFor = (wrapWidth, indent = 0) => Math.max(1, wrapWidth - indent);
  const pushBlank = () => rows.push({ text: '', align: 'left', indent: 0, blank: true });
  const pushWrapped = (rawText, { align = 'left', firstIndent = 0, emptyIsBlank = false, wrapWidth = regularBlockWidth } = {}) => {
    const text = sanitizeText(rawText).trim();
    if (!text) {
      if (emptyIsBlank) pushBlank();
      return;
    }
    const words = text.split(/ +/).filter(Boolean);
    let wordIndex = 0;
    let firstRow = true;
    while (wordIndex < words.length) {
      const indent = firstRow ? firstIndent : 0;
      const available = usableFor(wrapWidth, indent);
      let current = '';
      while (wordIndex < words.length) {
        const candidate = current ? `${current} ${words[wordIndex]}` : words[wordIndex];
        if (measure(candidate) <= available) {
          current = candidate;
          wordIndex += 1;
          continue;
        }
        if (!current) {
          const word = words[wordIndex];
          let taken = '';
          for (const ch of word) {
            if (taken && measure(taken + ch) > available) break;
            taken += ch;
          }
          if (!taken) taken = Array.from(word)[0] || '';
          current = taken;
          const rest = word.slice(taken.length);
          if (rest) words[wordIndex] = rest;
          else wordIndex += 1;
        }
        break;
      }
      rows.push({ text: current, align, indent, blank: false });
      firstRow = false;
    }
  };

  let logicalBlockIndex = 0;
  const pushLogicalBlock = (rawText, options = {}) => {
    const wrapWidth = logicalBlockIndex === 0 ? firstBlockWidth : regularBlockWidth;
    pushWrapped(rawText, { ...options, wrapWidth });
    logicalBlockIndex += 1;
  };

  if (kind === 'notice') {
    pushLogicalBlock(essay.title || 'Notice', { align: 'center' });
    pushBlank();
  } else if (essay.salutation) {
    pushLogicalBlock(essay.salutation);
    if (style === 'block') pushBlank();
  }
  const paragraphs = Array.isArray(essay.paragraphs) ? essay.paragraphs : [];
  for (const [index, paragraph] of paragraphs.entries()) {
    pushLogicalBlock(paragraphText(paragraph), { firstIndent: paragraphIndent, emptyIsBlank: true });
    if (style === 'block' && index < paragraphs.length - 1) pushBlank();
  }
  const signatureAlign = kind === 'notice' ? 'right' : style === 'indent' ? 'right' : 'left';
  const tail = [];
  if (essay.signature != null && String(essay.signature) !== '') {
    for (const line of String(essay.signature).split(/\r?\n/)) tail.push({ text: line, align: signatureAlign });
  }
  if (essay.date != null && String(essay.date).trim()) tail.push({ text: String(essay.date), align: 'right' });
  if (tail.length) {
    pushBlank();
    for (const item of tail) pushLogicalBlock(item.text, { align: item.align, emptyIsBlank: true });
  }

  const availableLines = slots.length;
  const lines = rows.map((row, index) => {
    const slot = slotFor(index);
    const overflow = index >= availableLines;
    const width = row.text ? measure(row.text) : 0;
    const startX = slot.startX;
    const endX = slot.endX;
    const left = startX + row.indent;
    const right = endX - RIGHT_PADDING;
    let x = left;
    if (row.align === 'center') x = left + (right - left - width) / 2;
    else if (row.align === 'right') x = right - width;
    return {
      text: row.text, align: row.align, indent: row.indent, blank: Boolean(row.blank), overflow, row: index,
      x, width, availableWidth: Math.max(1, right - left), startX, endX,
      sourceBaseline: overflow ? null : slot.baseline,
      baseline: overflow ? null : slot.baseline + baselineAdjust,
    };
  });
  const overflowRows = lines.filter((line) => line.overflow);
  const result = {
    lines,
    usedLines: lines.length,
    placedLines: Math.min(lines.length, availableLines),
    availableLines,
    overflowLines: overflowRows.length,
    overflowText: overflowRows.map((line) => line.text).filter(Boolean).join(' '),
    fits: overflowRows.length === 0,
    template: { key: template.key, label: template.label, lineCount: availableLines, page: template.page, backgroundUrl: template.background.url },
    font: { id: font.id, label: font.label, family: font.family, asciiPdfName: font.asciiPdfName, recommended: font.recommended },
    fontSize,
    slant: config.slant,
    baselineAdjust,
    style,
    kind,
    color: config.color,
    availableWidth: {
      firstLine: slots[0].endX - slots[0].startX - RIGHT_PADDING,
      other: slots[Math.min(1, slots.length - 1)].endX - slots[Math.min(1, slots.length - 1)].startX - RIGHT_PADDING,
    },
  };
  Object.defineProperty(result, 'config', { value: config, enumerable: false });
  return result;
}

function num(value, digits = 3) {
  const rounded = Number(value).toFixed(digits);
  return rounded.replace(/\.?0+$/, '') || '0';
}

function pdfDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}'${pad(absolute % 60)}'`;
}

function pdfTextString(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return `(${text.replace(/([\\()])/g, '\\$1')})`;
  return `<${Buffer.from(`\uFEFF${text}`, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

function buildWidths(font) {
  const widths = [];
  for (let code = 32; code <= 255; code += 1) {
    const unicode = WINANSI_TO_UNICODE[code];
    widths.push(unicode < 0 ? Math.round(font.spaceWidth) : Math.round(font.advanceWidth(unicode)));
  }
  return widths;
}

function contentStream(result, template) {
  const parts = [`q ${num(template.page.width, 2)} 0 0 ${num(template.page.height, 2)} 0 0 cm /Im1 Do Q`];
  const [r, g, b] = result.color;
  const tan = Math.tan((result.slant * Math.PI) / 180);
  parts.push('q', `${num(r)} ${num(g)} ${num(b)} rg`, 'BT', `/F1 ${num(result.fontSize)} Tf`);
  for (const line of result.lines) {
    if (line.overflow || !line.text) continue;
    parts.push(`1 0 ${num(tan, 5)} 1 ${num(line.x)} ${num(template.page.height - line.baseline)} Tm`);
    parts.push(`<${toWinAnsiBytes(line.text).toString('hex').toUpperCase()}> Tj`);
  }
  parts.push('ET', 'Q');
  return Buffer.from(`${parts.join('\n')}\n`, 'latin1');
}

export function renderPdf(essay = {}, options = {}) {
  const result = options.layout?.lines ? options.layout : layout(essay, options);
  const config = result.config ?? normalizeOptions(options);
  const { template, font } = config;
  const chunks = [];
  const offsets = [];
  let position = 0;
  const push = (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
    chunks.push(buffer);
    position += buffer.length;
  };
  const addObject = (id, body) => {
    offsets[id] = position;
    push(`${id} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  const addStreamObject = (id, dictionary, stream) => {
    offsets[id] = position;
    push(`${id} 0 obj\n<<${dictionary ? ` ${dictionary}` : ''} /Length ${stream.length} >>\nstream\n`);
    push(stream);
    push('\nendstream\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const content = contentStream(result, template);
  const fontProgram = font.buffer;
  const compressedFont = options.compressFont === false ? null : zlib.deflateSync(fontProgram, { level: 9 });
  const fontStream = compressedFont && compressedFont.length < fontProgram.length ? compressedFont : fontProgram;
  const fontFilter = fontStream === fontProgram ? '' : ' /Filter /FlateDecode';
  const widths = buildWidths(font);
  const [bx0, by0, bx1, by1] = font.metrics1000.bbox;
  const baseName = font.asciiPdfName;
  const mediaBox = `[0 0 ${num(template.page.width, 2)} ${num(template.page.height, 2)}]`;

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObject(3, `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 8 0 R >> /ProcSet [/PDF /Text /ImageC] >> /Contents 4 0 R >>`);
  addStreamObject(4, '', content);
  addObject(5, `<< /Type /Font /Subtype /TrueType /BaseFont /${baseName} /FirstChar 32 /LastChar 255 /Widths [${widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>`);
  const flags = 32 | 8 | (font.italicAngle ? 64 : 0);
  addObject(6, `<< /Type /FontDescriptor /FontName /${baseName} /Flags ${flags} /FontBBox [${bx0} ${by0} ${bx1} ${by1}] /ItalicAngle ${num(font.italicAngle, 2)} /Ascent ${font.metrics1000.ascender} /Descent ${font.metrics1000.descender} /CapHeight ${font.metrics1000.capHeight} /StemV 80 /FontFile2 7 0 R >>`);
  addStreamObject(7, `/Length1 ${fontProgram.length}${fontFilter}`, fontStream);
  addStreamObject(8, `/Type /XObject /Subtype /Image /Width ${template.background.width} /Height ${template.background.height} /ColorSpace /${template.background.colorSpace} /BitsPerComponent ${template.background.bitsPerComponent} /Filter /FlateDecode`, template.background.rgbDeflateBuffer);
  addObject(9, `<< /Title ${pdfTextString(`${template.label} · ${result.font.label}`)} /Author ${pdfTextString('english-essay-assistant')} /Subject ${pdfTextString('考研英语写作答题卡')} /Creator ${pdfTextString('english-essay-assistant')} /Producer ${pdfTextString('english-essay-assistant answer-sheet renderer')} /CreationDate (${pdfDate(options.date instanceof Date ? options.date : new Date())}) >>`);

  const xrefStart = position;
  const total = 10;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function rgbCss([r, g, b]) {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

export function renderSvg(essay = {}, options = {}) {
  const result = options.layout?.lines ? options.layout : layout(essay, options);
  const config = result.config ?? normalizeOptions(options);
  const { template, font } = config;
  const { width, height } = template.page;
  const tan = Math.tan((result.slant * Math.PI) / 180);
  const cssFamily = font.asciiPdfName;
  const fontDataUri = `data:font/ttf;base64,${font.buffer.toString('base64')}`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width, 2)}" height="${num(height, 2)}" viewBox="0 0 ${num(width, 2)} ${num(height, 2)}">`,
    `<defs><style>@font-face{font-family:'${cssFamily}';src:url('${fontDataUri}') format('truetype');font-style:normal;font-weight:normal;}</style></defs>`,
    `<image x="0" y="0" width="595.28" height="841.89" href="${template.background.pngDataUri}"/>`,
    `<g font-family="${escapeXml(cssFamily)}" font-size="${num(result.fontSize)}" fill="${rgbCss(result.color)}" xml:space="preserve">`,
  ];
  for (const line of result.lines) {
    if (line.overflow || !line.text) continue;
    const transform = tan ? ` transform="matrix(1 0 ${num(-tan, 5)} 1 ${num(tan * line.baseline)} 0)"` : '';
    parts.push(`<text x="${num(line.x)}" y="${num(line.baseline)}"${transform}>${escapeXml(line.text)}</text>`);
  }
  parts.push('</g>', '</svg>');
  return {
    svg: parts.join('\n'), width, height, lines: result.lines, usedLines: result.usedLines,
    placedLines: result.placedLines, availableLines: result.availableLines, overflowLines: result.overflowLines,
    overflowText: result.overflowText, fits: result.fits, layout: result,
  };
}

export function tips() {
  return {
    recommended: 'block',
    styles: [
      { key: 'block', name: '齐头式', recommended: true, points: ['各段首行不缩进，全部左侧齐头', '段与段之间空一行', '落款左侧齐头'], why: '讲义原话：同样的篇幅，齐头式显得写得更满' },
      { key: 'indent', name: '缩进式', recommended: false, points: ['每段首行缩进约四个字母宽度', '段间不空行', '落款偏右下书写'], why: '传统书信格式，同样可得分' },
    ],
    good: ['称呼顶格并加逗号', '段落分明、行距均匀', '单词间距清楚', '落款两行完整', '字写在横线之上'],
    bad: ['字迹过密', '随意换行', '称呼缩进不统一', '涂改严重'],
    pen: '讲义建议使用 0.7 的笔',
    noticeFormat: ['标题居中书写，如 Notice', '正文分段', '落款写机构名，靠右', '日期可另起一行靠右'],
    answerSheet: [
      '使用 400 DPI 完整原版答题卡背景，不再由程序重画横线、标题、题号或边框',
      '可切换黑/蓝墨水模拟考场，也可生成红字字帖进行临摹练习',
      '英语一写作区为 24 行，英语二写作区为 23 行（含题号所在首行）',
      '正文逐行对齐原素材的真实书写基线，首行自然避开印刷题号',
    ],
    overflow: ['溢出提示：超出模板行数的内容不会被打印，需回去压缩句子', '压缩优先删修饰语和重复论据，不要删首尾句和过渡词', '齐头式段间空行会额外占用槽位，行数紧张时可改缩进式'],
    colors: Object.keys(COLORS),
    fonts: getFonts(),
    defaultFontId: DEFAULT_FONT_ID,
  };
}

export default {
  COLORS, DEFAULT_FONT_ID, SHEETS_DIR, resolveColor, getTemplates, getFonts, loadTemplate,
  clearTemplateCache, sanitizeText, layout, renderPdf, renderSvg, tips,
};
