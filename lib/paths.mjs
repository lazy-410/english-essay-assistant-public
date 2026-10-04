import path from 'node:path';
import { homedir } from 'node:os';

/**
 * 项目根目录定位。
 * 各运行形态下入口文件（源码态 server.mjs、发行态 app.mjs / app.exe）
 * 都位于项目根目录；scripts/ 下的回归脚本入口目录名为 scripts，取其上级为根。
 * 刻意不用 import.meta.url —— 混淆打包与 SEA 下其语义会变化。
 */
const entryDir = path.resolve(path.dirname(String(process.argv[1] ?? '.')));
export const ROOT = path.basename(entryDir) === 'scripts' ? path.dirname(entryDir) : entryDir;
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
export const PAGES_DIR = path.join(ROOT, 'pages');
export const EXAM_ASSETS_DIR = path.join(ROOT, 'exam-assets');
export const TMP_DIR = path.join(ROOT, 'tmp');

/** 激活码授权文件所在目录：放用户配置目录而非软件目录，目录拷贝不等于拷贝激活状态。 */
export function licenseDir() {
  if (process.env.EEA_LICENSE_DIR) return process.env.EEA_LICENSE_DIR;
  const app = 'KaoyanEnglishEssayAssistant';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), app);
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', app);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), app);
}

export function licenseFile() {
  return path.join(licenseDir(), 'license.json');
}
