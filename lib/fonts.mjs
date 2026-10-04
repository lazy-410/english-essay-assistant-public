/**
 * 零依赖 TrueType 解析器。
 *
 * 只解析排版与 PDF 嵌入需要的表：
 * - head：unitsPerEm / indexToLocFormat / FontBBox
 * - hhea：ascender / descender / numberOfHMetrics
 * - maxp：numGlyphs
 * - hmtx：真实字符宽度
 * - cmap：format 4（平台 3/1、3/0）与 format 0 / 6 / 12 兜底
 * - name：显示名（nameID 4 优先，回退 1）
 * - OS/2、post：可选，缺失时降级
 *
 * 度量统一换算成 1/1000 em，与 PDF 的 /Widths 约定一致。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from './paths.mjs';

export const FONTS_DIR = path.join(PUBLIC_DIR, 'fonts');

const fontCache = new Map();
let listCache = null;

/* ---------------------------------- 工具 ---------------------------------- */

function tag(buffer, offset) {
  return buffer.toString('latin1', offset, offset + 4);
}

function readTableDirectory(buffer) {
  const version = buffer.readUInt32BE(0);
  // 0x00010000 = TrueType，'true' = 旧版 Mac，'OTTO' 为 CFF（无 glyf，无法按 TrueType 嵌入）
  if (version !== 0x00010000 && tag(buffer, 0) !== 'true' && tag(buffer, 0) !== 'ttcf' && tag(buffer, 0) !== 'OTTO') {
    throw new Error(`不支持的字体格式：0x${version.toString(16)}`);
  }
  let base = 0;
  if (tag(buffer, 0) === 'ttcf') {
    // 字体集合：取第一个字体
    base = buffer.readUInt32BE(12);
  }
  const numTables = buffer.readUInt16BE(base + 4);
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const record = base + 12 + i * 16;
    if (record + 16 > buffer.length) break;
    tables.set(tag(buffer, record), {
      offset: buffer.readUInt32BE(record + 8),
      length: buffer.readUInt32BE(record + 12),
    });
  }
  return tables;
}

function requireTable(tables, name, file) {
  const entry = tables.get(name);
  if (!entry) throw new Error(`${file} 缺少必需的 ${name} 表`);
  return entry;
}

/* --------------------------------- name 表 -------------------------------- */

function decodeNameRecord(buffer, platformID, start, length) {
  if (platformID === 3 || platformID === 0) {
    // UTF-16BE
    let out = '';
    for (let i = 0; i + 1 < length; i += 2) {
      out += String.fromCharCode(buffer.readUInt16BE(start + i));
    }
    return out;
  }
  return buffer.toString('latin1', start, start + length);
}

function parseName(buffer, tables) {
  const entry = tables.get('name');
  const result = { full: '', family: '', subfamily: '' };
  if (!entry) return result;
  const base = entry.offset;
  if (base + 6 > buffer.length) return result;
  const count = buffer.readUInt16BE(base + 2);
  const stringOffset = base + buffer.readUInt16BE(base + 4);

  // 记录候选，按平台优先级挑选：Windows Unicode(3/1) > Unicode(0) > Mac(1)
  const wanted = { 1: 'family', 2: 'subfamily', 4: 'full' };
  const best = new Map();
  const score = (platformID, encodingID) => {
    if (platformID === 3 && encodingID === 1) return 3;
    if (platformID === 3) return 2;
    if (platformID === 0) return 2;
    if (platformID === 1) return 1;
    return 0;
  };

  for (let i = 0; i < count; i += 1) {
    const record = base + 6 + i * 12;
    if (record + 12 > buffer.length) break;
    const platformID = buffer.readUInt16BE(record);
    const encodingID = buffer.readUInt16BE(record + 2);
    const nameID = buffer.readUInt16BE(record + 6);
    const key = wanted[nameID];
    if (!key) continue;
    const length = buffer.readUInt16BE(record + 8);
    const offset = stringOffset + buffer.readUInt16BE(record + 10);
    if (offset + length > buffer.length) continue;
    const rank = score(platformID, encodingID);
    if (rank === 0) continue;
    const previous = best.get(key);
    if (previous && previous.rank >= rank) continue;
    const value = decodeNameRecord(buffer, platformID, offset, length).replace(/\u0000/g, '').trim();
    if (!value) continue;
    best.set(key, { rank, value });
  }

  for (const [key, item] of best) result[key] = item.value;
  return result;
}

/* --------------------------------- cmap 表 -------------------------------- */

function parseCmapFormat4(buffer, offset) {
  const segCountX2 = buffer.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;
  const endBase = offset + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;
  const segments = [];
  for (let i = 0; i < segCount; i += 1) {
    segments.push({
      end: buffer.readUInt16BE(endBase + i * 2),
      start: buffer.readUInt16BE(startBase + i * 2),
      delta: buffer.readInt16BE(deltaBase + i * 2),
      rangeOffset: buffer.readUInt16BE(rangeBase + i * 2),
      rangeAt: rangeBase + i * 2,
    });
  }
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (const segment of segments) {
      if (cp > segment.end) continue;
      if (cp < segment.start) return 0;
      if (segment.rangeOffset === 0) return (cp + segment.delta) & 0xffff;
      const glyphAt = segment.rangeAt + segment.rangeOffset + (cp - segment.start) * 2;
      if (glyphAt + 2 > buffer.length) return 0;
      const glyph = buffer.readUInt16BE(glyphAt);
      return glyph === 0 ? 0 : (glyph + segment.delta) & 0xffff;
    }
    return 0;
  };
}

function parseCmapFormat0(buffer, offset) {
  const table = offset + 6;
  return (cp) => (cp >= 0 && cp < 256 && table + cp < buffer.length ? buffer.readUInt8(table + cp) : 0);
}

function parseCmapFormat6(buffer, offset) {
  const first = buffer.readUInt16BE(offset + 6);
  const count = buffer.readUInt16BE(offset + 8);
  return (cp) => {
    const index = cp - first;
    if (index < 0 || index >= count) return 0;
    return buffer.readUInt16BE(offset + 10 + index * 2);
  };
}

function parseCmapFormat12(buffer, offset) {
  const groups = buffer.readUInt32BE(offset + 12);
  return (cp) => {
    for (let i = 0; i < groups; i += 1) {
      const group = offset + 16 + i * 12;
      const start = buffer.readUInt32BE(group);
      const end = buffer.readUInt32BE(group + 4);
      if (cp < start) return 0;
      if (cp > end) continue;
      return buffer.readUInt32BE(group + 8) + (cp - start);
    }
    return 0;
  };
}

function buildCmapLookup(buffer, offset) {
  const format = buffer.readUInt16BE(offset);
  if (format === 4) return parseCmapFormat4(buffer, offset);
  if (format === 0) return parseCmapFormat0(buffer, offset);
  if (format === 6) return parseCmapFormat6(buffer, offset);
  if (format === 12) return parseCmapFormat12(buffer, offset);
  return null;
}

function parseCmap(buffer, tables) {
  const entry = tables.get('cmap');
  if (!entry) return { lookup: () => 0, platform: null };
  const base = entry.offset;
  const count = buffer.readUInt16BE(base + 2);
  const subtables = [];
  for (let i = 0; i < count; i += 1) {
    const record = base + 4 + i * 8;
    subtables.push({
      platformID: buffer.readUInt16BE(record),
      encodingID: buffer.readUInt16BE(record + 2),
      offset: base + buffer.readUInt32BE(record + 4),
    });
  }
  // 优先级：3/10（UCS-4）> 3/1（BMP）> 3/0（symbol）> 0/x（Unicode）> 1/0（Mac）
  const rank = ({ platformID, encodingID }) => {
    if (platformID === 3 && encodingID === 10) return 5;
    if (platformID === 3 && encodingID === 1) return 4;
    if (platformID === 3 && encodingID === 0) return 3;
    if (platformID === 0) return 2;
    if (platformID === 1 && encodingID === 0) return 1;
    return 0;
  };
  subtables.sort((a, b) => rank(b) - rank(a));

  for (const subtable of subtables) {
    if (rank(subtable) === 0) continue;
    const lookup = buildCmapLookup(buffer, subtable.offset);
    if (!lookup) continue;
    const symbol = subtable.platformID === 3 && subtable.encodingID === 0;
    const wrapped = symbol
      ? (cp) => {
          // symbol 字体常把 ASCII 映射到 0xF000 段
          const direct = lookup(cp);
          if (direct) return direct;
          return cp >= 0x20 && cp <= 0xff ? lookup(0xf000 + cp) : 0;
        }
      : lookup;
    return { lookup: wrapped, platform: `${subtable.platformID}/${subtable.encodingID}` };
  }
  return { lookup: () => 0, platform: null };
}

/* --------------------------------- 主解析 --------------------------------- */

function parseFont(file, id) {
  const buffer = fs.readFileSync(file);
  const tables = readTableDirectory(buffer);

  const head = requireTable(tables, 'head', path.basename(file));
  const unitsPerEm = buffer.readUInt16BE(head.offset + 18) || 1000;
  const indexToLocFormat = buffer.readInt16BE(head.offset + 50);
  const bbox = {
    xMin: buffer.readInt16BE(head.offset + 36),
    yMin: buffer.readInt16BE(head.offset + 38),
    xMax: buffer.readInt16BE(head.offset + 40),
    yMax: buffer.readInt16BE(head.offset + 42),
  };

  const hhea = requireTable(tables, 'hhea', path.basename(file));
  const ascender = buffer.readInt16BE(hhea.offset + 4);
  const descender = buffer.readInt16BE(hhea.offset + 6);
  const lineGap = buffer.readInt16BE(hhea.offset + 8);
  const numberOfHMetrics = buffer.readUInt16BE(hhea.offset + 34);

  const maxp = tables.get('maxp');
  const numGlyphs = maxp ? buffer.readUInt16BE(maxp.offset + 4) : numberOfHMetrics;

  const hmtx = requireTable(tables, 'hmtx', path.basename(file));
  const advances = new Uint16Array(Math.max(numberOfHMetrics, 1));
  for (let i = 0; i < numberOfHMetrics; i += 1) {
    const at = hmtx.offset + i * 4;
    advances[i] = at + 2 <= buffer.length ? buffer.readUInt16BE(at) : 0;
  }
  const lastAdvance = advances[numberOfHMetrics - 1] || Math.round(unitsPerEm / 2);

  const { lookup, platform } = parseCmap(buffer, tables);
  const names = parseName(buffer, tables);

  // OS/2 可选：仅用于 capHeight / typo 度量
  let capHeight = null;
  let typoAscender = null;
  let typoDescender = null;
  const os2 = tables.get('OS/2');
  if (os2 && os2.offset + 72 <= buffer.length) {
    const version = buffer.readUInt16BE(os2.offset);
    typoAscender = buffer.readInt16BE(os2.offset + 68);
    typoDescender = buffer.readInt16BE(os2.offset + 70);
    if (version >= 2 && os2.offset + 90 <= buffer.length) {
      capHeight = buffer.readInt16BE(os2.offset + 88);
    }
  }

  // post 可选：italicAngle 为 Fixed(16.16)
  let italicAngle = 0;
  const post = tables.get('post');
  if (post && post.offset + 8 <= buffer.length) {
    italicAngle = buffer.readInt32BE(post.offset + 4) / 65536;
  }

  const scale = 1000 / unitsPerEm;
  const glyphCache = new Map();

  const glyphIdFor = (cp) => {
    const code = typeof cp === 'string' ? cp.codePointAt(0) : cp;
    if (!Number.isInteger(code) || code < 0) return 0;
    if (glyphCache.has(code)) return glyphCache.get(code);
    let glyph = 0;
    try {
      glyph = lookup(code) || 0;
    } catch {
      glyph = 0;
    }
    if (glyph >= numGlyphs) glyph = 0;
    glyphCache.set(code, glyph);
    return glyph;
  };

  const advanceForGlyph = (glyph) => {
    if (glyph <= 0) return lastAdvance;
    if (glyph < numberOfHMetrics) return advances[glyph];
    return lastAdvance;
  };

  const spaceGlyph = glyphIdFor(0x20);
  const spaceUnits = spaceGlyph ? advanceForGlyph(spaceGlyph) : Math.round(unitsPerEm / 3);

  /** 单字符宽度，单位 1/1000 em。缺字形回退到空格宽度。 */
  const advanceWidth = (cp) => {
    const code = typeof cp === 'string' ? cp.codePointAt(0) : cp;
    const glyph = glyphIdFor(code);
    const units = glyph === 0 ? spaceUnits : advanceForGlyph(glyph);
    return units * scale;
  };

  /** 文本宽度，单位 pt（与 fontSize 同单位）。 */
  const widthOf = (text, size) => {
    let total = 0;
    for (const ch of String(text ?? '')) total += advanceWidth(ch.codePointAt(0));
    return (total * (Number(size) || 0)) / 1000;
  };

  const hasGlyph = (cp) => glyphIdFor(cp) !== 0;

  return {
    id,
    file,
    label: names.full || names.family || path.basename(file, path.extname(file)),
    family: names.family || names.full || path.basename(file, path.extname(file)),
    subfamily: names.subfamily || '',
    buffer,
    unitsPerEm,
    indexToLocFormat,
    numGlyphs,
    numberOfHMetrics,
    ascender,
    descender,
    lineGap,
    capHeight,
    typoAscender,
    typoDescender,
    italicAngle,
    bbox,
    cmapPlatform: platform,
    // 1/1000 em 尺度的常用度量，直接给 PDF FontDescriptor 用
    metrics1000: {
      ascender: Math.round(ascender * scale),
      descender: Math.round(descender * scale),
      capHeight: Math.round((capHeight ?? Math.round(ascender * 0.7)) * scale),
      bbox: [
        Math.round(bbox.xMin * scale),
        Math.round(bbox.yMin * scale),
        Math.round(bbox.xMax * scale),
        Math.round(bbox.yMax * scale),
      ],
    },
    glyphIdFor,
    advanceWidth,
    widthOf,
    hasGlyph,
    spaceWidth: spaceUnits * scale,
  };
}

/* ----------------------------------- API ---------------------------------- */

function relativePosix(file) {
  return path.relative(FONTS_DIR, file).split(path.sep).join('/');
}

function walkTtf(directory, output = []) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkTtf(file, output);
    else if (entry.isFile() && /\.ttf$/i.test(entry.name)) output.push(file);
  }
  return output;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function makeId(relative) {
  const withoutExt = relative.replace(/\.ttf$/i, '');
  const slug = withoutExt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'font';
  return `${slug}-${shortHash(relative)}`;
}

function friendlyName(relative) {
  const name = path.posix.basename(relative, path.posix.extname(relative));
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bVariableFont\b/gi, 'Variable')
    .replace(/\bwght\b/gi, 'Weight')
    .replace(/\s+/g, ' ')
    .trim();
}

function staticWeight(relative, subfamily) {
  if (!/(?:^|\/)static\//i.test(relative)) return '';
  const fromName = path.posix.basename(relative).match(/-(Bold|Medium|Regular|SemiBold)\.ttf$/i)?.[1];
  const value = fromName || String(subfamily || '').match(/\b(Bold|Medium|Regular|SemiBold)\b/i)?.[1] || '';
  if (!value) return '';
  return value.toLowerCase() === 'semibold'
    ? 'SemiBold'
    : value[0].toUpperCase() + value.slice(1).toLowerCase();
}

function withVisibleWeight(label, weight) {
  if (!weight || new RegExp(`\\b${weight}\\b`, 'i').test(label)) return label;
  return `${label} ${weight}`;
}

function fontUrl(relative) {
  return `/fonts/${relative.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function buildDescriptor(file) {
  const relative = relativePosix(file);
  const id = makeId(relative);
  const source = relative.startsWith('dome/') ? 'dome' : 'builtin';
  const recommended = relative === 'dome/舒窈英文衡水体.ttf';
  let family = friendlyName(relative);
  let subfamily = '';
  let label = family;
  try {
    const parsed = parseFont(file, id);
    family = parsed.family || family;
    subfamily = parsed.subfamily || '';
    label = parsed.label || family;
  } catch {
    // 字体仍会列出；真正 loadFont 时再把解析错误抛给调用者。
  }
  const weight = staticWeight(relative, subfamily);
  label = withVisibleWeight(label || friendlyName(relative), weight);
  return Object.freeze({
    id,
    label,
    family,
    subfamily,
    file,
    url: fontUrl(relative),
    source,
    recommended,
  });
}

/** 递归扫描 public/fonts 下全部 TTF；不按家族或字重去重。 */
export function listFonts() {
  if (!listCache) {
    listCache = Object.freeze(walkTtf(FONTS_DIR).map(buildDescriptor));
  }
  return listCache.map((font) => ({ ...font }));
}

function descriptorFor(id) {
  const key = String(id ?? '');
  if (!key) throw new Error('缺少字体 id');
  const descriptor = listFonts().find((font) => font.id === key);
  if (!descriptor) throw new Error(`未找到字体：${id}`);
  return descriptor;
}

/** 仅接受 listFonts() 返回的精确 id，解析并缓存真实 cmap/hmtx 与 TTF 程序。 */
export function loadFont(id) {
  const descriptor = descriptorFor(id);
  if (fontCache.has(descriptor.id)) return fontCache.get(descriptor.id);
  const parsed = parseFont(descriptor.file, descriptor.id);
  const font = Object.freeze({
    ...parsed,
    ...descriptor,
    // PDF Name 对象必须保持 ASCII；使用路径 id 可避免中文 family 和同名字体冲突。
    asciiPdfName: `EEA-${descriptor.id}`.replace(/[^A-Za-z0-9-]/g, '-'),
  });
  fontCache.set(descriptor.id, font);
  return font;
}

export function getDefaultFontId() {
  const fonts = listFonts();
  return (
    fonts.find((font) => font.recommended)?.id ||
    fonts.find((font) => /\bHandlee\b/i.test(`${font.label} ${font.family}`))?.id ||
    fonts.find((font) => /Ink\s*Free|Inkfree/i.test(`${font.label} ${font.family} ${font.file}`))?.id ||
    fonts[0]?.id ||
    ''
  );
}

/** 默认优先舒窈英文衡水体，缺失时依次回退 Handlee、Ink Free。 */
export const DEFAULT_FONT_ID = getDefaultFontId();

/** 测试或热更新时清空扫描与解析缓存。 */
export function clearFontCache() {
  fontCache.clear();
  listCache = null;
}

export default { listFonts, loadFont, getDefaultFontId, clearFontCache, DEFAULT_FONT_ID, FONTS_DIR };
