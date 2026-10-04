import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_CATALOG } from '../lib/modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'knowledge');
const RAW_FILES = ['raw-01-12.json', 'raw-13-24.json', 'raw-25-36.json', 'raw-37-47.json'];
const SLP_FILES = ['slp-big-e1.json', 'slp-big-e2.json', 'slp-small-e1.json', 'slp-small-e2.json'];

const rawDocs = await Promise.all(RAW_FILES.map(async (file) => JSON.parse(await readFile(path.join(DIR, file), 'utf8'))));
const slpDocs = await Promise.all(SLP_FILES.map(async (file) => JSON.parse(await readFile(path.join(DIR, file), 'utf8'))));

const pages = rawDocs.flatMap((d) => d.pages).sort((a, b) => a.page - b.page);
const rawEntries = pages.flatMap((p) => p.entries.map((e) => ({ ...e, kind: p.kind, pageTitle: p.title, source: 'scan-handout' })));

const slpPages = slpDocs.flatMap((d) => d.pages);
const slpEntries = slpPages.flatMap((p) => p.entries.map((e) => ({ ...e, kind: p.kind, pageTitle: p.title })));

const entries = [...rawEntries, ...slpEntries];
const rawVocab = pages.flatMap((p) => p.vocab.map((v, i) => ({ ...v, page: p.page, id: `vocab-p${String(p.page).padStart(2, '0')}-${i + 1}` })));
const slpVocab = slpPages.flatMap((p) => (p.vocab ?? []).map((v, i) => ({ ...v, page: p.page, source: p.source, id: `vocab-${p.source}-p${p.page}-${i + 1}` })));
const vocab = [...rawVocab, ...slpVocab];

const byKind = Object.fromEntries([...new Set([...pages, ...slpPages].map((p) => p.kind))].map((kind) => [kind, entries.filter((e) => e.kind === kind).map((e) => e.id)]));
const bySlot = {};
for (const entry of entries) {
  for (const slot of entry.slots ?? []) (bySlot[slot] ??= []).push(entry.id);
}
const byLetterType = {};
for (const entry of entries) {
  if (entry.letterType) (byLetterType[entry.letterType] ??= []).push(entry.id);
}

const slpSourceMetadata = slpDocs.map(({ source, sourceLabel, totalPages, scope }) => ({ source, sourceLabel, totalPages, scope }));
const scanSource = SOURCE_CATALOG.find((item) => item.source === 'scan-handout');
const sources = [scanSource, ...slpSourceMetadata];

const meta = {
  version: 3,
  title: '考研英语作文综合知识库',
  source: '考研英语作文.pdf + 石雷鹏考研英语大小作文笔记',
  sourcePageCount: 47,
  sources,
  counts: { pages: pages.length, entries: entries.length, rawEntries: rawEntries.length, slpEntries: slpEntries.length, vocab: vocab.length },
};

await writeFile(path.join(DIR, 'pages.json'), JSON.stringify({ meta, pages }, null, 2) + '\n', 'utf8');
await writeFile(path.join(DIR, 'templates.json'), JSON.stringify({ meta, entries }, null, 2) + '\n', 'utf8');
await writeFile(path.join(DIR, 'vocab.json'), JSON.stringify({ meta, vocab }, null, 2) + '\n', 'utf8');
await writeFile(path.join(DIR, 'index.json'), JSON.stringify({ meta, byKind, bySlot, byLetterType }, null, 2) + '\n', 'utf8');

const layouts = pages.filter((p) => p.layoutSpec).map((p) => ({ page: p.page, title: p.title, layoutSpec: p.layoutSpec, pageNotes: p.pageNotes }));
await writeFile(path.join(DIR, 'layout.json'), JSON.stringify({ meta, layouts }, null, 2) + '\n', 'utf8');

console.log(`正式知识库已构建：${pages.length} 页 / ${entries.length} 模板 / ${vocab.length} 词条`);
