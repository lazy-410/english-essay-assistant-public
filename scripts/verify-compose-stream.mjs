/**
 * 成文流式接口回归：POST /api/compose/stream 的 NDJSON 协议 + /api/compose 的诊断外壳。
 *
 * 全程零网络、零真实 AI 调用：把 EEA_DEEPSEEK_KEY / EEA_VISION_KEY 覆盖为空，
 * 于是「进度事件先行 → 关键阶段失败 → 错误转成 error 事件 → 流由处理器收尾」这条
 * 真实故障路径可以被稳定复现。协议一旦回归（例如错误抛出去让 server 补发 JSON、
 * 事件不换行、事件顺序错乱），本脚本立刻失败。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { routes, composeResponse } from '../lib/routes.mjs';
import { loadLicense, isActivated, setCloudUrl, activateWithCode } from '../lib/license.mjs';
import { readPemFile, signWithDays } from './issue-code.mjs';

const passed = [];

/* ---------------------------- 零网络环境 ---------------------------- */

process.env.EEA_DEEPSEEK_KEY = '';
process.env.EEA_VISION_KEY = '';
delete process.env.EEA_COMPOSE_ENGINE;
delete process.env.EEA_COMPOSE_V1;
delete process.env.EEA_COMPOSE_DEBUG_DIR;
setCloudUrl('');

const licenseDir = mkdtempSync(path.join(os.tmpdir(), 'eea-stream-'));
process.env.EEA_LICENSE_DIR = licenseDir;
const privateKey = await readPemFile(fileURLToPath(new URL('./keys/test-private.pem', import.meta.url)));
const activation = await activateWithCode(signWithDays(privateKey, 0).code);
assert.equal(activation.ok, true, '测试激活码应激活成功');
assert.equal(isActivated(), true);

/** 记录 writeHead / write / end 的最小 Response 替身，用于逐事件核对 NDJSON。 */
function fakeResponse() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    ended: false,
    destroyed: false,
    get writableEnded() { return this.ended; },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)); this.ended = true; return this; },
  };
  res.raw = () => chunks.join('');
  res.events = () => res.raw().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
  res.lines = () => res.raw().split('\n').filter((line) => line !== '');
  return res;
}

/** 逐行校验 NDJSON：单行一个 JSON、无嵌入换行、终态事件唯一且收尾。 */
function checkProtocol(res, { terminal }) {
  const lines = res.lines();
  assert.ok(lines.length >= 1, '至少要有 1 个事件');
  assert.equal(res.statusCode, 200, '流式响应应为 200');
  assert.match(String(res.headers['Content-Type'] ?? ''), /application\/x-ndjson/, 'Content-Type 必须是 NDJSON');
  for (const line of lines) assert.equal(line.includes('\r'), false, '事件必须是单行 JSON');
  const events = lines.map((line) => JSON.parse(line));
  for (const event of events) assert.equal(typeof event.type, 'string', '每个事件都要有 type');
  assert.equal(res.ended, true, '处理器必须自己结束响应（否则 server 会补发 JSON）');
  const terminals = events.filter((event) => event.type === 'error' || event.type === 'done');
  assert.equal(terminals.length, 1, `终态事件必须唯一：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(terminals[0].type, terminal, `终态事件应为 ${terminal}`);
  assert.equal(events.at(-1).type, terminal, '终态事件必须在最后一行');
  return events;
}

const stream = routes['POST /api/compose/stream'];
const compose = routes['POST /api/compose'];
assert.equal(typeof stream, 'function', '必须挂载 POST /api/compose/stream');
assert.equal(typeof compose, 'function', '必须挂载 POST /api/compose');

/* ------------------- 场景 1：空题目 → 单一 error 事件 ------------------- */
{
  const res = fakeResponse();
  await stream({ body: { text: '   ' }, res });
  const events = checkProtocol(res, { terminal: 'error' });
  assert.equal(events.length, 1, '空题目不应产生 start/step');
  assert.equal(events[0].status, 400);
  assert.match(events[0].error, /题目内容为空/);
  passed.push('stream-empty-question');
}

/* -------- 场景 2：无 Key 时必须降级出稿（不阻塞），并在进度里如实留痕 -------- */
{
  const res = fakeResponse();
  const question = 'Suppose you are Li Ming. Write a letter to your friend Zhang Wei to recommend an English novel, in about 100 words. Do not sign your own name at the end; use "Li Ming" instead.';
  await stream({ body: { text: question }, res });
  const events = checkProtocol(res, { terminal: 'done' });
  assert.equal(events[0].type, 'start', '首个事件必须是 start');
  assert.equal(events[0].engine, 'v3');
  const steps = events.filter((event) => event.type === 'step');
  assert.ok(steps.length >= 5, `无 Key 时也应跑完离线阶段：${JSON.stringify(steps.map((s) => s.key))}`);
  for (const step of steps) {
    assert.equal(typeof step.key, 'string');
    assert.equal(typeof step.label, 'string');
    assert.ok(step.label.length > 0, `步骤 ${step.key} 必须有中文名`);
    assert.equal(typeof step.summary, 'object');
  }
  assert.equal(steps.at(-1).key, 'essay', `最后一步应是成文：${JSON.stringify(steps.map((s) => s.key))}`);
  assert.equal(steps[0].key, 'classify');
  assert.ok(steps[0].summary.category, '判定步骤要回传题型');

  const done = events.at(-1);
  const diagnostics = done.data?.diagnostics;
  assert.ok(diagnostics, 'done 事件必须带诊断');
  assert.ok(diagnostics.aiErrors > 0, `AI 不可用必须留痕：${JSON.stringify(diagnostics)}`);
  assert.equal(diagnostics.aiError.code, 'no_key', '失败码要能区分“没配 Key”而不是内容问题');
  assert.ok(Array.isArray(diagnostics.rounds) && diagnostics.rounds.length > 0, '轮次要随诊断回传');
  assert.ok(done.data.essay.paragraphs.length > 0, '降级稿仍要有正文');
  assert.ok(Number.isFinite(done.data.check.words), '降级稿仍要给出词数');
  assert.ok(done.data.check.fallbackBlocks.length > 0, '降级稿的兜底块要如实标记');
  passed.push(`stream-degraded=${done.data.check.words}词/${steps.length}步`);
}

/* ---------- 场景 3：图画题缺视觉事实 → 早期 422 也要走 error 事件 ---------- */
{
  const res = fakeResponse();
  await stream({ body: { text: 'Write an essay of 160-200 words based on the picture below.' }, res });
  const events = checkProtocol(res, { terminal: 'error' });
  assert.equal(events.at(-1).status, 422);
  assert.equal(events.at(-1).code, 'visual_facts_required', '缺图必须报可核验事实缺失');
  passed.push('stream-visual-guard');
}

/* ------------------ 场景 4：v2 回退也走同一套流协议 ------------------ */
{
  const res = fakeResponse();
  await stream({ body: { text: 'Write a short notice about a reading week, in about 100 words.', version: 'v2' }, res });
  const events = checkProtocol(res, { terminal: 'done' });
  assert.equal(events[0].engine, 'v2', '回退引擎要在 start 事件里如实标注');
  assert.equal(events.at(-1).engine, 'v2');
  assert.equal(events.at(-1).diagnostics, null, 'v2 没有诊断，事件里必须是 null');
  assert.ok(events.at(-1).data.essay.paragraphs.length > 0, 'v2 无 Key 时也要降级出稿');
  passed.push('stream-v2-fallback');
}

/* ------------------ 场景 5：/api/compose 诊断外壳 ------------------ */
{
  const v3Shell = composeResponse({ essay: { paragraphs: [] }, check: { words: 174 }, diagnostics: { rounds: [{ name: 'trim' }], guards: ['p1:broken-tail'], fallbackBlocks: ['c2'] } }, 'v3');
  assert.equal(v3Shell.engine, 'v3');
  assert.deepEqual(v3Shell.diagnostics.rounds, [{ name: 'trim' }]);
  assert.deepEqual(v3Shell.diagnostics.guards, ['p1:broken-tail']);
  assert.equal(v3Shell.check.words, 174);

  const v2Shell = composeResponse({ essay: { paragraphs: [] } }, 'v2');
  assert.equal(v2Shell.engine, 'v2');
  assert.equal(v2Shell.diagnostics, null, '回退引擎没有诊断时必须是 null，前端据此隐藏按钮');

  // 接线检查：默认分支必须经外壳回传 V3 诊断，否则桌面“复制诊断 JSON”拿不到轮次信息。
  const source = await readFile(fileURLToPath(new URL('../lib/routes.mjs', import.meta.url)), 'utf8');
  assert.match(source, /composeResponse\(await composeV3\(/, '/api/compose 的 V3 分支必须经 composeResponse');
  assert.match(source, /composeResponse\(await composeV2\(/, '/api/compose 的 V2 回退分支必须经 composeResponse');
  passed.push('diagnostics-shell');
}

/* ------------- 场景 6：未激活时流式接口先被闸门挡住（不写半截流） ------------- */
{
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'eea-stream-locked-'));
  const activatedDir = process.env.EEA_LICENSE_DIR;
  process.env.EEA_LICENSE_DIR = emptyDir;
  assert.equal(await loadLicense(), false);
  assert.equal(isActivated(), false);
  const res = fakeResponse();
  await assert.rejects(
    stream({ body: { text: 'Write a letter to your friend, in about 100 words.' }, res }),
    (err) => err.code === 'NOT_ACTIVATED' && err.status === 403,
  );
  assert.equal(res.raw(), '', '未激活时不得写出任何流内容（server 会据此补发 403 JSON）');
  assert.equal(res.ended, false);

  // 还原激活态，供后续脚本/人工复用同一进程语义
  process.env.EEA_LICENSE_DIR = activatedDir;
  assert.equal(await loadLicense(), true);
  assert.equal(isActivated(), true);
  passed.push('stream-activation-gate');
}

/* ------- 场景 7：真实 HTTP 分发（server.mjs）也要拿到诊断外壳与 NDJSON ------- */
{
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: {
      ...process.env,
      EEA_PORT: String(port),
      EEA_NO_BROWSER: '1',
      EEA_LICENSE_DIR: licenseDir,
      EEA_LICENSE_URL: '',
      EEA_DEEPSEEK_KEY: '',
      EEA_VISION_KEY: '',
      EEA_COMPOSE_DEBUG_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      try {
        const health = await fetch(`${base}/api/health`);
        ready = health.ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.equal(ready, true, `服务器未能启动：${serverLog.slice(0, 400)}`);

    const question = 'Suppose you are Li Ming. Write a letter to your friend Zhang Wei to recommend an English novel, in about 100 words.';
    const composed = await fetch(`${base}/api/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question }),
    }).then((response) => response.json());
    assert.equal(composed.ok, true, JSON.stringify(composed).slice(0, 300));
    assert.equal(composed.data.engine, 'v3', 'HTTP 响应要标明引擎');
    assert.ok(composed.data.diagnostics?.rounds?.length > 0, 'HTTP 响应要带轮次诊断');
    assert.equal(composed.data.diagnostics.aiError?.code, 'no_key', '无 Key 的降级要留痕');
    assert.ok(composed.data.essay.paragraphs.length > 0, 'HTTP 响应仍要出稿');

    const streamed = await fetch(`${base}/api/compose/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question }),
    });
    assert.equal(streamed.status, 200);
    assert.match(String(streamed.headers.get('content-type') ?? ''), /application\/x-ndjson/);
    const lines = (await streamed.text()).split('\n').filter((line) => line !== '');
    const events = lines.map((line) => JSON.parse(line));
    assert.equal(events[0].type, 'start');
    assert.equal(events.at(-1).type, 'done', `HTTP 流应以 done 收尾：${JSON.stringify(events.map((e) => e.type))}`);
    assert.ok(events.some((event) => event.type === 'step'), 'HTTP 流要有进度事件');
    passed.push('http-envelope');
  } finally {
    child.kill();
  }
}

await rm(licenseDir, { recursive: true, force: true });
console.log(`compose-stream verification passed: ${passed.join(', ')}`);
