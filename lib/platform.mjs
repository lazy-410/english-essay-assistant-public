/**
 * 平台差异集中处理。
 *
 * 软件的核心能力（成文链、题库、知识库、学习卡片、答题卡排版）都是纯 Node 实现，
 * 真正与操作系统绑定的只有三件事：系统字体目录、打开浏览器的命令、本地 OCR 引擎。
 * 这里把三者收敛到一处，其余模块只依赖本模块，不再各自写平台判断。
 *
 * 所有函数都接受可选的 platform 参数，便于在任意系统上对三个分支做回归测试。
 */

import os from 'node:os';
import path from 'node:path';

export const WINDOWS = 'win32';
export const MAC = 'darwin';
export const LINUX = 'linux';
/** nodejs-mobile（Android 嵌入式 Node）报告的 process.platform */
export const ANDROID = 'android';

/**
 * 平台判定。真实运行：Windows/macOS/Linux 由 process.platform 决定，
 * Android（nodejs-mobile）进程的 process.platform 即为 'android'。
 * EEA_PLATFORM 允许在桌面端强制预演其它平台分支（回归测试用），
 * 服务端启动脚本与构建链均不设置它，避免影响真实行为。
 */
const current = () => process.env.EEA_PLATFORM || process.platform;

export const IS_WINDOWS = current() === WINDOWS;
export const IS_MAC = current() === MAC;
export const IS_ANDROID = current() === ANDROID;
export const IS_LINUX = !IS_WINDOWS && !IS_MAC && !IS_ANDROID;

export function platformLabel(platform = current()) {
  if (platform === WINDOWS) return 'Windows';
  if (platform === MAC) return 'macOS';
  if (platform === ANDROID) return 'Android';
  return 'Linux';
}

/**
 * 系统字体目录候选，按查找优先级排列。
 * 非 Windows 分支必须用 posix 拼接：在 Windows 上跑跨平台回归时，
 * path.join 会产出反斜杠，导致断言与真实 macOS/Linux 路径不一致。
 * Android（nodejs-mobile）没有桌面字体目录，读取 /system/fonts 及其它系统分区。
 */
export function fontDirectories(platform = current(), home = os.homedir()) {
  if (platform === WINDOWS) {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return [path.win32.join(root, 'Fonts')];
  }
  const userHome = String(home ?? '').replace(/\\/g, '/');
  if (platform === MAC) {
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      path.posix.join(userHome, 'Library', 'Fonts'),
    ];
  }
  if (platform === ANDROID) {
    return ['/system/fonts', '/product/fonts', '/vendor/fonts', path.posix.join(userHome, 'fonts')];
  }
  return [
    '/usr/share/fonts',
    '/usr/share/fonts/truetype',
    path.posix.join(userHome, '.local', 'share', 'fonts'),
    path.posix.join(userHome, '.fonts'),
  ];
}

/**
 * 中文字体候选文件名，按优先级排列。
 * macOS 与 Linux 的中文字体多为 TTC（字体集合），本项目的 TrueType 解析已支持 ttcf。
 * Android：AOSP 自带 NotoSansCJK-Regular.ttc；国产厂商系统字体名各异，
 * 候选落空时 print-pdf.mjs 会按 CJK_FONT_HINTS 递归扫描兜底。
 */
export function cjkFontCandidates(platform = current()) {
  if (platform === WINDOWS) {
    return ['simkai.ttf', 'simhei.ttf', 'msyh.ttc', 'simsun.ttc'];
  }
  if (platform === MAC) {
    return [
      'Songti.ttc',
      'Hiragino Sans GB.ttc',
      'Hiragino Sans GB W3.ttc',
      'STHeiti Light.ttc',
      'STHeiti Medium.ttc',
      'PingFang.ttc',
    ];
  }
  if (platform === ANDROID) {
    return [
      'NotoSansCJK-Regular.ttc',
      'NotoSansCJKsc-Regular.ttc',
      'NotoSansCJK-Bold.ttc',
      'DroidSansFallback.ttf',
    ];
  }
  return [
    'NotoSansCJK-Regular.ttc',
    'NotoSerifCJK-Regular.ttc',
    'NotoSansCJKsc-Regular.otf',
    'wqy-zenhei.ttc',
    'wqy-microhei.ttc',
  ];
}

/** 西文字体候选：中文字体的拉丁字形通常是半角等宽，排英文正文会像打字机。 */
export function latinFontCandidates(platform = current()) {
  if (platform === WINDOWS) {
    return ['times.ttf', 'georgia.ttf', 'calibri.ttf', 'arial.ttf'];
  }
  if (platform === MAC) {
    return ['Times New Roman.ttf', 'Times.ttc', 'Georgia.ttf', 'Helvetica.ttc'];
  }
  if (platform === ANDROID) {
    return ['Roboto-Regular.ttf', 'RobotoCondensed-Regular.ttf', 'NotoSerif-Regular.ttf'];
  }
  return [
    'DejaVuSerif.ttf',
    'LiberationSerif-Regular.ttf',
    'DejaVuSans.ttf',
    'LiberationSans-Regular.ttf',
  ];
}

/** 文件名里出现这些关键字时，视为可能的中文字体，用于具名候选全部落空后的兜底扫描。 */
export const CJK_FONT_HINTS = [
  'notosanscjk', 'notoserifcjk', 'sourcehansans', 'sourcehanserif',
  'pingfang', 'hiragino', 'songti', 'stheiti', 'heiti', 'kaiti',
  'wqy', 'zenhei', 'microhei', 'msyh', 'simsun', 'simhei', 'simkai',
];

/** 打开浏览器的命令。返回 null 表示当前平台不自动打开。 */
export function openBrowserCommand(url, platform = current()) {
  const target = String(url ?? '');
  if (!target) return null;
  if (platform === WINDOWS) return { command: 'cmd', args: ['/c', 'start', '', target] };
  if (platform === MAC) return { command: 'open', args: [target] };
  if (platform === ANDROID) return null; // Android 是内嵌 WebView，不需要也不应该拉起系统浏览器
  return { command: 'xdg-open', args: [target] };
}

/** 系统内置离线识别引擎。只有 Windows 自带可用的 Windows.Media.Ocr；Android 全走千问视觉。 */
export function localOcrBackend(platform = current()) {
  return platform === WINDOWS ? 'windows' : null;
}

export function hasLocalOcr(platform = current()) {
  return localOcrBackend(platform) !== null;
}

export default {
  WINDOWS,
  MAC,
  LINUX,
  ANDROID,
  IS_WINDOWS,
  IS_MAC,
  IS_LINUX,
  IS_ANDROID,
  platformLabel,
  fontDirectories,
  cjkFontCandidates,
  latinFontCandidates,
  CJK_FONT_HINTS,
  openBrowserCommand,
  localOcrBackend,
  hasLocalOcr,
};
