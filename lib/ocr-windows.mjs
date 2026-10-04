import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TMP_DIR } from './paths.mjs';
import { IS_WINDOWS, platformLabel } from './platform.mjs';

/**
 * Windows 内置 OCR（Windows.Media.Ocr）。
 * 优点：离线、免费、零依赖，中英混排可用。
 * 缺点：英文偶有 tO / writin g 之类的切分错误，后续交给 DeepSeek 清洗。
 */

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  })[0]

  function Await($op, $type) {
    $m = $asTask.MakeGenericMethod($type)
    $task = $m.Invoke($null, @($op))
    $task.Wait(60000) | Out-Null
    $task.Result
  }

  $imagePath = $env:EEA_OCR_IMAGE
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync(0)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
  }
  if ($null -eq $engine) { throw 'no-ocr-engine' }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($line in $result.Lines) { $lines += $line.Text }

  $payload = [ordered]@{
    language = $engine.RecognizerLanguage.LanguageTag
    lines    = $lines
  }
  ConvertTo-Json $payload -Depth 4 -Compress
} catch {
  ConvertTo-Json ([ordered]@{ error = $_.Exception.Message }) -Compress
}
`;

/** 脚本落盘再执行：-Command - 从 stdin 读多行脚本在部分环境下会静默失败 */
async function ensureScript() {
  await mkdir(TMP_DIR, { recursive: true });
  const scriptPath = path.join(TMP_DIR, 'ocr-engine.ps1');
  await writeFile(scriptPath, `\ufeff${PS_SCRIPT}`, 'utf8');
  return scriptPath;
}

function runPowerShell(scriptPath, imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { env: { ...process.env, EEA_OCR_IMAGE: imagePath }, windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('OCR 超时（90 秒）'));
    }, 90000);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        return reject(new Error(`OCR 无输出（exit ${code}）。${stderr.trim().slice(0, 300)}`));
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * @param {Buffer} buffer 图片二进制
 * @param {string} ext 扩展名（.png/.jpg）
 * @returns {Promise<{ text: string, lines: string[], language: string, backend: string }>}
 */
export async function recognize(buffer, ext = '.png') {
  // 非 Windows 直接给出可读原因，不启动 powershell 白等一次超时。
  if (!IS_WINDOWS) {
    throw Object.assign(
      new Error(`${platformLabel()} 没有 Windows 内置 OCR。请在「设置 → OCR」改用云端 OCR，或直接把题目文字粘贴到输入框。`),
      { code: 'local_ocr_unavailable' },
    );
  }
  await mkdir(TMP_DIR, { recursive: true });
  const tmpFile = path.join(TMP_DIR, `ocr-${randomUUID()}${ext}`);
  await writeFile(tmpFile, buffer);

  try {
    const scriptPath = await ensureScript();
    const raw = await runPowerShell(scriptPath, tmpFile);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`OCR 输出无法解析：${raw.slice(0, 200)}`);
    }

    if (parsed.error) {
      if (parsed.error === 'no-ocr-engine') {
        throw new Error('系统未安装可用的 OCR 语言包。可在「设置 → 语言」里添加中文或英文的「可选功能 → 光学字符识别」，或改用云端 OCR。');
      }
      throw new Error(`Windows OCR 失败：${parsed.error}`);
    }

    // PowerShell 单元素数组会被序列化成标量
    const lines = Array.isArray(parsed.lines) ? parsed.lines : parsed.lines ? [parsed.lines] : [];
    return {
      text: lines.join('\n'),
      lines,
      language: parsed.language ?? 'unknown',
      backend: 'windows',
    };
  } finally {
    await rm(tmpFile, { force: true });
  }
}
