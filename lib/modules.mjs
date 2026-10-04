const moduleOf = (id, label, description, order, required = true) => ({ id, label, description, order, required });

/** 模板浏览使用的三条轨道。模块 ID 是稳定 API 值，顺序即实际写作顺序。 */
export const TEMPLATE_TRACKS = [
  {
    id: 'chart',
    label: '图表作文',
    description: '英语二图表类大作文：描述数据，解释原因，再提出建议并展望。',
    order: 1,
    modules: [
      moduleOf('chart-introduction', '图表引入', '交代图表形式、数据主体、时间和地点。', 1),
      moduleOf('chart-data', '趋势 / 排序对比', '选择关键起点、终点、峰值、排序和显著对比。', 2),
      moduleOf('chart-question', '原因设问', '承接数据并自然引出原因分析。', 3),
      moduleOf('chart-reasons', '原因分析', '用两个或更多角度解释变化或分布。', 4),
      moduleOf('chart-advice', '建议', '针对图表反映的问题或趋势提出措施。', 5),
      moduleOf('chart-outlook', '展望', '用条件句、判断或趋势预测收束全文。', 6),
    ],
  },
  {
    id: 'picture',
    label: '图画作文',
    description: '英语一图画类大作文：客观描图、点明寓意、联系现实论证并升华。',
    order: 2,
    modules: [
      moduleOf('picture-introduction', '图画引入', '说明单图、双图或材料，引出画面。', 1, false),
      moduleOf('picture-scene', '画面描述', '按环境、人物、动作和文字说明客观描图。', 2),
      moduleOf('picture-theme', '寓意点题', '从画面过渡到主题、品质或社会寓意。', 3),
      moduleOf('picture-argument', '现象 / 论证', '联系现实分析原因、意义、影响或危害。', 4),
      moduleOf('picture-advice', '社会或个人建议', '给出社会治理或个人行动层面的建议。', 5),
      moduleOf('picture-outlook', '总结展望', '以号召、警示、价值判断或未来展望收尾。', 6),
    ],
  },
  {
    id: 'small',
    label: '小作文',
    description: '应用文小作文：按交际功能组装，并可继续按具体题型筛选。',
    order: 3,
    modules: [
      moduleOf('small-identity', '身份 / 寒暄', '称呼后的问候、自我介绍或背景交代。', 1, false),
      moduleOf('small-purpose', '写作目的', '明确邀请、建议、致歉、通知、介绍等来意。', 2),
      moduleOf('small-details', '事项展开', '落实时间、地点、安排、内容或问题描述。', 3),
      moduleOf('small-support', '理由 / 益处 / 请求', '补充理由、收益、请求或行动要求。', 4),
      moduleOf('small-politeness', '致谢 / 期待', '致谢、祝愿、期待回复或号召参与。', 5),
      moduleOf('small-format', '格式落款', '检查称呼、标题、日期和落款；该模块不提供正文模板。', 6, false),
    ],
  },
];

export const SOURCE_CATALOG = [
  {
    source: 'scan-handout',
    sourceLabel: '考研英语作文扫描讲义',
    totalPages: 47,
    scope: '图画作文、图表作文、小作文功能句、书写布局与词汇',
  },
  {
    source: 'slp-big-e1',
    sourceLabel: '26 石雷鹏大作文笔记 - 英语一（整理自：学长小谭）',
    totalPages: 70,
    scope: '图画作文（图画类大作文）',
  },
  {
    source: 'slp-big-e2',
    sourceLabel: '26 石雷鹏大作文笔记 - 英语二（整理自：学长小谭）',
    totalPages: 64,
    scope: '图表作文（图表类大作文）',
  },
  {
    source: 'slp-small-e1',
    sourceLabel: '26 石雷鹏小作文笔记 - 英语一（整理自：学长小谭）',
    totalPages: 62,
    scope: '应用文（小作文）。本文件收录英一英二共有的前六篇精讲/实训以及英一全部独有真题。',
  },
  {
    source: 'slp-small-e2',
    sourceLabel: '26 石雷鹏小作文笔记 - 英语二（整理自：学长小谭）',
    totalPages: 58,
    scope: '应用文（小作文）· 英语二独有真题。',
  },
];

const TRACK_BY_ID = new Map(TEMPLATE_TRACKS.map((track) => [track.id, track]));
const MODULE_BY_ID = new Map(TEMPLATE_TRACKS.flatMap((track) => track.modules.map((module) => [module.id, { ...module, track: track.id }])));
const SOURCE_BY_ID = new Map(SOURCE_CATALOG.map((source) => [source.source, source]));

export function getTrack(trackId) {
  return TRACK_BY_ID.get(trackId) ?? null;
}

export function getModule(moduleId) {
  return MODULE_BY_ID.get(moduleId) ?? null;
}

function inferTrack(entry) {
  const kind = String(entry.kind ?? '');
  const id = String(entry.id ?? '');
  const section = String(entry.section ?? '');
  if (kind === 'chart-essay' || id.includes('chart') || section.includes('图表作文')) return 'chart';
  if (kind.startsWith('small-essay-') || id.startsWith('small-') || id.startsWith('slp-sm-') || entry.letterType) return 'small';
  if (kind.startsWith('big-essay-') || id.includes('pic-') || section.includes('图画作文') || section.includes('大作文')) return 'picture';
  return null;
}

function inferPosition(entry, track) {
  const kind = String(entry.kind ?? '');
  const id = String(entry.id ?? '').toLowerCase();
  const section = String(entry.section ?? '');

  // section 最接近模板的实际功能，优先级高于页面 kind。
  if (/第一段|首段/.test(section)) return 'opening';
  if (/第三段|尾段/.test(section)) return 'closing';
  if (/第二段|中间段|主体段/.test(section)) return 'body';

  if (track === 'small') {
    if (kind === 'small-essay-para1' || /(?:^|-)p1(?:-|$)/.test(id)) return 'opening';
    if (kind === 'small-essay-para3' || /(?:^|-)p3(?:-|$)/.test(id)) return 'closing';
    return 'body';
  }
  if (kind === 'big-essay-opening' || id.includes('-open-')) return 'opening';
  if (kind === 'big-essay-closing' || id.includes('-close-')) return 'closing';
  // 无段落标记的图表趋势/句法条目本质上用于第一段数据描述。
  if (track === 'chart' && /动态|静态|趋势|排序|句型|数据描述|图表描述/.test(section)) return 'opening';
  return 'body';
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

/** 基于 kind / section / id / letterType 做纯函数式、确定性的功能模块归类。 */
export function classifyTemplateModule(entry = {}) {
  const track = inferTrack(entry);
  if (!track) return null;
  const kind = String(entry.kind ?? '');
  const id = String(entry.id ?? '').toLowerCase();
  const section = String(entry.section ?? '');
  const origin = String(entry.origin ?? '');
  const text = `${section}\n${origin}\n${id}`;
  const position = inferPosition(entry, track);

  if (track === 'chart') {
    if (includesAny(text, ['展望', '收尾', '尾段2', '条件句', '未来', '前景', 'outlook'])) return getModule('chart-outlook');
    if (position === 'closing' || includesAny(text, ['建议', '措施', '策略', '应该', '应当', '尾段1'])) return getModule('chart-advice');
    if (includesAny(text, ['设问', '过渡', 'what resulted', 'what caused', '为什么'])) return getModule('chart-question');
    if (position === 'body' || includesAny(text, ['原因一', '原因二', '原因分析', '理由', 'resulted in'])) return getModule('chart-reasons');
    if (includesAny(text, ['首句', '引入', 'given is', 'this is a', '图表形式'])) return getModule('chart-introduction');
    return getModule('chart-data');
  }

  if (track === 'picture') {
    if (position === 'closing' && includesAny(text, ['展望', '总结', '号召', '警示', '收尾', '前景'])) return getModule('picture-outlook');
    if (position === 'closing' || includesAny(text, ['建议', '措施', '应该', '应当', '个人层面', '社会层面'])) return getModule('picture-advice');
    if (position === 'body') return getModule('picture-argument');
    if (includesAny(text, ['点题', '寓意', '文字说明', '主题', '象征', 'message'])) return getModule('picture-theme');
    if (includesAny(text, ['描述', '环境', '动作', '人物', '主体', '左图', '右图', '画面'])) return getModule('picture-scene');
    return getModule('picture-introduction');
  }

  if (position === 'closing') return getModule('small-politeness');
  if (includesAny(text, ['身份', '寒暄', '自我介绍', '背景', '得知消息', '收到'])) return getModule('small-identity');
  if (position === 'opening' || includesAny(text, ['目的', '来意', '写信', '邀请', '通知'])) return getModule('small-purpose');
  if (includesAny(text, ['理由', '益处', '好处', '请求', '请教', '必要性', '三益处', 'why'])) return getModule('small-support');
  return getModule('small-details');
}

function inferSource(entry) {
  const explicit = String(entry.source ?? '');
  if (SOURCE_BY_ID.has(explicit)) return explicit;
  const id = String(entry.id ?? '');
  for (const source of SOURCE_CATALOG) {
    if (source.source.startsWith('slp-') && id.startsWith(source.source.replace('big-e1', 'pic').replace('big-e2', 'chart'))) {
      return source.source;
    }
  }
  if (id.startsWith('slp-pic-')) return 'slp-big-e1';
  if (id.startsWith('slp-chart-')) return 'slp-big-e2';
  if (id.startsWith('slp-sm-')) return id.includes('-e2-') ? 'slp-small-e2' : 'slp-small-e1';
  return 'scan-handout';
}

/** 将任意模板来源规范化；只有扫描讲义提供本地扫描页链接。 */
export function normalizeSourceInfo(entry = {}, sources = SOURCE_CATALOG) {
  const available = new Map(sources.map((source) => [source.source, source]));
  const sourceId = inferSource(entry);
  const definition = available.get(sourceId) ?? SOURCE_BY_ID.get(sourceId) ?? { source: sourceId, sourceLabel: sourceId };
  const sourceInfo = {
    source: definition.source,
    key: definition.source,
    sourceLabel: definition.sourceLabel,
    label: definition.sourceLabel,
    origin: entry.origin ?? definition.sourceLabel,
    totalPages: definition.totalPages,
    scope: definition.scope,
    page: Number.isInteger(Number(entry.page)) ? Number(entry.page) : null,
    href: null,
    pageUrl: null,
  };
  if (sourceId === 'scan-handout' && sourceInfo.page !== null) {
    sourceInfo.href = `/pages/p${String(sourceInfo.page).padStart(2, '0')}.png`;
    sourceInfo.pageUrl = sourceInfo.href;
  }
  return sourceInfo;
}

export function enrichTemplate(entry, sources) {
  return {
    ...entry,
    module: classifyTemplateModule(entry),
    sourceInfo: normalizeSourceInfo(entry, sources),
  };
}
