/**
 * 零依赖中文打印 PDF 生成器。
 *
 * 系统中文字体动辄 10MB 以上，整份内嵌会让 PDF 大到无法使用，
 * 因此这里做真正的 TrueType 子集化：只保留用到的字形，重建
 * head/hhea/maxp/hmtx/loca/glyf 表，再以 CIDFontType2 + Identity-H 内嵌。
 * CID 直接等于子集内的新字形号，因此 CIDToGIDMap 用 Identity 即可；
 * 另外写出 ToUnicode CMap，保证生成的 PDF 里中英文都能选取与搜索。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fontDirectories, cjkFontCandidates, latinFontCandidates, CJK_FONT_HINTS } from './platform.mjs';

/* ------------------------------ 字体文件定位 ------------------------------ */

/**
 * 字体查找按平台进行：Windows 用楷体/黑体/雅黑，macOS 用宋体/苹方等 TTC，
 * Linux 用 Noto CJK / 文泉驿。候选文件名全部落空时，再按关键字兜底扫描一次。
 */

/** OTF 使用 CFF 轮廓，没有 glyf/loca 表，无法走本文件的 TrueType 子集化路径。 */
function isSubsettableFont(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.otf')) return false;
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    try {
      if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    } finally {
      fs.closeSync(fd);
    }
    // 'OTTO' 同样是 CFF 轮廓，直接跳过而不是等到解析阶段抛错。
    return head.toString('latin1') !== 'OTTO';
  } catch {
    return false;
  }
}

function findNamedFont(candidates, directories) {
  for (const name of candidates) {
    for (const directory of directories) {
      const file = path.join(directory, name);
      if (fs.existsSync(file) && isSubsettableFont(file)) return file;
    }
  }
  return null;
}

/** 具名候选都不在时，扫描字体目录寻找文件名含中文字体关键字的可用字体。 */
function scanForCjkFont(directories, depth = 2) {
  const walk = (directory, level) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    const files = [];
    const subdirectories = [];
    for (const entry of entries) {
      if (entry.isDirectory()) subdirectories.push(path.join(directory, entry.name));
      else files.push(path.join(directory, entry.name));
    }
    for (const file of files) {
      const base = path.basename(file).toLowerCase().replace(/[\s_-]/g, '');
      if (!/\.(ttf|ttc)$/.test(base)) continue;
      if (!CJK_FONT_HINTS.some((hint) => base.includes(hint))) continue;
      if (isSubsettableFont(file)) return file;
    }
    if (level <= 0) return null;
    for (const sub of subdirectories) {
      const found = walk(sub, level - 1);
      if (found) return found;
    }
    return null;
  };
  for (const directory of directories) {
    const found = walk(directory, depth);
    if (found) return found;
  }
  return null;
}

export function findCjkFontFile(platform) {
  const directories = fontDirectories(platform);
  return findNamedFont(cjkFontCandidates(platform), directories) ?? scanForCjkFont(directories);
}

// 中文字体（尤其楷体）的拉丁字形是半角等宽的，直接用来排英文句子会变成打字机效果。
// 卡片和精讲的主体正是英文功能句，因此拉丁部分单独使用衬线西文字体。
export function findLatinFontFile(platform) {
  return findNamedFont(latinFontCandidates(platform), fontDirectories(platform));
}

/** 码点是否交给西文字体渲染。 */
function isLatinCodePoint(codePoint) {
  return codePoint < 0x2e80;
}

/* ------------------------------ TrueType 解析 ----------------------------- */

function readTables(buffer) {
  let base = 0;
  if (buffer.toString('latin1', 0, 4) === 'ttcf') base = buffer.readUInt32BE(12);
  const numTables = buffer.readUInt16BE(base + 4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = base + 12 + index * 16;
    tables.set(buffer.toString('latin1', record, record + 4), {
      offset: buffer.readUInt32BE(record + 8),
      length: buffer.readUInt32BE(record + 12),
    });
  }
  return tables;
}

function parseCmapFormat4(buffer, offset, map) {
  const segCountX2 = buffer.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;
  const endBase = offset + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;
  for (let seg = 0; seg < segCount; seg += 1) {
    const end = buffer.readUInt16BE(endBase + seg * 2);
    const start = buffer.readUInt16BE(startBase + seg * 2);
    if (start > end) continue;
    const delta = buffer.readInt16BE(deltaBase + seg * 2);
    const rangeOffset = buffer.readUInt16BE(rangeBase + seg * 2);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph;
      if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
      else {
        const at = rangeBase + seg * 2 + rangeOffset + (code - start) * 2;
        if (at + 1 >= buffer.length) continue;
        glyph = buffer.readUInt16BE(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph) map.set(code, glyph);
    }
  }
}

function parseCmapFormat12(buffer, offset, map) {
  const groups = buffer.readUInt32BE(offset + 12);
  for (let index = 0; index < groups; index += 1) {
    const at = offset + 16 + index * 12;
    const start = buffer.readUInt32BE(at);
    const end = buffer.readUInt32BE(at + 4);
    const startGlyph = buffer.readUInt32BE(at + 8);
    for (let code = start; code <= end; code += 1) map.set(code, startGlyph + (code - start));
  }
}

function parseCmap(buffer, tables) {
  const entry = tables.get('cmap');
  const map = new Map();
  if (!entry) return map;
  const count = buffer.readUInt16BE(entry.offset + 2);
  const subtables = [];
  for (let index = 0; index < count; index += 1) {
    const record = entry.offset + 4 + index * 8;
    subtables.push({
      platformID: buffer.readUInt16BE(record),
      encodingID: buffer.readUInt16BE(record + 2),
      offset: entry.offset + buffer.readUInt32BE(record + 4),
    });
  }
  // 优先 UCS-4（3/10），再 BMP（3/1）
  const ordered = subtables.sort((a, b) => {
    const score = (item) => (item.platformID === 3 && item.encodingID === 10 ? 2 : item.platformID === 3 && item.encodingID === 1 ? 1 : 0);
    return score(b) - score(a);
  });
  for (const subtable of ordered) {
    const format = buffer.readUInt16BE(subtable.offset);
    if (format === 4) parseCmapFormat4(buffer, subtable.offset, map);
    else if (format === 12) parseCmapFormat12(buffer, subtable.offset, map);
    if (map.size) break;
  }
  return map;
}

function loadSourceFont(file) {
  const buffer = fs.readFileSync(file);
  const tables = readTables(buffer);
  for (const name of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf']) {
    if (!tables.has(name)) throw new Error(`字体 ${path.basename(file)} 缺少 ${name} 表，无法子集化`);
  }
  const head = tables.get('head');
  const unitsPerEm = buffer.readUInt16BE(head.offset + 18) || 1000;
  const indexToLocFormat = buffer.readInt16BE(head.offset + 50);
  const hhea = tables.get('hhea');
  const numberOfHMetrics = buffer.readUInt16BE(hhea.offset + 34);
  const numGlyphs = buffer.readUInt16BE(tables.get('maxp').offset + 4);
  const locaEntry = tables.get('loca');
  const loca = new Uint32Array(numGlyphs + 1);
  for (let index = 0; index <= numGlyphs; index += 1) {
    loca[index] = indexToLocFormat === 0
      ? buffer.readUInt16BE(locaEntry.offset + index * 2) * 2
      : buffer.readUInt32BE(locaEntry.offset + index * 4);
  }
  const hmtxEntry = tables.get('hmtx');
  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let index = 0; index < numGlyphs; index += 1) {
    if (index < numberOfHMetrics) {
      const at = hmtxEntry.offset + index * 4;
      last = at + 1 < buffer.length ? buffer.readUInt16BE(at) : last;
    }
    advances[index] = last;
  }
  const scale = 1000 / unitsPerEm;
  return {
    file,
    buffer,
    tables,
    unitsPerEm,
    numGlyphs,
    loca,
    advances,
    scale,
    glyfOffset: tables.get('glyf').offset,
    cmap: parseCmap(buffer, tables),
    ascender: Math.round(buffer.readInt16BE(hhea.offset + 4) * scale),
    descender: Math.round(buffer.readInt16BE(hhea.offset + 6) * scale),
    bbox: [
      Math.round(buffer.readInt16BE(head.offset + 36) * scale),
      Math.round(buffer.readInt16BE(head.offset + 38) * scale),
      Math.round(buffer.readInt16BE(head.offset + 40) * scale),
      Math.round(buffer.readInt16BE(head.offset + 42) * scale),
    ],
  };
}

/* -------------------------------- 字形子集化 ------------------------------- */

/** 复合字形依赖的组件也必须一起保留，否则字会缺笔画。 */
function collectComposites(font, glyphId, collected) {
  const start = font.loca[glyphId];
  const end = font.loca[glyphId + 1];
  if (end <= start) return;
  const at = font.glyfOffset + start;
  if (font.buffer.readInt16BE(at) >= 0) return;
  let cursor = at + 10;
  for (;;) {
    const flags = font.buffer.readUInt16BE(cursor);
    const component = font.buffer.readUInt16BE(cursor + 2);
    if (!collected.has(component)) {
      collected.add(component);
      collectComposites(font, component, collected);
    }
    cursor += 4;
    cursor += flags & 1 ? 4 : 2;
    if (flags & 8) cursor += 2;
    else if (flags & 0x40) cursor += 4;
    else if (flags & 0x80) cursor += 8;
    if (!(flags & 0x20)) break;
  }
}

function tableChecksum(buffer) {
  let sum = 0;
  const padded = buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]) : buffer;
  for (let index = 0; index < padded.length; index += 4) sum = (sum + padded.readUInt32BE(index)) >>> 0;
  return sum;
}

/**
 * 构建子集字体。返回新字形号映射与字体程序。
 * CID 直接使用新字形号，因此 PDF 侧 CIDToGIDMap 用 Identity。
 */
function buildSubset(font, codePoints) {
  const glyphIds = new Set([0]);
  const codeToGlyph = new Map();
  for (const codePoint of codePoints) {
    const glyphId = font.cmap.get(codePoint) ?? 0;
    if (!glyphId || glyphId >= font.numGlyphs) continue;
    codeToGlyph.set(codePoint, glyphId);
    glyphIds.add(glyphId);
  }
  for (const glyphId of [...glyphIds]) collectComposites(font, glyphId, glyphIds);

  const ordered = [...glyphIds].sort((a, b) => a - b);
  const newIdByOld = new Map(ordered.map((oldId, index) => [oldId, index]));

  const glyphChunks = [];
  const locaValues = [0];
  let position = 0;
  for (const oldId of ordered) {
    const start = font.loca[oldId];
    const end = font.loca[oldId + 1];
    let data = end > start ? Buffer.from(font.buffer.subarray(font.glyfOffset + start, font.glyfOffset + end)) : Buffer.alloc(0);
    if (data.length && data.readInt16BE(0) < 0) {
      // 复合字形内部记录的是旧字形号，必须改写为子集内的新号。
      data = Buffer.from(data);
      let cursor = 10;
      for (;;) {
        const flags = data.readUInt16BE(cursor);
        const component = data.readUInt16BE(cursor + 2);
        data.writeUInt16BE(newIdByOld.get(component) ?? 0, cursor + 2);
        cursor += 4;
        cursor += flags & 1 ? 4 : 2;
        if (flags & 8) cursor += 2;
        else if (flags & 0x40) cursor += 4;
        else if (flags & 0x80) cursor += 8;
        if (!(flags & 0x20)) break;
      }
    }
    if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
    glyphChunks.push(data);
    position += data.length;
    locaValues.push(position);
  }

  const glyf = Buffer.concat(glyphChunks);
  const loca = Buffer.alloc(locaValues.length * 4);
  locaValues.forEach((value, index) => loca.writeUInt32BE(value, index * 4));

  const sourceHead = font.tables.get('head');
  const head = Buffer.from(font.buffer.subarray(sourceHead.offset, sourceHead.offset + 54));
  head.writeUInt32BE(0, 8); // checkSumAdjustment 置零，阅读器普遍接受
  head.writeInt16BE(1, 50); // 统一使用 long loca

  const sourceHhea = font.tables.get('hhea');
  const hhea = Buffer.from(font.buffer.subarray(sourceHhea.offset, sourceHhea.offset + 36));
  hhea.writeUInt16BE(ordered.length, 34);

  const sourceMaxp = font.tables.get('maxp');
  const maxp = Buffer.from(font.buffer.subarray(sourceMaxp.offset, sourceMaxp.offset + Math.min(32, sourceMaxp.length)));
  maxp.writeUInt16BE(ordered.length, 4);

  const hmtx = Buffer.alloc(ordered.length * 4);
  ordered.forEach((oldId, index) => {
    hmtx.writeUInt16BE(font.advances[oldId] ?? 0, index * 4);
    hmtx.writeInt16BE(0, index * 4 + 2);
  });

  const parts = [
    ['head', head], ['hhea', hhea], ['maxp', maxp],
    ['hmtx', hmtx], ['loca', loca], ['glyf', glyf],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const numTables = parts.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  const directory = Buffer.alloc(12 + numTables * 16);
  directory.writeUInt32BE(0x00010000, 0);
  directory.writeUInt16BE(numTables, 4);
  directory.writeUInt16BE(searchRange, 6);
  directory.writeUInt16BE(entrySelector, 8);
  directory.writeUInt16BE(numTables * 16 - searchRange, 10);

  let offset = directory.length;
  const bodies = [];
  parts.forEach(([tag, data], index) => {
    const record = 12 + index * 16;
    directory.write(tag, record, 4, 'latin1');
    directory.writeUInt32BE(tableChecksum(data), record + 4);
    directory.writeUInt32BE(offset, record + 8);
    directory.writeUInt32BE(data.length, record + 12);
    const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
    bodies.push(padded);
    offset += padded.length;
  });

  return {
    program: Buffer.concat([directory, ...bodies]),
    newIdByOld,
    codeToNewId: new Map([...codeToGlyph].map(([code, oldId]) => [code, newIdByOld.get(oldId) ?? 0])),
    glyphOrder: ordered,
    widths: ordered.map((oldId) => Math.round((font.advances[oldId] ?? 0) * font.scale)),
  };
}

/* --------------------------------- 排版模型 -------------------------------- */

export const PAGE = { width: 595.28, height: 841.89, margin: 44 };
const SIZES = { title: 17, heading: 12.5, body: 10, small: 8.6 };
const LINE_RATIO = 1.62;

const text = (value) => value == null ? '' : String(value).trim();
const array = (value) => Array.isArray(value) ? value : [];

/** 按码点选择字体后测量宽度；拉丁走西文字体，其余走中文字体。 */
class TextMeasurer {
  constructor(cjkFont, latinFont) {
    this.cjk = cjkFont;
    this.latin = latinFont;
    this.cache = new Map();
  }

  fontFor(codePoint) {
    return this.latin && isLatinCodePoint(codePoint) && this.latin.cmap.has(codePoint) ? this.latin : this.cjk;
  }

  advance(codePoint) {
    if (this.cache.has(codePoint)) return this.cache.get(codePoint);
    const font = this.fontFor(codePoint);
    const glyphId = font.cmap.get(codePoint) ?? 0;
    const width = (font.advances[glyphId] ?? font.unitsPerEm / 2) * font.scale;
    this.cache.set(codePoint, width);
    return width;
  }

  width(value, size) {
    let total = 0;
    for (const character of String(value)) total += this.advance(character.codePointAt(0));
    return (total * size) / 1000;
  }
}

/** 中英文混排断行：CJK 逐字可断，拉丁词整体保留。 */
function tokenize(value) {
  const tokens = [];
  let latin = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    const isLatin = code < 0x2e80 && !/\s/.test(character);
    if (isLatin) { latin += character; continue; }
    if (latin) { tokens.push({ text: latin, breakable: false }); latin = ''; }
    if (/\s/.test(character)) tokens.push({ text: ' ', breakable: true, space: true });
    else tokens.push({ text: character, breakable: true });
  }
  if (latin) tokens.push({ text: latin, breakable: false });
  return tokens;
}

function wrapText(value, maxWidth, size, measurer) {
  const lines = [];
  let current = '';
  let currentWidth = 0;
  for (const token of tokenize(value)) {
    const tokenWidth = measurer.width(token.text, size);
    if (token.space && !current) continue;
    if (currentWidth + tokenWidth > maxWidth && current) {
      lines.push(current);
      if (token.space) { current = ''; currentWidth = 0; continue; }
      current = token.text;
      currentWidth = tokenWidth;
      continue;
    }
    current += token.text;
    currentWidth += tokenWidth;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/* --------------------------------- PDF 写出 -------------------------------- */

const num = (value, digits = 2) => {
  const rounded = Number(value).toFixed(digits);
  return rounded.replace(/\.?0+$/, '') || '0';
};

function pdfTextString(value) {
  // UTF-16BE + BOM，保证文档信息里的中文正常显示
  const buffer = Buffer.from(`\uFEFF${value}`, 'utf16le').swap16();
  return `<${buffer.toString('hex').toUpperCase()}>`;
}

function toUnicodeCMap(codeToNewId) {
  const entries = [...codeToNewId].filter(([, glyphId]) => glyphId > 0);
  const lines = entries.map(([codePoint, glyphId]) => {
    const target = codePoint > 0xffff
      ? (() => {
        const value = codePoint - 0x10000;
        return `${(0xd800 + (value >> 10)).toString(16).padStart(4, '0')}${(0xdc00 + (value & 0x3ff)).toString(16).padStart(4, '0')}`;
      })()
      : codePoint.toString(16).padStart(4, '0');
    return `<${glyphId.toString(16).padStart(4, '0')}> <${target}>`;
  });
  const chunks = [];
  for (let index = 0; index < lines.length; index += 100) {
    const slice = lines.slice(index, index + 100);
    chunks.push(`${slice.length} beginbfchar\n${slice.join('\n')}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function widthArray(glyphOrder, widths) {
  const parts = [];
  let index = 0;
  while (index < glyphOrder.length) {
    let end = index;
    while (end + 1 < glyphOrder.length && widths[end + 1] === widths[index]) end += 1;
    if (end > index + 2) {
      parts.push(`${index} ${end} ${widths[index]}`);
      index = end + 1;
      continue;
    }
    const run = [];
    let cursor = index;
    while (cursor < glyphOrder.length && run.length < 12) { run.push(widths[cursor]); cursor += 1; }
    parts.push(`${index} [${run.join(' ')}]`);
    index = cursor;
  }
  return parts.join(' ');
}

/**
 * 把「文档块」渲染成 PDF。
 * blocks 是与字体、排版解耦的描述结构，便于卡片与精讲复用同一排版器。
 */
export function renderDocument({ title = '考研英语作文助手', subtitle = '', blocks = [], fontFile, latinFontFile } = {}) {
  // fontFile === undefined 表示自动查找；显式传值（含空串）一律按指定处理。
  // 显式传入不可子集化的字体（如 OTF/CFF）时归为「无可用中文字体」，而不是抛底层解析错。
  const requested = fontFile === undefined ? findCjkFontFile() : fontFile;
  const file = requested && isSubsettableFont(requested) ? requested : null;
  if (!file) {
    throw Object.assign(new Error(
      '未找到可用的系统中文字体，无法生成中文 PDF。'
      + 'Windows 需要 simkai/simhei/msyh/simsun；'
      + 'macOS 需要 Songti/Hiragino Sans GB/STHeiti 等；'
      + 'Linux 可安装 Noto CJK 或文泉驿字体（注意 .otf 字体无法内嵌，请使用 .ttf/.ttc）。',
    ), { status: 503, code: 'cjk_font_missing' });
  }
  const font = loadSourceFont(file);
  const latinFile = latinFontFile ?? findLatinFontFile();
  // 西文字体缺失不影响可用性，只会退回中文字体的半角拉丁字形。
  let latinFont = null;
  if (latinFile) { try { latinFont = loadSourceFont(latinFile); } catch { latinFont = null; } }
  const measurer = new TextMeasurer(font, latinFont);
  const contentWidth = PAGE.width - PAGE.margin * 2;

  // 第一遍：把块展开成带坐标的行，同时收集用到的码点。
  const pages = [];
  let lines = [];
  let cursorY = PAGE.margin + SIZES.title + 12;
  const used = new Set([32]);
  const usedLatin = new Set([32]);
  const noteCharacter = (codePoint) => {
    if (measurer.fontFor(codePoint) === latinFont && latinFont) usedLatin.add(codePoint);
    else used.add(codePoint);
  };
  const pushPage = () => { if (lines.length) pages.push(lines); lines = []; cursorY = PAGE.margin + SIZES.title + 12; };
  const ensureRoom = (height) => {
    if (cursorY + height > PAGE.height - PAGE.margin - 18) pushPage();
  };
  const addLine = (value, { size = SIZES.body, indent = 0, gapBefore = 0, gapAfter = 0, box = null } = {}) => {
    cursorY += gapBefore;
    const wrapped = wrapText(value, contentWidth - indent, size, measurer);
    for (const line of wrapped) {
      ensureRoom(size * LINE_RATIO);
      for (const character of line) noteCharacter(character.codePointAt(0));
      lines.push({ text: line, x: PAGE.margin + indent, y: cursorY + size, size, box });
      cursorY += size * LINE_RATIO;
    }
    cursorY += gapAfter;
  };

  for (const character of `${title}${subtitle}`) noteCharacter(character.codePointAt(0));

  for (const block of array(blocks)) {
    if (block.type === 'pagebreak') { pushPage(); continue; }
    if (block.type === 'heading') { addLine(text(block.text), { size: SIZES.heading, gapBefore: 8, gapAfter: 2 }); continue; }
    if (block.type === 'small') { addLine(text(block.text), { size: SIZES.small, indent: block.indent ?? 0, gapAfter: 1 }); continue; }
    if (block.type === 'spacer') { cursorY += Number(block.height) || 6; continue; }
    if (block.type === 'card') {
      const cardLines = [];
      const push = (value, size, indent) => { if (text(value)) cardLines.push({ value: text(value), size, indent }); };
      push(block.header, SIZES.small, 0);
      push(block.en, SIZES.body, 6);
      push(block.zh, SIZES.small, 6);
      for (const note of array(block.notes)) push(note, SIZES.small, 6);
      let height = 8;
      for (const item of cardLines) height += wrapText(item.value, contentWidth - 16 - item.indent, item.size, measurer).length * item.size * LINE_RATIO;
      ensureRoom(height + 10);
      const top = cursorY;
      cursorY += 5;
      for (const item of cardLines) addLine(item.value, { size: item.size, indent: item.indent + 8 });
      cursorY += 5;
      lines.push({ box: { x: PAGE.margin, y: top, width: contentWidth, height: cursorY - top } });
      cursorY += 7;
      continue;
    }
    addLine(text(block.text), { indent: block.indent ?? 0, gapBefore: block.gapBefore ?? 0, gapAfter: block.gapAfter ?? 2 });
  }
  pushPage();
  if (!pages.length) pages.push([]);

  // 页脚在渲染阶段才拼出，必须在子集化之前登记，否则「第 / 页」会缺字形。
  const footerFor = (pageIndex) => `第 ${pageIndex + 1} / ${pages.length} 页`;
  for (let index = 0; index < pages.length; index += 1) {
    for (const character of footerFor(index)) noteCharacter(character.codePointAt(0));
  }

  const subset = buildSubset(font, used);
  const latinSubset = latinFont ? buildSubset(latinFont, usedLatin) : null;

  /**
   * 一行文本按字体拆成若干 run。
   * 同时保留每个 run 的原文，用于按真实宽度推进 x 坐标。
   */
  const runsOf = (value) => {
    const runs = [];
    for (const character of String(value)) {
      const codePoint = character.codePointAt(0);
      const useLatin = Boolean(latinSubset && latinSubset.codeToNewId.has(codePoint));
      const resource = useLatin ? 'F2' : 'F1';
      const glyphId = useLatin
        ? latinSubset.codeToNewId.get(codePoint) ?? 0
        : subset.codeToNewId.get(codePoint) ?? 0;
      const hex = glyphId.toString(16).padStart(4, '0');
      const last = runs.at(-1);
      if (last && last.resource === resource) {
        last.hex += hex;
        last.text += character;
      } else {
        runs.push({ resource, hex, text: character });
      }
    }
    return runs;
  };

  const showText = (parts, value, size, x, baseline) => {
    let cursorX = x;
    for (const run of runsOf(value)) {
      parts.push(`/${run.resource} ${num(size)} Tf`, `1 0 0 1 ${num(cursorX, 3)} ${num(baseline, 3)} Tm`, `<${run.hex}> Tj`);
      cursorX += measurer.width(run.text, size);
    }
  };

  const contents = pages.map((pageLines, pageIndex) => {
    const parts = ['0.15 0.15 0.15 rg', '0.72 0.72 0.72 RG', '0.6 w'];
    for (const line of pageLines) {
      if (!line.box) continue;
      parts.push(`${num(line.box.x)} ${num(PAGE.height - line.box.y - line.box.height)} ${num(line.box.width)} ${num(line.box.height)} re S`);
    }
    parts.push('BT');
    showText(parts, title, SIZES.title, PAGE.margin, PAGE.height - PAGE.margin - SIZES.title);
    if (subtitle) showText(parts, subtitle, SIZES.small, PAGE.margin, PAGE.height - PAGE.margin - SIZES.title - 13);
    for (const line of pageLines) {
      if (!line.text) continue;
      showText(parts, line.text, line.size, line.x, PAGE.height - line.y);
    }
    showText(parts, footerFor(pageIndex), SIZES.small, PAGE.width - PAGE.margin - 60, PAGE.margin - 12);
    parts.push('ET');
    return zlib.deflateSync(Buffer.from(parts.join('\n'), 'latin1'), { level: 9 });
  });

  /* ------------------------------ 组装 PDF ------------------------------ */

  const chunks = [];
  const offsets = [];
  let position = 0;
  const push = (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
    chunks.push(buffer);
    position += buffer.length;
  };
  const addObject = (id, body) => { offsets[id] = position; push(`${id} 0 obj\n`); push(body); push('\nendobj\n'); };
  const addStream = (id, dictionary, stream) => {
    offsets[id] = position;
    push(`${id} 0 obj\n<< ${dictionary} /Length ${stream.length} >>\nstream\n`);
    push(stream);
    push('\nendstream\nendobj\n');
  };

  const nameOf = (fontPath) => `EEA-${path.basename(fontPath, path.extname(fontPath))}`.replace(/[^A-Za-z0-9-]/g, '-');
  const baseName = nameOf(file);
  const fontProgram = zlib.deflateSync(subset.program, { level: 9 });
  const cmapStream = zlib.deflateSync(Buffer.from(toUnicodeCMap(subset.codeToNewId), 'latin1'), { level: 9 });

  // 1-8 固定给目录、页树、中文字体与文档信息；西文字体占 20-23；页面从 30 开始。
  const latinIds = { type0: 20, cid: 21, descriptor: 22, file: 23, cmap: 24 };
  const pageIds = pages.map((_, index) => 30 + index * 2);
  const contentIds = pages.map((_, index) => 31 + index * 2);
  const fontResources = latinSubset
    ? `/F1 3 0 R /F2 ${latinIds.type0} 0 R`
    : '/F1 3 0 R';

  push('%PDF-1.5\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  addObject(3, `<< /Type /Font /Subtype /Type0 /BaseFont /${baseName} /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 7 0 R >>`);
  addObject(4, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 /W [${widthArray(subset.glyphOrder, subset.widths)}] /CIDToGIDMap /Identity >>`);
  addObject(5, `<< /Type /FontDescriptor /FontName /${baseName} /Flags 4 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${font.ascender} /Descent ${font.descender} /CapHeight ${Math.round(font.ascender * 0.7)} /StemV 80 /FontFile2 6 0 R >>`);
  addStream(6, `/Length1 ${subset.program.length} /Filter /FlateDecode`, fontProgram);
  addStream(7, '/Filter /FlateDecode', cmapStream);
  addObject(8, `<< /Title ${pdfTextString(title)} /Author ${pdfTextString('考研英语作文助手')} /Subject ${pdfTextString(subtitle || title)} /Creator ${pdfTextString('english-essay-assistant')} /Producer ${pdfTextString('english-essay-assistant print renderer')} /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

  if (latinSubset) {
    const latinName = nameOf(latinFile);
    addObject(latinIds.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${latinName} /Encoding /Identity-H /DescendantFonts [${latinIds.cid} 0 R] /ToUnicode ${latinIds.cmap} 0 R >>`);
    addObject(latinIds.cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${latinName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${latinIds.descriptor} 0 R /DW 1000 /W [${widthArray(latinSubset.glyphOrder, latinSubset.widths)}] /CIDToGIDMap /Identity >>`);
    addObject(latinIds.descriptor, `<< /Type /FontDescriptor /FontName /${latinName} /Flags 34 /FontBBox [${latinFont.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${latinFont.ascender} /Descent ${latinFont.descender} /CapHeight ${Math.round(latinFont.ascender * 0.7)} /StemV 80 /FontFile2 ${latinIds.file} 0 R >>`);
    addStream(latinIds.file, `/Length1 ${latinSubset.program.length} /Filter /FlateDecode`, zlib.deflateSync(latinSubset.program, { level: 9 }));
    addStream(latinIds.cmap, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from(toUnicodeCMap(latinSubset.codeToNewId), 'latin1'), { level: 9 }));
  }

  pages.forEach((_, index) => {
    addObject(pageIds[index], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE.width)} ${num(PAGE.height)}] /Resources << /Font << ${fontResources} >> /ProcSet [/PDF /Text] >> /Contents ${contentIds[index]} 0 R >>`);
    addStream(contentIds[index], '/Filter /FlateDecode', contents[index]);
  });

  const maxId = Math.max(8, ...Object.values(latinSubset ? latinIds : {}), ...pageIds, ...contentIds);
  const xrefStart = position;
  const rows = ['0000000000 65535 f '];
  for (let id = 1; id <= maxId; id += 1) {
    rows.push(offsets[id] === undefined ? '0000000000 65535 f ' : `${String(offsets[id]).padStart(10, '0')} 00000 n `);
  }
  push(`xref\n0 ${maxId + 1}\n${rows.join('\n')}\n`);
  push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/* ------------------------------ 文档内容构建 ------------------------------ */

/** 背诵卡片打印稿。hideChinese 用于自测：只印英文与占位符。 */
export function buildCardBlocks(cards, { hideChinese = false, groupLabel = '' } = {}) {
  const blocks = [];
  let currentModule = '';
  if (groupLabel) blocks.push({ type: 'heading', text: groupLabel });
  for (const card of array(cards)) {
    if (card.moduleLabel !== currentModule) {
      currentModule = card.moduleLabel;
      blocks.push({ type: 'heading', text: `${card.trackLabel ?? ''}${card.trackLabel ? ' · ' : ''}${currentModule}` });
    }
    const notes = [];
    if (array(card.slots).length) notes.push(`占位符：${card.slots.join(' / ')}`);
    for (const constraint of array(card.constraints)) notes.push(`注意：${constraint}`);
    for (const warning of array(card.warnings).slice(0, 2)) notes.push(`易错：${warning}`);
    const page = card.source?.page ? `讲义 p${card.source.page}` : '';
    notes.push([page, card.source?.pageTitle].filter(Boolean).join(' · '));
    blocks.push({
      type: 'card',
      header: `${card.moduleLabel}｜约 ${card.estimatedWords} 词`,
      en: card.en,
      zh: hideChinese ? '' : card.zh,
      notes: notes.filter(Boolean),
    });
  }
  return blocks;
}

/** 真题精讲打印稿。 */
export function buildAnalysisBlocks(analysis) {
  const blocks = [];
  blocks.push({ type: 'heading', text: `题目要求` });
  for (const line of text(analysis.exam?.directions).split('\n')) {
    if (text(line)) blocks.push({ type: 'small', text: text(line), indent: 6 });
  }
  blocks.push({ type: 'heading', text: `行文骨架（${analysis.track?.label ?? ''}）` });
  for (const item of array(analysis.blueprint)) {
    blocks.push({ type: 'text', text: `${item.name}：${item.purpose}`, indent: 6 });
    if (item.avoid) blocks.push({ type: 'small', text: `避免：${item.avoid}`, indent: 12, gapAfter: 3 });
  }
  for (const note of array(analysis.notes)) blocks.push({ type: 'small', text: note, indent: 6, gapBefore: 4 });

  for (const paragraph of array(analysis.paragraphs)) {
    blocks.push({ type: 'heading', text: `${paragraph.name}（${paragraph.words} 词）` });
    if (paragraph.purpose) blocks.push({ type: 'small', text: `本段任务：${paragraph.purpose}`, indent: 6 });
    if (paragraph.avoid) blocks.push({ type: 'small', text: `避免：${paragraph.avoid}`, indent: 6 });
    if (paragraph.aiNote) blocks.push({ type: 'small', text: `补充讲解：${paragraph.aiNote}`, indent: 6 });
    for (const sentence of array(paragraph.sentences)) {
      blocks.push({ type: 'text', text: `${sentence.index}. ${sentence.text}`, indent: 6, gapBefore: 3 });
      blocks.push({ type: 'small', text: `［${sentence.roleLabel}］${sentence.why}`, indent: 14 });
      for (const skeleton of array(sentence.skeletons)) {
        const page = skeleton.source?.page ? `讲义 p${skeleton.source.page}` : '';
        blocks.push({ type: 'small', text: `对应功能句（${page}）：${skeleton.en}`, indent: 14 });
      }
    }
  }

  if (analysis.aiInsight?.summary) {
    blocks.push({ type: 'heading', text: '整体行文思路' });
    blocks.push({ type: 'text', text: analysis.aiInsight.summary, indent: 6 });
    for (const pitfall of array(analysis.aiInsight.pitfalls)) {
      blocks.push({ type: 'small', text: `易错：${pitfall}`, indent: 12 });
    }
  }

  const coverage = array(analysis.moduleCoverage);
  if (coverage.length) {
    blocks.push({ type: 'heading', text: '模块覆盖' });
    blocks.push({ type: 'small', text: coverage.map((item) => `${item.label}：${item.covered ? '已覆盖' : '未覆盖'}`).join('；'), indent: 6 });
  }
  return blocks;
}

const SEVERITY_TITLES = { required: '必改项', suggested: '建议项', structure: '结构项' };

/** 批改报告打印稿：分档、得失分点、分级修改项（含依据与页码）、终稿。 */
export function buildReviewBlocks(review, finalText = '') {
  const blocks = [];
  const grade = review?.grade ?? {};

  blocks.push({ type: 'heading', text: `批改结论：${text(grade.band) || '—'}` });
  if (grade.summary) blocks.push({ type: 'text', text: text(grade.summary), indent: 6 });
  blocks.push({ type: 'small', text: `题型：${text(review?.category)}｜全文 ${review?.words ?? 0} 词｜必改 ${grade.counts?.required ?? 0} 项、建议 ${grade.counts?.suggested ?? 0} 项、结构 ${grade.counts?.structure ?? 0} 项`, indent: 6 });
  if (grade.disclaimer) blocks.push({ type: 'small', text: text(grade.disclaimer), indent: 6, gapAfter: 4 });

  if (array(grade.gains).length) {
    blocks.push({ type: 'heading', text: '得分点' });
    for (const item of array(grade.gains)) blocks.push({ type: 'small', text: `· ${text(item)}`, indent: 6 });
  }
  if (array(grade.losses).length) {
    blocks.push({ type: 'heading', text: '失分点' });
    for (const item of array(grade.losses)) blocks.push({ type: 'small', text: `· ${text(item)}`, indent: 6 });
  }

  for (const severity of ['required', 'suggested', 'structure']) {
    const items = array(review?.issues).filter((issue) => issue.severity === severity);
    if (!items.length) continue;
    blocks.push({ type: 'heading', text: `${SEVERITY_TITLES[severity]}（${items.length} 项）` });
    items.forEach((issue, index) => {
      blocks.push({ type: 'text', text: `${index + 1}. ${text(issue.title)}`, indent: 6, gapBefore: 3 });
      if (issue.quote) blocks.push({ type: 'small', text: `原文：${text(issue.quote)}`, indent: 14 });
      const rewritten = text(issue.replacement) || text(issue.suggestion);
      if (rewritten) blocks.push({ type: 'small', text: `改为：${rewritten}`, indent: 14 });
      if (issue.detail) blocks.push({ type: 'small', text: `说明：${text(issue.detail)}`, indent: 14 });
      // 依据是本功能的立足点，必须逐条打印出来。
      blocks.push({ type: 'small', text: `依据：${text(issue.basis)}${issue.page ? `（讲义 P${issue.page}）` : ''}`, indent: 14 });
    });
  }

  const modules = array(review?.moduleFlow);
  if (modules.length) {
    blocks.push({ type: 'heading', text: '模块覆盖' });
    blocks.push({ type: 'small', text: modules.map((item) => `${item.label}：${item.covered ? '已覆盖' : '未覆盖'}`).join('；'), indent: 6 });
  }

  if (text(finalText)) {
    blocks.push({ type: 'pagebreak' });
    blocks.push({ type: 'heading', text: '修改后终稿' });
    for (const paragraph of text(finalText).split(/\n\s*\n/)) {
      if (text(paragraph)) blocks.push({ type: 'text', text: text(paragraph), indent: 6, gapAfter: 4 });
    }
  }
  return blocks;
}

export default { renderDocument, buildCardBlocks, buildAnalysisBlocks, buildReviewBlocks, findCjkFontFile, PAGE };
