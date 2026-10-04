import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PUBLIC_DIR, PAGES_DIR, EXAM_ASSETS_DIR, ROOT } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { routes } from './lib/routes.mjs';
import { loadExams } from './lib/exams.mjs';
import { openBrowserCommand, platformLabel, hasLocalOcr } from './lib/platform.mjs';
import { isActivated, loadLicense, licenseStatus, startCloudHeartbeat } from './lib/license.mjs';

/**
 * 文件日志兜底：Android（nodejs-mobile）等控制台不可见的形态下，
 * 设置 EEA_LOG_FILE 后把 console 输出同时落盘，便于真机排查。
 * 桌面端不设该变量，行为零变化。
 */
(function attachFileLog() {
  const file = process.env.EEA_LOG_FILE;
  if (!file) return;
  const stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  stream.on('error', () => {}); // 日志盘写失败静默降级
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const level of ['log', 'error', 'warn', 'info', 'debug']) {
    const original = console[level]?.bind(console);
    if (!original) continue;
    console[level] = (...args) => {
      original(...args);
      try {
        stream.write(`[${stamp()}] [${level}] ${args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ')}\n`);
      } catch { /* 磁盘写入失败不影响主流程 */ }
    };
  }
})();

/**
 * 启动前置自检。换机器部署时最常见的失败是 Node 太旧或解压不完整，
 * 这里给出可读提示，而不是抛出难懂的模块栈。
 */
async function preflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error('');
    console.error(`  [错误] 当前 Node.js 版本为 ${process.versions.node}，本软件需要 18 或更高版本。`);
    console.error('  请前往 https://nodejs.org 安装新版后重试。');
    console.error('');
    process.exit(1);
  }

  const required = [
    ['knowledge/pages.json', '知识库页面数据'],
    ['knowledge/templates.json', '模板句数据'],
    ['knowledge/vocab.json', '替换词表'],
    ['public/index.html', '前端页面'],
    ['public/app.js', '前端脚本'],
  ];
  const missing = required.filter(([rel]) => !existsSync(path.join(ROOT, rel)));
  if (missing.length) {
    console.error('');
    console.error('  [错误] 以下必需文件缺失，说明解压不完整：');
    for (const [rel, label] of missing) console.error(`    - ${rel}（${label}）`);
    console.error('  请重新完整解压压缩包，注意不要只解压部分文件。');
    console.error('');
    process.exit(1);
  }

  try {
    await loadExams({ force: true });
    console.log('  题库自检：knowledge/exams.json 已加载');
  } catch (err) {
    if (err.code === 'exams_not_built') {
      console.warn('  [提示] knowledge/exams.json 尚未生成，题库接口暂不可用（其他功能仍可启动）。');
    } else {
      console.warn(`  [提示] 题库自检失败：${err.message}`);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 24 * 1024 * 1024; // 24MB，容纳手机拍照原图

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('请求体过大，图片请压缩到 24MB 以内');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

/** 静态文件：限制在白名单目录内，防路径穿越 */
async function serveStatic(req, res, urlPath) {
  let baseDir = PUBLIC_DIR;
  let rel = urlPath;

  if (urlPath.startsWith('/pages/')) {
    baseDir = PAGES_DIR;
    rel = urlPath.slice('/pages'.length);
  } else if (urlPath.startsWith('/exam-assets/')) {
    baseDir = EXAM_ASSETS_DIR;
    rel = urlPath.slice('/exam-assets'.length);
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const relativePath = path.normalize(rel).replace(/^([/\\])+/, '');
  const target = path.resolve(baseDir, relativePath);
  const boundary = path.relative(baseDir, target);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) return send(res, 403, 'Forbidden');
  if (!existsSync(target)) return send(res, 404, 'Not Found');
  const realBase = await realpath(baseDir);
  const realTarget = await realpath(target);
  const realBoundary = path.relative(realBase, realTarget);
  if (realBoundary.startsWith('..') || path.isAbsolute(realBoundary)) return send(res, 403, 'Forbidden');

  const ext = path.extname(realTarget).toLowerCase();
  const data = await readFile(realTarget);
  const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
  // 页面扫描图和题库图片是不变资产，允许缓存以免重复传输大文件。
  if (baseDir === PAGES_DIR || baseDir === EXAM_ASSETS_DIR) {
    headers['Cache-Control'] = 'public, max-age=86400';
  }
  send(res, 200, data, headers);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const urlPath = decodeURIComponent(url.pathname);

  try {
    // ── 激活闸门：未激活时只放行激活相关入口与无业务数据的静态资源 ──
    if (!isActivated()) {
      const isApi = urlPath.startsWith('/api/');
      const whitelistedApi =
        urlPath === '/api/activate' || urlPath === '/api/license-status' || urlPath === '/api/health';
      if (isApi && !whitelistedApi) {
        return sendJson(res, 403, {
          ok: false,
          code: 'NOT_ACTIVATED',
          error: '软件尚未激活，请先输入激活码后再使用。',
        });
      }
      if (!whitelistedApi) {
        // 页面类请求一律呈现激活页；css/js/图片等资源可放行（本身不含业务数据）
        const ext = path.extname(urlPath);
        if (ext === '' || ext === '.html') return serveStatic(req, res, '/activate.html');
        return serveStatic(req, res, urlPath);
      }
    }
    if (urlPath.startsWith('/api/')) {
      const handler = routes[`${req.method} ${urlPath}`];
      if (!handler) return sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${urlPath}` });
      const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
      const result = await handler({ body, query: Object.fromEntries(url.searchParams), req, res });
      if (res.writableEnded) return; // handler 自行结束（如流式响应）
      return sendJson(res, 200, { ok: true, data: result });
    }
    await serveStatic(req, res, urlPath);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[error] ${req.method} ${urlPath}:`, err);
    if (!res.writableEnded) {
      sendJson(res, status, { ok: false, error: err.message ?? String(err), code: err.code });
    }
  }
});

// ── 启动入口 ─────────────────────────────────────────────
// 包成 async main()：既满足打包器把模块转成 CJS 的限制（无顶层 await），
// 也让「启动前读授权」的顺序一目了然。
async function main() {
  await preflight();
  await loadLicense(); // 读取本机授权：有有效激活码才解锁全部功能（云端模式含一次静默确认）
  startCloudHeartbeat(); // 云端模式：每 12h 后台心跳（吊销即时生效）
  const cfg = await loadConfig();
  const envPort = Number(process.env.EEA_PORT);
  const port = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : (cfg.server.port ?? 7654);

  server.listen(port, '127.0.0.1', () => {
    const addr = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  考研英语作文辅助助手');
    if (!isActivated()) {
      const why = licenseStatus().cloudReason;
      const cloudText = {
        revoked: '该激活码已被作者吊销',
        not_registered: '该激活码未在服务器登记',
        device_limit: '设备数已达上限',
        need_online: '首次使用需联网登记',
      };
      console.log(`  ⚠ 软件未激活${cloudText[why] ? `（${cloudText[why]}）` : ''}：请先输入激活码（浏览器会打开激活页）。`);
    }
    console.log(`  已启动：${addr}`);
    console.log('  知识来源：考研英语作文.pdf（47 页）');
    console.log(`  运行平台：${platformLabel()}${hasLocalOcr() ? '（系统内置 OCR 可用）' : '（无系统内置 OCR，拍照识题请配置云端 OCR）'}`);
    console.log('  按 Ctrl+C 停止');
    console.log('');
    if (cfg.server.openBrowser && process.env.EEA_NO_BROWSER !== '1') {
      // 平台命令缺失或调用失败都不应影响服务本身，用户手动访问地址即可。
      const opener = openBrowserCommand(addr);
      if (opener) {
        try {
          const child = spawn(opener.command, opener.args, { detached: true, stdio: 'ignore', windowsHide: true });
          child.on('error', () => {});
          child.unref();
        } catch {
          // 忽略：仅是没能自动打开浏览器
        }
      }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用。改 config.json 里的 server.port，或关掉占用该端口的程序。`);
      process.exit(1);
    }
    throw err;
  });
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
