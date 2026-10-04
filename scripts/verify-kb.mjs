import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE = path.join(ROOT, 'knowledge');
const RAW_FILES = [
  ['raw-01-12.json', 1, 12],
  ['raw-13-24.json', 13, 24],
  ['raw-25-36.json', 25, 36],
  ['raw-37-47.json', 37, 47],
];
const SLP_FILES = [
  'slp-big-e1.json',
  'slp-big-e2.json',
  'slp-small-e1.json',
  'slp-small-e2.json',
];
const KINDS = new Set([
  'big-essay-opening', 'big-essay-body', 'big-essay-closing', 'chart-essay',
  'small-essay-para1', 'small-essay-para2', 'small-essay-para3', 'small-essay-typed',
  'layout', 'vocab', 'method', 'transition',
]);
const REQUIRED_ENTRY_RAW = ['id', 'page', 'section', 'en', 'zh', 'slots', 'swappable', 'examples', 'notes'];
const REQUIRED_ENTRY_SLP = ['id', 'source', 'page', 'origin', 'derived', 'originalText', 'section', 'en', 'zh', 'slots', 'swappable', 'notes'];

const errors = [];
const warnings = [];
const allIds = new Map();
const allPages = [];
let entryCount = 0;
let vocabCount = 0;
let uncertainCount = 0;

function err(where, message) { errors.push(`${where}: ${message}`); }
function warn(where, message) { warnings.push(`${where}: ${message}`); }
function isStringArray(v) { return Array.isArray(v) && v.every((x) => typeof x === 'string'); }

for (const [filename, start, end] of RAW_FILES) {
  const target = path.join(KNOWLEDGE, filename);
  let doc;
  try {
    doc = JSON.parse(await readFile(target, 'utf8'));
  } catch (e) {
    err(filename, `无法读取或解析 JSON：${e.message}`);
    continue;
  }
  if (!Array.isArray(doc.pages)) {
    err(filename, 'pages 不是数组');
    continue;
  }
  const expected = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const actual = doc.pages.map((p) => p.page);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    err(filename, `页码应为 ${start}-${end} 连续递增，实际为 [${actual.join(', ')}]`);
  }

  for (const page of doc.pages) {
    const where = `p${String(page.page).padStart(2, '0')}`;
    allPages.push(page);
    if (!Number.isInteger(page.page) || page.page < start || page.page > end) err(where, 'page 越界');
    if (typeof page.title !== 'string' || !page.title.trim()) err(where, 'title 为空');
    if (!KINDS.has(page.kind)) err(where, `未知 kind：${page.kind}`);
    for (const key of ['entries', 'pageNotes', 'vocab']) {
      if (!Array.isArray(page[key])) err(where, `${key} 不是数组`);
    }
    if (page.kind === 'transition' && page.entries?.length) warn(where, 'transition 页含 entries，请确认分类');
    if (page.kind === 'layout' && !page.layoutSpec) err(where, 'layout 页缺少 layoutSpec');

    for (const [index, entry] of (page.entries ?? []).entries()) {
      entryCount += 1;
      const ew = `${where}.entries[${index}]`;
      for (const key of REQUIRED_ENTRY_RAW) {
        if (!(key in entry)) err(ew, `缺少字段 ${key}`);
      }
      if (!entry.id || typeof entry.id !== 'string') err(ew, 'id 为空或非字符串');
      else if (allIds.has(entry.id)) err(ew, `id 重复，首次出现于 ${allIds.get(entry.id)}`);
      else allIds.set(entry.id, ew);
      if (entry.page !== page.page) err(ew, `entry.page=${entry.page} 与页面 ${page.page} 不一致`);
      if (typeof entry.en !== 'string' || typeof entry.zh !== 'string') err(ew, 'en/zh 必须是字符串');
      for (const key of ['slots', 'swappable', 'notes']) {
        if (!isStringArray(entry[key])) err(ew, `${key} 必须是字符串数组`);
      }
      if (!Array.isArray(entry.examples)) err(ew, 'examples 必须是数组');
      for (const [ei, example] of (entry.examples ?? []).entries()) {
        if (typeof example !== 'object' || typeof example.label !== 'string' || typeof example.en !== 'string' || typeof example.zh !== 'string') {
          err(`${ew}.examples[${ei}]`, '必须包含字符串 label/en/zh');
        }
      }
      const text = `${entry.en ?? ''}\n${entry.zh ?? ''}`;
      for (const slot of entry.slots ?? []) {
        if (!text.includes(`{${slot}}`) && !text.includes(slot)) {
          err(ew, `slot「${slot}」未出现在 en/zh 中`);
        }
      }
      if (text.includes('⟨?⟩') && !Array.isArray(entry.uncertain)) err(ew, '含 ⟨?⟩ 但未提供 uncertain');
      if (Array.isArray(entry.uncertain) && entry.uncertain.length) uncertainCount += entry.uncertain.length;
      if (!entry.en.trim() && !entry.zh.trim()) warn(ew, 'en 与 zh 都为空');
    }

    for (const [index, item] of (page.vocab ?? []).entries()) {
      vocabCount += 1;
      if (!item || typeof item.en !== 'string' || typeof item.zh !== 'string' || !item.en.trim() || !item.zh.trim()) {
        err(`${where}.vocab[${index}]`, '词条必须包含非空 en/zh');
      }
    }
  }
}

let slpEntryCount = 0;
let slpVocabCount = 0;

for (const filename of SLP_FILES) {
  const target = path.join(KNOWLEDGE, filename);
  let doc;
  try {
    doc = JSON.parse(await readFile(target, 'utf8'));
  } catch (e) {
    err(filename, `无法读取或解析 JSON：${e.message}`);
    continue;
  }
  if (!Array.isArray(doc.pages)) {
    err(filename, 'pages 不是数组');
    continue;
  }

  for (const page of doc.pages) {
    const where = `${filename}.p${page.page}`;
    if (!Number.isInteger(page.page)) err(where, 'page 非整数');
    if (typeof page.title !== 'string' || !page.title.trim()) err(where, 'title 为空');
    if (!KINDS.has(page.kind)) err(where, `未知 kind：${page.kind}`);
    for (const key of ['entries', 'pageNotes', 'vocab']) {
      if (!Array.isArray(page[key])) err(where, `${key} 不是数组`);
    }

    for (const [index, entry] of (page.entries ?? []).entries()) {
      slpEntryCount += 1;
      const ew = `${where}.entries[${index}]`;
      for (const key of REQUIRED_ENTRY_SLP) {
        if (!(key in entry)) err(ew, `缺少字段 ${key}`);
      }
      if (!entry.id || typeof entry.id !== 'string') err(ew, 'id 为空或非字符串');
      else if (allIds.has(entry.id)) err(ew, `id 重复，首次出现于 ${allIds.get(entry.id)}`);
      else allIds.set(entry.id, ew);
      if (entry.page < page.page || entry.page > page.page + 5) {
        err(ew, `entry.page=${entry.page} 偏离章节起始页 ${page.page} 过远`);
      }
      if (typeof entry.en !== 'string' || typeof entry.zh !== 'string' || typeof entry.originalText !== 'string') {
        err(ew, 'en/zh/originalText 必须是字符串');
      }
      if (typeof entry.derived !== 'boolean') err(ew, 'derived 必须是布尔值');
      for (const key of ['slots', 'swappable', 'notes']) {
        if (!isStringArray(entry[key])) err(ew, `${key} 必须是字符串数组`);
      }
      const text = `${entry.en ?? ''}\n${entry.zh ?? ''}`;
      for (const slot of entry.slots ?? []) {
        if (!text.includes(`{${slot}}`) && !text.includes(slot)) {
          err(ew, `slot「${slot}」未出现在 en/zh 中`);
        }
      }
    }

    for (const [index, item] of (page.vocab ?? []).entries()) {
      slpVocabCount += 1;
      if (!item || typeof item.en !== 'string' || typeof item.zh !== 'string' || !item.en.trim() || !item.zh.trim()) {
        err(`${where}.vocab[${index}]`, '词条必须包含非空 en/zh');
      }
    }
  }
}

const pageNumbers = allPages.map((p) => p.page).sort((a, b) => a - b);
const expectedAll = Array.from({ length: 47 }, (_, i) => i + 1);
if (JSON.stringify(pageNumbers) !== JSON.stringify(expectedAll)) {
  err('全局', `必须完整覆盖 1-47 页且无重复，实际为 [${pageNumbers.join(', ')}]`);
}

console.log(`知识库验收：47 原 PDF 页 + 石雷鹏笔记 158 条，原版 ${entryCount} 条 + 石雷鹏 ${slpEntryCount} 条 = 共 ${entryCount + slpEntryCount} 条模板，${vocabCount + slpVocabCount} 个词条，${uncertainCount} 处待核字`);
if (warnings.length) {
  console.log(`\n警告（${warnings.length}）：`);
  for (const item of warnings) console.log(`  - ${item}`);
}
if (errors.length) {
  console.error(`\n错误（${errors.length}）：`);
  for (const item of errors) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('\n结构验收通过。下一步仍需人工抽样核对原页，才能构建正式知识库。');
