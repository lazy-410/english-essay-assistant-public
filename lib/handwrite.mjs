/**
 * 手写体排版渲染。样式依据讲义 p41 / p42 / p43：
 * - 齐头式（作者推荐：同样篇幅显得写得更满）与缩进式两种
 * - 答题卡横线纸，字写在横线之上
 * - 书信：称呼顶格 + 正文 + Yours sincerely, / Li Ming 落款
 * - 通知类：标题居中、日期与落款靠右
 * 输出 SVG，前端可直接显示或转 PNG 下载。
 */

const FONTS = {
  inkfree: { family: 'Ink Free', label: 'Ink Free（清秀手写）' },
  segoe: { family: 'Segoe Script', label: 'Segoe Script（连笔手写）' },
  comic: { family: 'Comic Sans MS', label: 'Comic Sans MS（圆润易读）' },
};

const PAGE = {
  width: 900,
  paddingX: 64,
  paddingTop: 56,
  paddingBottom: 56,
  lineHeight: 40,
  fontSize: 23,
  baselineOffset: 7, // 字坐在横线上方的距离
};

function escapeXml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 估算文本宽度。手写字体偏窄，按字符类别加权，避免溢出横线纸。
 */
function estimateWidth(text, fontSize) {
  let units = 0;
  for (const ch of text) {
    if (ch === ' ') units += 0.28;
    else if (/[iIljt.,;:'`!|]/.test(ch)) units += 0.28;
    else if (/[mwMW]/.test(ch)) units += 0.82;
    else if (/[A-Z]/.test(ch)) units += 0.62;
    else if (/[0-9]/.test(ch)) units += 0.55;
    else units += 0.5;
  }
  return units * fontSize;
}

function wrapText(text, maxWidth, fontSize) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateWidth(candidate, fontSize) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 把作文内容排成行序列。
 * @returns {Array<{text:string, align:'left'|'center'|'right', indent:number}>}
 */
function layoutLines(essay, { style, kind }) {
  const usableWidth = PAGE.width - PAGE.paddingX * 2;
  const indentWidth = style === 'indent' ? PAGE.fontSize * 2.4 : 0;
  const lines = [];

  const pushBlank = () => lines.push({ text: '', align: 'left', indent: 0 });

  if (kind === 'notice') {
    // 通知类：标题居中
    const title = essay.title || 'Notice';
    lines.push({ text: title, align: 'center', indent: 0 });
    pushBlank();
  } else if (essay.salutation) {
    // 书信：称呼顶格
    lines.push({ text: essay.salutation, align: 'left', indent: 0 });
    if (style === 'block') pushBlank();
  }

  const paragraphs = essay.paragraphs ?? [];
  for (const [index, para] of paragraphs.entries()) {
    const text = Array.isArray(para.sentences) ? para.sentences.join(' ') : String(para.text ?? '');
    if (!text.trim()) continue;

    const firstLineWidth = usableWidth - indentWidth;
    const wrapped = wrapText(text, firstLineWidth, PAGE.fontSize);

    // 首行缩进后，后续行可用整宽，这里重新按整宽排后续内容以贴近真实书写
    if (indentWidth && wrapped.length > 1) {
      const [first, ...restWords] = [wrapped[0], ...wrapped.slice(1).join(' ').split(/\s+/)];
      const rest = wrapText(restWords.join(' '), usableWidth, PAGE.fontSize);
      lines.push({ text: first, align: 'left', indent: indentWidth });
      for (const line of rest) lines.push({ text: line, align: 'left', indent: 0 });
    } else {
      for (const [i, line] of wrapped.entries()) {
        lines.push({ text: line, align: 'left', indent: i === 0 ? indentWidth : 0 });
      }
    }

    // 齐头式段间空行；缩进式靠首行缩进区分段落
    if (style === 'block' && index < paragraphs.length - 1) pushBlank();
  }

  if (kind === 'notice') {
    pushBlank();
    if (essay.signature) {
      for (const line of String(essay.signature).split('\n')) {
        lines.push({ text: line, align: 'right', indent: 0 });
      }
    }
    if (essay.date) lines.push({ text: essay.date, align: 'right', indent: 0 });
  } else if (essay.signature) {
    pushBlank();
    const sigLines = String(essay.signature).split('\n').filter(Boolean);
    for (const line of sigLines) {
      // 缩进式落款偏右下，齐头式落款左侧齐头
      lines.push({ text: line, align: style === 'indent' ? 'right' : 'left', indent: 0 });
    }
  }

  return lines;
}

/**
 * 渲染成 SVG。
 * @param {object} essay { salutation, paragraphs:[{sentences:[]}], signature, title, date }
 * @param {object} options { style:'block'|'indent', font:'inkfree'|'segoe'|'comic', kind:'letter'|'notice', showRuling }
 */
export function renderSvg(essay, options = {}) {
  const style = options.style === 'indent' ? 'indent' : 'block';
  const font = FONTS[options.font] ?? FONTS.inkfree;
  const kind = options.kind === 'notice' ? 'notice' : 'letter';
  const showRuling = options.showRuling !== false;

  const lines = layoutLines(essay, { style, kind });
  // 至少铺满 20 行，空白横线让卷面更像答题卡
  const lineCount = Math.max(lines.length + 2, 20);
  const height = PAGE.paddingTop + lineCount * PAGE.lineHeight + PAGE.paddingBottom;
  const usableWidth = PAGE.width - PAGE.paddingX * 2;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width}" height="${height}" viewBox="0 0 ${PAGE.width} ${height}" font-family="${escapeXml(font.family)}, 'Segoe Script', 'Comic Sans MS', cursive">`,
  );
  parts.push(`<rect width="${PAGE.width}" height="${height}" fill="#fffdf7"/>`);

  if (showRuling) {
    for (let i = 0; i < lineCount; i += 1) {
      const y = PAGE.paddingTop + (i + 1) * PAGE.lineHeight;
      parts.push(
        `<line x1="${PAGE.paddingX}" y1="${y}" x2="${PAGE.width - PAGE.paddingX}" y2="${y}" stroke="#cfd6e0" stroke-width="1"/>`,
      );
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!line.text) continue;
    const y = PAGE.paddingTop + (index + 1) * PAGE.lineHeight - PAGE.baselineOffset;
    let x = PAGE.paddingX + line.indent;
    let anchor = 'start';
    if (line.align === 'center') {
      x = PAGE.width / 2;
      anchor = 'middle';
    } else if (line.align === 'right') {
      x = PAGE.width - PAGE.paddingX;
      anchor = 'end';
    }
    parts.push(
      `<text x="${x}" y="${y}" font-size="${PAGE.fontSize}" fill="#12233a" text-anchor="${anchor}" xml:space="preserve">${escapeXml(line.text)}</text>`,
    );
  }

  parts.push('</svg>');

  return {
    svg: parts.join('\n'),
    width: PAGE.width,
    height,
    lineCount: lines.filter((l) => l.text).length,
    style,
    font: options.font ?? 'inkfree',
    kind,
    usableWidth,
  };
}

/** 讲义 p41/p42 的卷面要点，界面侧边展示 */
export function layoutTips() {
  return {
    recommended: 'block',
    styles: [
      {
        key: 'block',
        name: '齐头式',
        recommended: true,
        points: ['各段首行不缩进，全部左侧齐头', '段与段之间空一行', '落款左侧齐头'],
        why: '讲义原话：同样的篇幅，齐头式显得写得更满',
      },
      {
        key: 'indent',
        name: '缩进式',
        recommended: false,
        points: ['每段首行缩进约四个字母宽度', '段间不空行', '落款偏右下书写'],
        why: '传统书信格式，同样可得分',
      },
    ],
    good: ['称呼顶格并加逗号', '段落分明、行距均匀', '单词间距清楚', '落款两行完整', '字写在横线之上'],
    bad: ['字迹过密', '随意换行', '称呼缩进不统一', '涂改严重'],
    pen: '讲义建议使用 0.7 的笔',
    noticeFormat: ['标题居中书写，如 Notice', '正文分段', '落款写机构名，靠右', '日期可另起一行靠右'],
    fonts: Object.entries(FONTS).map(([key, v]) => ({ key, label: v.label })),
  };
}
