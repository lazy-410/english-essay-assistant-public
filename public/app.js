// 考研英语作文辅助助手 · 前端
// 设计原则：解析过程全程可见，每条模板都能追溯到 PDF 页码。

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const json = await res.json().catch(() => ({ ok: false, error: `服务返回异常（${res.status}）` }));
  if (!json.ok) throw new Error(json.error ?? '未知错误');
  return json.data;
}

// ---------------- 导出/下载（真机与桌面双通道） ----------------

/** 是否运行在 App 内 WebView（存在原生导出桥 EEABridge） */
const isAppWebView = () => !!(window.EEABridge && typeof window.EEABridge.shareBase64 === 'function');

/** Blob → data:URL（内部用 base64，供导出桥与桌面下载共用） */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取导出数据失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 统一文件导出入口：
 * - App 内 WebView：blob:/data: URL 的 <a download> 在 Android 上不可用，
 *   改走 EEABridge.shareBase64 写缓存文件并经系统「保存/分享」面板落盘；
 * - 桌面浏览器：保持原 objectURL + a.download 行为。
 * @param {string} fileName 建议文件名（含扩展名，中文可用）
 * @param {string} mime MIME 类型
 * @param {Blob|string} blobOrDataUrl 文件内容（Blob 或 data: URL）
 */
async function downloadOrShare(fileName, mime, blobOrDataUrl) {
  if (isAppWebView()) {
    const dataUrl = typeof blobOrDataUrl === 'string'
      ? blobOrDataUrl
      : await blobToBase64(blobOrDataUrl);
    window.EEABridge.shareBase64(fileName, dataUrl, mime || 'application/octet-stream');
    return;
  }
  const url = typeof blobOrDataUrl === 'string'
    ? blobOrDataUrl
    : URL.createObjectURL(blobOrDataUrl);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  if (typeof blobOrDataUrl !== 'string') {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** 把 {占位符} 和 [次级占位符] 高亮成 PDF 里的颜色语言 */
function hlPlaceholders(text) {
  return esc(text)
    .replace(/\{([^{}]+)\}/g, '<span class="ph-slot">{$1}</span>')
    .replace(/\[([^\[\]]+)\]/g, '<span class="ph-sec">[$1]</span>');
}

function safeHref(href) {
  if (!href) return null;
  try {
    const url = new URL(String(href), window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function getSourceInfo(item) {
  return item?.sourceInfo ?? item?.source ?? null;
}

function sourceMetaHtml(item, options = {}) {
  const source = getSourceInfo(item);
  const module = item?.module;
  const page = source?.page ?? item?.page;
  const explicitHref = source?.href ?? source?.pageUrl;
  const isScanSource = !source || source.source === 'scan-handout' || source.type === 'pdf';
  const href = safeHref(explicitHref) ?? (isScanSource && page ? `/pages/p${String(page).padStart(2, '0')}.png` : null);
  const label = source?.label ?? source?.sourceLabel ?? source?.origin ?? (page ? '扫描讲义' : '来源未标注');
  const bits = [];
  if (module?.label || module?.id) bits.push(`<span class="tag module-tag">模块：${esc(module.label ?? module.id)}</span>`);
  if (item?.label || item?.templateLabel) bits.push(`<span class="tag">模板：${esc(item.label ?? item.templateLabel)}</span>`);
  if (page) bits.push(href
    ? `<a class="tag page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">P${esc(page)} ${esc(label)}</a>`
    : `<span class="tag page">P${esc(page)} ${esc(label)}</span>`);
  else if (source) bits.push(`<span class="tag page">${esc(label)}</span>`);
  const traceKey = item?.templateId ?? item?.id ?? source?.key;
  if (options.showKey && traceKey) bits.push(`<span class="dim small mono">${esc(traceKey)}</span>`);
  return bits.join('');
}

function notesHtml(item) {
  const notes = item?.notes ?? item?.reminders ?? (item?.reminder ? [item.reminder] : []);
  return notes.length ? `<div class="note">讲义提醒：${notes.map(esc).join('；')}</div>` : '';
}


// ---------------- Tab 切换（桌面顶部导航 + 移动底部导航共用） ----------------

/** 移动端「工具」Tab 下辖的页面：在这些页面时，底部导航仍高亮「工具」。 */
const TOOLS_GROUP = new Set(['kb', 'hand']);

function showView(name) {
  const target = document.getElementById(`view-${name}`);
  if (!target) return;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v === target));
  // 桌面顶部导航按各自按钮高亮；移动底部导航把 kb/hand 归到「工具」组。
  const group = TOOLS_GROUP.has(name) ? 'tools' : name;
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.app-tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === group));
  if (name === 'kb') initKb();
  if (name === 'exams') initExams();
  if (name === 'review') initReviewExams();
  if (name === 'hand') initHand();
  if (name === 'set') initSettings();
  window.scrollTo({ top: 0 });
  if (location.hash.slice(1) !== name) {
    try { history.replaceState(null, '', `#${name}`); } catch { /* file:// 等环境可忽略 */ }
  }
}

document.querySelectorAll('nav.tabs button, .app-tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
// 工具中转页里的入口卡片
document.querySelectorAll('#view-tools [data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.goto));
});
// 越过窄屏断点时「工具」中转页没有桌面入口：自动落到知识库，避免停留在无导航页面。
window.addEventListener('resize', () => {
  if (window.matchMedia('(min-width: 821px)').matches && document.getElementById('view-tools')?.classList.contains('active')) {
    showView('kb');
  }
});

// 视图状态写入 #hash，便于刷新/回归截图直达；hash 变化时同步切换。
window.addEventListener('hashchange', () => {
  const name = location.hash.replace(/^#/, '');
  if (name && document.getElementById(`view-${name}`)) showView(name);
});

// ---------------- 状态栏 ----------------

let health = null;

async function refreshHealth() {
  try {
    health = await api('/api/health');
    const visionLabel = health.visionReady ? '视觉已配置' : (health.localOcrAvailable ? '离线识别可用' : '识别未配置');
    const bits = [
      health.hasApiKey ? 'API 已配置' : 'API 未配置',
      health.knowledgeBuilt ? '知识库就绪' : '知识库未构建',
      `图片识别: ${visionLabel}`,
    ];
    if (health.platform && health.platform !== 'Windows') bits.push(health.platform);
    $('statusText').textContent = bits.join(' · ');
    $('status').querySelector('.dot').className = `dot${health.hasApiKey && health.knowledgeBuilt ? '' : ' bad'}`;
  } catch (err) {
    $('statusText').textContent = `服务异常：${err.message}`;
    $('status').querySelector('.dot').className = 'dot bad';
  }
}
refreshHealth();

// ---------------- 图片输入与识别 ----------------

let currentImage = null;
let currentImageAnalysis = null;
let currentExamId = null;

function showPreview(dataUrl, { clearExam = true } = {}) {
  currentImage = dataUrl;
  currentImageAnalysis = null;
  if (clearExam) currentExamId = null;
  $('preview').innerHTML = '';
  const image = document.createElement('img');
  image.src = dataUrl;
  image.alt = '题目图片';
  $('preview').append(image);
}

async function runOcr(dataUrl) {
  $('ocrBox').innerHTML = '<div class="dim small" style="margin-top:10px"><span class="spinner" style="border-color:rgba(37,99,235,.3);border-top-color:#2563eb"></span> 正在用千问视觉识别题图（画面理解 + 题面文字转录）…</div>';
  try {
    const pipe = await api('/api/image/analyze', { image: dataUrl });
    const vis = pipe.vision?.raw ?? {};
    const conflicts = pipe.conflicts ?? [];

    let html = `<div class="ok-box small">图片识别完成（耗时 ${pipe.totalLatencyMs} ms）。`;
    if (pipe.vision) html += ` 视觉模型：<b>${pipe.vision.model}</b>。`;
    html += '</div>';

    if (pipe.fallback === 'desktop-local-ocr') {
      html += '<div class="warn-box small">当前为离线文字提取，不含画面与图表解读。在「设置 → 图片识别」配置 Key 后可获得完整识别效果。</div>';
    } else if (pipe.fallback === 'vision-text-only' || (pipe.vision && pipe.visionError)) {
      html += `<div class="warn-box small">画面理解未完成（${esc(pipe.vision?.model ? pipe.visionError : (pipe.visionError ?? '未知原因'))}）。题干已按题面文字生成，如有缺漏请对照原图补全。</div>`;
    }

    if (conflicts.length) {
      const list = conflicts.map((c) => `<li>${esc(c.detail)}</li>`).join('');
      html += `<div class="warn-box small"><b>交叉校验提示：检测到 ${conflicts.length} 处需注意项：</b><ul style="margin:4px 0 0;padding-left:18px">${list}</ul></div>`;
    }

    if (vis.category) {
      html += `<div class="card" style="margin-top:10px;background:#fafbfc">
        <div class="row" style="margin-bottom:6px">
          <span class="tag">${esc(vis.category)}</span>
          ${vis.subType ? `<span class="tag page">${esc(vis.subType)}</span>` : ''}
          ${vis.themeGuess ? `<span class="tag ok">主题推断：${esc(vis.themeGuess)}</span>` : ''}
        </div>`;
      if (vis.sceneDescription) {
        html += `<div class="small" style="margin-top:4px"><b>画面描述（将嵌入第一段）：</b><div class="mono dim">${esc(vis.sceneDescription)}</div></div>`;
      }
      if (vis.chartData?.dataPoints?.length) {
        const dps = vis.chartData.dataPoints.map((dp) => `${esc(dp.label)}: <b>${esc(dp.value)}</b>`).join(' · ');
        html += `<div class="small" style="margin-top:6px"><b>识别出的图表数据：</b><div>${dps}</div></div>`;
      }
      if (vis.uncertain?.length) {
        html += `<div class="why small" style="margin-top:4px">防幻觉提醒（模棱两可项）：${vis.uncertain.map(esc).join('；')}</div>`;
      }
      html += '</div>';
    }

    $('ocrBox').innerHTML = html;
    currentImageAnalysis = pipe;
    $('question').value = pipe.composedQuestion;
  } catch (err) {
    $('ocrBox').innerHTML = `<div class="err-box small">识别失败：${esc(err.message)}<br>可以直接在下方手动输入题目。</div>`;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

$('btnPickImg').addEventListener('click', () => $('fileImg').click());
async function handleWriteImage(file) {
  if (!file) return;
  const url = await readFileAsDataUrl(file);
  showPreview(url);
  runOcr(url);
}
// 拍照直达（仅窄屏显示按钮；capture 优先系统相机，取消时无副作用）
$('btnCamWrite')?.addEventListener('click', () => $('camWrite').click());
$('camWrite')?.addEventListener('change', (e) => {
  handleWriteImage(e.target.files?.[0]);
  e.target.value = '';
});
$('fileImg').addEventListener('change', async (e) => {
  await handleWriteImage(e.target.files?.[0]);
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const url = await readFileAsDataUrl(file);
  showPreview(url);
  runOcr(url);
});
window.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const url = await readFileAsDataUrl(item.getAsFile());
  showPreview(url);
  runOcr(url);
});

// ---------------- 解析链渲染 ----------------

const STEP_NAMES = ['题面事实', '内容规划', '语言骨架', '成文与自检'];

function showProgress(activeIndex) {
  const wrap = el('div', 'progress');
  STEP_NAMES.forEach((name, i) => {
    const cls = i < activeIndex ? 'p-item done' : i === activeIndex ? 'p-item active' : 'p-item';
    const mark = i < activeIndex ? '✓' : i === activeIndex ? '●' : '○';
    wrap.append(el('div', cls, `${mark} 第 ${i + 2} 步 · ${esc(name)}`));
  });
  $('progress').innerHTML = '';
  $('progress').append(wrap);
}

function stepEl(num, title, open = false) {
  const d = el('details', 'step');
  if (open) d.open = true;
  d.innerHTML = `<summary><span class="num">${num}</span>${esc(title)}</summary><div class="body"></div>`;
  return d;
}

function sourceEvidenceText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (Array.isArray(entry)) return entry.map(sourceEvidenceText).filter(Boolean).join('；');
  for (const key of ['text', 'value', 'label', 'claim', 'description', 'evidence']) {
    const shown = sourceEvidenceText(entry[key]);
    if (shown) return shown;
  }
  return '';
}

function contentSourceLabel(content, fallbackId = '') {
  if (!content) return fallbackId;
  if (typeof content === 'string') return content;
  const typeNames = {
    picture: '题图事实',
    chart: '图表事实',
    prompt: '题干任务',
    reasoning: '内容规划',
    examReference: '题库校对事实',
  };
  const type = typeNames[content.sourceType] ?? content.label ?? content.type ?? '内容依据';
  const evidence = listValues(content.evidence)
    .map(sourceEvidenceText)
    .filter(Boolean)
    .slice(0, 2)
    .join('；');
  return evidence ? `${type}：${evidence}` : `${type}${fallbackId ? `（${fallbackId}）` : ''}`;
}

function languageSourceLabel(language) {
  if (!language) return '内容计划直接实现';
  if (typeof language === 'string') return language;
  return language.label ?? language.id ?? language.text ?? language.templateId ?? '内容计划直接实现';
}

function renderSourceLayers(item) {
  const content = item?.contentSource ?? item?.contentUnit ?? item?.contentEvidence;
  const language = item?.skeleton ?? item?.sourceInfo ?? item?.languageSource;
  const parts = [];
  if (content) parts.push(`<span class="tag page">内容来源：${esc(contentSourceLabel(content, item?.contentUnit))}</span>`);
  if (language) parts.push(`<span class="tag page">语言来源：${esc(languageSourceLabel(language))}</span>`);
  return parts.join('');
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function renderFacts(data) {
  const d = stepEl(2, '第 2 步 · 题面事实', true);
  const b = d.querySelector('.body');
  const facts = data.facts ?? data;
  const rows = [];
  const add = (name, value, source = '') => {
    const shown = Array.isArray(value) ? value.filter(Boolean).join('、') : value;
    if (shown != null && shown !== '') rows.push({ name, value: shown, source });
  };
  add('作文类型', facts.category, '题干判定');
  add('目标字数', facts.targetWords, '题目要求');
  if (facts.category === '大作文') {
    add('客观画面', facts.picture?.sceneDescription, facts.picture?.source === 'imageAnalysis' ? '题图视觉识读' : '题干');
    add('可见人物/物件', facts.picture?.characters, '题图视觉识读');
    add('可见动作', facts.picture?.actions, '题图视觉识读');
    add('图中文字', facts.picture?.caption, '题图识别');
    if (facts.chart?.hasFacts) {
      add('混合题图表类型', facts.chart?.type, '题图/题库校对事实');
      add('混合题图表数据', (facts.chart?.dataPoints ?? []).map((x) => `${x.label}: ${x.value}`), '题图/题库校对事实');
    }
  } else if (facts.category === '图表作文') {
    add('图表类型', facts.chart?.type, '题图视觉识读');
    add('标题', facts.chart?.chartData?.title, '题图视觉识读');
    add('单位', facts.chart?.unit, '题图视觉识读');
    add('数据', (facts.chart?.dataPoints ?? []).map((x) => `${x.label}: ${x.value}`), '题图视觉识读');
    add('关键趋势/对比', facts.chart?.trend, '题图视觉识读');
  } else {
    add('收件对象', facts.small?.addressee, '题干');
    add('语域', facts.small?.register, '题干');
    add('格式', facts.small?.format, '题干');
    add('必答任务', (facts.small?.tasks ?? []).map((x) => x.text), 'Directions');
  }
  if (rows.length) {
    const html = rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.value)}</td><td class="dim small">${esc(x.source)}</td></tr>`).join('');
    b.append(el('div', '', `<h3>题面事实与来源</h3><table><tr><th>项目</th><th>识别内容</th><th>来源/依据</th></tr>${html}</table>`));
  }
  const uncertain = [...listValues(facts.picture?.uncertain), ...listValues(facts.warnings), ...listValues(data.validation?.warnings)];
  if (uncertain.length) b.append(el('div', 'warn-box small', `<b>不确定项/提醒：</b>${uncertain.map((x) => esc(typeof x === 'string' ? x : x.text ?? x.label ?? JSON.stringify(x))).join('；')}`));
  return d;
}

function renderPlan(data) {
  const d = stepEl(3, '第 3 步 · 内容规划');
  const b = d.querySelector('.body');
  for (const paragraph of data.paragraphs ?? data.sections ?? []) {
    b.append(el('h3', '', esc(paragraph.name ?? paragraph.title ?? '段落')));
    for (const unit of paragraph.units ?? paragraph.items ?? []) {
      const evidence = (unit.evidence ?? []).map((x) => x.text ?? x.value ?? x).filter(Boolean);
      const item = el('div', 'sent');
      item.innerHTML = `<div><b>${esc(unit.rhetoricalFunction ?? '内容')}</b> · ${esc(unit.claim ?? unit.content ?? '')}</div>
        <div class="why">为什么写：这是“${esc(unit.semanticKey ?? unit.contentId ?? '')}”内容单元，用于完成本段的${esc(unit.rhetoricalFunction ?? '表达')}功能。</div>
        ${evidence.length ? `<div class="meta">内容证据：${evidence.map(esc).join('；')}</div>` : '<div class="meta">内容依据：围绕题面主题进行分析，不冒充题图事实。</div>'}`;
      b.append(item);
    }
  }
  const validation = data.validation;
  if (validation && !validation.valid) b.append(el('div', 'warn-box small', `规划校验未通过：${(validation.errors ?? []).map(esc).join('；')}`));
  return d;
}

function renderSkeletons(data) {
  const d = stepEl(4, '第 4 步 · 语言骨架');
  const b = d.querySelector('.body');
  for (const binding of data.bindings ?? data.skeletons ?? data.items ?? []) {
    const item = binding.skeleton ?? binding;
    if (!item?.en) {
      b.append(el('div', 'dim small', `${esc(binding.contentId ?? '内容单元')}：未绑定固定骨架，由内容计划直接实现。`));
      continue;
    }
    const node = el('div', 'sent');
    node.innerHTML = `<div class="en">${hlPlaceholders(item.en)}</div>${item.zh ? `<div class="zh">${esc(item.zh)}</div>` : ''}
      <div class="meta">${sourceMetaHtml(item, { showKey: true })}<span class="mono small">${esc(binding.skeletonId ?? item.id ?? '')}</span></div>
      <div class="why">为什么用：该骨架与内容单元 ${esc(binding.contentId ?? '')} 的修辞功能匹配；同一冲突组在全文只使用一次。</div>`;
    b.append(node);
  }
  return d;
}

function renderClassify(data) {
  const d = stepEl(2, '第 2 步 · 题型判定', true);
  const b = d.querySelector('.body');
  const f = data.final;

  b.append(el('div', 'row', `
    <span class="tag">${esc(f.category ?? '未判定')}</span>
    ${f.subType ? `<span class="tag">${esc(f.subType)}</span>` : ''}
    ${f.letterType ? `<span class="tag">${esc(f.letterType)}</span>` : ''}
    ${f.polarity ? `<span class="tag ${f.polarity === '负面' ? 'warn' : 'ok'}">${esc(f.polarity)}倾向</span>` : ''}
    ${f.topicClass ? `<span class="tag page">${esc(f.topicClass)}</span>` : ''}
    <span class="dim small">置信度 ${Math.round((f.confidence ?? 0) * 100)}%</span>`));

  if (f.keyPhrase) b.append(el('div', '', `<h3>核心「题目相关词」</h3><b>${esc(f.keyPhrase)}</b>`));
  if (f.reason) b.append(el('div', '', `<h3>判定依据</h3><div class="dim">${esc(f.reason)}</div>`));

  const ev = data.rules?.evidence ?? {};
  if (Object.keys(ev).length) {
    const rows = Object.entries(ev).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono small">${esc(Array.isArray(v) ? v.join('、') : v)}</td></tr>`).join('');
    b.append(el('div', '', `<h3>关键词规则命中（可解释证据）</h3><table><tr><th>类别</th><th>命中词</th></tr>${rows}</table>`));
  }

  if (data.conflicts?.length) {
    const list = data.conflicts.map((c) => `${esc(c.field)}：规则判为「${esc(c.rules)}」，AI 判为「${esc(c.ai)}」`).join('<br>');
    b.append(el('div', 'warn-box small', `规则层与 AI 层结论不一致，已采用 AI 结论，请人工确认：<br>${list}`));
  } else {
    b.append(el('div', 'dim small', '规则层与 AI 层结论一致。'));
  }
  return d;
}

function renderTemplates(data) {
  const d = stepEl(3, `第 3 步 · 模板选配（目标 ${data.wordCount}）`);
  const b = d.querySelector('.body');

  if (data.candidateCounts?.length) {
    b.append(el('div', 'dim small', `候选池：${data.candidateCounts.map((c) => `${esc(c.name)} ${c.count} 条`).join(' · ')}`));
  }
  if (data.invalidIds?.length) {
    b.append(el('div', 'warn-box small', `有 ${data.invalidIds.length} 个无效模板 id 已被剔除（AI 未按规则引用）。`));
  }

  for (const section of data.sections ?? []) {
    b.append(el('h3', '', esc(section.name)));
    for (const item of section.items ?? []) {
      const s = el('div', 'sent');
      s.innerHTML = `
        <div class="en">${hlPlaceholders(item.en)}</div>
        ${item.zh ? `<div class="zh">${hlPlaceholders(item.zh)}</div>` : ''}
        <div class="meta">
          ${sourceMetaHtml(item, { showKey: true })}
          <span class="dim small">${esc(item.section)}</span>
          ${(item.slots ?? []).map((x) => `<span class="tag slot">${esc(x)}</span>`).join('')}
          ${(item.swappable ?? []).map((x) => `<span class="tag swap">${esc(x)}</span>`).join('')}
        </div>
        ${item.reason ? `<div class="why">选它的理由：${esc(item.reason)}</div>` : ''}
        ${notesHtml(item)}`;
      b.append(s);
    }
  }
  return d;
}

function renderFills(data) {
  const d = stepEl(4, '第 4 步 · 关键词选择与替换优化');
  const b = d.querySelector('.body');

  b.append(el('div', 'dim small', '这是讲义方法的核心：红色占位符用题干信息填充，蓝色词按题目替换，同一含义在全篇尽量换不同表达以免生硬。'));

  if (data.fills?.length) {
    const rows = data.fills.map((f) => `<tr>
      <td><span class="mono">${esc(f.raw ?? `{${f.name}}`)}</span></td>
      <td><b>${esc(f.recommended ?? f.candidates?.[0]?.en ?? '')}</b>${(f.candidates ?? []).length > 1 ? `<div class="dim small">备选：${f.candidates.filter((c) => c.en !== f.recommended).map((c) => esc(c.en)).join(' / ')}</div>` : ''}</td>
      <td class="dim small">${esc(f.reason ?? '')}</td>
    </tr>`).join('');
    b.append(el('div', '', `<h3>占位符填充（原占位符 → 填充值 → 理由）</h3><table><tr><th style="width:22%">占位符</th><th style="width:38%">填充值</th><th>为什么这样填</th></tr>${rows}</table>`));
  }

  if (data.swaps?.length) {
    const rows = data.swaps.map((s) => `<tr>
      <td>${esc(s.original)}</td><td><b>${esc(s.suggestion)}</b></td><td class="dim small">${esc(s.reason ?? '')}</td>
    </tr>`).join('');
    b.append(el('div', '', `<h3>可替换词优化建议</h3><table><tr><th style="width:22%">讲义原词</th><th style="width:38%">建议替换为</th><th>理由</th></tr>${rows}</table>`));
  }

  if (data.filled?.length) {
    const wrap = el('div');
    wrap.append(el('h3', '', '填充后的模板句'));
    for (const section of data.filled) {
      wrap.append(el('div', 'dim small', esc(section.name)));
      for (const s of section.sentences) {
        const item = el('div', 'sent');
        item.innerHTML = `<div class="en">${esc(s.filled)}</div>
          <div class="meta">${sourceMetaHtml(s, { showKey: true })}<span class="dim small mono">${esc(s.templateId)}</span>
          ${s.leftover?.length ? `<span class="tag err">未填充 ${s.leftover.length} 处</span>` : '<span class="tag ok">已填满</span>'}</div>
          ${notesHtml(s)}`;
        wrap.append(item);
      }
    }
    b.append(wrap);
  }

  if (data.vocabRefs?.length) {
    b.append(el('div', '', `<h3>参考了讲义词表</h3><div class="dim small">${data.vocabRefs.slice(0, 14).map((v) => `${esc(v.en)}（${esc(v.zh)}）`).join('、')} …</div>`));
  }
  return d;
}

function renderEssayStep(data) {
  const d = stepEl(5, '第 5 步 · 成文与自检', true);
  const b = d.querySelector('.body');

  if (data.essay?.adjustments?.length) {
    const rows = data.essay.adjustments.map((a) => `<tr><td class="mono small">${esc(a.templateId ?? '')}</td><td>${esc(a.change ?? '')}</td></tr>`).join('');
    b.append(el('div', '', `<h3>润色调整记录（只允许语法层面的改动）</h3><table><tr><th style="width:32%">模板</th><th>改了什么</th></tr>${rows}</table>`));
  }

  const c = data.check;
  const checks = el('div');
  checks.append(el('h3', '', '自检清单'));
  for (const item of c.checks) {
    checks.append(el('div', 'check', `<span class="tag ${item.pass ? 'ok' : 'err'}">${item.pass ? '通过' : '注意'}</span><span><b>${esc(item.name)}</b> · <span class="dim">${esc(item.detail)}</span></span>`));
  }
  b.append(checks);

  if (data.chartNumberRepair?.from?.length) {
    b.append(el('div', 'ok-box small', `已自动核对并改写 ${data.chartNumberRepair.from.length} 个无法直接由图表核验的数字，改为原始数据或定性比较。`));
  }

  if (data.skeletonIssues?.length) {
    const list = data.skeletonIssues.map((i) => `<li>P${i.page} ${esc(i.templateId)}（保留度 ${Math.round(i.ratio * 100)}%）</li>`).join('');
    b.append(el('div', 'warn-box small', `以下句子与讲义模板骨架偏离较大，建议核对：<ul style="margin:6px 0 0">${list}</ul>`));
  } else {
    b.append(el('div', 'dim small', '内容与语言来源可追溯；未发现需要额外核对的骨架偏离。'));
  }
  return d;
}

let lastEssay = null;

function essayPlainText(essay) {
  const lines = [];
  if (essay.title) lines.push(essay.title, '');
  if (essay.salutation) lines.push(essay.salutation, '');
  for (const p of essay.paragraphs ?? []) lines.push((p.sentences ?? []).join(' '), '');
  if (essay.signature) lines.push(essay.signature);
  if (essay.date) lines.push(essay.date);
  return lines.join('\n');
}

function sentenceSourceHtml(source, sentenceIndex) {
  if (!source) return '<span class="dim small">本句暂无来源标注</span>';
  const template = source.template ?? source;
  const info = source.sourceInfo ?? template.sourceInfo;
  const content = source.contentSource ?? source.contentUnit ?? source.contentEvidence;
  const language = source.skeleton ?? source.languageSource ?? info;
  const sourceItem = {
    ...template,
    module: source.module ?? template.module,
    sourceInfo: language,
    label: source.templateLabel ?? template.label,
  };
  const layers = [];
  if (content) layers.push(`<span class="tag page">内容来源：${esc(contentSourceLabel(content, source.contentUnit))}</span>`);
  if (language || Object.hasOwn(source, 'skeleton')) layers.push(`<span class="tag page">语言来源：${esc(languageSourceLabel(language))}</span>`);
  // V2 已明确提供内容与语言双层来源，不再额外显示“来源未标注”的旧模板元数据。
  const legacyMeta = source.skeleton || source.contentSource ? '' : sourceMetaHtml(sourceItem, { showKey: true });
  return `<div class="sentence-source"><span class="source-index">${sentenceIndex + 1}</span>${legacyMeta}${layers.join('')}</div>`;
}

function renderResult(r) {
  lastEssay = r.essay;
  const card = el('div', 'card');
  const heading = el('div', 'spread');
  heading.innerHTML = `<h2 style="margin:0">生成结果</h2><span class="dim small">${r.check.words} 词 · ${r.check.allPass ? '自检全部通过' : '有项目需要注意'}</span>`;
  card.append(heading);

  // AI 不可用时会降级为确定性兜底稿（不阻塞出稿），必须让用户看到原因，
  // 否则只会以为“内容质量忽然变差”。
  if (r.diagnostics?.aiErrors) {
    card.append(el('div', 'err-box small',
      `本次 AI 调用失败（${esc(r.diagnostics.aiError?.message ?? '未知原因')}），已按确定性兜底路径出稿：请在「设置」页检查 Key 后重新生成。`));
  }

  const sourceToggle = el('label', 'source-toggle row');
  sourceToggle.innerHTML = '<input type="checkbox"> 显示逐句来源标注';
  const essay = el('div', 'essay');
  const renderEssay = (showSources = false) => {
    essay.innerHTML = '';
    if (r.essay.title) essay.append(el('p', '', `<b style="display:block;text-align:center">${esc(r.essay.title)}</b>`));
    if (r.essay.salutation) essay.append(el('p', '', `<b>${esc(r.essay.salutation)}</b>`));
    for (const p of r.essay.paragraphs ?? []) {
      if (!showSources) {
        essay.append(el('p', '', esc((p.sentences ?? []).join(' '))));
        continue;
      }
      const block = el('div', 'sourced-paragraph');
      (p.sentences ?? []).forEach((sentence, i) => {
        const row = el('div', 'sourced-sentence');
        row.innerHTML = `<div class="sentence-text">${esc(sentence)}</div>${sentenceSourceHtml(p.sentenceSources?.[i], i)}`;
        block.append(row);
      });
      essay.append(block);
    }
    if (r.essay.signature) essay.append(el('div', 'sig', esc(r.essay.signature).replace(/\n/g, '<br>')));
    if (r.essay.date) essay.append(el('div', 'sig', esc(r.essay.date)));
  };
  sourceToggle.querySelector('input').addEventListener('change', (e) => renderEssay(e.target.checked));
  card.append(sourceToggle);
  renderEssay(false);
  card.append(essay);

  const actions = el('div', 'row');
  actions.style.marginTop = '14px';
  const btnCopy = el('button', 'btn ghost sm', '复制作文');
  btnCopy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(essayPlainText(r.essay));
    btnCopy.textContent = '已复制';
    setTimeout(() => { btnCopy.textContent = '复制作文'; }, 1500);
  });
  const btnHand = el('button', 'btn sm', '生成答题卡排版');
  btnHand.addEventListener('click', () => {
    document.querySelector('nav.tabs button[data-view="hand"]').click();
    fillHandFromEssay(r.essay, r.classification, { question: r.question ?? $('question').value, facts: r.facts });
  });
  actions.append(btnCopy, btnHand);

  // 诊断 JSON：坏样本直接复制给作者复现（V3 才有 diagnostics；v1/v2 回退时隐藏）。
  if (r.diagnostics) {
    const btnDiag = el('button', 'btn ghost sm', '复制诊断 JSON');
    btnDiag.title = '复制本次生成的引擎、轮次、守卫与兜底块信息';
    btnDiag.addEventListener('click', async () => {
      const payload = {
        engine: r.engine ?? null,
        question: r.question ?? $('question').value,
        classification: r.classification ?? null,
        diagnostics: r.diagnostics,
        check: {
          words: r.check?.words ?? null,
          target: r.check?.target ?? null,
          checks: (r.check?.checks ?? []).map((item) => ({ name: item.name, pass: item.pass, detail: item.detail ?? null })),
          violations: r.check?.violations ?? [],
          unsupportedNumbers: r.check?.unsupportedNumbers ?? [],
          fallbackBlocks: r.check?.fallbackBlocks ?? [],
        },
        at: new Date().toISOString(),
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        btnDiag.textContent = '已复制诊断';
      } catch {
        btnDiag.textContent = '复制失败';
      }
      setTimeout(() => { btnDiag.textContent = '复制诊断 JSON'; }, 1500);
    });
    actions.append(btnDiag);
  }
  card.append(actions);

  $('result').innerHTML = '';
  $('result').append(card);

  // 成文之后立刻给出模块化复盘与本次用到的模板句。
  const review = el('div');
  review.id = 'composeReview';
  $('result').append(review);
  renderComposeReview(r, review);
}

// ---------------- 成文后复盘：模块解析 + 本次模板句 ----------------

/** 把本篇实际套用的骨架列出来，可直接标记掌握状态并同步进度。 */
async function renderUsedTemplates(result, container) {
  const sentenceSources = (result.essay?.paragraphs ?? []).flatMap((p) => p.sentenceSources ?? []);
  if (!sentenceSources.length) return;
  const card = el('div', 'card');
  card.innerHTML = '<div class="spread"><h2 style="margin:0">本次用到的模板句</h2><span class="dim small">加载中…</span></div>';
  container.append(card);
  try {
    const data = await api('/api/study/link-essay', { sentenceSources });
    if (!data.cards.length) {
      card.innerHTML = `<h2>本次用到的模板句</h2><div class="dim small">本篇 ${sentenceSources.length} 句均由内容规划直接实现，未套用讲义模板。</div>`;
      return;
    }
    const items = data.cards.map((c) => {
      const page = c.source?.page;
      const href = page ? `/pages/p${String(page).padStart(2, '0')}.png` : null;
      return `<div class="used-template" data-card="${esc(c.cardId)}">
        <div class="used-template-head">
          <span class="tag module-tag">${esc(c.trackLabel)} · ${esc(c.moduleLabel)}</span>
          ${page ? `<a class="tag page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">讲义 P${esc(page)}</a>` : ''}
          <span class="tag status-${esc(c.status)}">${esc(STATUS_LABEL[c.status] ?? c.status)}</span>
        </div>
        <div class="used-template-en">${hlPlaceholders(c.en)}</div>
        <div class="used-template-actions row">
          <button class="btn sm" data-status="mastered">已掌握</button>
          <button class="btn ghost sm" data-status="review">需复习</button>
        </div>
      </div>`;
    }).join('');
    card.innerHTML = `<div class="spread"><h2 style="margin:0">本次用到的模板句</h2>
      <span class="dim small">命中 ${esc(data.matched)} 条${data.unmatchedSentences ? ` · 另有 ${esc(data.unmatchedSentences)} 句未套模板` : ''}</span></div>
      <div class="dim small" style="margin-top:6px">标记后会同步到知识库「学习卡片」的背诵进度。</div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="btnMasterAll">全部标记已掌握</button></div>
      <div class="used-template-list">${items}</div>
      <div id="usedTemplateMsg"></div>`;

    const writeStatus = async (entries) => {
      const out = await api('/api/study/progress', { entries });
      $('usedTemplateMsg').innerHTML = `<div class="ok-box small">已同步到学习卡片：已掌握 ${esc(out.summary.mastered)} / ${esc(out.summary.total)}。</div>`;
      // 知识库页下次进入时重新拉取，保证两处一致。
      studyInited = false;
    };

    card.querySelector('#btnMasterAll').addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        await writeStatus(data.cards.map((c) => ({ cardId: c.cardId, status: 'mastered' })));
        for (const node of card.querySelectorAll('.used-template')) {
          const badge = node.querySelector('.tag[class*="status-"]');
          badge.className = 'tag status-mastered';
          badge.textContent = STATUS_LABEL.mastered;
        }
      } catch (err) {
        $('usedTemplateMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
      } finally {
        event.target.disabled = false;
      }
    });

    card.querySelector('.used-template-list').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-status]');
      if (!button) return;
      const item = button.closest('.used-template');
      try {
        await writeStatus([{ cardId: item.dataset.card, status: button.dataset.status }]);
        const badge = item.querySelector('.tag[class*="status-"]');
        badge.className = `tag status-${button.dataset.status}`;
        badge.textContent = STATUS_LABEL[button.dataset.status];
      } catch (err) {
        $('usedTemplateMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
      }
    });
  } catch (err) {
    card.innerHTML = `<h2>本次用到的模板句</h2><div class="err-box small">加载失败：${esc(err.message)}</div>`;
  }
}

async function renderComposeReview(result, container) {
  const wrap = el('div', 'card');
  wrap.innerHTML = `<div class="spread"><h2 style="margin:0">行文复盘</h2>
    <label class="dim small"><input type="checkbox" id="composeAnalysisAi"> AI 深化讲解</label></div>
    <div class="dim small" style="margin-top:6px">按模块拆解这篇作文的组装方式，并指出缺少哪个功能模块。</div>
    <div id="composeAnalysisBody"><div class="dim small" style="margin-top:10px">正在生成…</div></div>`;
  container.append(wrap);

  const load = async (useAi) => {
    const body = $('composeAnalysisBody');
    body.innerHTML = '<div class="dim small" style="margin-top:10px">正在生成…</div>';
    try {
      const analysis = await api('/api/analysis/essay', {
        essay: result.essay,
        classification: result.classification,
        facts: result.facts,
        question: result.question ?? $('question').value,
        ai: Boolean(useAi),
      });
      renderAnalysis(analysis, body);
    } catch (err) {
      body.innerHTML = `<div class="err-box small">行文复盘失败：${esc(err.message)}</div>`;
    }
  };
  $('composeAnalysisAi').addEventListener('change', (event) => load(event.target.checked));
  await load(false);
  await renderUsedTemplates(result, container);
}

// ---------------- 解析入口 ----------------

$('btnCompose').addEventListener('click', async () => {
  const text = $('question').value.trim();
  if (!text) return void ($('composeErr').innerHTML = '<div class="err-box small">请先输入或识别题目。</div>');

  $('composeErr').innerHTML = '';
  $('steps').innerHTML = '';
  $('result').innerHTML = '';
  const btn = $('btnCompose');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 解析中，约需 1-2 分钟…';
  showProgress(0);

  try {
    const request = { text };
    if (currentImage) request.image = currentImage;
    if (currentExamId != null) request.examId = currentExamId;
    if (currentImageAnalysis) {
      request.imageAnalysis = currentImageAnalysis;
      request.currentImageAnalysis = currentImageAnalysis;
    }
    const r = await api('/api/compose', request);
    $('progress').innerHTML = '';
    for (const step of r.steps ?? []) {
      if (step.key === 'facts') $('steps').append(renderFacts(step.data));
      if (step.key === 'plan') $('steps').append(renderPlan(step.data));
      if (step.key === 'skeletons') $('steps').append(renderSkeletons(step.data));
      if (step.key === 'classify') $('steps').append(renderClassify(step.data));
      if (step.key === 'templates') $('steps').append(renderTemplates(step.data));
      if (step.key === 'fills') $('steps').append(renderFills(step.data));
      if (step.key === 'essay') $('steps').append(renderEssayStep(step.data));
    }
    renderResult(r);
  } catch (err) {
    $('progress').innerHTML = '';
    $('composeErr').innerHTML = `<div class="err-box small">解析失败：${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始解析并生成作文';
  }
});

$('btnClassifyOnly').addEventListener('click', async () => {
  const text = $('question').value.trim();
  if (!text) return void ($('composeErr').innerHTML = '<div class="err-box small">请先输入或识别题目。</div>');
  $('composeErr').innerHTML = '';
  $('steps').innerHTML = '';
  $('result').innerHTML = '';
  const btn = $('btnClassifyOnly');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="border-color:rgba(37,99,235,.3);border-top-color:#2563eb"></span> 判定中…';
  try {
    const r = await api('/api/classify', { text });
    $('steps').append(renderClassify({ final: r.final, rules: r.rules, conflicts: r.conflicts }));
  } catch (err) {
    $('composeErr').innerHTML = `<div class="err-box small">判定失败：${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '只做题型判定';
  }
});

// ---------------- 答题卡排版 ----------------

let handInited = false;
let handInitPromise = null;
let hwTemplates = [];
let hwFonts = [];

function preferredHandFont() {
  return hwFonts.find((font) => font.recommended === true && /舒窈(?:英文)?衡水体/.test(font.label ?? '')) ?? hwFonts[0] ?? null;
}

function safeHandFontUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(String(rawUrl), window.location.href);
    return /^(https?:)$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function updateHandFontSample() {
  const sample = $('hwFontSample');
  const selectedIndex = hwFonts.findIndex((font) => String(font.id) === $('hwFont').value);
  const font = selectedIndex >= 0 ? hwFonts[selectedIndex] : null;
  const styleId = 'hwFontPreviewFace';
  let faceStyle = document.getElementById(styleId);
  if (!faceStyle) {
    faceStyle = document.createElement('style');
    faceStyle.id = styleId;
    document.head.append(faceStyle);
  }

  const family = font ? `HWPreview_${selectedIndex}` : '';
  const fontUrl = safeHandFontUrl(font?.url);
  faceStyle.textContent = fontUrl
    ? `@font-face { font-family: "${family}"; src: url(${JSON.stringify(fontUrl)}); font-display: swap; }`
    : '';
  sample.style.fontFamily = family ? `"${family}", cursive` : '';
  sample.style.color = ({ black: '#111827', red: '#c62828', blue: '#1d4ed8', darkgray: '#4b5563' })[$('hwColor').value] ?? '#111827';
  sample.style.fontSize = `${clampNumber($('hwSize').value, 12, 28, 17) * 4 / 3}px`;
  sample.style.fontStyle = `oblique ${clampNumber($('hwSlant').value, 0, 15, 0)}deg`;
}

function handFontOptions(fonts) {
  const groups = [
    ['Dome 全部字体', fonts.filter((font) => font.source === 'dome')],
    ['系统原有字体', fonts.filter((font) => font.source !== 'dome')],
  ];
  return groups
    .filter(([, items]) => items.length)
    .map(([label, items]) => `<optgroup label="${esc(label)}">${items.map((font) => `<option value="${esc(font.id)}">${esc(font.label)}</option>`).join('')}</optgroup>`)
    .join('');
}

function hwSetError(message) {
  $('hwErr').innerHTML = message ? `<div class="err-box small">${esc(message)}</div>` : '';
}

function renderHandTips(tips) {
  const styleCards = (tips.styles ?? []).map((s) => `
    <div>
      <b>${esc(s.name)}${s.recommended ? '（推荐）' : ''}</b>
      <ul>${(s.points ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <div class="dim small" style="margin-top:4px">${esc(s.why)}</div>
    </div>`).join('');
  const answerSheet = Array.isArray(tips.answerSheet) ? tips.answerSheet.filter(Boolean) : [];
  $('hwTips').innerHTML = `
    <div class="tips-grid">${styleCards}</div>
    <div class="tips-grid" style="margin-top:16px">
      <div><b style="color:var(--ok)">✓ 应该这样</b><ul>${(tips.good ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div><b style="color:var(--err)">✗ 避免这样</b><ul>${(tips.bad ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>
    ${answerSheet.length ? `<div style="margin-top:14px"><b>答题卡书写要点</b><ul>${answerSheet.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <div style="margin-top:14px"><b>通知类格式</b><ul>${(tips.noticeFormat ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    ${tips.pen ? `<div class="dim small" style="margin-top:10px">${esc(tips.pen)}</div>` : ''}`;
}

async function initHand() {
  if (handInited) return handInitPromise;
  handInited = true;
  handInitPromise = (async () => {
    const [templates, fonts, tips] = await Promise.allSettled([
      api('/api/handwrite/templates'),
      api('/api/handwrite/fonts'),
      api('/api/handwrite/tips'),
    ]);

    if (templates.status === 'fulfilled') {
      hwTemplates = templates.value.templates ?? [];
      $('hwTemplate').innerHTML = hwTemplates
        .map((t) => `<option value="${esc(t.key)}">${esc(t.label)}${t.lineCount ? `（${esc(t.lineCount)} 行）` : ''}</option>`)
        .join('') || '<option value="">无可用答题卡</option>';
    } else {
      $('hwTemplate').innerHTML = '<option value="">加载失败</option>';
      hwSetError(`答题卡区域加载失败：${templates.reason?.message ?? templates.reason}`);
    }

    if (fonts.status === 'fulfilled') {
      hwFonts = fonts.value.fonts ?? [];
      $('hwFont').innerHTML = handFontOptions(hwFonts) || '<option value="">无可用字体</option>';
      const preferred = preferredHandFont();
      if (preferred) $('hwFont').value = String(preferred.id);
      updateHandFontSample();
    } else {
      hwFonts = [];
      $('hwFont').innerHTML = '<option value="">加载失败</option>';
      updateHandFontSample();
      hwSetError(`字体列表加载失败：${fonts.reason?.message ?? fonts.reason}`);
    }

    if (tips.status === 'fulfilled') renderHandTips(tips.value);
    else $('hwTips').innerHTML = `<div class="err-box small">${esc(tips.reason?.message ?? tips.reason)}</div>`;
  })();
  return handInitPromise;
}

$('hwFont').addEventListener('change', updateHandFontSample);
$('hwColor').addEventListener('change', updateHandFontSample);
$('hwSize').addEventListener('input', updateHandFontSample);
$('hwSlant').addEventListener('input', updateHandFontSample);
updateHandFontSample();

async function applyHandPreset({ color, fontSize }) {
  try { await initHand(); } catch { /* 字体加载失败时仍应用其余预设 */ }
  const preferred = preferredHandFont();
  if (preferred) $('hwFont').value = String(preferred.id);
  $('hwColor').value = color;
  $('hwSize').value = String(fontSize);
  $('hwSlant').value = '0';
  $('hwBaseline').value = '0';
  updateHandFontSample();
  if ($('hwText').value.trim()) $('btnHwRender').click();
}

$('btnHwExamPreset').addEventListener('click', () => applyHandPreset({ color: 'black', fontSize: 17 }));
$('btnHwCopybookPreset').addEventListener('click', () => applyHandPreset({ color: 'red', fontSize: 18 }));

/** 按题型/科目推断答题卡区域：小作文 → Part A，大作文与图表作文 → Part B。 */
function pickSheetTemplateKey(classification, context = {}) {
  const category = classification?.category ?? '';
  const part = category === '小作文' ? 'a' : 'b';
  const haystack = [context.question, classification?.subType, classification?.letterType, category]
    .filter(Boolean).join(' ');
  const target = String(context.facts?.targetWords ?? context.targetWords ?? '');
  // 英语二线索：题干/分类里出现「英语二」，或图表作文且目标词数落在 150 词附近（140-159）。
  const looksEnglish2 = /英语\s*[二2]|English\s*(II|2)/i.test(haystack)
    || (category === '图表作文' && /\b1[45]\d\b/.test(target));
  return `english${looksEnglish2 ? 2 : 1}_${part}`;
}

async function fillHandFromEssay(essay, classification, context = {}) {
  const paras = (essay.paragraphs ?? []).map((p) => (p.sentences ?? []).join(' '));
  $('hwText').value = paras.join('\n\n');
  $('hwSalutation').value = essay.salutation ?? '';
  $('hwSignature').value = (essay.signature ?? '').replace(/\n/g, ' / ');
  $('hwTitle').value = essay.title ?? 'Notice';
  $('hwDate').value = essay.date ?? '';
  const isNotice = classification?.letterType === '通知类' || classification?.letterType === '公告类';
  $('hwKind').value = isNotice ? 'notice' : 'letter';
  $('hwKind').dispatchEvent(new Event('change'));

  try { await initHand(); } catch { /* 列表加载失败时保留手动选择 */ }
  const wanted = pickSheetTemplateKey(classification, context);
  const select = $('hwTemplate');
  if ([...select.options].some((o) => o.value === wanted)) select.value = wanted;

  const label = select.selectedOptions[0]?.textContent?.trim();
  $('hwHint').textContent = label
    ? `已带入「写作文」页的生成结果，答题卡区域自动选为「${label}」。`
    : '已带入「写作文」页的生成结果。';
  $('btnHwRender').click();
}

$('hwKind').addEventListener('change', () => {
  $('hwNoticeFields').style.display = $('hwKind').value === 'notice' ? 'flex' : 'none';
});

function collectHandEssay() {
  const paragraphs = $('hwText').value.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t) => ({ sentences: [t] }));
  const sig = $('hwSignature').value.trim();
  return {
    salutation: $('hwSalutation').value.trim() || null,
    paragraphs,
    signature: sig ? sig.split(/\s*\/\s*/).join('\n') : null,
    title: $('hwTitle')?.value?.trim() || 'Notice',
    date: $('hwDate')?.value?.trim() || null,
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function collectHandRequest() {
  return {
    essay: collectHandEssay(),
    template: $('hwTemplate').value,
    fontId: $('hwFont').value,
    fontSize: clampNumber($('hwSize').value, 12, 28, 17),
    slant: clampNumber($('hwSlant').value, 0, 15, 0),
    baselineAdjust: clampNumber($('hwBaseline').value, -4, 4, 0),
    color: $('hwColor').value,
    style: $('hwStyle').value,
    kind: $('hwKind').value,
  };
}

function currentTemplate() {
  const key = $('hwTemplate').value;
  return hwTemplates.find((t) => t.key === key) ?? { key, label: $('hwTemplate').selectedOptions[0]?.textContent ?? '' };
}

/** 由模板 label / key 推导下载文件名主体，例如「英语一-PartB」。 */
function sheetFileBase(template) {
  const label = String(template?.label ?? '').trim();
  const keyMatch = /^english([12])_([ab])$/i.exec(String(template?.key ?? ''));
  let exam = keyMatch ? (keyMatch[1] === '2' ? '英语二' : '英语一') : '';
  let part = keyMatch ? `Part${keyMatch[2].toUpperCase()}` : '';
  if (!exam) exam = /英语\s*[二2]|English\s*(II|2)/i.test(label) ? '英语二' : (/英语\s*[一1]/.test(label) ? '英语一' : '');
  if (!part) {
    const partMatch = /part\s*([ab])/i.exec(label);
    part = partMatch ? `Part${partMatch[1].toUpperCase()}` : '';
  }
  const bits = [exam, part].filter(Boolean);
  if (bits.length) return bits.join('-');
  const cleaned = label.replace(/[\\/:*?"<>|·（）()\s]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return cleaned || '答题卡';
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function renderLineStatus(r) {
  const used = r.usedLines ?? 0;
  const available = r.availableLines ?? 0;
  const overflow = r.overflowLines ?? Math.max(0, used - available);
  const base = `已用 ${used} / 可用 ${available} 行`;
  if (overflow > 0 || r.fits === false) {
    $('hwLineStatus').innerHTML = `<div class="warn-box small">${esc(base)}，超出 ${esc(overflow)} 行。建议把字号调小 0.5-1 或精简内容后重新生成。</div>`;
  } else {
    $('hwLineStatus').innerHTML = `<div class="ok-box small">${esc(base)}，未超出答题卡书写区。</div>`;
  }
}

/** 把返回的 SVG 挂到预览区，保持 A4 比例、宽度自适应且不裁切。 */
function mountPreviewSvg(svgText, width, height) {
  $('hwPreview').innerHTML = svgText;
  const node = $('hwPreview').querySelector('svg');
  if (!node) return;
  if (!node.getAttribute('viewBox') && width && height) node.setAttribute('viewBox', `0 0 ${width} ${height}`);
  node.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  node.removeAttribute('width');
  node.removeAttribute('height');
  node.style.width = '100%';
  node.style.height = 'auto';
}

let lastHw = null;
$('btnHwRender').addEventListener('click', async () => {
  const payload = collectHandRequest();
  if (!payload.essay.paragraphs.length) {
    hwSetError('请先填写作文内容。');
    return;
  }
  if (!payload.template) {
    hwSetError('请先选择答题卡区域。');
    return;
  }
  hwSetError('');
  const btn = $('btnHwRender');
  btn.disabled = true;
  try {
    const r = await api('/api/handwrite', payload);
    lastHw = r;
    mountPreviewSvg(r.svg, r.width, r.height);
    renderLineStatus(r);
  } catch (err) {
    lastHw = null;
    $('hwPreview').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
    $('hwLineStatus').textContent = '生成失败，暂无行数统计。';
  } finally {
    btn.disabled = false;
  }
});

// App 内下载不可用：答题卡导出按钮改口为系统「分享」面板（桌面保持「下载」）
if (isAppWebView()) {
  const pdfBtn = $('btnHwPdf');
  const pngBtn = $('btnHwPng');
  if (pdfBtn) pdfBtn.textContent = '分享 PDF';
  if (pngBtn) pngBtn.textContent = '分享 PNG';
}

$('btnHwPdf').addEventListener('click', async () => {
  const payload = collectHandRequest();
  if (!payload.essay.paragraphs.length) return void hwSetError('请先填写作文内容。');
  if (!payload.template) return void hwSetError('请先选择答题卡区域。');
  hwSetError('');
  const btn = $('btnHwPdf');
  btn.disabled = true;
  try {
    const res = await fetch('/api/handwrite/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = `服务返回异常（${res.status}）`;
      try {
        const json = JSON.parse(detail);
        message = json.error ?? json.message ?? message;
      } catch { if (detail) message = detail.slice(0, 200); }
      throw new Error(message);
    }
    const blob = await res.blob();
    await downloadOrShare(
      `答题卡-${sheetFileBase(currentTemplate())}-${todayStamp()}.pdf`,
      'application/pdf',
      blob);
  } catch (err) {
    hwSetError(`PDF 下载失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('btnHwPng').addEventListener('click', () => {
  if (!lastHw) return void $('btnHwRender').click();
  const svgNode = $('hwPreview').querySelector('svg');
  if (!svgNode) return void hwSetError('还没有可导出的预览，请先生成预览。');

  const scale = 2;
  const width = lastHw.width || svgNode.viewBox?.baseVal?.width || 794;
  const height = lastHw.height || svgNode.viewBox?.baseVal?.height || 1123;
  // 克隆并写回显式尺寸，避免预览用的百分比宽度影响栅格化。
  const clone = svgNode.cloneNode(true);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.width = '';
  clone.style.height = '';

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    downloadOrShare(
      `答题卡-${sheetFileBase(currentTemplate())}-${todayStamp()}.png`,
      'image/png',
      canvas.toDataURL('image/png'))
      .catch((err) => hwSetError(`PNG 导出失败：${err.message}`));
  };
  img.onerror = () => { URL.revokeObjectURL(url); hwSetError('PNG 导出失败，请改用下载 PDF 或截图。'); };
  img.src = url;
});

// ---------------- 真题题库 ----------------

let examsInited = false;
let examState = { items: [], selectedId: null };

function examValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'object') return value.text ?? value.content ?? value.en ?? value.label ?? JSON.stringify(value);
  return String(value);
}

function examArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function examModelEssay(exam) {
  const model = exam?.modelEssay;
  if (!model) return [];
  const paragraphs = Array.isArray(model) ? model : (Array.isArray(model.paragraphs) ? model.paragraphs : [model]);
  return paragraphs.map((paragraph) => {
    if (typeof paragraph === 'string') return { text: paragraph, sentences: [{ text: paragraph, labels: [] }] };
    const rawSentences = examArray(paragraph?.sentences ?? paragraph?.sentence ?? paragraph?.text ?? paragraph?.content ?? paragraph?.en);
    const sentences = rawSentences.map((sentence) => {
      if (typeof sentence === 'string') return { text: sentence, labels: [] };
      return { text: examValue(sentence?.text ?? sentence?.content ?? sentence?.en ?? sentence?.sentence), labels: examArray(sentence?.module ?? sentence?.modules ?? sentence?.moduleLabel ?? sentence?.tags ?? sentence?.labels) };
    }).filter((sentence) => sentence.text);
    return { ...paragraph, sentences, text: examValue(paragraph?.text ?? paragraph?.content ?? paragraph?.en) };
  });
}

function examLabels(exam) {
  return {
    subject: exam.examType === 'e1' ? '英语一' : exam.examType === 'e2' ? '英语二' : exam.subject,
    size: exam.section === 'big' ? '大作文' : exam.section === 'small' ? '小作文' : (exam.essaySize ?? exam.size),
    type: { picture: '图画', chart: '图表', hybrid: '图画+图表', small: '小作文' }[exam.essayType] ?? exam.essayType ?? exam.type,
  };
}

function examTitle(exam) {
  if (exam.title) return exam.title;
  const labels = examLabels(exam);
  return [exam.year, labels.subject, labels.size].filter(Boolean).join(' · ') || '历年真题';
}

function examMeta(exam) {
  const labels = examLabels(exam);
  return [labels.subject, exam.year, labels.size, labels.type, exam.letterType]
    .filter(Boolean).map((x) => `<span class="tag">${esc(examValue(x))}</span>`).join('');
}

function examPlainText(exam, includeModel = false) {
  const directionText = examValue(exam?.directions).trim();
  const promptText = examValue(exam?.prompt).trim();
  const extraRequirements = examArray(exam?.requirements).map(examValue).filter((item) => item && !directionText.includes(item));
  const parts = [directionText, promptText && promptText !== directionText ? promptText : '', ...extraRequirements].filter(Boolean);
  if (!includeModel) return parts.join('\n\n');
  const paragraphs = examModelEssay(exam).flatMap((p) => p.sentences?.length ? p.sentences.map((s) => s.text ?? s) : [p.text]).filter(Boolean);
  return [...parts, ...paragraphs].join('\n\n');
}

function examSourceHtml(source) {
  const rawLabel = typeof source === 'string' ? source : source?.label ?? source?.name ?? source?.title ?? source?.file ?? '来源';
  const label = `${rawLabel}${source?.page ? ` · P${source.page}` : ''}${source?.kind === 'modelEssay' ? ' · 范文' : source?.kind === 'prompt' ? ' · 真题' : ''}`;
  const href = safeHref(source?.url ?? source?.href ?? source?.imageUrl);
  return href ? `<a class="tag page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : `<span class="tag page">${esc(label)}</span>`;
}

function examParagraphHtml(paragraph, index) {
  const sentences = paragraph.sentences?.length ? paragraph.sentences : [{ text: paragraph.text, labels: [] }];
  const module = paragraph.module ?? paragraph.moduleLabel ?? paragraph.section;
  const labels = examArray(paragraph.tags ?? paragraph.labels ?? paragraph.modules).concat(module ? [module] : []);
  return `<div class="exam-paragraph"><div class="exam-paragraph-head"><span class="source-index">${index + 1}</span>${labels.map((label) => `<span class="tag module-tag">${esc(examValue(label))}</span>`).join('')}</div>${sentences.map((sentence) => { const sentenceLabels = examArray(sentence.labels ?? sentence.modules ?? sentence.module); return `<div class="exam-sentence"><span>${esc(examValue(sentence.text ?? sentence))}</span>${sentenceLabels.map((label) => `<span class="tag">${esc(examValue(label))}</span>`).join('')}</div>`; }).join('')}</div>`;
}

function examDetailHtml(exam) {
  const model = examModelEssay(exam);
  const rawImage = exam.imageUrl ?? exam.image ?? exam.localImageUrl;
  const imagePath = rawImage && !String(rawImage).startsWith('/') ? `/${rawImage}` : rawImage;
  const image = safeHref(imagePath);
  const sources = examArray(exam.sources ?? exam.source ?? exam.references);
  const promptIsDuplicate = examValue(exam.prompt).trim() === examValue(exam.directions).trim();
  return `<div class="spread exam-detail-title"><div><h2>${esc(examTitle(exam))}</h2><div class="meta">${examMeta(exam)}${exam.hasModelEssay ?? model.length ? '<span class="tag ok">有范文</span>' : '<span class="tag warn">无范文</span>'}</div></div><div class="row"><button class="btn ghost sm" data-exam-copy="question">复制题干</button><button class="btn ghost sm" data-exam-practice>用这道题练习</button></div></div>
    ${image ? `<img class="exam-image" src="${esc(image)}" alt="真题图片" loading="lazy">` : ''}
    <section class="exam-copy"><h3>题目要求</h3><div>${examArray(exam.directions).map((x) => `<p>${esc(examValue(x))}</p>`).join('') || '<p class="dim">暂无题目要求。</p>'}</div>${!promptIsDuplicate && exam.prompt ? `<h3>补充题干</h3><div>${examArray(exam.prompt).map((x) => `<p>${esc(examValue(x))}</p>`).join('')}</div>` : ''}${examArray(exam.requirements).length ? `<h3>写作任务</h3><div>${examArray(exam.requirements).map((x) => `<p>${esc(examValue(x))}</p>`).join('')}</div>` : ''}</section>
    <details class="exam-model"><summary>范文（默认折叠）</summary><div class="exam-model-body">${model.length ? `${model.map(examParagraphHtml).join('')}<button class="btn ghost sm" data-exam-copy="model">复制范文</button>` : '<div class="dim">这道题暂无范文。</div>'}</div></details>
    ${sources.length ? `<section class="exam-sources"><h3>Sources</h3><div class="meta">${sources.map(examSourceHtml).join('')}</div></section>` : ''}
    <div class="row exam-detail-actions"><button class="btn sm" data-exam-practice>用这道题练习</button><button class="btn ghost sm" data-exam-analysis>看行文解析</button><button class="btn ghost sm" data-exam-templates>查看同类模板</button></div>`;
}

function examQuery() {
  const params = new URLSearchParams();
  const fields = [['examType', 'examSubject'], ['year', 'examYear'], ['section', 'examEssaySize'], ['essayType', 'examEssayType'], ['hasEssay', 'examHasModel'], ['keyword', 'examKeyword']];
  fields.forEach(([key, id]) => {
    let value = $(id).value.trim();
    if (key === 'hasEssay') value = value === 'yes' ? 'true' : value === 'no' ? 'false' : '';
    if (value) params.set(key, value);
  });
  params.set('limit', '100');
  return params;
}

async function loadExamStats() {
  const stats = await api('/api/exams/stats');
  $('examStats').innerHTML = `
    <div class="stat"><b>${esc(stats.exams ?? 0)}</b><span>真题总数</span></div>
    <div class="stat"><b>${esc(stats.withEssay ?? 0)}</b><span>参考范文</span></div>
    <div class="stat"><b>${esc(stats.examTypes?.e1 ?? 0)}</b><span>英语一</span></div>
    <div class="stat"><b>${esc(stats.examTypes?.e2 ?? 0)}</b><span>英语二</span></div>
    <div class="stat"><b>${esc(stats.essayTypes?.picture ?? 0)}</b><span>图画作文</span></div>
    <div class="stat"><b>${esc((stats.essayTypes?.chart ?? 0) + (stats.essayTypes?.hybrid ?? 0))}</b><span>图表/混合</span></div>`;
  const fill = (id, values, labels = {}) => {
    const select = $(id);
    Object.keys(values ?? {}).sort((a, b) => id === 'examYear' ? Number(b) - Number(a) : a.localeCompare(b)).forEach((value) => {
      const option = el('option', '', esc(labels[value] ?? value)); option.value = value; select.append(option);
    });
  };
  fill('examSubject', stats.examTypes, { e1: '英语一', e2: '英语二' });
  fill('examYear', stats.years);
  fill('examEssayType', stats.essayTypes, { picture: '图画作文', chart: '图表作文', hybrid: '图画+图表', small: '小作文' });
}

async function searchExams() {
  $('examList').innerHTML = '<div class="dim small">检索中…</div>';
  try {
    const payload = await api(`/api/exams?${examQuery()}`);
    const items = payload.exams ?? payload.items ?? (Array.isArray(payload) ? payload : []);
    examState.items = items;
    $('examCount').textContent = `共 ${items.length} 题`;
    $('examList').innerHTML = items.length ? items.map((exam) => `<button class="exam-item ${String(exam.id) === String(examState.selectedId) ? 'active' : ''}" data-exam-id="${esc(exam.id)}"><strong>${esc(examTitle(exam))}</strong><span class="meta">${examMeta(exam)}</span><span class="dim small">${esc(exam.prompt ?? exam.directions ?? '点击查看详情')}</span></button>`).join('') : '<div class="dim small">没有匹配的真题。</div>';
  } catch (err) { $('examList').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`; }
}

async function loadExamDetail(id) {
  examState.selectedId = id;
  $('examDetail').innerHTML = '<div class="dim small">加载详情…</div>';
  try {
    const payload = await api(`/api/exams/detail?id=${encodeURIComponent(id)}`);
    const exam = payload.exam ?? payload;
    examState.current = exam;
    $('examDetail').innerHTML = examDetailHtml(exam);
    document.querySelectorAll('.exam-item').forEach((item) => item.classList.toggle('active', String(item.dataset.examId) === String(id)));
  } catch (err) { $('examDetail').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`; }
}

function openExamTrack(exam) {
  const type = String(exam.essaySize ?? exam.size ?? exam.essayType ?? exam.type ?? '').toLowerCase();
  const track = type.includes('small') || type.includes('小') ? 'small' : type.includes('picture') || type.includes('hybrid') || type.includes('图画') || type.includes('漫画') ? 'picture' : 'chart';
  practiceState.trackId = track;
  $('moduleTrack').value = track;
  $('moduleLetterTypeWrap').hidden = track !== 'small';
  document.querySelector('nav.tabs button[data-view="kb"]').click();
  setKbView('modules');
  loadModules(true);
}

/** 把题库真题带入写作文：题干进文本框，题图进图片区，供后续视觉解析使用。 */
async function practiceWithExam(exam, button) {
  const label = button?.textContent;
  const rawImage = exam.imageUrl ?? exam.image ?? exam.localImageUrl;
  const imagePath = rawImage && !String(rawImage).startsWith('/') ? `/${rawImage}` : rawImage;
  const src = safeHref(imagePath);

  $('question').value = examPlainText(exam);
  document.querySelector('nav.tabs button[data-view="write"]').click();
  if (src) {
    if (button) button.textContent = '正在载入题图…';
    $('preview').innerHTML = '<div class="dim small">正在载入真题原图…</div>';
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`题图请求失败（${response.status}）`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error(`题图类型异常（${blob.type || '未知'}）`);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('题图读取失败'));
        reader.readAsDataURL(blob);
      });
      showPreview(dataUrl, { clearExam: false });
      currentExamId = exam.id ?? null;
      currentImageAnalysis = null;
      $('ocrBox').innerHTML = '<div class="ok-box small">已带入真题题干与原题图。点击「开始解析并生成作文」时会一并分析题图内容。</div>';
    } catch {
      currentImage = null;
      currentImageAnalysis = null;
      currentExamId = null;
      $('preview').innerHTML = '';
      $('ocrBox').innerHTML = '<div class="warn-box small">题干已带入，但题图加载失败。可回到真题题库右键保存题图后手动上传。</div>';
    }
    if (button) button.textContent = label;
  } else {
    currentImage = null;
    currentImageAnalysis = null;
    currentExamId = null;
    $('preview').innerHTML = '';
    $('ocrBox').innerHTML = '<div class="ok-box small">已带入真题题干（这道题没有题图）。</div>';
  }

  $('question').focus();
}

function bindExamDetailActions() {
  $('examDetail').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || !examState.current) return;
    if (button.dataset.examCopy) {
      const text = button.dataset.examCopy === 'model' ? examModelEssay(examState.current).map((p) => (p.sentences ?? [{ text: p.text }]).map((s) => examValue(s.text ?? s)).filter(Boolean).join(' ')).join('\n\n') : examPlainText(examState.current);
      if (!text) return;
      await navigator.clipboard.writeText(text);
      const old = button.textContent; button.textContent = '已复制'; setTimeout(() => { button.textContent = old; }, 1200);
    } else if ('examPractice' in button.dataset) {
      await practiceWithExam(examState.current, button);
    } else if ('examAnalysis' in button.dataset) {
      await openAnalysisFor(examState.current.id);
    } else if ('examTemplates' in button.dataset) openExamTrack(examState.current);
  });
}

async function initExams() {
  if (examsInited) return;
  examsInited = true;
  bindExamDetailActions();
  try { await loadExamStats(); await searchExams(); } catch (err) { $('examStats').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`; }
}
$('btnExamSearch').addEventListener('click', searchExams);
$('examKeyword').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchExams(); });
$('examList').addEventListener('click', (event) => { const item = event.target.closest('[data-exam-id]'); if (item) loadExamDetail(item.dataset.examId); });
$('btnExamRandom').addEventListener('click', () => { const item = examState.items[Math.floor(Math.random() * examState.items.length)]; if (item?.id != null) loadExamDetail(item.id); });

// ---------------- 知识库 ----------------

const PRACTICE_KEY = 'eea-module-practice-v1';
let kbInited = false;
let moduleData = null;
let practiceState = loadPracticeState();

function loadPracticeState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PRACTICE_KEY) ?? '{}');
    return {
      trackId: saved.trackId ?? 'chart',
      letterType: saved.letterType ?? '',
      items: Array.isArray(saved.items) ? saved.items : [],
      fills: saved.fills && typeof saved.fills === 'object' ? saved.fills : {},
    };
  } catch {
    return { trackId: 'chart', letterType: '', items: [], fills: {} };
  }
}

function savePracticeState() {
  sessionStorage.setItem(PRACTICE_KEY, JSON.stringify(practiceState));
  updateDraftBadges();
}

// ---------------- 批改作文 ----------------

const SEVERITY_META = {
  required: { label: '必改', cls: 'err', hint: '语法、格式、字数或讲义明令禁止项，不改会直接失分' },
  suggested: { label: '建议', cls: 'warn', hint: '可替换为讲义功能句或词表表达，用于提升语言档次' },
  structure: { label: '结构', cls: 'page', hint: '缺少写作模块，需要自己动笔补写' },
};

const reviewState = { image: null, raw: '', review: null, accepted: new Set(), finalText: '', mode: 'exam', exams: [], rotation: 0, usedRotation: 0 };

/* ---------------- 真题选择 ---------------- */

document.querySelectorAll('[data-rv-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    reviewState.mode = btn.dataset.rvMode;
    document.querySelectorAll('[data-rv-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    $('rvModeExam').classList.toggle('active', reviewState.mode === 'exam');
    $('rvModeFree').classList.toggle('active', reviewState.mode === 'free');
  });
});

/** 拉取全部真题一次，之后按考试/类型/年份在前端联动，避免反复请求。 */
async function initReviewExams() {
  if (reviewState.exams.length) return;
  try {
    const data = await api('/api/exams?limit=200');
    reviewState.exams = data.exams ?? [];
    refreshReviewYears();
  } catch (err) {
    $('rvExamInfo').innerHTML = `<span class="dim small">题目列表加载失败：${esc(err.message)}</span>`;
  }
}

function refreshReviewYears() {
  const examType = $('rvExamType').value;
  const section = $('rvSection').value;
  const matched = reviewState.exams.filter((exam) => exam.examType === examType && exam.section === section);
  const years = [...new Set(matched.map((exam) => exam.year))].sort((a, b) => b - a);
  const previous = $('rvYear').value;
  $('rvYear').innerHTML = years.map((year) => `<option value="${year}">${year} 年</option>`).join('');
  if (previous && years.includes(Number(previous))) $('rvYear').value = previous;
  refreshReviewExamIds();
}

function refreshReviewExamIds() {
  const examType = $('rvExamType').value;
  const section = $('rvSection').value;
  const year = Number($('rvYear').value);
  const matched = reviewState.exams.filter((exam) => exam.examType === examType
    && exam.section === section && exam.year === year);
  $('rvExamId').innerHTML = matched.map((exam) => {
    const essayType = exam.essayType === 'chart' ? '图表' : exam.essayType === 'hybrid' ? '混合' : exam.essayType === 'picture' ? '图画' : '应用文';
    // 列表接口用的字段是 hasEssay，不是 hasModelEssay。
    return `<option value="${esc(exam.id)}">${essayType}${exam.hasEssay ? '（有范文）' : '（无范文）'}</option>`;
  }).join('');
  updateReviewExamInfo();
}

function updateReviewExamInfo() {
  const exam = reviewState.exams.find((item) => item.id === $('rvExamId').value);
  if (!exam) { $('rvExamInfo').textContent = ''; return; }
  const label = `${exam.year} ${exam.examType === 'e1' ? '英语一' : '英语二'}${exam.section === 'small' ? '小作文' : '大作文'}`;
  $('rvExamInfo').innerHTML = exam.hasEssay
    ? `已选：<b>${esc(label)}</b>。将使用官方题干与范文做对照批改。`
    : `已选：<b>${esc(label)}</b>。该题暂无校对范文，只用官方题干做校验，不做范文对比。`;
}

$('rvExamType').addEventListener('change', refreshReviewYears);
$('rvSection').addEventListener('change', refreshReviewYears);
$('rvYear').addEventListener('change', refreshReviewExamIds);
$('rvExamId').addEventListener('change', updateReviewExamInfo);

function rvError(box, message) {
  $(box).innerHTML = message ? `<div class="err-box small">${esc(message)}</div>` : '';
}

function setReviewStep(step) {
  for (const node of document.querySelectorAll('#reviewSteps li')) {
    node.classList.toggle('active', Number(node.dataset.step) === step);
    node.classList.toggle('done', Number(node.dataset.step) < step);
  }
  for (const panel of document.querySelectorAll('.review-panel')) {
    panel.classList.toggle('active', panel.id === `reviewStep${step}`);
  }
}

$('btnRvPick').addEventListener('click', () => $('rvFile').click());
// 拍照直达（仅窄屏显示按钮）
$('btnCamReview')?.addEventListener('click', () => $('camReview').click());
$('camReview')?.addEventListener('change', async (event) => {
  if (event.target.files?.[0]) await loadReviewImage(event.target.files[0]);
  event.target.value = '';
});
$('rvFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) await loadReviewImage(file);
});
$('rvDrop').addEventListener('dragover', (event) => { event.preventDefault(); $('rvDrop').classList.add('over'); });
$('rvDrop').addEventListener('dragleave', () => $('rvDrop').classList.remove('over'));
$('rvDrop').addEventListener('drop', async (event) => {
  event.preventDefault();
  $('rvDrop').classList.remove('over');
  const file = event.dataTransfer?.files?.[0];
  if (file) await loadReviewImage(file);
});
window.addEventListener('paste', async (event) => {
  if (!$('view-review').classList.contains('active')) return;
  const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith('image/'));
  if (item) await loadReviewImage(item.getAsFile());
});

async function loadReviewImage(file) {
  try {
    reviewState.image = await readFileAsDataUrl(file);
    reviewState.rotation = 0;
    renderReviewPreview();
    $('btnRvOcr').disabled = false;
    $('rvRotateBar').hidden = false;
    rvError('rvErr1', '');
  } catch (err) {
    rvError('rvErr1', `图片读取失败：${err.message}`);
  }
}

function renderReviewPreview() {
  const degrees = reviewState.rotation ?? 0;
  $('rvPreview').innerHTML = `<img src="${esc(reviewState.image)}" alt="待批改的作文照片" style="transform:rotate(${degrees}deg)">`;
  $('rvRotateHint').textContent = degrees ? `已手动旋转 ${degrees}°` : '';
}

/** 把图片按指定角度旋转，返回新的 dataURL。浏览器自带解码器，无需额外依赖。 */
function rotateDataUrl(dataUrl, degrees) {
  return new Promise((resolve, reject) => {
    if (!degrees) return void resolve(dataUrl);
    const image = new Image();
    image.onerror = () => reject(new Error('图片解码失败'));
    image.onload = () => {
      const swap = degrees === 90 || degrees === 270;
      const canvas = document.createElement('canvas');
      canvas.width = swap ? image.height : image.width;
      canvas.height = swap ? image.width : image.height;
      const context = canvas.getContext('2d');
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((degrees * Math.PI) / 180);
      context.drawImage(image, -image.width / 2, -image.height / 2);
      // 手写稿用 JPEG 足够，且体积远小于 PNG，避免请求过大。
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    image.src = dataUrl;
  });
}

$('rvRotateBar').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-rotate]');
  if (!button || !reviewState.image) return;
  reviewState.rotation = (((reviewState.rotation ?? 0) + Number(button.dataset.rotate)) % 360 + 360) % 360;
  renderReviewPreview();
});

/**
 * 拍照时手机常把作文拍成横躺（竖排文字），而离线本地 OCR 读不了旋转文本。
 * 因此先用轻量 /api/ocr 试四个方向，挑出识别效果最好的那个，再走完整清洗流程。
 */
async function detectBestOrientation(dataUrl, onProgress) {
  const manual = reviewState.rotation ?? 0;
  // 用户手动转过就以其为准，只在该方向上识别，尊重用户判断。
  const candidates = manual ? [manual] : [0, 90, 270, 180];
  if (!candidates.length) return { degrees: 0, image: dataUrl, score: 0, words: 0 };
  const results = [];
  for (const [index, degrees] of candidates.entries()) {
    onProgress?.(index + 1, candidates.length, degrees);
    try {
      const rotated = await rotateDataUrl(dataUrl, degrees);
      const out = await api('/api/ocr', { image: rotated });
      results.push({ degrees, image: rotated, score: out.quality?.score ?? 0, words: out.quality?.words ?? 0 });
      // 已经读到足够多的英文单词，无需再试其余方向，省时间。
      if ((out.quality?.words ?? 0) >= 12) break;
    } catch {
      results.push({ degrees, image: null, score: -1, words: 0 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results[0] ?? { degrees: 0, image: dataUrl, score: 0, words: 0 };
}

$('btnRvOcr').addEventListener('click', async () => {
  if (!reviewState.image) return;
  const btn = $('btnRvOcr');
  btn.disabled = true;
  $('rvOcrBox').innerHTML = '<div class="dim small" style="margin-top:10px"><span class="spinner"></span> 正在识别手写作文…</div>';
  try {
    // 视觉模型能自行处理旋转，先直接送原图；只有回退到本地 OCR 时才需要逐方向试。
    let image = reviewState.image;
    if (reviewState.rotation) image = await rotateDataUrl(reviewState.image, reviewState.rotation);
    reviewState.usedRotation = reviewState.rotation ?? 0;

    let data = await api('/api/review/ocr', { image });
    // 走了本地 OCR 且质量不佳，说明可能是方向问题，再做四方向探测重试一次。
    if (data.channel === 'local-ocr' && data.lowQuality && !reviewState.rotation) {
      $('rvOcrBox').innerHTML = '<div class="dim small" style="margin-top:10px"><span class="spinner"></span> 识别效果不佳，正在检测照片方向…</div>';
      const best = await detectBestOrientation(reviewState.image, (current, total, degrees) => {
        $('rvOcrBox').innerHTML = `<div class="dim small" style="margin-top:10px"><span class="spinner"></span> 正在尝试第 ${current}/${total} 个方向（旋转 ${degrees}°）…</div>`;
      });
      if (best.degrees && best.image) {
        reviewState.usedRotation = best.degrees;
        data = await api('/api/review/ocr', { image: best.image });
      }
    }
    reviewState.raw = data.raw;
    $('rvText').value = data.cleaned;
    updateReviewWordCount();
    $('btnRvRestoreRaw').hidden = data.cleaned === data.raw;
    applyDetection(data.detection);
    // 识别质量差时如实告知，绝不假装识别成功。
    const notes = [];
    if (reviewState.usedRotation) notes.push(`已把照片旋转 ${reviewState.usedRotation}° 后识别`);
    if (data.channel === 'vision' && data.rotationDetected) notes.push(`视觉模型检测到照片旋转了 ${data.rotationDetected}°，已自动纠正`);
    if (data.unreadableCount) notes.push(`${data.unreadableCount} 处无法辨认，已用 [?] 标出`);
    const noteText = notes.length ? `${notes.join('；')}。` : '';
    const channel = data.channelLabel ?? data.backend ?? '';
    $('rvOcrBox').innerHTML = data.lowQuality
      ? `<div class="err-box small"><b>识别质量较低</b>（${esc(channel)}，可辨认字符 ${esc(Math.round((data.latinRatio ?? 0) * 100))}%）。${esc(noteText)}${esc(data.warning ?? '')}</div>`
      : `<div class="ok-box small">识别完成（${esc(channel)}${data.cleanedBy !== 'none' ? ' + 文本清洗' : ''}）。${esc(noteText)}请在下一步核对文本。</div>`;
    // 离线通道读手写体效果有限，如实给出改善建议。
    if (data.channel === 'local-ocr' && data.visionError) {
      $('rvOcrBox').insertAdjacentHTML('beforeend',
        `<div class="warn-box small">未能使用视觉模型（${esc(data.visionError)}）。手写作文建议在「设置 → 图片识别」配置千问视觉 Key，转写会更准确。</div>`);
    }
    if (data.lowQuality) {
      $('rvLowQuality').hidden = false;
      $('rvLowQuality').innerHTML = `<b>请特别注意：</b>下面是未经清洗的原始识别结果，很可能与你写的内容差别很大。`
        + `请直接改成你实际写的作文再继续——否则批改的是识别错误，而不是你的作文。`;
    } else {
      $('rvLowQuality').hidden = true;
    }
    setReviewStep(2);
  } catch (err) {
    $('rvOcrBox').innerHTML = '';
    rvError('rvErr1', `识别失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('btnRvManual').addEventListener('click', () => {
  reviewState.raw = '';
  $('btnRvRestoreRaw').hidden = true;
  setReviewStep(2);
  $('rvText').focus();
});

$('btnRvBack1').addEventListener('click', () => setReviewStep(1));
$('btnRvBack2').addEventListener('click', () => setReviewStep(2));
$('btnRvRestoreRaw').addEventListener('click', () => {
  $('rvText').value = reviewState.raw;
  updateReviewWordCount();
});

function updateReviewWordCount() {
  const count = $('rvText').value.trim().split(/\s+/).filter(Boolean).length;
  $('rvWordCount').textContent = `${count} 词`;
}
$('rvText').addEventListener('input', updateReviewWordCount);

function applyDetection(detection) {
  if (!detection) return;
  $('rvCategory').value = detection.category;
  $('rvDetection').innerHTML = `自动判定为 <b>${esc(detection.category)}</b>${detection.confident ? '' : '（置信度较低，请确认）'}｜依据：${esc((detection.evidence ?? []).join('；'))}`;
}

// 文本变化后重新判定题型，避免手动输入时题型停留在旧值。
let detectTimer = null;
$('rvText').addEventListener('input', () => {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    const essayText = $('rvText').value.trim();
    if (essayText.split(/\s+/).filter(Boolean).length < 20) return;
    try {
      applyDetection(await api('/api/review/classify', { essayText, questionText: $('rvQuestion').value }));
    } catch { /* 判定失败不打扰用户，题型仍可手选 */ }
  }, 900);
});

$('btnRvAnalyze').addEventListener('click', async () => {
  const essayText = $('rvText').value.trim();
  if (!essayText) return void rvError('rvErr2', '请先填写或识别作文内容。');
  const btn = $('btnRvAnalyze');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 正在按讲义规则批改…';
  rvError('rvErr2', '');
  try {
    const payload = {
      essayText,
      ai: $('rvAi').checked,
      aiGrammar: $('rvAiGrammar').checked,
    };
    if (reviewState.mode === 'exam' && $('rvExamId').value) {
      // 指定真题时题型与题干由题库决定，无需前端传。
      payload.examId = $('rvExamId').value;
    } else {
      payload.category = $('rvCategory').value;
      payload.questionText = $('rvQuestion').value.trim();
    }
    const review = await api('/api/review/analyze', payload);
    reviewState.review = review;
    reviewState.accepted = new Set();
    reviewState.finalText = essayText;
    renderReview(review);
    setReviewStep(3);
    $('view-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    rvError('rvErr2', `批改失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '确认文本并开始批改';
  }
});

function renderReview(review) {
  const grade = review.grade ?? {};
  const counts = grade.counts ?? {};
  const examLabel = review.exam ? `${review.exam.label} · ` : '';
  $('rvGrade').innerHTML = `
    <div class="review-grade">
      <div class="review-band">
        <span class="review-band-value">${esc(grade.band ?? '—')}</span>
        <span class="dim small">${esc(examLabel)}${esc(review.category)} · ${esc(review.words)} 词</span>
      </div>
      <div class="review-band-summary">${esc(grade.summary ?? '')}</div>
    </div>
    <div class="row review-counts">
      <span class="tag err">语法 ${esc(counts.grammar ?? 0)}</span>
      <span class="tag err">必改 ${esc(counts.required ?? 0)}</span>
      <span class="tag warn">建议 ${esc(counts.suggested ?? 0)}</span>
      <span class="tag page">结构 ${esc(counts.structure ?? 0)}</span>
    </div>
    <div class="review-gain-loss">
      <div><b>得分点</b>${(grade.gains ?? []).length ? `<ul>${grade.gains.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<div class="dim small">暂无</div>'}</div>
      <div><b>失分点</b>${(grade.losses ?? []).length ? `<ul>${grade.losses.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<div class="dim small">暂无</div>'}</div>
    </div>
    <div class="warn-box small">${esc(grade.disclaimer ?? '')}</div>`;

  renderReviewScore(review.score);
  renderReviewComparison(review);

  const container = $('rvIssues');
  container.innerHTML = '';
  for (const severity of ['required', 'suggested', 'structure']) {
    const items = (review.issues ?? []).filter((issue) => issue.severity === severity);
    if (!items.length) continue;
    const meta = SEVERITY_META[severity];
    const card = el('div', 'card');
    card.innerHTML = `<div class="spread"><h3 style="margin:0">${esc(meta.label)}项 · ${items.length} 条</h3>
      <span class="dim small">${esc(meta.hint)}</span></div>
      <div class="review-issue-list">${items.map((issue) => issueHtml(issue, meta)).join('')}</div>`;
    container.append(card);
  }
  updateReviewDiff();
}

/** 四维分项估分。区间而非确定值，避免造成"精确"的错觉。 */
function renderReviewScore(score) {
  const box = $('rvScore');
  if (!score?.dimensions?.length) { box.innerHTML = ''; return; }
  const rows = score.dimensions.map((item) => {
    const percent = item.max ? Math.round((item.high / item.max) * 100) : 0;
    return `<div class="score-row">
      <span class="score-label">${esc(item.label)}</span>
      <span class="score-value">${esc(item.low)}–${esc(item.high)} <span class="dim">/ ${esc(item.max)}</span></span>
      <span class="score-bar"><span class="score-bar-fill" style="width:${percent}%"></span></span>
      <span class="score-reason dim small">${esc(item.reason)}</span>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="card">
    <div class="spread">
      <h3 style="margin:0">分项估分</h3>
      <span class="score-total">${esc(score.totalLow)}–${esc(score.totalHigh)} <span class="dim">/ ${esc(score.full)} 分</span></span>
    </div>
    <div class="score-grid">${rows}</div>
    <div class="dim small" style="margin-top:10px">按内容、结构、语言、格式四项分别估算。语言项主要看语法错误与重复表达，这也是最容易丢分的地方。</div>
  </div>`;
}

/** 与该年真题范文的对照。范文只作参系。 */
function renderReviewComparison(review) {
  const box = $('rvCompare');
  const compare = review.modelComparison;
  if (!compare) { box.innerHTML = ''; return; }
  if (!compare.available) {
    box.innerHTML = `<div class="card"><h3>与范文对比</h3><div class="warn-box small">${esc(compare.note)}</div></div>`;
    return;
  }
  const gap = compare.wordGap;
  const gapText = gap === 0 ? '与范文字数相当' : gap < 0 ? `比范文少 ${Math.abs(gap)} 词` : `比范文多 ${gap} 词`;
  box.innerHTML = `<div class="card">
    <div class="spread"><h3 style="margin:0">与范文对比</h3><span class="dim small">${esc(review.exam?.label ?? '')}</span></div>
    <div class="compare-grid">
      <div><b>字数</b><div class="dim small">你 ${esc(compare.myWords)} 词 · 范文 ${esc(compare.modelWords)} 词<br>${esc(gapText)}</div></div>
      <div><b>段落</b><div class="dim small">你 ${esc(compare.myParagraphs)} 段 · 范文 ${esc(compare.modelParagraphs)} 段</div></div>
      <div><b>模块</b><div class="dim small">${compare.missingModules.length
    ? `范文用了你没用的：${compare.missingModules.map(esc).join('、')}`
    : '范文覆盖的模块你都写到了'}</div></div>
    </div>
    ${compare.notableWords.length
    ? `<div class="compare-words"><b>范文用到、你没用的表达</b><div>${compare.notableWords.map((word) => `<span class="tag">${esc(word)}</span>`).join('')}</div></div>`
    : ''}
    <div class="dim small" style="margin-top:10px">${esc(compare.note)}</div>
  </div>`;
}

function issueHtml(issue, meta) {
  const rewritten = issue.replacement || issue.suggestion;
  const pageTag = issue.page
    ? `<a class="tag page" href="/pages/p${String(issue.page).padStart(2, '0')}.png" target="_blank" rel="noopener noreferrer">讲义 P${esc(issue.page)}</a>`
    : '';
  const canAccept = Boolean(issue.quote && rewritten);
  // 含占位符的骨架不能直接套进终稿，必须先由考生填空。
  const needsFill = canAccept && !issue.replacement && issue.autoApplicable === false;
  const slotHint = (issue.slots ?? []).length
    ? `<div class="review-issue-slots">需替换：${issue.slots.map((slot) => `<span class="tag slot">{${esc(slot)}}</span>`).join('')}</div>`
    : '';
  return `<div class="review-issue" data-issue="${esc(issue.id)}">
    <div class="review-issue-head">
      <span class="tag ${esc(meta.cls)}">${esc(meta.label)}</span>
      <span class="review-issue-title">${esc(issue.title)}</span>
      ${pageTag}
    </div>
    ${issue.quote ? `<div class="review-issue-quote"><span class="review-issue-tag">原文</span><del>${esc(issue.quote)}</del></div>` : ''}
    ${rewritten ? `<div class="review-issue-fix"><span class="review-issue-tag">改为</span><ins>${hlPlaceholders(rewritten)}</ins></div>` : ''}
    ${slotHint}
    <div class="review-issue-detail">${esc(issue.detail ?? '')}</div>
    <div class="review-issue-basis"><b>修改依据</b>：${esc(issue.basis)}${issue.aiWhy ? `｜AI 补充：${esc(issue.aiWhy)}` : ''}</div>
    <div class="row review-issue-actions">
      ${canAccept
    ? `<button class="btn sm" data-accept>${needsFill ? '标记为待套用' : '采纳'}</button><button class="btn ghost sm" data-ignore>忽略</button>`
    : '<span class="dim small">该项需要自己动笔修改，无法自动替换</span>'}
      ${needsFill ? '<span class="dim small">含占位符，需你填入本题内容后再写进终稿</span>' : ''}
    </div>
  </div>`;
}

$('rvIssues').addEventListener('click', async (event) => {
  const node = event.target.closest('.review-issue');
  if (!node) return;
  const id = node.dataset.issue;
  if (event.target.matches('[data-accept]')) {
    reviewState.accepted.add(id);
    node.classList.add('is-accepted');
    node.classList.remove('is-ignored');
  } else if (event.target.matches('[data-ignore]')) {
    reviewState.accepted.delete(id);
    node.classList.remove('is-accepted');
    node.classList.add('is-ignored');
  } else return;
  await updateReviewDiff();
});

async function updateReviewDiff() {
  const total = reviewState.accepted.size;
  $('rvAcceptedCount').textContent = `已采纳 ${total} 项`;
  const original = $('rvText').value.trim();
  if (!total) {
    reviewState.finalText = original;
    $('rvDiff').innerHTML = '<div class="dim small">尚未采纳任何修改项。</div>';
    return;
  }
  try {
    const out = await api('/api/review/apply', {
      essayText: original,
      issues: reviewState.review?.issues ?? [],
      acceptedIds: [...reviewState.accepted],
    });
    reviewState.finalText = out.text;
    const rows = out.applied.map((item) => `<div class="review-diff-row">
      <del>${esc(item.from)}</del><span class="review-diff-arrow">→</span><ins>${esc(item.to)}</ins>
    </div>`).join('');
    const manual = out.manual.length
      ? `<div class="review-manual"><b>以下 ${out.manual.length} 项需要你自己动笔</b>${out.manual.map((item) => `
        <div class="review-manual-item">
          <div>${esc(item.title)}</div>
          ${item.template ? `<div class="dim small">套用：${hlPlaceholders(item.template)}</div>` : ''}
        </div>`).join('')}</div>`
      : '';
    $('rvDiff').innerHTML = `${rows || '<div class="dim small">采纳的条目均需手动修改。</div>'}${manual}
      <h4 style="margin-top:14px">终稿</h4>
      <div class="essay">${out.text.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
  } catch (err) {
    $('rvDiff').innerHTML = `<div class="err-box small">生成终稿失败：${esc(err.message)}</div>`;
  }
}

$('btnRvCopyFinal').addEventListener('click', async () => {
  await navigator.clipboard.writeText(reviewState.finalText || $('rvText').value);
  const btn = $('btnRvCopyFinal');
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = '复制终稿'; }, 1500);
});

$('btnRvToSheet').addEventListener('click', () => {
  const body = reviewState.finalText || $('rvText').value;
  if (!body.trim()) return;
  document.querySelector('nav.tabs button[data-view="hand"]').click();
  $('hwText').value = body;
});

$('btnRvPrint').addEventListener('click', () => {
  if (!reviewState.review) return void rvError('rvErr3', '请先完成批改。');
  downloadPdf('/api/print/review', { review: reviewState.review, finalText: reviewState.finalText },
    `批改报告-${new Date().toISOString().slice(0, 10)}.pdf`, $('btnRvPrint'), (m) => rvError('rvErr3', m));
});

// ---------------- 备考方向 ----------------

const EXAM_LABELS = { e1: '英语一', e2: '英语二' };
let examTypeState = null;

function renderExamChip() {
  const chip = $('examChip');
  if (!examTypeState?.examType) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = `备考：${EXAM_LABELS[examTypeState.examType]}`;
}

/** 首次未选方向时弹出引导；选完立即生效。 */
async function initExamType() {
  try {
    examTypeState = await api('/api/study/exam-type');
  } catch {
    return;
  }
  renderExamChip();
  $('cfgExamType').value = examTypeState.examType ?? '';
  const chosen = examTypeState.options?.find((option) => option.id === examTypeState.examType);
  $('examTypeNote').textContent = chosen?.note ?? '';
  if (examTypeState.chosen) return;

  const gate = $('examGate');
  $('examGateOptions').innerHTML = (examTypeState.options ?? []).map((option) => `
    <button class="exam-gate-option" data-exam-type="${esc(option.id)}">
      <strong>我考${esc(option.label)}</strong>
      <span class="dim small">${esc(option.note)}</span>
    </button>`).join('');
  gate.hidden = false;
  $('examGateOptions').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-exam-type]');
    if (!button) return;
    button.disabled = true;
    try {
      await api('/api/study/exam-type', { examType: button.dataset.examType });
      examTypeState = await api('/api/study/exam-type');
      renderExamChip();
      $('cfgExamType').value = examTypeState.examType ?? '';
      $('examTypeNote').textContent = examTypeState.options?.find((o) => o.id === examTypeState.examType)?.note ?? '';
      gate.hidden = true;
      // 已经打开过卡片页时需要按新方向重建。
      studyInited = false;
      if (document.querySelector('.kb-panel#kb-cards')?.classList.contains('active')) await initStudyCards();
    } catch (err) {
      $('examGateOptions').insertAdjacentHTML('afterend', `<div class="err-box small">保存失败：${esc(err.message)}</div>`);
      button.disabled = false;
    }
  });
}

$('btnSaveExamType').addEventListener('click', async () => {
  const value = $('cfgExamType').value;
  if (!value) return void ($('examTypeMsg').innerHTML = '<div class="err-box small">请选择英语一或英语二。</div>');
  const btn = $('btnSaveExamType');
  btn.disabled = true;
  try {
    await api('/api/study/exam-type', { examType: value });
    examTypeState = await api('/api/study/exam-type');
    renderExamChip();
    $('examTypeNote').textContent = examTypeState.options?.find((o) => o.id === value)?.note ?? '';
    $('examTypeMsg').innerHTML = '<div class="ok-box small">已保存。知识库范围与进度口径已切换。</div>';
    studyInited = false;
    studyOutline = null;
  } catch (err) {
    $('examTypeMsg').innerHTML = `<div class="err-box small">保存失败：${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------------- 学习卡片 ----------------

const STATUS_LABEL = { new: '未学', review: '需复习', mastered: '已掌握' };
let studyOutline = null;
let studyState = null;
let studyInited = false;

function studyError(message) {
  $('cardErr').innerHTML = message ? `<div class="err-box small">${esc(message)}</div>` : '';
}

function studyFilters() {
  return {
    track: $('cardTrack').value || undefined,
    module: $('cardModule').value || undefined,
    status: $('cardStatus').value || undefined,
    unit: $('cardUnit').value || undefined,
  };
}

function renderStudySummary() {
  if (!studyState) return;
  const { summary, totalUnits, currentUnit, examTypeLabel, scopeNote } = studyState;
  const percent = summary.total ? Math.round((summary.mastered / summary.total) * 100) : 0;
  $('cardBarFill').style.width = `${percent}%`;
  const scopePrefix = examTypeLabel ? `<b>${esc(examTypeLabel)}</b> · ` : '';
  $('cardSummary').innerHTML = `${scopePrefix}共 <b>${esc(summary.total)}</b> 张 · 已掌握 <b>${esc(summary.mastered)}</b>（${percent}%） · 需复习 <b>${esc(summary.review)}</b> · 未学 <b>${esc(summary.new)}</b> · 学习单元 ${esc(currentUnit)} / ${esc(totalUnits)}`;
  const note = $('cardScopeNote');
  if (note) note.textContent = scopeNote ?? '';
}

function renderStudyUnitOptions() {
  const select = $('cardUnit');
  const previous = select.value;
  const options = ['<option value="">全部单元</option>'];
  for (const unit of studyState?.units ?? []) {
    options.push(`<option value="${unit.unitIndex}">第 ${unit.unitIndex} 单元（${unit.mastered}/${unit.cardIds.length}）</option>`);
  }
  select.innerHTML = options.join('');
  select.value = previous && [...select.options].some((option) => option.value === previous) ? previous : String(studyState?.currentUnit ?? '');
}

function renderStudyModuleOptions() {
  const track = $('cardTrack').value;
  const select = $('cardModule');
  const previous = select.value;
  const tracks = (studyOutline ?? []).filter((item) => !track || item.id === track);
  const options = ['<option value="">全部模块</option>'];
  for (const item of tracks) {
    for (const module of item.modules) {
      if (!module.count) continue;
      options.push(`<option value="${esc(module.id)}">${esc(item.label)} · ${esc(module.label)}（${module.count}）</option>`);
    }
  }
  select.innerHTML = options.join('');
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
}

function cardItemHtml(card) {
  const status = card.status ?? 'new';
  const slots = (card.slots ?? []).length
    ? `<div class="card-slots">占位符：${card.slots.map((slot) => `<span class="tag slot">${esc(slot)}</span>`).join('')}</div>` : '';
  const notes = [...(card.constraints ?? []), ...(card.warnings ?? []).slice(0, 2)];
  const noteHtml = notes.length ? `<div class="note">${notes.map(esc).join('；')}</div>` : '';
  const page = card.source?.page;
  const href = page ? `/pages/p${String(page).padStart(2, '0')}.png` : null;
  const sourceHtml = page
    ? `<a class="tag page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">讲义 P${esc(page)}</a>`
    : '';
  const variants = (card.variants ?? []).slice(0, 6);
  const variantHtml = variants.length
    ? `<div class="card-variants dim small">可替换：${variants.map((item) => esc(item.value)).join('、')}</div>` : '';
  const scopeTag = card.examScope && card.examScope !== 'shared'
    ? `<span class="tag scope-own">${esc(card.scopeLabel)}</span>`
    : '<span class="tag scope-shared">通用</span>';
  const extendedTag = card.priority === 'extended' ? '<span class="tag warn">拓展题型</span>' : '';
  return `<div class="study-card" data-card="${esc(card.cardId)}">
    <div class="study-card-head">
      <span class="tag module-tag">${esc(card.trackLabel ?? '')} · ${esc(card.moduleLabel ?? '')}</span>
      ${scopeTag}${extendedTag}
      <span class="tag">约 ${esc(card.estimatedWords)} 词</span>
      ${sourceHtml}
      <span class="tag status-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>
    </div>
    <div class="study-card-en">${hlPlaceholders(card.en)}</div>
    <div class="study-card-zh${$('cardHideZh').checked ? ' hidden-zh' : ''}">${card.zhMissing ? '<span class="dim">讲义原文未提供中文译文</span>' : hlPlaceholders(card.zh)}</div>
    ${slots}${variantHtml}${noteHtml}
    <div class="study-card-actions row">
      <button class="btn sm" data-status="mastered">已掌握</button>
      <button class="btn ghost sm" data-status="review">需复习</button>
      <button class="btn ghost sm" data-status="new">重置</button>
      <button class="btn ghost sm" data-toggle-zh>${$('cardHideZh').checked ? '显示中文' : '隐藏中文'}</button>
    </div>
  </div>`;
}

async function loadStudyCards() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(studyFilters())) if (value) params.set(key, value);
  try {
    const data = await api(`/api/study/cards?${params.toString()}`);
    const list = $('cardList');
    if (!data.cards.length) {
      list.innerHTML = '<div class="card dim small">没有符合条件的卡片。</div>';
      return;
    }
    list.innerHTML = data.cards.map(cardItemHtml).join('');
    studyError('');
  } catch (err) {
    studyError(`卡片加载失败：${err.message}`);
  }
}

async function refreshStudyPlan(planPatch) {
  try {
    studyState = planPatch ? await api('/api/study/plan', planPatch) : await api('/api/study/plan');
    $('cardDaily').value = String(studyState.options.dailyCount);
    $('cardExtended').checked = studyState.options.includeExtended === true;
    // 英语二没有拓展轨道，隐藏该开关避免误导。
    const hasExtended = (studyState.visibleTracks ?? []).length > (studyState.coreTracks ?? []).length;
    $('cardExtended').closest('label').hidden = !hasExtended;
    renderStudySummary();
    renderStudyUnitOptions();
    await loadStudyCards();
  } catch (err) {
    studyError(`学习计划加载失败：${err.message}`);
  }
}

async function initStudyCards() {
  if (studyInited) return;
  studyInited = true;
  try {
    studyOutline = (await api('/api/study/outline')).tracks;
    $('cardTrack').innerHTML = ['<option value="">全部轨道</option>',
      ...studyOutline.map((track) => `<option value="${esc(track.id)}">${esc(track.label)}（${track.count}）</option>`)].join('');
    renderStudyModuleOptions();
  } catch (err) {
    studyError(`轨道加载失败：${err.message}`);
  }
  await refreshStudyPlan();
}

$('cardList').addEventListener('click', async (event) => {
  const card = event.target.closest('.study-card');
  if (!card) return;
  if (event.target.matches('[data-toggle-zh]')) {
    const zh = card.querySelector('.study-card-zh');
    zh.classList.toggle('hidden-zh');
    event.target.textContent = zh.classList.contains('hidden-zh') ? '显示中文' : '隐藏中文';
    return;
  }
  const status = event.target.dataset?.status;
  if (!status) return;
  try {
    const result = await api('/api/study/progress', { cardId: card.dataset.card, status });
    studyState = { ...studyState, summary: result.summary, units: result.units, currentUnit: result.currentUnit };
    renderStudySummary();
    renderStudyUnitOptions();
    const badge = card.querySelector('.study-card-head .tag[class*="status-"]');
    badge.className = `tag status-${status}`;
    badge.textContent = STATUS_LABEL[status] ?? status;
  } catch (err) {
    studyError(`进度保存失败：${err.message}`);
  }
});

$('cardTrack').addEventListener('change', () => { renderStudyModuleOptions(); loadStudyCards(); });
$('cardModule').addEventListener('change', loadStudyCards);
$('cardStatus').addEventListener('change', loadStudyCards);
$('cardUnit').addEventListener('change', loadStudyCards);
$('cardDaily').addEventListener('change', () => refreshStudyPlan({
  dailyCount: Number($('cardDaily').value),
  includeExtended: $('cardExtended').checked,
}));
$('cardExtended').addEventListener('change', () => refreshStudyPlan({
  dailyCount: Number($('cardDaily').value),
  includeExtended: $('cardExtended').checked,
}));
$('cardHideZh').addEventListener('change', loadStudyCards);

$('btnCardReset').addEventListener('click', async () => {
  if (!window.confirm('确定要重置全部学习进度吗？该操作不可撤销。')) return;
  try {
    studyState = await api('/api/study/reset', { keepPlan: true });
    renderStudySummary();
    renderStudyUnitOptions();
    await loadStudyCards();
  } catch (err) {
    studyError(`重置失败：${err.message}`);
  }
});

async function downloadPdf(path, payload, fileName, button, setError) {
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = '生成中…'; }
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = `服务返回异常（${res.status}）`;
      try { const json = JSON.parse(detail); message = json.error ?? message; } catch { if (detail) message = detail.slice(0, 200); }
      throw new Error(message);
    }
    const blob = await res.blob();
    await downloadOrShare(fileName, 'application/pdf', blob);
    setError('');
  } catch (err) {
    setError(`PDF 导出失败：${err.message}`);
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

$('btnCardPrint').addEventListener('click', () => {
  const filters = studyFilters();
  downloadPdf('/api/print/cards', { ...filters, hideChinese: $('cardHideZh').checked },
    `背诵卡片-${new Date().toISOString().slice(0, 10)}.pdf`, $('btnCardPrint'), studyError);
});

// ---------------- 行文解析 ----------------

let analysisInited = false;

function analysisError(message) {
  $('analysisErr').innerHTML = message ? `<div class="err-box small">${esc(message)}</div>` : '';
}

/** 模块流程条：把「按模块组装」的思想显式画出来。 */
function moduleFlowHtml(flow) {
  if (!(flow ?? []).length) return '';
  const steps = flow.map((module, index) => {
    const state = module.covered ? 'done' : module.required ? 'missing' : 'optional';
    const count = module.sentences?.length ?? 0;
    return `<div class="flow-step is-${state}" title="${esc(module.description ?? '')}">
      <span class="flow-index">${index + 1}</span>
      <span class="flow-label">${esc(module.label)}</span>
      <span class="flow-meta">${module.covered ? `${count} 句` : module.required ? '缺失' : '未用'}</span>
    </div>`;
  }).join('<span class="flow-arrow">→</span>');
  const gaps = flow.filter((module) => !module.covered && module.suggestion);
  const advice = gaps.length
    ? `<div class="flow-advice">${gaps.map((module) => `<div class="flow-advice-item"><span class="tag ${module.required ? 'err' : 'warn'}">${esc(module.label)}</span><span class="dim small">${esc(module.suggestion)}</span></div>`).join('')}</div>`
    : '<div class="dim small" style="margin-top:8px">六个模块均已覆盖，结构完整。</div>';
  return `<div class="module-flow">${steps}</div>${advice}`;
}

function analysisSentenceHtml(sentence) {
  const skeletons = (sentence.skeletons ?? []).map((item) => {
    const page = item.source?.page;
    const href = page ? `/pages/p${String(page).padStart(2, '0')}.png` : null;
    const tag = page
      ? `<a class="tag page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">讲义 P${esc(page)}</a>`
      : '<span class="tag page">讲义功能句</span>';
    const badge = item.exact ? '<span class="tag ok">本句所用模板</span>' : '<span class="tag">相似模板</span>';
    return `<div class="analysis-skeleton">${badge}${tag}<span class="dim small">${hlPlaceholders(item.en)}</span></div>`;
  }).join('');
  const moduleTag = sentence.moduleLabel
    ? `<span class="tag module-tag">${esc(sentence.moduleLabel)}</span>` : '';
  const note = sentence.templateNote
    ? `<div class="dim small analysis-template-note">${esc(sentence.templateNote)}</div>` : '';
  return `<div class="analysis-sentence">
    <div class="analysis-sentence-head">
      <span class="source-index">${esc(sentence.index)}</span>
      ${moduleTag}
      <span class="tag">${esc(sentence.roleLabel)}</span>
      <span class="dim small">${esc(sentence.words)} 词</span>
    </div>
    <div class="analysis-text">${esc(sentence.text)}</div>
    <div class="analysis-why">${esc(sentence.why)}</div>
    ${skeletons}${note}
  </div>`;
}

function renderAnalysis(analysis, target = $('analysisBody')) {
  const body = target;
  body.innerHTML = '';

  const overview = el('div', 'card');
  const distribution = (analysis.wordDistribution ?? [])
    .map((item) => `第${item.index}段 ${item.words} 词（${item.percent}%）`).join(' · ');
  const title = analysis.source === 'composedEssay'
    ? `本篇作文 · ${analysis.track.label}`
    : `${analysis.exam.year} ${analysis.exam.examType === 'e1' ? '英语一' : '英语二'}${analysis.exam.section === 'small' ? '小作文' : '大作文'} · ${analysis.track.label}`;
  overview.innerHTML = `<div class="spread"><h2 style="margin:0">${esc(title)}</h2>
    <span class="dim small">全文 ${esc(analysis.totalWords)} 词</span></div>
    <div class="dim small" style="margin-top:6px">${esc(analysis.track.description)}</div>
    ${distribution ? `<div class="dim small" style="margin-top:6px">字数分配：${esc(distribution)}</div>` : ''}
    <h3 style="margin-top:14px">模块组装流程</h3>
    <div class="dim small">这篇作文由下面这些功能模块依次拼装而成；灰色表示尚未覆盖。</div>
    ${moduleFlowHtml(analysis.moduleFlow)}
    ${(analysis.notes ?? []).map((note) => `<div class="warn-box small" style="margin-top:8px">${esc(note)}</div>`).join('')}`;
  body.append(overview);

  if (analysis.aiInsight?.summary) {
    const ai = el('div', 'card');
    ai.innerHTML = `<h2>整体行文思路（AI 深化）</h2><div>${esc(analysis.aiInsight.summary)}</div>
      ${(analysis.aiInsight.pitfalls ?? []).length ? `<div class="note">易错：${analysis.aiInsight.pitfalls.map(esc).join('；')}</div>` : ''}`;
    body.append(ai);
  }

  const blueprint = el('div', 'card');
  blueprint.innerHTML = `<h2>行文骨架</h2>${(analysis.blueprint ?? []).map((item) => `
    <div class="analysis-blueprint">
      <b>${esc(item.name)}</b>
      <div class="dim small">${esc(item.purpose)}</div>
      ${item.avoid ? `<div class="note">避免：${esc(item.avoid)}</div>` : ''}
    </div>`).join('')}`;
  body.append(blueprint);

  for (const paragraph of analysis.paragraphs ?? []) {
    const card = el('div', 'card');
    card.innerHTML = `<div class="spread"><h2 style="margin:0">${esc(paragraph.name)}</h2><span class="dim small">${esc(paragraph.words)} 词</span></div>
      ${paragraph.purpose ? `<div class="dim small" style="margin-top:6px">本段任务：${esc(paragraph.purpose)}</div>` : ''}
      ${paragraph.avoid ? `<div class="note">避免：${esc(paragraph.avoid)}</div>` : ''}
      ${paragraph.aiNote ? `<div class="ok-box small" style="margin-top:8px">补充讲解：${esc(paragraph.aiNote)}</div>` : ''}
      ${(paragraph.sentences ?? []).map(analysisSentenceHtml).join('')}`;
    body.append(card);
  }

  if (!(analysis.paragraphs ?? []).length) {
    body.append(el('div', 'card dim small', '本题暂无已校对范文，上面的行文骨架仍可作为写作顺序参考。'));
  }
}

async function loadAnalysis() {
  const id = $('analysisExam').value;
  if (!id) return;
  $('analysisBody').innerHTML = '<div class="card dim small">正在生成解析…</div>';
  try {
    const params = new URLSearchParams({ id });
    if ($('analysisAi').checked) params.set('ai', '1');
    renderAnalysis(await api(`/api/analysis/exam?${params.toString()}`));
    analysisError('');
  } catch (err) {
    $('analysisBody').innerHTML = '';
    analysisError(`解析失败：${err.message}`);
  }
}

/** 只填充题目下拉；是否立即解析由调用方决定，避免覆盖指定题目。 */
async function initAnalysis({ autoLoad = true } = {}) {
  if (analysisInited) return;
  analysisInited = true;
  try {
    const data = await api('/api/exams?limit=200&hasEssay=true');
    $('analysisExam').innerHTML = data.exams.map((exam) => {
      const label = `${exam.year} ${exam.examType === 'e1' ? '英语一' : '英语二'}${exam.section === 'small' ? '小作文' : '大作文'}`;
      return `<option value="${esc(exam.id)}">${esc(label)}</option>`;
    }).join('');
    if (autoLoad && data.exams.length) await loadAnalysis();
  } catch (err) {
    analysisError(`题目列表加载失败：${err.message}`);
  }
}

$('analysisExam').addEventListener('change', loadAnalysis);
$('analysisAi').addEventListener('change', loadAnalysis);
$('btnAnalysisPrint').addEventListener('click', () => {
  const id = $('analysisExam').value;
  if (!id) return void analysisError('请先选择题目。');
  downloadPdf('/api/print/analysis', { examId: id, ai: $('analysisAi').checked },
    `行文精讲-${id}.pdf`, $('btnAnalysisPrint'), analysisError);
});

/** 从真题题库跳转到指定题目的行文解析。 */
async function openAnalysisFor(examId) {
  document.querySelector('nav.tabs button[data-view="kb"]').click();
  // 先只建下拉，避免默认题目把指定题目覆盖掉。
  await initAnalysis({ autoLoad: false });
  setKbViewActive('analysis');
  const select = $('analysisExam');
  if (![...select.options].some((option) => option.value === examId)) {
    $('analysisBody').innerHTML = '';
    analysisError('该题目暂无已校对范文，无法生成逐句解析。');
    return;
  }
  select.value = examId;
  await loadAnalysis();
}

/** 只切换标签与面板的激活态，不触发任何数据加载。 */
function setKbViewActive(view) {
  document.querySelectorAll('[data-kb-view]').forEach((b) => b.classList.toggle('active', b.dataset.kbView === view));
  document.querySelectorAll('.kb-panel').forEach((p) => p.classList.toggle('active', p.id === `kb-${view}`));
}

function setKbView(view) {
  setKbViewActive(view);
  if (view === 'modules') loadModules();
  if (view === 'practice') renderPractice();
  // 卡片页每次进入都要重新拉进度：写作文页标记模板句后必须能立即看到。
  if (view === 'cards') studyInited ? refreshStudyPlan() : initStudyCards();
  if (view === 'analysis') initAnalysis();
}

document.querySelectorAll('[data-kb-view]').forEach((btn) => btn.addEventListener('click', () => setKbView(btn.dataset.kbView)));

async function initKb() {
  if (kbInited) return;
  kbInited = true;
  try {
    const stats = await api('/api/kb/stats');
    const KIND_LABEL = {
      'big-essay-opening': '大作文开头段', 'big-essay-body': '大作文主体段', 'big-essay-closing': '大作文结尾段',
      'chart-essay': '图表作文', 'small-essay-para1': '小作文第一段', 'small-essay-para2': '小作文第二段',
      'small-essay-para3': '小作文第三段', 'small-essay-typed': '小作文题型专项', 'layout': '卷面格式',
      'vocab': '词表', 'method': '方法论', 'transition': '过渡页',
    };
    $('kbStats').innerHTML = `
      <div class="stat"><b>${esc(stats.pages)}</b><span>PDF 页数</span></div>
      <div class="stat"><b>${esc(stats.entries)}</b><span>模板句</span></div>
      <div class="stat"><b>${esc(stats.vocab)}</b><span>替换词条</span></div>
      <div class="stat"><b>${esc(stats.layouts)}</b><span>卷面规范</span></div>
      <div class="stat"><b>${esc(stats.letterTypes?.length ?? 0)}</b><span>小作文题型</span></div>
      <div class="stat"><b>${esc(stats.exams ?? 0)}</b><span>历年真题</span></div>
      <div class="stat"><b>${esc(stats.examEssays ?? 0)}</b><span>参考范文</span></div>`;

    const kindSel = $('kbKind');
    for (const [kind, count] of Object.entries(stats.kindCounts ?? {})) {
      const opt = el('option', '', `${esc(KIND_LABEL[kind] ?? kind)}（${esc(count)}）`);
      opt.value = kind;
      kindSel.append(opt);
    }
    for (const lt of stats.letterTypes ?? []) {
      [$('kbLetterType'), $('moduleLetterType')].forEach((select) => {
        const opt = el('option', '', esc(lt));
        opt.value = lt;
        select.append(opt);
      });
    }
    $('moduleTrack').value = practiceState.trackId;
    $('moduleLetterType').value = practiceState.letterType;
    $('moduleLetterTypeWrap').hidden = practiceState.trackId !== 'small';
    updateDraftBadges();
    searchKb();
  } catch (err) {
    $('kbStats').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
}

function templateCardHtml(t, includeAction = true) {
  return `
    <div class="template-main">${hlPlaceholders(t.en ?? t.text ?? '')}</div>
    ${t.zh ? `<div class="zh dim small">${hlPlaceholders(t.zh)}</div>` : ''}
    <div class="meta">
      ${sourceMetaHtml(t, { showKey: true })}
      ${t.letterType ? `<span class="tag">${esc(t.letterType)}</span>` : ''}
      ${(t.slots ?? []).map((x) => `<span class="tag slot">${esc(x)}</span>`).join('')}
      ${(t.swappable ?? []).map((x) => `<span class="tag swap">${esc(x)}</span>`).join('')}
    </div>
    ${(t.examples ?? []).length ? `<div class="dim small example">真题示例（${esc(t.examples[0].label)}）：${esc(t.examples[0].en || t.examples[0].zh)}</div>` : ''}
    ${notesHtml(t)}
    ${includeAction ? `<div class="template-actions"><button class="btn ghost sm add-template" data-template-id="${esc(t.id)}">加入练习稿</button></div>` : ''}`;
}

async function searchKb() {
  const params = new URLSearchParams();
  if ($('kbKeyword').value.trim()) params.set('keyword', $('kbKeyword').value.trim());
  if ($('kbKind').value) params.set('kind', $('kbKind').value);
  if ($('kbLetterType').value) params.set('letterType', $('kbLetterType').value);
  params.set('limit', '120');

  $('kbList').innerHTML = '<div class="dim small">检索中…</div>';
  try {
    const r = await api(`/api/kb/templates?${params}`);
    if (!r.templates?.length) {
      $('kbList').innerHTML = '<div class="dim small">没有匹配的模板。</div>';
      return;
    }
    $('kbList').innerHTML = '';
    $('kbList').append(el('div', 'dim small', `共 ${esc(r.count)} 条`));
    for (const t of r.templates) {
      const item = el('div', 'kb-item template-card');
      item.innerHTML = templateCardHtml(t);
      item.querySelector('.add-template').addEventListener('click', () => addPracticeItem(t, t.module));
      $('kbList').append(item);
    }
  } catch (err) {
    $('kbList').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
}

function normalizeTrackPayload(r) {
  const track = r.track ?? r;
  return { tracks: r.tracks ?? [], track: { ...track, modules: track.modules ?? [] } };
}

async function loadModules(force = false) {
  const trackId = $('moduleTrack').value;
  const letterType = trackId === 'small' ? $('moduleLetterType').value : '';
  if (!force && moduleData?.track.id === trackId && (moduleData.letterType ?? '') === letterType) return;
  $('moduleList').innerHTML = '<div class="card dim small">正在加载模块…</div>';
  const params = new URLSearchParams({ track: trackId });
  if (letterType) params.set('letterType', letterType);
  try {
    const payload = normalizeTrackPayload(await api(`/api/kb/modules?${params}`));
    moduleData = { ...payload, letterType };
    practiceState.trackId = payload.track.id ?? trackId;
    practiceState.letterType = letterType;
    savePracticeState();
    renderModules();
  } catch (err) {
    $('moduleList').innerHTML = `<div class="card err-box small">${esc(err.message)}</div>`;
  }
}

function renderModules() {
  const track = moduleData?.track;
  if (!track) return;
  $('moduleTrackDescription').textContent = track.description ?? `当前轨道：${track.label ?? track.id}`;
  if (moduleData.tracks?.length) {
    const select = $('moduleTrack');
    // 必须先取旧值：innerHTML 清空后 value 会被浏览器重置为空。
    const wanted = select.value || track.id;
    select.innerHTML = '';
    for (const t of moduleData.tracks) {
      const opt = el('option', '', esc(t.label ?? t.id));
      opt.value = t.id;
      select.append(opt);
    }
    select.value = moduleData.tracks.some((t) => t.id === wanted) ? wanted : (track.id ?? moduleData.tracks[0].id);
  }
  $('moduleList').innerHTML = '';
  if (!track.modules.length) {
    $('moduleList').innerHTML = '<div class="card dim small">当前筛选下没有可用模块。</div>';
    return;
  }
  track.modules.forEach((module, index) => {
    const card = el('section', 'card module-card');
    card.innerHTML = `<div class="module-heading"><span class="module-order">${index + 1}</span><div><h2>${esc(module.label ?? module.id)} ${module.required ? '<span class="tag warn">必选</span>' : '<span class="tag page">可选</span>'}</h2><div class="dim small">${esc(module.description ?? '')}</div></div></div><div class="module-templates"></div>`;
    const list = card.querySelector('.module-templates');
    for (const template of module.templates ?? []) {
      const normalized = { ...template, module: template.module ?? { id: module.id, label: module.label } };
      const item = el('div', 'template-card');
      item.innerHTML = templateCardHtml(normalized);
      item.querySelector('.add-template').addEventListener('click', () => addPracticeItem(normalized, module));
      list.append(item);
    }
    $('moduleList').append(card);
  });
  updateDraftBadges();
}

function practiceItemFromTemplate(template, module) {
  return {
    uid: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    id: template.id,
    label: template.label,
    en: template.en ?? template.text ?? '',
    zh: template.zh ?? '',
    notes: template.notes ?? template.reminders ?? [],
    module: template.module ?? (module ? { id: module.id, label: module.label, required: module.required } : null),
    sourceInfo: template.sourceInfo ?? null,
    page: template.page,
    trackId: practiceState.trackId,
  };
}

function addPracticeItem(template, module) {
  practiceState.items.push(practiceItemFromTemplate(template, module));
  savePracticeState();
  renderPractice();
  const buttons = document.querySelectorAll(`[data-template-id="${CSS.escape(String(template.id))}"]`);
  buttons.forEach((button) => {
    button.textContent = '已加入';
    setTimeout(() => { button.textContent = '加入练习稿'; }, 1000);
  });
}

function updateDraftBadges() {
  const count = practiceState.items.length;
  $('practiceCount').textContent = count;
  $('moduleDraftCount').textContent = `${count} 句`;
  const modules = [...new Set(practiceState.items.map((x) => x.module?.label).filter(Boolean))];
  $('moduleDraftSummary').textContent = count ? `已选 ${count} 句，覆盖：${modules.join('、') || '未标注模块'}` : '尚未选句。';
}

function moduleCandidates(item) {
  const module = moduleData?.track?.modules?.find((m) => m.id === item.module?.id);
  return module?.templates ?? [];
}

function renderPractice() {
  updateDraftBadges();
  const wrap = $('practiceSentences');
  wrap.innerHTML = '';
  if (!practiceState.items.length) {
    wrap.innerHTML = '<div class="empty-state">练习稿为空，请返回「模块组装」选择模板句。</div>';
  }
  practiceState.items.forEach((item, index) => {
    const row = el('article', 'practice-row');
    const candidates = moduleCandidates(item);
    row.innerHTML = `
      <div class="practice-order">${index + 1}</div>
      <div class="practice-content">
        <div>${hlPlaceholders(item.en)}</div>
        <div class="meta">${sourceMetaHtml(item, { showKey: true })}</div>
        ${notesHtml(item)}
        ${candidates.length > 1 ? `<label class="replacement small">候选替换 <select data-replace="${esc(item.uid)}">${candidates.map((candidate) => `<option value="${esc(candidate.id)}" ${candidate.id === item.id ? 'selected' : ''}>${esc(candidate.label ?? candidate.en ?? candidate.id)}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="practice-actions">
        <button class="btn ghost sm" data-move="up" data-uid="${esc(item.uid)}" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn ghost sm" data-move="down" data-uid="${esc(item.uid)}" aria-label="下移" ${index === practiceState.items.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ghost sm danger" data-remove="${esc(item.uid)}">删除</button>
      </div>`;
    wrap.append(row);
  });
  renderPracticeFills();
  renderPracticePreview();
}

function placeholderTokens() {
  const map = new Map();
  for (const item of practiceState.items) {
    const matches = String(item.en).matchAll(/\{([^{}]+)\}|\[([^\[\]]+)\]/g);
    for (const match of matches) {
      const raw = match[0];
      if (!map.has(raw)) map.set(raw, { raw, name: match[1] ?? match[2], primary: raw.startsWith('{') });
    }
  }
  return [...map.values()];
}

function renderPracticeFills() {
  const tokens = placeholderTokens();
  $('practiceFills').innerHTML = '';
  if (!tokens.length) {
    $('practiceFills').innerHTML = '<div class="dim small">所选句子没有占位符。</div>';
    return;
  }
  for (const token of tokens) {
    const label = el('label', 'fill-field');
    label.innerHTML = `<span class="${token.primary ? 'ph-slot' : 'ph-sec'}">${esc(token.raw)}</span><input type="text" data-fill="${esc(token.raw)}" value="${esc(practiceState.fills[token.raw] ?? '')}" placeholder="填写 ${esc(token.name)}">`;
    $('practiceFills').append(label);
  }
}

function filledPracticeText(item) {
  return String(item.en).replace(/\{([^{}]+)\}|\[([^\[\]]+)\]/g, (raw) => practiceState.fills[raw]?.trim() || raw);
}

function countEnglishWords(text) {
  return (String(text).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length;
}

function missingRequiredModules() {
  return (moduleData?.track?.modules ?? [])
    .filter((m) => m.required && !practiceState.items.some((item) => item.module?.id === m.id))
    .map((m) => m.label ?? m.id);
}

function renderPracticePreview() {
  const texts = practiceState.items.map(filledPracticeText);
  const unfilled = placeholderTokens().filter((token) => !practiceState.fills[token.raw]?.trim());
  const missing = missingRequiredModules();
  $('practiceWords').textContent = `${countEnglishWords(texts.join(' '))} 词`;
  $('practicePreview').innerHTML = texts.length
    ? texts.map((text) => `<p>${hlPlaceholders(text)}</p>`).join('')
    : '<p class="dim small">选择模板后在此预览。</p>';
  const warnings = [];
  if (unfilled.length) warnings.push(`<div class="warn-box small">未填占位符（${unfilled.length}）：${unfilled.map((x) => esc(x.raw)).join('、')}</div>`);
  if (missing.length) warnings.push(`<div class="warn-box small">缺失必选模块：${missing.map(esc).join('、')}</div>`);
  if (!unfilled.length && !missing.length && texts.length) warnings.push('<div class="ok-box small">占位符与必选模块检查通过。</div>');
  $('practiceWarnings').innerHTML = warnings.join('');
}

$('practiceSentences').addEventListener('click', (e) => {
  const move = e.target.closest('[data-move]');
  const remove = e.target.closest('[data-remove]');
  if (move) {
    const index = practiceState.items.findIndex((x) => x.uid === move.dataset.uid);
    const next = move.dataset.move === 'up' ? index - 1 : index + 1;
    if (index >= 0 && next >= 0 && next < practiceState.items.length) {
      [practiceState.items[index], practiceState.items[next]] = [practiceState.items[next], practiceState.items[index]];
    }
  } else if (remove) {
    practiceState.items = practiceState.items.filter((x) => x.uid !== remove.dataset.remove);
  } else return;
  savePracticeState();
  renderPractice();
});

$('practiceSentences').addEventListener('change', (e) => {
  const uid = e.target.dataset.replace;
  if (!uid) return;
  const index = practiceState.items.findIndex((x) => x.uid === uid);
  const current = practiceState.items[index];
  const candidate = moduleCandidates(current).find((x) => String(x.id) === e.target.value);
  if (!candidate) return;
  practiceState.items[index] = { ...practiceItemFromTemplate(candidate, current.module), uid };
  savePracticeState();
  renderPractice();
});

$('practiceFills').addEventListener('input', (e) => {
  if (!e.target.dataset.fill) return;
  practiceState.fills[e.target.dataset.fill] = e.target.value;
  savePracticeState();
  renderPracticePreview();
});

$('btnCopyPractice').addEventListener('click', async () => {
  const text = practiceState.items.map(filledPracticeText).join(' ');
  if (!text) return;
  await navigator.clipboard.writeText(text);
  $('btnCopyPractice').textContent = '已复制';
  setTimeout(() => { $('btnCopyPractice').textContent = '复制纯文本'; }, 1500);
});

$('btnOpenPractice').addEventListener('click', () => setKbView('practice'));
$('btnBackModules').addEventListener('click', () => setKbView('modules'));
$('moduleTrack').addEventListener('change', () => {
  $('moduleLetterTypeWrap').hidden = $('moduleTrack').value !== 'small';
  loadModules(true);
});
$('moduleLetterType').addEventListener('change', () => loadModules(true));
$('btnKbSearch').addEventListener('click', searchKb);
$('kbKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchKb(); });
$('kbKind').addEventListener('change', searchKb);
$('kbLetterType').addEventListener('change', searchKb);

// ---------------- 设置 ----------------

let setInited = false;
async function initSettings() {
  if (setInited) return;
  setInited = true;
  try {
    const cfg = await api('/api/config');
    $('cfgKeyMask').textContent = cfg.deepseek.hasApiKey ? `当前 Key：${cfg.deepseek.apiKeyMasked}` : '当前未配置 API Key';
    $('cfgModelR').value = cfg.deepseek.modelReasoning;
    $('cfgModelF').value = cfg.deepseek.modelFast;

    if (cfg.vision) {
      $('cfgVisionKeyMask').textContent = cfg.vision.hasApiKey ? `当前千问 Key：${cfg.vision.apiKeyMasked}` : '当前未配置千问 Key';
      $('cfgVisionModel').value = cfg.vision.model || 'qwen3.7-plus';
    }

  } catch (err) {
    $('cfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
}

$('btnSaveCfg').addEventListener('click', async () => {
  try {
    const cfg = await api('/api/config', {
      deepseek: {
        apiKey: $('cfgKey').value.trim() || undefined,
        modelReasoning: $('cfgModelR').value,
        modelFast: $('cfgModelF').value,
      },
    });
    $('cfgKey').value = '';
    $('cfgKeyMask').textContent = cfg.deepseek.hasApiKey ? `当前 Key：${cfg.deepseek.apiKeyMasked}` : '当前未配置 API Key';
    $('cfgMsg').innerHTML = '<div class="ok-box small">已保存。</div>';
    refreshHealth();
  } catch (err) {
    $('cfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
});

$('btnSaveVisionCfg')?.addEventListener('click', async () => {
  try {
    const cfg = await api('/api/config', {
      vision: {
        apiKey: $('cfgVisionKey').value.trim() || undefined,
        model: $('cfgVisionModel').value,
      },
    });
    $('cfgVisionKey').value = '';
    $('cfgVisionKeyMask').textContent = cfg.vision.hasApiKey ? `当前千问 Key：${cfg.vision.apiKeyMasked}` : '当前未配置千问 Key';
    $('visionCfgMsg').innerHTML = cfg.vision.hasApiKey
      ? '<div class="ok-box small">千问视觉设置已保存。</div>'
      : '<div class="warn-box small">设置已保存，但仍未检测到千问 Key，请确认已填写。</div>';
    refreshHealth();
  } catch (err) {
    $('visionCfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
});

$('btnTestVisionCfg')?.addEventListener('click', async () => {
  const btn = $('btnTestVisionCfg');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '测试中…';
  try {
    // 允许先填 Key 直接测试，未填则测试已保存的 Key。
    const typed = $('cfgVisionKey').value.trim();
    const r = await api('/api/vision/test', {
      ...(typed ? { apiKey: typed } : {}),
      model: $('cfgVisionModel').value,
    });
    const seen = (r.objectsSeen ?? []).filter(Boolean).map(esc).join('、');
    $('visionCfgMsg').innerHTML = `<div class="ok-box small">千问视觉连通正常：模型 ${esc(r.model)}，响应 ${r.latencyMs} ms${seen ? `，识读示例：${seen}` : ''}。</div>`;
  } catch (err) {
    $('visionCfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('btnClearVisionKey')?.addEventListener('click', async () => {
  try {
    const cfg = await api('/api/config', { vision: { apiKey: null } });
    $('cfgVisionKey').value = '';
    $('cfgVisionKeyMask').textContent = cfg.vision.hasApiKey ? `当前千问 Key：${cfg.vision.apiKeyMasked}` : '当前未配置千问 Key';
    $('visionCfgMsg').innerHTML = '<div class="ok-box small">千问 Key 已清除。</div>';
    refreshHealth();
  } catch (err) {
    $('visionCfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
});

$('btnClearKey').addEventListener('click', async () => {
  if (!confirm('确定清除已保存的 API Key？清除后需要重新填写才能使用 AI 功能。')) return;
  try {
    const cfg = await api('/api/config', { deepseek: { apiKey: null } });
    $('cfgKeyMask').textContent = cfg.deepseek.hasApiKey ? `当前 Key：${cfg.deepseek.apiKeyMasked}` : '当前未配置 API Key';
    $('cfgMsg').innerHTML = '<div class="ok-box small">已清除 API Key。</div>';
    refreshHealth();
  } catch (err) {
    $('cfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  }
});

$('btnTestCfg').addEventListener('click', async () => {
  const btn = $('btnTestCfg');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    // 该接口只接受 POST；api() 在无 body 时会发 GET，因此显式传空对象。
    const r = await api('/api/deepseek/test', {});
    $('cfgMsg').innerHTML = `<div class="ok-box small">连通正常：模型 ${esc(r.model)}，响应 ${r.latencyMs} ms，回复「${esc(r.reply)}」。</div>`;
  } catch (err) {
    $('cfgMsg').innerHTML = `<div class="err-box small">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连通性';
  }
});

// 首屏引导：未选备考方向时提示选择（依赖后置定义，放在文件末尾调用）
initExamType();

// 通过 #hash 直达某视图（分享链接/回归截图等场景）
const bootView = location.hash.replace(/^#/, '');
if (bootView && document.getElementById(`view-${bootView}`)) showView(bootView);
