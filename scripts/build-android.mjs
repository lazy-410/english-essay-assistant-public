#!/usr/bin/env node
// Android 版构建链：正式数据 bundle（混淆 app.cjs + 资源）→ gradle release APK（作者公钥 + 发布签名）
//
// 用法（项目根目录执行）：
//   node scripts/build-android.mjs \
//       --license-key ../secrets/license/private.pem
//
// 参数：
//   --license-key   作者私钥 PEM 路径（决定注入的公钥；缺省=测试公钥，产物仅演练用）
//   --out           产物输出目录（默认 %USERPROFILE%/english-essay-release-android）
//   --keystore-dir  Android 发布签名目录（默认 <out>/keystore，可单独放入受保护目录）
//   --tools         构建工具目录（默认 %USERPROFILE%/eea-build-tools，含 esbuild/javascript-obfuscator）
//   --with-pages    打包 pages/（真题原页大图，+90MB 体积；默认不带）
//   --skip-bundle   跳过 bundle 重建（只重跑 gradle，bundle 已就位时提速）
//   --license-url   激活码云端校验服务器地址（如 http://1.2.3.4:8080），写入 bundle config.json 的
//                   server.licenseUrl；不传 = 纯离线激活（现状）
//   --keep-stage    保留中间产物（默认清空）
//   --gradle-retry  允许中文路径下失败后清 .cxx 自动重试一次（默认开）
//
// 产物：out/<版本名>/考研英语作文助手-v<版本>-android-arm64.apk + keystore（首次生成）
// 说明：lib/license-pub.mjs 在公钥注入期间被临时覆盖，结束后还原并校验。

import { spawn, spawnSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ANDROID_DIR = path.join(ROOT, 'android');
const APP_DIR = path.join(ANDROID_DIR, 'app');
const ASSETS_DIR = path.join(APP_DIR, 'src', 'main', 'assets');

// ---------- 参数 ----------
const arg = (name, dft) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dft;
};
const keyPath = arg('--license-key', null);
const licenseUrl = arg('--license-url', '');
const outRoot = path.resolve(arg('--out', path.join(os.homedir(), 'english-essay-release-android')));
const keystoreRoot = path.resolve(arg('--keystore-dir', path.join(outRoot, 'keystore')));
const toolsDir = path.resolve(arg('--tools', path.join(os.homedir(), 'eea-build-tools')));
const withPages = process.argv.includes('--with-pages');
const skipBundle = process.argv.includes('--skip-bundle');
const keepStage = process.argv.includes('--keep-stage');
const gradleRetry = !process.argv.includes('--no-gradle-retry');
const isTest = !keyPath;

const GRADLE = arg('--gradle', process.env.EEA_GRADLE || path.join(os.homedir(), 'android-dl', 'gradle-dist', 'gradle-8.5', 'bin', 'gradle.bat'));
const say = (...a) => console.log(...a);
const hr = () => say('-'.repeat(64));
const fail = (msg) => { say(`[错误] ${msg}`); process.exit(1); };

// python 绝对路径：排除 WindowsApps 商店存根，取真实解释器
const PYTHON_EXE = (() => {
  try {
    const lines = execSync('where python', { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const real = lines.find((l) => !/WindowsApps/i.test(l));
    if (real) return real;
  } catch { /* fallthrough */ }
  return 'python';
})();

const esbuildCli = path.join(toolsDir, 'node_modules', 'esbuild', 'bin', 'esbuild');
const obfuscatorCli = path.join(toolsDir, 'node_modules', 'javascript-obfuscator', 'bin', 'javascript-obfuscator');

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

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

async function dirBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirBytes(p) : (await stat(p)).size;
  }
  return total;
}

async function main() {
  const t0 = Date.now();
  hr();
  say('考研英语作文助手 · Android 构建链');
  say(`来源：${ROOT}`);
  say(`模式：${isTest ? '演练（测试公钥）' : '正式（注入作者公钥）'}${withPages ? ' · 含 pages 原页图' : ''}`);
  hr();

  // ---------- 0. 环境探测 ----------
  for (const [p, name] of [[toolsDir, '构建工具目录'], [esbuildCli, 'esbuild'], [obfuscatorCli, 'javascript-obfuscator'], [GRADLE, 'Gradle 发行版'], [PYTHON_EXE, 'python']]) {
    if (p === PYTHON_EXE) {
      try { execSync(`"${p}" --version`, { stdio: 'ignore' }); } catch { fail('找不到 python（bundle zip 打包需要）'); }
      continue;
    }
    if (!existsSync(p)) fail(`${name}不存在：${p}（工具目录先执行 npm i esbuild javascript-obfuscator）`);
  }
  if (!existsSync(path.join(APP_DIR, 'libnode', 'bin'))) {
    fail('app/libnode/ 缺失：请先执行 scripts/setup-libnode.cmd 安装 nodejs-mobile 预编译库');
  }

  // ---------- 1. bundle 数据 ----------
  const stage = path.join(outRoot, '.stage');
  const bundleDir = path.join(stage, 'bundle');
  const bundleVersion = `bundle-a1-v${String(Date.now()).slice(-6)}`;
  if (!skipBundle) {
    await rm(stage, { recursive: true, force: true });
    say('步骤 1/6  数据 bundle…');
    await mkdir(bundleDir, { recursive: true });
    const dataDirs = ['public', 'knowledge', 'exam-assets', 'assets'];
    if (withPages) dataDirs.push('pages');
    for (const d of dataDirs) {
      await cp(path.join(ROOT, d), path.join(bundleDir, d), { recursive: true });
      const bytes = await dirBytes(path.join(bundleDir, d));
      say(`         → ${d}/ ${(bytes / 1048576).toFixed(1)} MiB`);
    }
    await cp(path.join(ROOT, 'config.example.json'), path.join(bundleDir, 'config.json'));
    if (licenseUrl) {
      const cfgPath = path.join(bundleDir, 'config.json');
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
      cfg.server = cfg.server || {};
      cfg.server.licenseUrl = licenseUrl;
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    }
    await mkdir(path.join(bundleDir, 'tmp'), { recursive: true });
    // 数据目录下若有缓存/生成物，剔除
    for (const junk of ['__pycache__', '.DS_Store']) {
      await rm(path.join(bundleDir, junk), { recursive: true, force: true });
    }
    say(`         → config.json（默认配置，无任何密钥）`);
  }

  // ---------- 2. 混淆 app.cjs（复刻桌面发行链） ----------
  const appRaw = path.join(stage, 'app.raw.cjs');
  const appCjs = path.join(bundleDir, 'app.cjs');
  if (!skipBundle) {
    // 公钥注入必须早于 esbuild（与桌面 build-protected.mjs 一致），否则混淆产物
    // 内嵌的是开发测试公钥，正式激活码无法通过验证。
    const pubFile = path.join(ROOT, 'lib', 'license-pub.mjs');
    const pubBackup = path.join(stage, 'license-pub.backup.mjs');
    const pubPem = keyPath
      ? readFileSync(path.join(path.dirname(keyPath), 'public.pem'), 'utf8')
      : readFileSync(path.join(ROOT, 'scripts', 'keys', 'test-public.pem'), 'utf8');
    await writeFile(pubBackup, await readFile(pubFile, 'utf8'));
    await writeFile(pubFile, `export const LICENSE_PUBKEY = ${JSON.stringify(pubPem)};\n`);
    try {
      say('步骤 2/6  esbuild 打包（ESM → CJS 单文件，目标公钥已注入）…');
      await runNode(esbuildCli, [
        path.join(ROOT, 'server.mjs'),
        '--bundle', '--platform=node', '--format=cjs', '--minify', '--target=node18',
        `--outfile=${appRaw}`,
      ]);
      say(`         → app.raw.cjs ${(await stat(appRaw)).size} B`);

    say('步骤 3/6  混淆（保守档：与桌面发行同配置）…');
    const obfCfgPath = path.join(stage, 'obfuscate.json');
    await writeFile(obfCfgPath, JSON.stringify({
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

      await runNode(obfuscatorCli, [appRaw, '--output', appCjs, '--config', obfCfgPath], { silent: true });
      say(`         → app.cjs ${(await stat(appCjs)).size} B（混淆产物）`);
    } finally {
      await writeFile(pubFile, await readFile(pubBackup, 'utf8'));
      const now = await readFile(pubFile, 'utf8');
      if (now !== await readFile(pubBackup, 'utf8')) fail('lib/license-pub.mjs 还原校验失败！');
    }

    say('步骤 4/6  bundle 压缩（zip + version.txt）…');
    await writeFile(path.join(bundleDir, 'version.txt'), bundleVersion);
    const pyScript = [
      'import zipfile, os',
      'src = os.path.abspath(' + JSON.stringify(bundleDir).replace(/\\/g, '\\\\') + ')',
      'out = ' + JSON.stringify(path.join(ASSETS_DIR, 'bundle.zip')).replace(/\\/g, '\\\\'),
      'z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)',
      'for root, dirs, files in os.walk(src):',
      '    for f in files:',
      '        p = os.path.join(root, f)',
      '        rel = os.path.relpath(p, src).replace(os.sep, "/")',
      '        z.write(p, rel)',
      'z.close()',
      'print("zip bytes:", os.path.getsize(out))',
    ].join('\n');
    await writeFile(path.join(stage, 'zip-bundle.py'), pyScript);
    await runCmd(PYTHON_EXE, [path.join(stage, 'zip-bundle.py')]);
    await writeFile(path.join(ASSETS_DIR, 'version.txt'), bundleVersion);
    say(`         → assets/bundle.zip + version.txt（${bundleVersion}）`);
  } else {
    say('跳过 bundle（--skip-bundle），沿用现 assets/bundle.zip');
  }

  // ---------- 3. keystore（首次生成，之后复用；props 每次重写保证路径一致） ----------
  const keystoreDir = keystoreRoot;
  const keystoreFile = path.join(keystoreDir, 'android-release.jks');
  const propsFile = path.join(ANDROID_DIR, 'keystore.properties');
  const passFile = path.join(keystoreDir, 'keystore-passwords.txt');
  let storePass, keyPass;
  if (!existsSync(keystoreFile)) {
    say('步骤 5/6  生成发布签名密钥（keytool）…');
    await mkdir(keystoreDir, { recursive: true });
    storePass = randomBytes(18).toString('base64url');
    keyPass = randomBytes(18).toString('base64url');
    const alias = 'kaoyan-essay';
    const dname = 'CN=Kaoyan Essay Assistant, OU=EEA, O=EEA, L=Beijing, C=CN';
    const keytoolArgs = [
      '-genkeypair', '-v',
      '-keystore', keystoreFile,
      '-storepass', storePass, '-keypass', keyPass,
      '-alias', alias,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '36500',
      '-dname', dname,
      '-storetype', 'JKS',
    ];
    // keytool 直接 spawn（不经 shell，避免中文路径经 cmd 编码损坏）
    const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '';
    const keytool = javaBin ? path.join(javaBin, 'keytool') : 'keytool';
    const kt = spawnSync(keytool, keytoolArgs, { stdio: 'inherit', encoding: 'utf8' });
    if (kt.error) fail(`keytool 不可用：${kt.error.message}`);
    if (kt.status !== 0) fail(`keytool 生成密钥失败（退出码 ${kt.status}）`);
    // 口令留档（放 keystore 旁；请自行备份保管，丢失将无法升级签名）
    await writeFile(passFile, `storePassword=${storePass}\nkeyPassword=${keyPass}\nalias=${alias}\n`);
    say(`         → ${keystoreFile}`);
  } else {
    say('步骤 5/6  复用既有发布密钥');
    const passText = readFileSync(passFile, 'utf8');
    storePass = passText.match(/storePassword=(.+)/)?.[1];
    keyPass = passText.match(/keyPassword=(.+)/)?.[1];
    if (!storePass || !keyPass) fail(`口令文件缺失口令：${passFile}`);
  }
  // storeFile 相对 android/（rootProject 基准）；切勿再加额外 ../ 前缀
  const storeRel = path.relative(ANDROID_DIR, keystoreFile).split(path.sep).join('/');
  await writeFile(propsFile, [
    `storeFile=${storeRel}`,
    `storePassword=${storePass}`,
    'keyAlias=kaoyan-essay',
    `keyPassword=${keyPass}`,
    '',
  ].join('\n'));

  // ---------- 4. gradle assembleRelease ----------
  say('步骤 6/6  gradle assembleRelease…');
  const buildRelease = () => runCmd(GRADLE, ['--no-daemon', 'assembleRelease'], { cwd: ANDROID_DIR, shell: true });
  try {
    try {
      await buildRelease();
    } catch (err) {
      if (gradleRetry && existsSync(path.join(APP_DIR, '.cxx'))) {
        say('首次构建失败，清 .cxx 缓存重试（中文路径下的已知间歇问题）…');
        await rm(path.join(APP_DIR, '.cxx'), { recursive: true, force: true });
        await buildRelease();
      } else {
        throw err;
      }
    }
  } finally {
    // 口令由受保护的 keystore-passwords.txt 管理；不要在源码树残留临时 Gradle 属性文件。
    await rm(propsFile, { force: true });
  }

  // ---------- 5. 产物 ----------
  const apk = path.join(APP_DIR, 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!existsSync(apk)) fail('release APK 未产出');
  const outDir = path.join(outRoot, 'dist');
  await mkdir(outDir, { recursive: true });
  // 版本号以 app/build.gradle 的 versionName 为唯一来源，避免文件名与 APK 内版本脱节
  const gradleText = readFileSync(path.join(APP_DIR, 'build.gradle'), 'utf8');
  const versionName = (gradleText.match(/versionName\s+['"]([^'"]+)['"]/) || [])[1];
  if (!versionName) fail('无法从 app/build.gradle 读取 versionName');
  const apkName = `考研英语作文助手-v${versionName}-android-arm64${isTest ? '-TEST' : ''}.apk`;
  const target = path.join(outDir, apkName);
  await cp(apk, target);
  const sizeMb = ((await stat(target)).size / 1048576).toFixed(1);
  const bundleMb = ((await stat(path.join(ASSETS_DIR, 'bundle.zip'))).size / 1048576).toFixed(1);

  if (!keepStage) await rm(stage, { recursive: true, force: true });

  hr();
  say('构建完成：');
  say(`  APK   → ${target}（${sizeMb} MiB）`);
  say(`  bundle→ ${bundleMb} MiB（version.txt=${readFileSync(path.join(ASSETS_DIR, 'version.txt'), 'utf8').trim()}）`);
  say(`  密钥  → ${keystoreFile}（口令见同目录 keystore-passwords.txt，请妥善保管）`);
  say(`  耗时  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  say(isTest ? '  ⚠ 本产物使用测试公钥，无法用正式激活码激活！' : '  已注入作者公钥，可正常激活。');
  hr();
}

main().catch((err) => { say(`\n[构建失败] ${err.message}`); process.exit(1); });
