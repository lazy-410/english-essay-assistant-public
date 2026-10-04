import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const CONFIG_PATH = path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    modelReasoning: 'deepseek-v4-flash',
    modelFast: 'deepseek-v4-flash',
    temperature: 0.3,
    timeoutMs: 240000,
    maxRetries: 2,
  },
  vision: {
    apiKey: '',
    model: 'qwen3.7-plus',
    enabled: true,
  },
  server: { port: 7654, openBrowser: true, licenseUrl: '' },
  // 备考方向：e1 / e2；null 表示用户还没选过，首次打开时引导选择。
  study: { examType: null },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;

/**
 * 环境变量覆盖（只影响本次进程的读取视图，绝不写回 config.json）：
 * EEA_DEEPSEEK_KEY / EEA_VISION_KEY 供自动化回归注入“无 Key / 假 Key”场景，
 * EEA_LICENSE_URL 用来显式关闭云端校验（空串=纯离线），
 * 让服务器进程也能在零网络、零真实调用的条件下被完整演练。
 */
const ENV_OVERRIDES = [
  ['EEA_DEEPSEEK_KEY', (cfg, value) => { cfg.deepseek.apiKey = value; }],
  ['EEA_VISION_KEY', (cfg, value) => { cfg.vision.apiKey = value; }],
  ['EEA_LICENSE_URL', (cfg, value) => { cfg.server.licenseUrl = value; }],
];

function withEnvOverrides(cfg) {
  const active = ENV_OVERRIDES.filter(([name]) => process.env[name] !== undefined);
  if (!active.length) return cfg;
  const view = structuredClone(cfg);
  for (const [name, apply] of active) apply(view, String(process.env[name]));
  return view;
}

export async function loadConfig({ force = false } = {}) {
  if (cache && !force) return withEnvOverrides(cache);
  const target = existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
  let raw = {};
  try {
    raw = JSON.parse(await readFile(target, 'utf8'));
  } catch (err) {
    if (existsSync(target)) {
      throw new Error(`配置文件 ${path.basename(target)} 解析失败：${err.message}`);
    }
  }
  cache = deepMerge(DEFAULTS, raw);
  return withEnvOverrides(cache);
}

export async function saveConfig(patch) {
  // 保存永远基于磁盘上的真实内容：环境变量覆盖只属于读取视图，不能写进配置文件。
  await loadConfig({ force: true });
  const next = deepMerge(cache, patch);
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cache = next;
  return withEnvOverrides(next);
}

/** 供前端展示：key 一律掩码，绝不回传明文 */
export function maskConfig(cfg) {
  const mask = (s) => {
    if (!s) return '';
    if (s.length <= 10) return '*'.repeat(s.length);
    return `${s.slice(0, 5)}${'*'.repeat(Math.max(4, s.length - 9))}${s.slice(-4)}`;
  };
  return {
    deepseek: {
      apiKeyMasked: mask(cfg.deepseek.apiKey),
      hasApiKey: Boolean(cfg.deepseek.apiKey),
      baseUrl: cfg.deepseek.baseUrl,
      modelReasoning: cfg.deepseek.modelReasoning,
      modelFast: cfg.deepseek.modelFast,
      temperature: cfg.deepseek.temperature,
    },
    vision: {
      apiKeyMasked: mask(cfg.vision?.apiKey),
      hasApiKey: Boolean(cfg.vision?.apiKey),
      model: cfg.vision?.model ?? 'qwen3.7-plus',
      enabled: cfg.vision?.enabled !== false,
    },
    server: { port: cfg.server.port },
    study: { examType: cfg.study?.examType ?? null },
  };
}
