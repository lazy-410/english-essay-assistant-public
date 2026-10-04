import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
const DIR = path.join(ROOT, 'knowledge', 'writing');
const FILES = ['sources','page-map','methods','skeletons','variants','examples','warnings','relations','aliases'];
let cache;
const read = async (name) => JSON.parse(await readFile(path.join(DIR, `${name}.json`), 'utf8'));
export class WritingKnowledgeMissingError extends Error { constructor(missing) { super(`写作知识库 V2 尚未构建，缺少：${missing.join('、')}`); this.code = 'writing_kb_not_built'; this.status = 503; } }
export async function loadWritingKnowledge({ force = false } = {}) {
  if (cache && !force) return cache;
  const missing = FILES.filter((f) => !existsSync(path.join(DIR, `${f}.json`)));
  if (missing.length) throw new WritingKnowledgeMissingError(missing);
  const docs = Object.fromEntries(await Promise.all(FILES.map(async (name) => [name, await read(name)])));
  const skeletons = docs.skeletons.skeletons ?? [];
  cache = { ...docs, sources: docs.sources.sources ?? [], pages: docs['page-map'].pages ?? [], methods: docs.methods.methods ?? [], skeletons, variants: docs.variants.variants ?? [], examples: docs.examples.examples ?? [], warnings: docs.warnings.warnings ?? [], relations: docs.relations.relations ?? {}, aliases: docs.aliases.aliases ?? {}, bySkeletonId: new Map(skeletons.map((s) => [s.id, s])) };
  return cache;
}
export async function isWritingKnowledgeBuilt() { return FILES.every((f) => existsSync(path.join(DIR, `${f}.json`))); }
function aliasMatches(value, aliasMap, requested) { if (!requested) return true; const text = String(requested).toLowerCase(); return String(value ?? '').toLowerCase() === text || (aliasMap?.[value] ?? []).some((a) => String(a).toLowerCase() === text); }
function matchesTask(skeleton, task, aliases) { return !task || aliasMatches(skeleton.applicability?.[0], aliases?.task, task) || skeleton.applicability?.some((v) => aliasMatches(v, aliases?.task, task)); }
export async function queryWritingSkeletons({ task, function: rhetoricalFunction, applicability, keyword, productionOnly = true, limit = 200 } = {}) {
  const kb = await loadWritingKnowledge(); let list = kb.skeletons;
  if (productionOnly) list = list.filter((s) => s.productionEligible === true);
  if (task) list = list.filter((s) => matchesTask(s, task, kb.aliases));
  if (rhetoricalFunction) list = list.filter((s) => aliasMatches(s.rhetoricalFunction, kb.aliases.function, rhetoricalFunction));
  if (applicability) list = list.filter((s) => s.applicability.some((v) => aliasMatches(v, kb.aliases.applicability, applicability)));
  if (keyword?.trim()) { const q = keyword.trim().toLowerCase(); list = list.filter((s) => `${s.en}\n${s.zh}\n${s.semanticKey}\n${s.slots.join('\n')}`.toLowerCase().includes(q)); }
  return list.slice(0, Number.isFinite(Number(limit)) ? Number(limit) : 200);
}
export async function queryWritingMethods({ category, keyword, limit = 200 } = {}) { const kb = await loadWritingKnowledge(); let list = kb.methods; if (category) list = list.filter((m) => m.category === category); if (keyword) list = list.filter((m) => m.text.includes(keyword)); return list.slice(0, limit); }
export async function queryWritingWarnings({ keyword, limit = 200 } = {}) { const kb = await loadWritingKnowledge(); let list = kb.warnings; if (keyword) list = list.filter((w) => w.text.includes(keyword)); return list.slice(0, limit); }
export async function queryWritingExamples({ task, applicability, year, keyword, limit = 200 } = {}) { const kb = await loadWritingKnowledge(); let list = kb.examples; if (task) list = list.filter((e) => (e.skeletonIds ?? []).some((id) => matchesTask(kb.bySkeletonId.get(id) ?? {}, task, kb.aliases))); if (applicability) list = list.filter((e) => (e.skeletonIds ?? []).some((id) => (kb.bySkeletonId.get(id)?.applicability ?? []).some((v) => aliasMatches(v, kb.aliases.applicability, applicability)))); if (year) list = list.filter((e) => e.year === String(year)); if (keyword) list = list.filter((e) => `${e.label}\n${e.en ?? ''}\n${e.zh ?? ''}`.toLowerCase().includes(String(keyword).toLowerCase())); return list.slice(0, limit); }
export async function getWritingVariants(skeletonId) { const kb = await loadWritingKnowledge(); return kb.variants.filter((v) => v.skeletonId === skeletonId); }
export async function getWritingStats() { const kb = await loadWritingKnowledge(); return kb.skeletons.reduce((out, s) => { out.skeletons += 1; out.productionSkeletons += Number(s.productionEligible); return out; }, { pages: kb.pages.length, methods: kb.methods.length, warnings: kb.warnings.length, skeletons: 0, productionSkeletons: 0, variants: kb.variants.length, examples: kb.examples.length }); }
