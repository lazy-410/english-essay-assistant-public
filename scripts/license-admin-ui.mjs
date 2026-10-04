#!/usr/bin/env node
/**
 * 激活码可视化管理器（作者本机使用）。
 * 默认只监听 127.0.0.1，并通过 license-admin.mjs 的 SSH 通道管理云端。
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PAGE = path.join(ROOT, 'public', 'license-admin.html');
const CLI = path.join(ROOT, 'scripts', 'license-admin.mjs');
const HOST = process.env.EEA_LICENSE_UI_HOST || '127.0.0.1';
const PORT = Number(process.env.EEA_LICENSE_UI_PORT || 8787);
const MAX_BODY = 1024 * 1024;
const CLI_TIMEOUT_MS = 120000;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('管理操作超时，请检查 SSH 连接或服务器状态。'));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseJsonOutput(result) {
  const textValue = result.stdout.trim();
  try {
    return JSON.parse(textValue);
  } catch {
    const start = textValue.lastIndexOf('{');
    if (start >= 0) {
      try { return JSON.parse(textValue.slice(start)); } catch { /* fall through */ }
    }
    throw new Error(result.stderr.trim() || textValue || `CLI 退出码 ${result.code}`);
  }
}

function requireCliSuccess(result) {
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `CLI 退出码 ${result.code}`);
  }
  return result;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求 JSON 格式错误。'); }
}

function value(body, name) {
  return typeof body?.[name] === 'string' ? body[name].trim() : '';
}

function issueArgs(body, tempOut) {
  const count = Number(body?.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('数量必须是 1～10000 的整数。');
  const customer = value(body, 'customer');
  const note = value(body, 'note');
  const expiry = value(body, 'expiry');
  if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error('到期日格式应为 YYYY-MM-DD。');
  const args = ['issue', '--count', String(count), '--out', tempOut];
  if (customer) args.push('--customer', customer);
  if (note) args.push('--note', note);
  if (expiry) args.push('--expiry', expiry);
  if (body?.noRegister === true) args.push('--no-register');
  return args;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    const result = requireCliSuccess(await runCli(['health', '--json']));
    return json(res, 200, parseJsonOutput(result));
  }
  if (req.method === 'GET' && pathname === '/api/list') {
    const result = requireCliSuccess(await runCli(['list', '--json']));
    return json(res, 200, parseJsonOutput(result));
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
  const body = await readBody(req);

  if (pathname === '/api/issue') {
    const tempDir = path.join(os.tmpdir(), `eea-license-ui-${process.pid}`);
    await mkdir(tempDir, { recursive: true });
    const tempOut = path.join(tempDir, `codes-${Date.now()}-${randomUUID()}.txt`);
    try {
      const result = requireCliSuccess(await runCli(issueArgs(body, tempOut)));
      const codeText = await readFile(tempOut, 'utf8');
      const codes = codeText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      return json(res, 200, { ok: true, codes, output: result.stdout });
    } finally {
      await rm(tempOut, { force: true });
    }
  }

  if (pathname === '/api/action') {
    const action = value(body, 'action');
    const hash = value(body, 'hash');
    const code = value(body, 'code');
    const targetArgs = code ? ['--code', code] : hash ? ['--hash', hash] : [];
    if (['revoke', 'restore'].includes(action)) {
      if (!targetArgs.length) throw new Error('缺少激活码或哈希。');
      const result = requireCliSuccess(await runCli([action, ...targetArgs]));
      return json(res, 200, { ok: true, output: result.stdout.trim() });
    }
    if (action === 'unbind') {
      if (!targetArgs.length) throw new Error('缺少激活码或哈希。');
      const deviceId = value(body, 'deviceId');
      if (!deviceId) throw new Error('缺少设备 ID。');
      const result = requireCliSuccess(await runCli(['unbind', ...targetArgs, '--device-id', deviceId]));
      return json(res, 200, { ok: true, output: result.stdout.trim() });
    }
    if (action === 'strict') {
      const mode = value(body, 'mode').toLowerCase();
      if (!['on', 'off'].includes(mode)) throw new Error('严格模式参数错误。');
      const result = requireCliSuccess(await runCli(['strict', mode]));
      return json(res, 200, { ok: true, output: result.stdout.trim() });
    }
    throw new Error(`未知管理操作：${action}`);
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/license-admin.html')) {
      text(res, 200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8');
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    json(res, 400, { ok: false, error: errorMessage(error) });
  }
});

server.on('error', (error) => {
  console.error(`[错误] 无法启动可视化工具：${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log('激活码可视化管理工具已启动');
  console.log(`访问地址：${url}`);
  console.log('管理操作默认通过 SSH 访问云端，不会在网页中显示管理口令。');
  if (process.platform === 'win32') {
    execFile('explorer.exe', [url], { windowsHide: true }, () => {});
  } else {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, [url], { windowsHide: true }, () => {});
  }
});
