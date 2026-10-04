import { chatJson } from './deepseek.mjs';
import { loadKnowledge, queryTemplates, queryVocab } from './kb.mjs';
import { classify, planTemplateKinds } from './classify.mjs';

/**
 * 解析链核心：把「模板句 + 替换词」这一中心思想拆成可见的步骤。
 * 每一步都记录用了知识库的哪一条、来自 PDF 哪一页，绝不做黑箱。
 */

const SLOT_RE = /\{([^{}]+)\}|\[([^[\]]+)\]/g;

/** 抽取句子里的全部占位符：{一级} 与 [二级] */
export function extractSlots(text = '') {
  const found = [];
  for (const m of String(text).matchAll(SLOT_RE)) {
    const name = m[1] ?? m[2];
    const kind = m[1] ? 'primary' : 'secondary';
    const raw = m[0];
    if (!found.some((f) => f.raw === raw)) found.push({ name, kind, raw });
  }
  return found;
}

const SENTENCE_SEGMENTER = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
  ? new Intl.Segmenter('en', { granularity: 'sentence' })
  : null;

function getTemplateModule(entry = {}) {
  return entry.module ?? {
    id: entry.kind ?? 'template',
    label: entry.pageTitle ?? entry.section ?? entry.kind ?? '作文模板',
  };
}

function getTemplateSourceInfo(entry = {}, meta = null) {
  const attached = entry.sourceInfo ?? (entry.source && typeof entry.source === 'object' ? entry.source : null);
  const page = attached?.page ?? entry.page ?? null;
  if (attached) return { ...attached, page, key: attached.key ?? attached.source ?? entry.id ?? null };
  const sourceId = typeof entry.source === 'string' ? entry.source : 'scan-handout';
  const isScan = sourceId === 'scan-handout';
  const label = meta?.sources?.find((source) => source.source === sourceId)?.sourceLabel
    ?? meta?.source
    ?? '考研英语作文讲义';
  return {
    source: sourceId,
    sourceLabel: label,
    label,
    origin: entry.origin ?? label,
    key: sourceId,
    page,
    href: isScan && page ? `/pages/p${String(page).padStart(2, '0')}.png` : null,
  };
}

function splitSentenceText(text = '') {
  const value = String(text ?? '').trim();
  if (!value) return [];
  if (SENTENCE_SEGMENTER) {
    const parts = [...SENTENCE_SEGMENTER.segment(value)]
      .map(({ segment }) => segment.trim())
      .filter(Boolean);
    if (parts.length) return parts;
  }
  return value.match(/[^.!?]+(?:[.!?]+["']?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [value];
}

function templateTrace(entry = {}, meta = null) {
  const sourceInfo = getTemplateSourceInfo(entry, meta);
  return {
    templateId: entry.templateId ?? entry.id ?? null,
    module: getTemplateModule(entry),
    sourceInfo,
    page: sourceInfo.page ?? entry.page ?? null,
    originalTemplate: entry.originalTemplate ?? entry.original ?? entry.en ?? '',
  };
}

function sentenceWords(text = '') {
  return new Set(String(text).toLowerCase().match(/[a-z']{3,}/g) ?? []);
}

function sentenceSimilarity(left, right) {
  const a = sentenceWords(left);
  const b = sentenceWords(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return (2 * common) / (a.size + b.size);
}

function paragraphSourceUnits(section) {
  return (section?.sentences ?? []).flatMap((item) => {
    const trace = templateTrace(item);
    const expected = splitSentenceText(item.filled || item.original || item.originalTemplate);
    return (expected.length ? expected : ['']).map((text) => ({ text, trace }));
  });
}

/** 旧式 sentences:string[] 没有 id 时，按固定词相似度并结合原顺序回配来源。 */
function matchLegacySentenceSources(sentences, section) {
  const units = paragraphSourceUnits(section);
  if (!units.length) return sentences.map(() => templateTrace());
  let cursor = 0;
  return sentences.map((sentence) => {
    let bestIndex = Math.min(cursor, units.length - 1);
    let bestSimilarity = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < units.length; index += 1) {
      const similarity = sentenceSimilarity(sentence, units[index].text);
      const score = similarity * 100 - Math.abs(index - cursor) * 2 - (index < cursor ? 20 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestSimilarity = similarity;
        bestIndex = index;
      }
    }
    if (bestSimilarity < 0.08) bestIndex = Math.min(cursor, units.length - 1);
    if (bestIndex >= cursor) cursor = Math.min(bestIndex + 1, units.length);
    return { ...units[bestIndex].trace };
  });
}

function blockTextParts(block) {
  if (Array.isArray(block?.sentences)) return block.sentences.flatMap(splitSentenceText);
  return splitSentenceText(block?.text ?? block?.sentence ?? '');
}

/** 将模型的新旧协议统一成 paragraphs[].sentences + sentenceSources。 */
export function normalizeEssayParagraphs(rawParagraphs, filledSections) {
  const raw = Array.isArray(rawParagraphs) ? rawParagraphs : [];
  const filled = Array.isArray(filledSections) ? filledSections : [];
  const count = Math.max(raw.length, filled.length);
  const normalized = [];

  for (let index = 0; index < count; index += 1) {
    const paragraph = raw[index] ?? {};
    const section = filled.find((item) => item.name === paragraph.name) ?? filled[index];
    const sourceItems = section?.sentences ?? [];
    const sourceById = new Map(sourceItems.map((item) => [String(item.templateId), templateTrace(item)]));
    const explicitBlocks = Array.isArray(paragraph.sentenceBlocks)
      ? paragraph.sentenceBlocks
      : (Array.isArray(paragraph.sentences) && paragraph.sentences.some((item) => item && typeof item === 'object' && item.templateId)
          ? paragraph.sentences
          : null);

    let sentences = [];
    let sentenceSources = [];
    if (explicitBlocks) {
      for (const block of explicitBlocks) {
        const parts = blockTextParts(block);
        if (!parts.length) continue;
        const explicit = sourceById.get(String(block.templateId));
        const fallback = matchLegacySentenceSources(parts, section);
        sentences.push(...parts);
        sentenceSources.push(...parts.map((_, partIndex) => ({
          ...(explicit ?? fallback[partIndex] ?? templateTrace()),
          templateId: explicit?.templateId ?? block.templateId ?? fallback[partIndex]?.templateId ?? null,
        })));
      }
    } else {
      sentences = (paragraph.sentences ?? []).flatMap((item) => splitSentenceText(
        typeof item === 'string' ? item : item?.text ?? item?.sentence ?? '',
      ));
      sentenceSources = matchLegacySentenceSources(sentences, section);
    }

    if (!sentences.length && sourceItems.length) {
      for (const item of sourceItems) {
        const parts = splitSentenceText(item.filled);
        sentences.push(...parts);
        sentenceSources.push(...parts.map(() => templateTrace(item)));
      }
    }

    const { sentenceBlocks: _sentenceBlocks, ...rest } = paragraph;
    normalized.push({
      ...rest,
      name: paragraph.name ?? section?.name ?? `第${index + 1}段`,
      sentences,
      sentenceSources,
    });
  }
  return normalized;
}

// ---------- 步骤三：模板选配 ----------

/**
 * 按段落规划挑选候选模板。
 * 小作文优先取匹配 letterType 的专项句，大作文按 polarity 匹配正/负版本。
 */
export async function selectTemplates(final) {
  const plan = await planTemplateKinds(final);
  const sections = [];

  for (const para of plan.paragraphs) {
    let candidates = await queryTemplates({ kinds: para.kinds, limit: 500 });

    // 小作文：题型专项句优先，通用句兜底
    if (final.category === '小作文' && final.letterType) {
      const typed = candidates.filter((c) => c.letterType === final.letterType);
      const generic = candidates.filter((c) => !c.letterType);
      candidates = [...typed, ...generic];
    }

    // 大作文/图表：按褒贬倾向过滤结尾段的正负版本
    if (final.polarity && para.kinds.includes('big-essay-closing')) {
      const wanted = final.polarity === '负面' ? '反面' : '正面';
      const matched = candidates.filter((c) => c.section?.includes(wanted));
      if (matched.length) candidates = matched;
    }

    sections.push({
      name: para.name,
      kinds: para.kinds,
      candidates: candidates.map((c) => ({
        id: c.id,
        page: c.page,
        pageTitle: c.pageTitle,
        kind: c.kind,
        module: getTemplateModule(c),
        sourceInfo: getTemplateSourceInfo(c),
        section: c.section,
        letterType: c.letterType ?? null,
        en: c.en,
        zh: c.zh,
        slots: c.slots,
        swappable: c.swappable,
        notes: c.notes,
        examples: c.examples,
      })),
    });
  }

  return { wordCount: plan.wordCount, sections };
}

const SELECT_SYSTEM = `你是考研英语作文模板选配助手。你的职责是从给定候选模板中为每个段落挑选合适的句子，不要自己造句。

规则：
1. 只能从候选列表里挑，必须原样引用候选的 id。禁止编造 id。
2. 每段挑选的句子数量必须严格遵守：
   - 普通书信类小作文（目标约 100 词）：第一段 2 句、第二段 2-3 句、第三段 1-2 句
   - 通知类/公告类应用文（目标约 100 词）：第一段 1 句、第二段 2-3 句、第三段 1 句
   - 大作文（目标 160-200 词）：第一段 2 句（描述 + 点题）、第二段主体论证、第三段建议 + 展望。
     判断标准是【词数】而不是条数：把三段模板句的英文词数加起来，应落在 170-195 词之间（瞄准 180 词左右，不要贴着 160 或 200）。
     * 如果第二段选中的是一条完整主体段模板（本身已含 3-4 句、约 70-90 词），那第二段就只选这 1 条。
     * 如果候选都是单句模板（每句约 20-30 词），第二段要选 3-4 句，第三段选 2 句，否则会严重字数不足。
     选完后自己核算一次总词数：低于 160 词必须再补句，高于 200 词必须减句。
   - 图表作文（目标 180-220 词，字数不足会扣分，务必选足）：
     * 第一段必须选 3 句：① 图表引入句（Given is a.../This is a...）② 最大项/起点句 ③ 次序与末位项句（Then, the next.../Finally comes...）或趋势对比句（By contrast...）
     * 第二段必须选 3 句：① 承接数据的设问过渡句（Such statistics... but what resulted in...）② 原因一（For one thing...）③ 原因二（For another...）
     * 第三段必须选 2 句：① 针对性建议句（Accordingly... are supposed to...）② 展望句（If they do their utmost...）
     绝不能第一段只选 1 句或第二段只写 1 条原因，那样必然字数不足。
3. 挑选要贴合题目：优先选那些占位符能被题目信息自然填满的句子。
4. 同一段落内挑的句子要能顺畅衔接，不要重复同一句式，也不要挑语义重复的句子。
   特别注意：如果两个候选句填入题目信息后会表达相同的意思（比如都在说"邀请你参加X"），只能挑其中一句。
5. 必须为每次挑选写出理由（reason），说明为什么这句适合这道题。

严格返回 JSON：
{"sections":[{"name":"段落名","picks":[{"id":"候选id","reason":"挑选理由（中文，一句）"}]}]}`;

export async function pickTemplates(final, selection, questionText) {
  const brief = selection.sections.map((s) => ({
    name: s.name,
    candidates: s.candidates.slice(0, 40).map((c) => ({
      id: c.id,
      page: c.page,
      section: c.section,
      en: c.en,
      slots: c.slots,
    })),
  }));

  const { data, usage } = await chatJson({
    tier: 'reasoning',
    system: SELECT_SYSTEM,
    messages: [{
      role: 'user',
      content: `题目：\n${questionText}\n\n判定结果：${JSON.stringify(final, null, 2)}\n\n候选模板：\n${JSON.stringify(brief, null, 2)}`,
    }],
    temperature: 0.2,
    maxTokens: 4096,
  });

  const kb = await loadKnowledge();
  const picked = [];
  const invalid = [];
  const trimmed = [];

  // 确定性兜底：按「累计模板词数」而不是固定条数控制规模。
  // 只砍掉会让全文明显超出目标上限的多余模板，避免把主体段削得字数不足。
  // 瞄准接受区间上沿（中点 +10%），润色阶段通常略增词，这里不再按考试上限凑句。
  const budget = acceptedWordBand(selection.wordCount)[1];
  const templateWords = (text = '') => String(text).split(/\s+/).filter(Boolean).length;
  const sectionList = data.sections ?? [];

  // 为后续每个段落各预留一条模板的额度，避免前面的段落把预算吃光、
  // 导致结尾段只剩空壳；同时保证总词数不会明显超出上限。
  const firstPickCost = sectionList.map((section) => {
    for (const pick of section.picks ?? []) {
      const entry = kb.byId.get(pick.id);
      if (entry) return templateWords(entry.en);
    }
    return 0;
  });
  let usedWords = 0;

  for (const [sectionIndex, section] of sectionList.entries()) {
    const items = [];
    const reserved = firstPickCost.slice(sectionIndex + 1).reduce((sum, cost) => sum + cost, 0);
    for (const pick of section.picks ?? []) {
      const entry = kb.byId.get(pick.id);
      if (!entry) {
        invalid.push(pick.id);
        continue;
      }
      const cost = templateWords(entry.en);
      // 每段至少保留 1 条，保证段落结构完整；之后才按词数预算裁剪。
      if (items.length >= 1 && usedWords + cost + reserved > budget) {
        trimmed.push(pick.id);
        continue;
      }
      usedWords += cost;
      items.push({
        id: entry.id,
        page: entry.page,
        pageTitle: entry.pageTitle,
        kind: entry.kind,
        module: getTemplateModule(entry),
        sourceInfo: getTemplateSourceInfo(entry, kb.meta),
        section: entry.section,
        en: entry.en,
        zh: entry.zh,
        slots: entry.slots,
        swappable: entry.swappable,
        notes: entry.notes,
        examples: entry.examples,
        placeholders: extractSlots(entry.en),
        reason: pick.reason ?? '',
      });
    }
    picked.push({ name: section.name, items });
  }

  // 字数不足不再补模板。新链路会回到内容计划增加新的原因、例证或影响，
  // 再为该内容单元选择一个语义唯一的骨架，避免同义句和正反观点被同时塞入。
  return { picked, invalid, trimmed, usage };
}

// ---------- 步骤四：关键词提取与替换优化 ----------

const FILL_SYSTEM = `你是考研英语作文的「占位符填充与替换词优化」助手。

任务：为模板里的每个占位符输出最地道、最贴切的英文填充词，并对可替换词给出优化建议。

【图表/数据题铁律——防止低级逻辑错误】：
1. 数据升降一致性：必须核对数值走势！若起点数值低于终点数值（如 83.7 到 98.2，或 75.2 到 145.9），属于上升/增长！严禁将模板中的趋势词填充为 declined / decreased / dropped 等下降词，必须使用 increased / rose / showed a growth / ascended 等上升词。
2. 单位与量词匹配：严格看清图表单位！
   - 若单位是“台/每百户”、“件”、“人”、“元”等非百分比数据，严禁使用 percentage of / share of / proportion of！必须替换为 number of / figure for / average quantity of / ownership of。
   - 只有当数据单位是 % 或百分比时，才允许使用 percentage / share / proportion。

规则：
1. 填充值必须是地道英文，语法上直接嵌入句子（注意单复数、时态、动词ing形式）。
2. 同一占位符在不同句子里出现时，尽量换不同英文表达，避免重复。
3. 理由用中文，简明一句话。

严格返回紧凑 JSON：
{
  "fills": [
    { "templateId": "模板ID", "raw": "{题目相关词}", "name": "题目相关词", "value": "直接给出最推荐的英文表达", "reason": "中文理由" }
  ],
  "swaps": [
    { "templateId": "模板ID", "original": "原词", "suggestion": "建议替换词", "reason": "中文理由" }
  ]
}`;

export async function optimizeFills(final, picked, questionText) {
  const sectionsWithTargets = picked.map((section) => {
    const targets = [];
    for (const item of section.items) {
      if (item.placeholders?.length || item.swappable?.length) {
        targets.push({
          templateId: item.id,
          en: item.en,
          zh: item.zh,
          placeholders: item.placeholders ?? [],
          swappable: item.swappable ?? [],
          examples: item.examples ?? [],
        });
      }
    }
    return { name: section.name, targets };
  }).filter((s) => s.targets.length > 0);

  if (!sectionsWithTargets.length) return { fills: [], swaps: [], vocabRefs: [], usage: null };

  const vocabRefs = await queryVocab({ limit: 60 });
  const vocabSample = vocabRefs.slice(0, 30).map((v) => `${v.en} = ${v.zh}`).join('\n');

  // 按段落顺序填充：避免并发请求踩爆 API 的 RPM / Rate Limit 限制
  const results = [];
  for (const { name, targets } of sectionsWithTargets) {
    const { data } = await chatJson({
      tier: 'fast',
      system: FILL_SYSTEM,
      messages: [{
        role: 'user',
        content:
          `题目：\n${questionText}\n\n判定结果：${JSON.stringify(final)}\n\n` +
          `当前段落：${name}\n\n` +
          `讲义自带词表参考：\n${vocabSample}\n\n` +
          `该段待填充模板：\n${JSON.stringify(targets, null, 2)}`,
      }],
      temperature: 0.2,
      maxTokens: 4096,
    });
    results.push({
      fills: data.fills ?? [],
      swaps: data.swaps ?? [],
    });
  }

  return {
    fills: results.flatMap((r) => r.fills),
    swaps: results.flatMap((r) => r.swaps),
    vocabRefs: vocabRefs.slice(0, 20),
    usage: null,
  };
}

/** 用填充结果把占位符替换掉，得到「机械填充版」，作为骨架校验的基准 */
export function applyFills(picked, fills) {
  const byTemplate = new Map();
  for (const fill of fills) {
    if (!byTemplate.has(fill.templateId)) byTemplate.set(fill.templateId, []);
    byTemplate.get(fill.templateId).push(fill);
  }

  const result = [];
  for (const section of picked) {
    const sentences = [];
    for (const item of section.items) {
      let text = item.en;
      const used = [];
      for (const fill of byTemplate.get(item.id) ?? []) {
        const value = fill.value || fill.recommended || fill.candidates?.[0]?.en;
        if (!value || !fill.raw) continue;
        if (text.includes(fill.raw)) {
          text = text.split(fill.raw).join(value);
          used.push({ raw: fill.raw, value, reason: fill.reason ?? '' });
        }
      }
      sentences.push({
        templateId: item.id,
        module: item.module ?? getTemplateModule(item),
        sourceInfo: item.sourceInfo ?? getTemplateSourceInfo(item),
        page: item.sourceInfo?.page ?? item.page,
        original: item.en,
        originalTemplate: item.en,
        filled: text,
        fills: used,
        leftover: extractSlots(text),
      });
    }
    result.push({ name: section.name, sentences });
  }
  return result;
}

// ---------- 步骤五：成文与自检 ----------

const WRITE_SYSTEM = `你是考研英语作文成文助手。给你的是已经填好占位符的模板句，你只做最小必要的语法润色与衔接。

铁律：
1. 保持模板骨架，禁止无故删改结构。
2. 【数据与事实绝对正确】：
   - 检查所有趋势词与数据是否匹配！例如从 83.7 到 98.2 是增加，如果模板里残留了 decline / decrease 等词，必须修正为 increase / rise / grow / show growth。
   - 检查量词与单位是否匹配！如果单位是拥有量/台数（如 103.4 台），严禁写成 "the percentage of refrigerators was 103.4" 或 "the share of..."，必须修正为 "the figure for refrigerators..." 或 "the number of refrigerators..." 或 "the ownership of refrigerators..."。
3. 单复数、时态、冠词、介词搭配一致。
4. 普通书信必须保留称呼行与落款（Dear ... , / Yours sincerely, / Li Ming）。
   通知类、公告类不是书信：不得写 Dear... 或 Yours sincerely；标题写 Notice，落款写题目指定机构（未指定时用 The Students' Union）。
5. 每个输入模板块必须在对应段落原样保留 templateId。即使一个模板块润色后包含多句，也必须作为同一个 sentenceBlocks 项返回；禁止合并不同 templateId 的内容或编造 templateId。
6. 【字数硬约束】必须把全文总词数控制在给定目标区间内（含上限）。如果模板句叠加后会超出上限，就在保留每个 templateId 的前提下精简冗余修饰、合并啰嗦从句、删掉重复例证，而不是照抄全部内容。绝不允许超过上限。

返回 JSON（paragraphs 必须使用 sentenceBlocks；服务端仍兼容旧版 sentences 字符串数组）：
{"title":null,"date":null,"paragraphs":[{"name":"段落名","sentenceBlocks":[{"templateId":"输入模板ID","text":"该模板块润色后的完整英文，可含多句"}]}],"salutation":null,"signature":null,"wordCount":0,"adjustments":[{"templateId":"","change":"改了什么（中文简述）"}]}`;

export async function writeEssay(final, filledSections, questionText, wordCount) {
  const payload = filledSections.map((s) => ({
    name: s.name,
    sentenceBlocks: s.sentences.map((x) => ({
      templateId: x.templateId,
      module: x.module,
      sourceInfo: x.sourceInfo,
      page: x.page,
      originalTemplate: x.originalTemplate ?? x.original,
      text: x.filled,
    })),
  }));

  const { data, usage } = await chatJson({
    tier: 'fast',
    system: WRITE_SYSTEM,
    messages: [{
      role: 'user',
      content:
        `题目：\n${questionText}\n\n判定：${JSON.stringify(final)}\n` +
        `目标字数：${wordCount}（请把全文总词数写在 ${acceptedWordBand(wordCount).join('-')} 词之间，瞄准中间值，不要贴着区间两端）\n\n` +
        `已填充的模板句：\n${JSON.stringify(payload, null, 2)}` +
        (final.category === '小作文'
          ? (['通知类', '公告类'].includes(final.letterType)
              ? '\n\n这是通知/公告类应用文：title 固定为 "Notice"，salutation 必须为 null；signature 使用题目指定机构，未指定则为 "The Students\' Union"；不得写 Yours sincerely 或 Li Ming。'
              : '\n\n这是普通书信类小作文，请给出 salutation（如 "Dear Jack,"）与 signature（固定为 "Yours sincerely,\\nLi Ming"）。')
          : ''),
    }],
    temperature: 0.2,
    maxTokens: 4096,
  });

  // 通知/公告格式是讲义 p43 的硬规则，不交给模型自由决定。
  if (['通知类', '公告类'].includes(final.letterType)) {
    data.title = 'Notice';
    data.salutation = null;
    data.signature = /学生会|Students'? Union/i.test(questionText) ? "The Students' Union" : (data.signature || "The Students' Union");
    if (/Yours sincerely|Li Ming/i.test(data.signature)) data.signature = "The Students' Union";
  }

  data.paragraphs = normalizeEssayParagraphs(data.paragraphs, filledSections);
  data.sentenceSources = data.paragraphs.flatMap((paragraph) => paragraph.sentenceSources);
  const compressed = await enforceWordLimit(data, wordCount);
  return { ...compressed, usage };
}

/** 统计成文词数 */
function essayWordCount(essay) {
  return (essay.paragraphs ?? [])
    .flatMap((p) => p.sentences ?? [])
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** 解析目标字数区间：'160-200 词' → [160, 200]；'约 100 词' → [100, 100] */
function wordRange(wordCountTarget) {
  const range = String(wordCountTarget).match(/(\d+)\s*[-–~]\s*(\d+)/);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = String(wordCountTarget).match(/(\d+)/);
  return single ? [Number(single[1]), Number(single[1])] : [180, 220];
}

/** 目标字数上限 */
function wordCeiling(wordCountTarget) {
  return wordRange(wordCountTarget)[1];
}

/** 判定与调整都以区间中点 ±10% 为准：160-200 词 → [162, 198] */
function acceptedWordBand(wordCountTarget) {
  const [low, high] = wordRange(wordCountTarget);
  const center = (low + high) / 2;
  return [Math.round(center * 0.9), Math.round(center * 1.1)];
}

/**
 * 字数兜底：偏离目标区间（含 ±10% 容差）时，让模型在保留全部 templateId
 * 与段落骨架的前提下压缩或扩写一次。调整无效则保留原文，绝不丢句子来源。
 */
async function enforceWordLimit(essay, wordCountTarget) {
  const [min, max] = acceptedWordBand(wordCountTarget);
  const [low, high] = [min, max];
  const words = essayWordCount(essay);
  if (!words || (words >= min && words <= max)) return essay;

  const tooLong = words > max;
  const payload = (essay.paragraphs ?? []).map((paragraph) => ({
    name: paragraph.name,
    sentenceBlocks: (paragraph.sentences ?? []).map((text, index) => ({
      templateId: paragraph.sentenceSources?.[index]?.templateId ?? null,
      text,
    })),
  }));

  const target = Math.round((min + max) / 2);
  const distance = (n) => (n < min ? min - n : n > max ? n - max : 0);
  let best = essay;
  let bestWords = words;

  // 最多尝试两轮：模型一次往往调不到位，尤其是需要大幅扩写时。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (distance(bestWords) === 0) break;
    const long = bestWords > max;
    const blocks = (best.paragraphs ?? []).map((paragraph) => ({
      name: paragraph.name,
      sentenceBlocks: (paragraph.sentences ?? []).map((text, index) => ({
        templateId: paragraph.sentenceSources?.[index]?.templateId ?? null,
        text,
      })),
    }));
    const blockCount = blocks.reduce((sum, p) => sum + p.sentenceBlocks.length, 0) || 1;
    const perBlock = Math.max(12, Math.round(target / blockCount));

    const task = long
      ? `把作文压缩到 ${low}-${high} 词（当前 ${bestWords} 词，偏多 ${bestWords - max} 词）。只删冗余修饰、重复例证和啰嗦从句，不得删掉整个模板块。`
      : `把作文扩充到 ${low}-${high} 词（当前 ${bestWords} 词，还差 ${min - bestWords} 词）。必须在现有模板块内部实质性展开：补充具体例证、原因分析、影响说明或对比论证。平均每个模板块约 ${perBlock} 词。`;

    try {
      const { data } = await chatJson({
        tier: 'fast',
        system: `你是考研英语作文字数调整助手。${task}

规则：
1. 段落数量、顺序与每段的 templateId 集合必须完全保持不变，每个 templateId 都要保留。
2. 保持模板骨架句式与论证立场，只在块内做必要的增补或精简。
3. 语法、时态、单复数、搭配必须正确，行文自然连贯，符合考研写作语域。
4. 【硬性要求】调整后全文总词数必须落在 ${low}-${high} 词之间，最理想是 ${target} 词左右。返回前请自己数一遍词数。
5. 扩写时禁止空话和同义重复，要写出有信息量的具体内容。

严格返回 JSON：
{"paragraphs":[{"name":"段落名","sentenceBlocks":[{"templateId":"原 templateId","text":"调整后的英文"}]}]}`,
        messages: [{
          role: 'user',
          content: `当前 ${bestWords} 词，目标 ${low}-${high} 词（${long ? '偏多，需压缩' : '偏少，需扩充'}）。\n\n作文：\n${JSON.stringify(blocks, null, 2)}`,
        }],
        temperature: 0.3,
        maxTokens: 4096,
      });

      const rebuilt = normalizeEssayParagraphs(data.paragraphs, blocks.map((p) => ({
        name: p.name,
        sentences: p.sentenceBlocks.map((b) => ({ templateId: b.templateId, filled: b.text })),
      })));
      const next = {
        ...best,
        paragraphs: rebuilt,
        sentenceSources: rebuilt.flatMap((p) => p.sentenceSources),
      };
      const nextWords = essayWordCount(next);
      // 只有真正更接近目标区间才采用，避免越改越差。
      if (nextWords && distance(nextWords) < distance(bestWords)) {
        best = next;
        bestWords = nextWords;
      } else {
        break;
      }
    } catch {
      break; // 调整失败不影响成文，自检仍会提示字数问题。
    }
  }

  return bestWords === words ? essay : { ...best, wordCountAdjustedFrom: words };
}

/**
 * 骨架一致性校验：防止 AI 借润色之名把模板改写掉。
 * 做法是比对模板去掉占位符后的固定词序列，是否仍保留在成文句子中。
 */
export function verifySkeleton(filledSections, essayParagraphs) {
  const issues = [];
  const flatFilled = filledSections.flatMap((s) => s.sentences);
  const flatFinal = (essayParagraphs ?? []).flatMap((p) => p.sentences ?? []);

  for (const source of flatFilled) {
    // 一个知识库条目可能本身是完整多句段落（如 p11 主体段）。
    // 必须逐句寻找最接近的成文句，再汇总固定词保留度；不能拿整个段落与单句比较。
    const templateSentences = source.original
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let totalAnchors = 0;
    let totalKept = 0;
    const matches = [];

    for (const templateSentence of templateSentences) {
      const anchorWords = templateSentence
        .replace(SLOT_RE, ' ')
        .toLowerCase()
        .split(/[^a-z']+/)
        .filter((w) => w.length > 3);

      if (!anchorWords.length) continue;
      totalAnchors += anchorWords.length;

      const best = flatFinal.reduce((acc, sentence) => {
        const lower = sentence.toLowerCase();
        const kept = anchorWords.filter((w) => lower.includes(w)).length;
        return kept > acc.kept ? { kept, sentence } : acc;
      }, { kept: 0, sentence: null });

      totalKept += best.kept;
      matches.push({ templateSentence, closest: best.sentence, kept: best.kept, total: anchorWords.length });
    }

    if (!totalAnchors) continue;
    const ratio = totalKept / totalAnchors;
    if (ratio < 0.6) {
      issues.push({
        templateId: source.templateId,
        page: source.page,
        ratio: Number(ratio.toFixed(2)),
        template: source.original,
        closest: matches.map((m) => m.closest).filter(Boolean).join(' '),
        matches,
        message: '成文与模板骨架偏离过大，可能被改写',
      });
    }
  }
  return issues;
}

/** 自检清单 */
export function selfCheck(final, essay, filledSections, wordCountTarget) {
  const sentences = (essay.paragraphs ?? []).flatMap((p) => p.sentences ?? []);
  const fullText = sentences.join(' ');
  const words = fullText.split(/\s+/).filter(Boolean).length;

  const leftover = filledSections
    .flatMap((s) => s.sentences)
    .flatMap((x) => x.leftover.map((l) => ({ templateId: x.templateId, raw: l.raw })));

  const stillHasPlaceholder = extractSlots(fullText);

  // 以目标区间的中点为基准上下各 10%：160-200 词 → 中点 180 → 接受 162-198。
  // 「约 100 词」这类单值目标直接以该值为中点，接受 90-110。
  const [low, high] = wordRange(wordCountTarget);
  const center = (low + high) / 2;
  const [min, max] = Number.isFinite(center) && center > 0
    ? [center * 0.9, center * 1.1]
    : [80, 120];

  // 检测语义重复：同一实义短语在全文出现 3 次以上视为啰嗦
  const phraseCounts = new Map();
  const lowerText = fullText.toLowerCase();
  for (const m of lowerText.matchAll(/\b[a-z]+(?:\s+[a-z]+){2,3}\b/g)) {
    const phrase = m[0];
    if (phrase.split(/\s+/).some((w) => w.length > 4)) {
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }
  const repeats = [...phraseCounts.entries()].filter(([, n]) => n >= 3).map(([p, n]) => `${p}（${n} 次）`);

  // 检测数据事实逻辑冲突：上升被写成 decline，或者百分比 > 100
  const logicErrors = [];

  const declineUp = lowerText.match(/(?:declin|decreas|fall|drop|slump)ed\s+from\s+(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)/i);
  if (declineUp && Number(declineUp[1]) < Number(declineUp[2])) {
    logicErrors.push(`数据从 ${declineUp[1]} 增长至 ${declineUp[2]}，却使用了下降动词 ${declineUp[0]}`);
  }

  const pctOver100 = lowerText.match(/(?:percentage|share|proportion)\s+of\s+[a-z\s]+(?:was|is|reached|at)\s+([1-9]\d{2,}(?:\.\d+)?)/i);
  if (pctOver100) {
    logicErrors.push(`百分比/份额表达使用了非百分比数值 ${pctOver100[1]}`);
  }

  const checks = [
    {
      name: '词数达标',
      pass: words >= min && words <= max,
      detail: `实际 ${words} 词，目标 ${wordCountTarget}（可接受 ${Math.round(min)}-${Math.round(max)}）`,
    },
    {
      name: '数据逻辑与事实准确',
      pass: logicErrors.length === 0,
      detail: logicErrors.length ? `发现数据逻辑矛盾：${logicErrors.join('；')}` : '数值走势与单位表达逻辑自洽',
    },
    {
      name: '无明显重复表达',
      pass: repeats.length === 0,
      detail: repeats.length ? `重复短语：${repeats.slice(0, 3).join('、')}` : '未发现重复短语',
    },
    {
      name: '占位符已全部替换',
      pass: stillHasPlaceholder.length === 0,
      detail: stillHasPlaceholder.length
        ? `仍残留：${stillHasPlaceholder.map((p) => p.raw).join('、')}`
        : '无残留',
    },
    {
      name: '填充阶段无遗漏',
      pass: leftover.length === 0,
      detail: leftover.length ? `未填充：${leftover.map((l) => l.raw).join('、')}` : '全部填充',
    },
    {
      name: '段落数正确',
      pass: (essay.paragraphs ?? []).length >= 3,
      detail: `${(essay.paragraphs ?? []).length} 段`,
    },
  ];

  if (final.category === '小作文') {
    const isNotice = ['通知类', '公告类'].includes(final.letterType);
    if (isNotice) {
      checks.push({
        name: '通知格式完整',
        pass: essay.title === 'Notice' && !essay.salutation && Boolean(essay.signature) && !/Yours sincerely|Li Ming/i.test(essay.signature),
        detail: `标题：${essay.title ?? '缺失'}；称呼：${essay.salutation ?? '无（正确）'}；落款：${essay.signature ?? '缺失'}`,
      });
    } else {
      checks.push({
        name: '称呼与落款完整',
        pass: Boolean(essay.salutation) && Boolean(essay.signature),
        detail: `称呼：${essay.salutation ?? '缺失'}；落款：${(essay.signature ?? '缺失').replace(/\n/g, ' / ')}`,
      });
    }
  }

  return { words, checks, allPass: checks.every((c) => c.pass) };
}

// ---------- 全链路 ----------

export async function composeFull(questionText, { onStep } = {}) {
  const steps = [];
  const record = (step) => {
    steps.push(step);
    onStep?.(step);
    return step;
  };

  // 步骤二：题型判定（步骤一 OCR 在路由层完成）
  const classification = await classify(questionText);
  record({
    step: 2,
    key: 'classify',
    title: '题型判定',
    data: {
      final: classification.final,
      rules: classification.rules,
      ai: classification.ai ? { category: classification.ai.category, letterType: classification.ai.letterType, reason: classification.ai.reason } : null,
      conflicts: classification.conflicts,
      needsConfirm: classification.needsConfirm,
    },
  });

  // 步骤三：模板选配
  const selection = await selectTemplates(classification.final);
  const { picked, invalid, trimmed, supplemented } = await pickTemplates(classification.final, selection, questionText);
  record({
    step: 3,
    key: 'templates',
    title: '模板选配',
    data: {
      wordCount: selection.wordCount,
      sections: picked.map((s) => ({
        name: s.name,
        items: s.items.map((i) => ({
          id: i.id, page: i.page, section: i.section, en: i.en, zh: i.zh,
          module: i.module, sourceInfo: i.sourceInfo,
          slots: i.slots, swappable: i.swappable, notes: i.notes, reason: i.reason,
        })),
      })),
      candidateCounts: selection.sections.map((s) => ({ name: s.name, count: s.candidates.length })),
      invalidIds: invalid,
      trimmedIds: trimmed ?? [],
      supplementedIds: supplemented ?? [],
    },
  });

  // 步骤四：关键词提取与替换优化
  const optimization = await optimizeFills(classification.final, picked, questionText);
  const filledSections = applyFills(picked, optimization.fills);
  record({
    step: 4,
    key: 'fills',
    title: '关键词选择与替换优化',
    data: {
      fills: optimization.fills,
      swaps: optimization.swaps,
      vocabRefs: optimization.vocabRefs,
      filled: filledSections,
    },
  });

  // 步骤五：成文与自检
  const essay = await writeEssay(classification.final, filledSections, questionText, selection.wordCount);
  const skeletonIssues = verifySkeleton(filledSections, essay.paragraphs);
  const check = selfCheck(classification.final, essay, filledSections, selection.wordCount);
  record({
    step: 5,
    key: 'essay',
    title: '成文与自检',
    data: {
      essay: {
        title: essay.title ?? null,
        date: essay.date ?? null,
        salutation: essay.salutation ?? null,
        paragraphs: essay.paragraphs ?? [],
        sentenceSources: essay.sentenceSources ?? [],
        signature: essay.signature ?? null,
        adjustments: essay.adjustments ?? [],
      },
      skeletonIssues,
      check,
    },
  });

  return {
    question: questionText,
    classification: classification.final,
    steps,
    essay: {
      title: essay.title ?? null,
      date: essay.date ?? null,
      salutation: essay.salutation ?? null,
      paragraphs: essay.paragraphs ?? [],
      sentenceSources: essay.sentenceSources ?? [],
      signature: essay.signature ?? null,
    },
    check,
    skeletonIssues,
  };
}
