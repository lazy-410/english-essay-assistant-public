#!/usr/bin/env node
// 分发构建：混淆 + 作者公钥注入 + SEA 单文件 exe + 四个发行包
//
// 用法（在项目根目录执行）：
//   node scripts/build-protected.mjs \
//       --out C:/Users/懒将军/english-essay-release \
//       --license-key C:/Users/懒将军/english-essay-license/private.pem
//
// 参数：
//   --out          输出根目录（默认 ~/english-essay-release）
//   --license-key  作者私钥 PEM 路径。缺省时使用测试私钥并以“-TEST”命名产物（仅演练用）
//   --tools        一次性构建工具目录（默认 ~/eea-build-tools）
//   --skip-zip     只构建发行树，不压缩
//   --skip-exe     不构建 Windows 单文件 exe 版（调试混淆 zip 时提速）
//
// 说明：发行产物中【不包含】lib/、server.mjs、scripts/ 源码与任何私钥。
//       lib/license-pub.mjs 会在构建期间被临时覆盖为作者公钥，构建结束后还原。

import { spawn } from 'node:child_process';
import { createPublicKey, createPrivateKey, sign } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const PREFIX = 'EEA1';
const EPOCH_UTC = Date.UTC(2024, 0, 1);
const DAY_MS = 86400000;

// ---------- 参数 ----------
const arg = (name, dft) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dft;
};
const outRoot = path.resolve(arg('--out', path.join(os.homedir(), 'english-essay-release')));
const keyPath = arg('--license-key', null);
const toolsDir = path.resolve(arg('--tools', path.join(os.homedir(), 'eea-build-tools')));
const skipZip = process.argv.includes('--skip-zip');
const skipExe = process.argv.includes('--skip-exe');
const isTest = !keyPath;

const say = (...a) => console.log(...a);
const hr = () => say('-'.repeat(64));

// ---------- 工具命令 ----------
const esbuildCli = path.join(toolsDir, 'node_modules', 'esbuild', 'bin', 'esbuild');
const obfuscatorCli = path.join(toolsDir, 'node_modules', 'javascript-obfuscator', 'bin', 'javascript-obfuscator');
const postjectCli = path.join(toolsDir, 'node_modules', 'postject', 'dist', 'cli.js');
const WIN_TAR = 'C:/Windows/System32/tar.exe';

function runNode(script, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: opts.silent ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(script)} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

// ---------- 产码（构建自检激活流程用） ----------
function signCode(privatePem, days = 0) {
  const data = Buffer.alloc(8);
  data[0] = 0x4b;
  data[1] = 0x01;
  data.writeUInt16BE(days, 2);
  data.writeUInt32BE(randomBytes(4).readUInt32BE(0), 4);
  const sig = sign(null, data, createPrivateKey(privatePem));
  return PREFIX + data.toString('base64url') + sig.toString('base64url');
}

async function main() {
  const t0 = Date.now();
  hr();
  say('考研英语作文助手 · 混淆发行构建');
  hr();
  if (!existsSync(toolsDir)) throw new Error(`构建工具目录不存在：${toolsDir}（先执行 npm i esbuild javascript-obfuscator postject）`);
  for (const f of [esbuildCli, obfuscatorCli, postjectCli]) {
    if (!existsSync(f)) throw new Error(`缺少构建工具：${f}`);
  }
  if (isTest) {
    say('⚠⚠⚠  未提供 --license-key，本次使用【测试私钥】，产物仅用于演练！');
    say('⚠⚠⚠  正式分发给用户前，必须用作者私钥重新构建。');
  } else {
    say(`作者私钥：${keyPath}`);
    say('公钥将注入产物：本机生成的激活码才会被接受。');
  }
  const privatePem = readFileSync(isTest ? path.join(ROOT, 'scripts', 'keys', 'test-private.pem') : keyPath, 'utf8');
  const publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
  hr();

  const stage = path.join(outRoot, 'stage');
  const trees = path.join(outRoot, 'trees');
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(trees, { recursive: true });
  await mkdir(path.join(outRoot, 'zip'), { recursive: true });

  // ---------- 1. 公钥注入（构建后还原） ----------
  const pubFile = path.join(ROOT, 'lib', 'license-pub.mjs');
  const pubBackup = await readFile(pubFile, 'utf8');
  const inject = `// 由 build-protected.mjs 临时注入的作者公钥（构建结束立即还原为开发测试公钥）\nexport const LICENSE_PUBKEY = \`${publicPem.replace(/`/g, '\\`')}\`;\n`;
  await writeFile(pubFile, inject);
  let pubRestored = false;
  const restore = async () => {
    if (pubRestored) return;
    await writeFile(pubFile, pubBackup);
    pubRestored = true;
    const now = await readFile(pubFile, 'utf8');
    if (now !== pubBackup) throw new Error('lib/license-pub.mjs 还原校验失败！');
  };
  try {
    // ---------- 2. esbuild 打包（ESM → CJS 单文件） ----------
    say('步骤 1/5  esbuild 打包…');
    await runNode(esbuildCli, [
      path.join(ROOT, 'server.mjs'),
      '--bundle', '--platform=node', '--format=cjs', '--minify', '--target=node18',
      `--outfile=${path.join(stage, 'app.raw.cjs')}`,
    ]);
    say(`         → app.raw.cjs ${(await stat(path.join(stage, 'app.raw.cjs'))).size} B`);

    // ---------- 3. 混淆 ----------
    say('步骤 2/5  混淆（保守档：字符串编码 + 标识符打乱）…');
    const obfCfg = path.join(stage, 'obfuscate.json');
    await writeFile(obfCfg, JSON.stringify({
      compact: true,
      identifierNamesGenerator: 'mangled',
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.8,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      selfDefending: false,
      disableConsoleOutput: false,
      numbersToExpressions: true,
      simplify: true,
      transformObjectKeys: true,
      unicodeEscapeSequence: false,
      seed: 0,
      sourceMap: false,
    }, null, 2));
    const obfOut = path.join(stage, 'app.cjs');
    await runNode(obfuscatorCli, [path.join(stage, 'app.raw.cjs'), '--output', obfOut, '--config', obfCfg], { silent: true });
    say(`         → app.cjs ${(await stat(obfOut)).size} B（混淆产物）`);
    await runNode('--check', [], { silent: true }).catch(() => {});
    await new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--check', obfOut], { stdio: 'ignore' });
      c.on('exit', (code) => (code === 0 ? res() : rej(new Error('混淆产物语法检查失败'))));
      c.on('error', rej);
    });
    say('         → 语法检查通过');

    // ---------- 4. 发行树 ----------
    const dataDirs = ['public', 'knowledge', 'exam-assets', 'assets'];
    const treeName = 'english-essay-assistant';
    const appCode = await readFile(obfOut, 'utf8');
    const mkTree = async (variant) => {
      const tree = path.join(trees, variant, treeName);
      await rm(path.join(trees, variant), { recursive: true, force: true });
      await mkdir(tree, { recursive: true });
      for (const d of dataDirs) await cp(path.join(ROOT, d), path.join(tree, d), { recursive: true });
      await cp(path.join(ROOT, 'config.example.json'), path.join(tree, 'config.example.json'));
      await mkdir(path.join(tree, 'tmp'), { recursive: true });
      await mkdir(path.join(tree, 'scripts'), { recursive: true });
      await cp(path.join(ROOT, 'scripts', 'verify-package.mjs'), path.join(tree, 'scripts', 'verify-package.mjs'));
      return tree;
    };
    const patchEntry = async (tree, variant) => {
      if (variant === 'exe') return;
      for (const f of ['start.bat', 'start.command', 'start.sh']) {
        const src = await readFile(path.join(ROOT, f), 'utf8');
        await writeFile(path.join(tree, f), src.replaceAll('server.mjs', 'app.cjs'));
      }
    };

    const treesBuilt = [];
    // A. Windows 单文件版（SEA exe + 数据）
    let exeEntry = null;
    if (!skipExe) {
      say('步骤 3/5  Windows 单文件版（SEA）…');
      const tree = await mkTree('win-exe');
      await cp(path.join(ROOT, 'README.md'), path.join(tree, 'README.md'));
      const exeName = '考研英语作文助手.exe';
      const seaCfg = path.join(stage, 'sea-config.json');
      await writeFile(seaCfg, JSON.stringify({ main: obfOut, output: path.join(stage, 'sea-prep.blob'), disableExperimentalSEAWarning: true }));
      await new Promise((res, rej) => {
        const c = spawn(process.execPath, ['--experimental-sea-config', seaCfg], { stdio: 'ignore', cwd: stage });
        c.on('exit', (code) => (code === 0 ? res() : rej(new Error('SEA blob 生成失败'))));
        c.on('error', rej);
      });
      exeEntry = path.join(tree, exeName);
      await cp(path.join(ROOT, 'runtime', 'node.exe'), exeEntry);
      await new Promise((res, rej) => {
        const c = spawn(process.execPath, [postjectCli, exeEntry, 'NODE_SEA_BLOB', path.join(stage, 'sea-prep.blob'), '--sentinel-fuse', SEA_FUSE], { stdio: 'ignore' });
        c.on('exit', (code) => (code === 0 ? res() : rej(new Error('postject 注入失败'))));
        c.on('error', rej);
      });
      say(`         → ${exeEntry}`);
      treesBuilt.push({ name: '考研英语作文助手-Windows单文件版' + (isTest ? '-TEST' : ''), tree, entry: exeEntry });
    }

    // B/C/D. zip 树（免安装 / 完整 / 精简跨平台）
    for (const variant of ['lite', 'full', 'portable']) {
      const tree = await mkTree(variant);
      await cp(path.join(ROOT, 'README.md'), path.join(tree, 'README.md'));
      await patchEntry(tree, variant);
      if (variant !== 'portable') {
        await mkdir(path.join(tree, 'runtime'), { recursive: true });
        await cp(path.join(ROOT, 'runtime', 'node.exe'), path.join(tree, 'runtime', 'node.exe'));
      }
      if (variant === 'full') await cp(path.join(ROOT, 'pages'), path.join(tree, 'pages'), { recursive: true });
      const entry = path.join(tree, 'app.cjs');
      await writeFile(entry, appCode);
      const label = { lite: '考研英语作文助手-免安装版', full: '考研英语作文助手-完整版', portable: '考研英语作文助手-精简跨平台版' }[variant];
      treesBuilt.push({ name: label + (isTest ? '-TEST' : ''), tree, entry });
    }

    // ---------- 5. 黑盒自检 ----------
    // 每个发行树启动一次服务（verify-package 内部负责 spawn 入口），
    // 依次验证：未激活锁定 → 垃圾码拒绝 → 真实激活 → 解锁放行。
    const verifyScript = path.join(ROOT, 'scripts', 'verify-package.mjs');
    const checkCode = signCode(privatePem, 0);
    say('步骤 4/5  黑盒自检（每树启动服务 → 激活全流程）…');
    for (const tb of treesBuilt) {
      const r = await new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [verifyScript, '--entry', tb.entry, '--code', checkCode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (out += d));
        c.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`黑盒失败(${tb.name}): ${out.slice(-600)}`))));
        c.on('error', reject);
      });
      const pass = (r.match(/PASS/g) || []).length;
      if (!/ALL PASS/.test(r)) throw new Error(`黑盒未全过(${tb.name})：${r.slice(-600)}`);
      say(`         ${tb.name}：${pass} 项 PASS ✓`);
    }

    // ---------- 6. 压缩 ----------
    if (!skipZip) {
      say('步骤 5/5  打包 zip…');
      for (const tb of treesBuilt) {
        const zipPath = path.join(outRoot, 'zip', `${tb.name}.zip`);
        const parent = path.dirname(tb.tree);
        await new Promise((resolve, reject) => {
          const c = spawn(WIN_TAR, ['-a', '-c', '-f', zipPath, '-C', parent, treeName], { stdio: 'ignore' });
          c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`打包失败 ${tb.name}（tar 退出码 ${code}）`))));
          c.on('error', reject);
        });
        const size = (await stat(zipPath)).size;
        say(`         → ${zipPath}  ${(size / 1024 / 1024).toFixed(1)} MB`);
      }
    }
  } finally {
    await restore();
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  hr();
  if (isTest) {
    say(`⚠ 本次产物使用【测试私钥】，仅限演练：正式分发必须用作者私钥重建！`);
    say(`  运行以下命令生成作者密钥对（只在本机保存）：`);
    say(`    node scripts/author-keygen.mjs --out C:/Users/懒将军/english-essay-license`);
    say(`  然后重新构建：`);
    say(`    node scripts/build-protected.mjs --out C:/Users/懒将军/english-essay-release --license-key C:/Users/懒将军/english-essay-license/private.pem`);
  }
  say(`构建完成，耗时 ${sec} 秒。产物在 ${path.join(outRoot, skipZip ? 'trees' : 'zip')}/`);
  hr();
}

main().catch((err) => {
  console.error('\n构建失败：', err.message);
  process.exit(1);
});
