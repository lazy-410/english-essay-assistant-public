import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  renderDocument,
  buildCardBlocks,
  buildAnalysisBlocks,
  findCjkFontFile,
  findLatinFontFile,
  PAGE,
} from '../lib/print-pdf.mjs';
import { buildStudyPlan } from '../lib/study-cards.mjs';
import { analyzeExamEssay, deepenAnalysis } from '../lib/essay-analysis.mjs';
import { TEMPLATE_TRACKS } from '../lib/modules.mjs';

const TRACK_LABELS = new Map(TEMPLATE_TRACKS.map((track) => [track.id, track.label]));

/**
 * 解码 PDF 自身内嵌的 ToUnicode CMap，再按字体资源还原文本。
 * 这样验证的是 PDF 里真实的字形到字符映射，等价于阅读器复制出的文本。
 */
function extract(pdf) {
  const latin = pdf.toString('latin1');
  const streams = [...latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map((match) => Buffer.from(match[1], 'latin1'));
  const decoded = streams.map((buffer) => {
    try { return zlib.inflateSync(buffer).toString('latin1'); } catch { return ''; }
  });
  const maps = decoded.filter((item) => item.includes('beginbfchar')).map((item) => {
    const map = new Map();
    for (const entry of item.matchAll(/<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4,8})>/g)) {
      map.set(parseInt(entry[1], 16), String.fromCodePoint(parseInt(entry[2].slice(0, 4), 16)));
    }
    return map;
  });
  const pageTexts = decoded.filter((item) => item.includes(' Tj')).map((content) => {
    let out = '';
    // 内容流按 /F1（中文）与 /F2（西文）切段，各自用对应的映射还原。
    for (const segment of content.split(/(?=\/F[12] )/)) {
      const map = maps[segment.startsWith('/F2') ? 1 : 0] ?? maps[0];
      for (const match of segment.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
        const hex = match[1];
        for (let index = 0; index + 4 <= hex.length; index += 4) {
          out += map?.get(parseInt(hex.slice(index, index + 4), 16)) ?? '\uFFFD';
        }
      }
    }
    return out;
  });
  return {
    pageTexts,
    text: pageTexts.join('\n'),
    glyphMaps: maps.length,
    pageCount: (latin.match(/\/Type \/Page[^s]/g) ?? []).length,
    cidFonts: (latin.match(/CIDFontType2/g) ?? []).length,
    identityH: (latin.match(/Identity-H/g) ?? []).length,
    fontFiles: (latin.match(/FontFile2/g) ?? []).length,
    hasXref: latin.includes('\nxref\n'),
    endsProperly: latin.trimEnd().endsWith('%%EOF'),
    mediaBox: latin.includes(`/MediaBox [0 0 ${PAGE.width.toFixed(2)} ${PAGE.height.toFixed(2)}]`)
      || /\/MediaBox \[0 0 595\.28 841\.89\]/.test(latin),
  };
}

const cjkFont = findCjkFontFile();
assert.ok(cjkFont, '未找到系统中文字体，无法验证中文 PDF');
const latinFont = findLatinFontFile();

/* ------------------------------ 基础结构校验 ------------------------------ */

const simple = renderDocument({ title: '标题测试', subtitle: '副标题', blocks: [{ type: 'text', text: '中文与 English 混排 123。' }] });
const simpleInfo = extract(simple);
assert.equal(simpleInfo.pageCount, 1);
assert.equal(simpleInfo.hasXref, true, '缺少 xref');
assert.equal(simpleInfo.endsProperly, true, 'PDF 未以 %%EOF 结束');
assert.equal(simpleInfo.mediaBox, true, 'MediaBox 应为 A4');
assert.ok(simpleInfo.cidFonts >= 1, '应内嵌 CIDFontType2 字体');
assert.ok(simpleInfo.identityH >= 1, '应使用 Identity-H 编码');
assert.ok(simpleInfo.fontFiles >= 1, '应内嵌 FontFile2 字体程序');
assert.ok(simple.subarray(0, 5).toString('latin1') === '%PDF-', 'PDF 魔数错误');
// 中英文都要能还原，且不能出现缺字形。
assert.ok(simpleInfo.text.includes('标题测试'), '标题中文未正确嵌入');
assert.ok(simpleInfo.text.includes('副标题'), '副标题未正确嵌入');
assert.ok(simpleInfo.text.includes('English'), '英文未正确嵌入');
assert.ok(simpleInfo.text.includes('中文与'), '正文中文未正确嵌入');
assert.equal(simpleInfo.text.includes('\uFFFD'), false, '存在缺失字形');
assert.ok(/第\s*1\s*\/\s*1\s*页/.test(simpleInfo.text), '页脚未正确渲染');

if (latinFont) {
  assert.equal(simpleInfo.cidFonts, 2, '存在西文字体时应内嵌两套 CID 字体');
  assert.equal(simpleInfo.glyphMaps, 2, '两套字体应各有 ToUnicode 映射');
}

// 字体子集必须远小于源字体，否则说明没有真正子集化。
assert.ok(simple.length < 200 * 1024, `单页 PDF 过大，子集化可能失效：${simple.length}`);

/* ------------------------------ 卡片文档 ------------------------------ */

const plan = await buildStudyPlan({ dailyCount: 8 });
const cards = plan.cards.map((card) => ({ ...card, trackLabel: TRACK_LABELS.get(card.track) ?? card.track }));

const unitCards = cards.slice(0, 8);
const unitPdf = renderDocument({
  title: '考研英语作文 · 背诵卡片',
  subtitle: `第 1 单元 · 共 ${unitCards.length} 张`,
  blocks: buildCardBlocks(unitCards),
});
const unitInfo = extract(unitPdf);
assert.ok(unitInfo.text.includes('背诵卡片'), '卡片标题缺失');
assert.ok(unitInfo.text.includes(unitCards[0].en.slice(0, 24)), '卡片英文骨架缺失');
assert.ok(unitInfo.text.includes('占位符'), '卡片应打印占位符提示');
assert.ok(/讲义 p\d+/.test(unitInfo.text), '卡片应打印讲义页码');
assert.equal(unitInfo.text.includes('\uFFFD'), false, '卡片存在缺失字形');

// 自测模式必须隐藏中文译文，但保留英文。
const hiddenPdf = renderDocument({ title: '自测卡片', blocks: buildCardBlocks(unitCards, { hideChinese: true }) });
const hiddenInfo = extract(hiddenPdf);
assert.ok(hiddenInfo.text.includes(unitCards[0].en.slice(0, 24)), '自测模式应保留英文');
const zhSample = unitCards.find((card) => card.zh)?.zh?.slice(0, 10);
assert.ok(zhSample, '测试样本缺少中文');
assert.equal(hiddenInfo.text.includes(zhSample), false, '自测模式不应打印中文译文');

// 全量卡片验证多页分页与页码连续。
const allPdf = renderDocument({ title: '全部背诵卡片', subtitle: `共 ${cards.length} 张`, blocks: buildCardBlocks(cards) });
const allInfo = extract(allPdf);
assert.ok(allInfo.pageCount > 20, `全量卡片应分多页，实际 ${allInfo.pageCount}`);
assert.equal(allInfo.pageTexts.length, allInfo.pageCount, '内容流数量应等于页数');
assert.ok(new RegExp(`第\\s*${allInfo.pageCount}\\s*/\\s*${allInfo.pageCount}\\s*页`).test(allInfo.text), '末页页码错误');
assert.equal(allInfo.text.includes('\uFFFD'), false, '全量卡片存在缺失字形');
// 三条轨道的标题都应出现，确认按写作顺序完整覆盖。
for (const label of TRACK_LABELS.values()) {
  assert.ok(allInfo.text.includes(label), `全量卡片缺少轨道：${label}`);
}

/* ------------------------------ 精讲文档 ------------------------------ */

for (const examId of ['e2-2012-b', 'e1-2011-b', 'e2-2015-a']) {
  const analysis = await analyzeExamEssay(examId);
  const pdf = renderDocument({ title: `${examId} · 行文精讲`, subtitle: analysis.track.label, blocks: buildAnalysisBlocks(analysis) });
  const info = extract(pdf);
  assert.ok(info.pageCount >= 1);
  assert.equal(info.endsProperly, true);
  assert.ok(info.text.includes('题目要求'), `${examId} 精讲缺少题干`);
  assert.ok(info.text.includes('行文骨架'), `${examId} 精讲缺少行文骨架`);
  assert.ok(info.text.includes('模块覆盖'), `${examId} 精讲缺少模块覆盖`);
  const firstSentence = analysis.paragraphs[0].sentences[0];
  assert.ok(info.text.includes(firstSentence.text.slice(0, 24)), `${examId} 精讲缺少范文句`);
  assert.ok(info.text.includes(firstSentence.roleLabel), `${examId} 精讲缺少功能标签`);
  assert.equal(info.text.includes('\uFFFD'), false, `${examId} 精讲存在缺失字形`);
}

// AI 深化内容应出现在精讲 PDF 中。
const deepened = await deepenAnalysis(await analyzeExamEssay('e2-2012-b'), {
  chatJsonImpl: async () => ({
    summary: '先描述数据再归因，最后给建议。',
    paragraphNotes: [{ index: 1, note: '首段只挑关键数据。' }],
    pitfalls: ['不要罗列全部数字'],
  }),
});
const deepenedInfo = extract(renderDocument({ title: 'AI 精讲', blocks: buildAnalysisBlocks(deepened) }));
assert.ok(deepenedInfo.text.includes('整体行文思路'), '缺少 AI 小节标题');
assert.ok(deepenedInfo.text.includes('先描述数据再归因'), '缺少 AI 概述');
assert.ok(deepenedInfo.text.includes('首段只挑关键数据'), '缺少段落级 AI 备注');
assert.ok(deepenedInfo.text.includes('不要罗列全部数字'), '缺少 AI 易错点');

// 无范文题目也应能导出，且给出降级提示。
const noEssayInfo = extract(renderDocument({ title: '无范文精讲', blocks: buildAnalysisBlocks(await analyzeExamEssay('e1-2025-b')) }));
assert.ok(noEssayInfo.text.includes('暂无已校对范文'), '无范文精讲应保留降级提示');

/* ------------------------------ 降级路径 ------------------------------ */

// 中文字体不可用时必须给出明确错误码，而不是产出乱码 PDF。
assert.throws(
  () => renderDocument({ title: '缺字体', blocks: [{ type: 'text', text: '中文' }], fontFile: '' }),
  (error) => error.code === 'cjk_font_missing' && error.status === 503,
);

// 无西文字体时仍应能出图，只是拉丁字形退回中文字体。
const cjkOnly = renderDocument({ title: '仅中文字体', blocks: [{ type: 'text', text: 'Only CJK font 中文' }], latinFontFile: '' });
const cjkOnlyInfo = extract(cjkOnly);
assert.equal(cjkOnlyInfo.cidFonts, 1, '无西文字体时应只内嵌一套字体');
assert.ok(cjkOnlyInfo.text.includes('Only CJK font'), '退回中文字体后英文仍应可读');
assert.equal(cjkOnlyInfo.text.includes('\uFFFD'), false, '退回路径不应缺字形');

console.log(`print-pdf verification passed: cjk=${cjkFont.split(/[\\/]/).pop()}, latin=${latinFont ? latinFont.split(/[\\/]/).pop() : 'none'}, cards=${cards.length}/${allInfo.pageCount}页/${Math.round(allPdf.length / 1024)}KB, analysis=ok, fallback=ok`);
