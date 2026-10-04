import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DIR } from './paths.mjs';
import { TEMPLATE_TRACKS, enrichTemplate, getModule } from './modules.mjs';

/**
 * 知识库加载器。只读经过 verify-kb + build-kb 产出的正式文件，
 * 不直接读 raw-*.json，避免未验收内容进入生成链路。
 */

const FILES = {
  templates: 'templates.json',
  vocab: 'vocab.json',
  index: 'index.json',
  layout: 'layout.json',
  pages: 'pages.json',
};

let cache = null;

export class KnowledgeMissingError extends Error {
  constructor(missing) {
    super(
      `知识库尚未构建，缺少：${missing.join('、')}。` +
      '请先运行 node scripts/verify-kb.mjs 通过验收，再运行 node scripts/build-kb.mjs 构建。',
    );
    this.name = 'KnowledgeMissingError';
    this.status = 503;
    this.code = 'kb_not_built';
  }
}

export async function loadKnowledge({ force = false } = {}) {
  if (cache && !force) return cache;

  const missing = Object.values(FILES).filter((f) => !existsSync(path.join(KNOWLEDGE_DIR, f)));
  if (missing.length) throw new KnowledgeMissingError(missing);

  const read = async (file) => JSON.parse(await readFile(path.join(KNOWLEDGE_DIR, file), 'utf8'));
  const [templates, vocab, index, layout, pages] = await Promise.all([
    read(FILES.templates), read(FILES.vocab), read(FILES.index), read(FILES.layout), read(FILES.pages),
  ]);

  const rawEntries = templates.entries ?? [];
  const sources = templates.meta?.sources ?? [];
  const entries = rawEntries.map((entry) => enrichTemplate(entry, sources));
  cache = {
    meta: templates.meta ?? null,
    entries,
    byId: new Map(entries.map((e) => [e.id, e])),
    vocab: vocab.vocab ?? [],
    index: { byKind: index.byKind ?? {}, bySlot: index.bySlot ?? {}, byLetterType: index.byLetterType ?? {} },
    layouts: layout.layouts ?? [],
    pages: pages.pages ?? [],
  };
  return cache;
}

export async function isBuilt() {
  return Object.values(FILES).every((f) => existsSync(path.join(KNOWLEDGE_DIR, f)));
}

/** 按 kind / track / module / letterType / 页码 / 关键词筛选模板，供界面浏览与选配使用 */
export async function queryTemplates({ kind, kinds, track, module, letterType, page, keyword, ids, limit = 200 } = {}) {
  const kb = await loadKnowledge();
  let list = kb.entries;

  if (ids?.length) {
    const wanted = new Set(ids);
    return kb.entries.filter((e) => wanted.has(e.id));
  }
  const kindSet = kinds?.length ? new Set(kinds) : kind ? new Set([kind]) : null;
  if (kindSet) list = list.filter((e) => kindSet.has(e.kind));
  if (track) list = list.filter((e) => e.module?.track === track);
  if (module) list = list.filter((e) => e.module?.id === module);
  if (letterType) list = list.filter((e) => e.letterType === letterType);
  if (page) list = list.filter((e) => e.page === Number(page));

  if (keyword?.trim()) {
    const kw = keyword.trim().toLowerCase();
    list = list.filter((e) => {
      const hay = [e.en, e.zh, e.section, e.pageTitle, ...(e.slots ?? []), ...(e.swappable ?? [])]
        .join('\n').toLowerCase();
      return hay.includes(kw);
    });
  }
  const numericLimit = Number(limit);
  return list.slice(0, Number.isFinite(numericLimit) && numericLimit >= 0 ? numericLimit : 200);
}

/**
 * 按轨道和模块组织模板。track/module/letterType 均为可选过滤条件；
 * 返回的轨道及模块顺序由 modules.mjs 的显式 order 保证。
 */
export async function queryModules({ track, module, letterType } = {}) {
  const moduleDefinition = module ? getModule(module) : null;
  if (module && !moduleDefinition) return [];
  const effectiveTrack = track ?? moduleDefinition?.track;
  // 与正式成文链路一致：小作文专项句优先展示，同时保留无 letterType 的通用句兜底，
  // 避免某些题型只收录了主体句而缺少开头或结尾模块。
  let templates;
  if (letterType && effectiveTrack === 'small') {
    const allSmallTemplates = await queryTemplates({ track: effectiveTrack, module, limit: Number.MAX_SAFE_INTEGER });
    templates = allSmallTemplates.filter((entry) => !entry.letterType || entry.letterType === letterType);
    templates.sort((a, b) => Number(Boolean(b.letterType)) - Number(Boolean(a.letterType)));
  } else {
    templates = await queryTemplates({ track: effectiveTrack, module, letterType, limit: Number.MAX_SAFE_INTEGER });
  }
  const grouped = new Map();
  for (const template of templates) {
    if (!template.module) continue;
    (grouped.get(template.module.id) ?? grouped.set(template.module.id, []).get(template.module.id)).push(template);
  }

  return TEMPLATE_TRACKS
    .filter((definition) => !effectiveTrack || definition.id === effectiveTrack)
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      order: definition.order,
      count: definition.modules.reduce((sum, item) => sum + (grouped.get(item.id)?.length ?? 0), 0),
      modules: definition.modules
        .filter((item) => !module || item.id === module)
        .map((item) => ({
          ...item,
          count: grouped.get(item.id)?.length ?? 0,
          templates: grouped.get(item.id) ?? [],
        })),
    }))
    .filter((definition) => !module || definition.modules.length > 0);
}

export async function getTemplates(ids = []) {
  const kb = await loadKnowledge();
  const found = [];
  const missing = [];
  for (const id of ids) {
    const entry = kb.byId.get(id);
    if (entry) found.push(entry);
    else missing.push(id);
  }
  return { found, missing };
}

/** 词库检索：供替换词优化步骤引用 PDF 原始词表 */
export async function queryVocab({ keyword, page, limit = 100 } = {}) {
  const kb = await loadKnowledge();
  let list = kb.vocab;
  if (page) list = list.filter((v) => v.page === Number(page));
  if (keyword?.trim()) {
    const kw = keyword.trim().toLowerCase();
    list = list.filter((v) => `${v.en}\n${v.zh}`.toLowerCase().includes(kw));
  }
  return list.slice(0, limit);
}

export async function getStats() {
  const kb = await loadKnowledge();
  const kindCounts = {};
  for (const entry of kb.entries) kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
  return {
    meta: kb.meta,
    pages: kb.pages.length,
    entries: kb.entries.length,
    vocab: kb.vocab.length,
    layouts: kb.layouts.length,
    kindCounts,
    letterTypes: Object.keys(kb.index.byLetterType),
  };
}
