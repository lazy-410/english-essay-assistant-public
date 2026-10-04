import { loadConfig } from './config.mjs';

export class DeepSeekError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status ?? 502;
    this.code = code;
    this.retryable = retryable;
  }
}

function classify(status, payload) {
  const detail = payload?.error?.message ?? '';
  switch (status) {
    case 400:
      return new DeepSeekError(`请求格式有误：${detail}`, { status: 400, code: 'bad_request' });
    case 401:
      return new DeepSeekError('API Key 无效或已撤销，请到「设置」页更新。', { status: 401, code: 'auth' });
    case 402:
      return new DeepSeekError('DeepSeek 账户余额不足，请充值后再试。', { status: 402, code: 'insufficient_balance' });
    case 429:
      return new DeepSeekError('请求过于频繁，稍后再试。', { status: 429, code: 'rate_limit', retryable: true });
    case 500:
    case 502:
    case 503:
      return new DeepSeekError(`DeepSeek 服务暂时不可用（${status}）。`, { status: 503, code: 'upstream', retryable: true });
    default:
      return new DeepSeekError(`DeepSeek 返回异常（${status}）：${detail}`, { status: 502, code: 'unknown' });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用 DeepSeek chat completions。
 * @param {object} opts
 * @param {'reasoning'|'fast'} [opts.tier] 模型档位：reasoning=判断类，fast=纠错润色类
 * @param {boolean} [opts.json] 是否强制 JSON 输出
 */
export async function chat({
  system,
  messages,
  tier = 'fast',
  json = false,
  temperature,
  maxTokens = 4096,
  model,
} = {}) {
  const cfg = await loadConfig();
  const ds = cfg.deepseek;

  if (!ds.apiKey) {
    throw new DeepSeekError('还没有配置 DeepSeek API Key，请到「设置」页填写。', { status: 400, code: 'no_key' });
  }

  const finalModel = model ?? (tier === 'reasoning' ? ds.modelReasoning : ds.modelFast);
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...(messages ?? []));

  const payload = {
    model: finalModel,
    messages: msgs,
    temperature: temperature ?? ds.temperature ?? 0.3,
    max_tokens: maxTokens,
    stream: false,
  };
  // 当为 fast 档时显式关闭思考模式，避免 token 全被 reasoning_content 吞掉导致 content 为空
  if (tier === 'fast') payload.thinking = { type: 'disabled' };
  if (json) payload.response_format = { type: 'json_object' };

  const maxAttempts = (ds.maxRetries ?? 2) + 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ds.timeoutMs ?? 120000);
    try {
      const res = await fetch(`${ds.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ds.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (!res.ok) {
        const err = classify(res.status, parsed);
        if (!parsed && text) err.rawText = text.slice(0, 300);
        if (err.retryable && attempt < maxAttempts) {
          lastErr = err;
          await sleep(800 * attempt);
          continue;
        }
        throw err;
      }

      const msg = parsed?.choices?.[0]?.message;
      const content = msg?.content ?? (msg?.reasoning_content ? null : undefined);
      if (typeof content !== 'string') {
        const reasoning = msg?.reasoning_content ? `（仅有 reasoning_content: ${msg.reasoning_content.slice(0, 100)}...）` : '';
        throw new DeepSeekError(`DeepSeek 返回内容为空 ${reasoning}。完整响应 choices: ${JSON.stringify(parsed?.choices ?? text.slice(0, 200))}`, { status: 502, code: 'empty' });
      }

      return {
        content,
        model: parsed.model ?? finalModel,
        usage: parsed.usage ?? null,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DeepSeekError) {
        if (err.retryable && attempt < maxAttempts) {
          lastErr = err;
          await sleep(800 * attempt);
          continue;
        }
        throw err;
      }
      if (err.name === 'AbortError') {
        const e = new DeepSeekError(
          `请求超时（${Math.round((ds.timeoutMs ?? 120000) / 1000)} 秒）。`,
          { status: 504, code: 'timeout', retryable: true },
        );
        if (attempt < maxAttempts) {
          lastErr = e;
          continue;
        }
        throw e;
      }
      // 网络层错误
      const e = new DeepSeekError(`无法连接 DeepSeek：${err.message}`, {
        status: 502,
        code: 'network',
        retryable: true,
      });
      if (attempt < maxAttempts) {
        lastErr = e;
        await sleep(800 * attempt);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new DeepSeekError('调用失败。', { status: 502 });
}

/**
 * 要求模型返回 JSON 并解析；容忍 ```json 围栏。
 * v4-pro 会把大量 token 用在内部推理上，偶尔会在 JSON 尚未闭合时耗尽输出预算。
 * 遇到截断/非法 JSON 时，扩大 token 预算并把温度降到 0，完整重跑同一请求一次。
 */
export async function chatJson(opts) {
  const parse = (out) => {
    if (!out || typeof out.content !== 'string' || !out.content.trim()) {
      throw new Error(`API 响应结构为空`);
    }
    let text = out.content.trim();
    // 剥离 ```json ... ``` 围栏
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // 如果剥离后仍包含围栏或文本前缀，正则截取最外层 { ... }
    const match = text.match(/\{[\s\S]*\}/);
    if (match) text = match[0];

    try {
      return { ...out, data: JSON.parse(text) };
    } catch (e) {
      throw new Error(`无法解析为 JSON: ${e.message}。原始文本前 200 字: ${out.content.slice(0, 200)}`);
    }
  };

  // 不强制传 response_format: { type: "json_object" }，避免部分模型静默返回空包
  const first = await chat({ ...opts, json: false });
  try {
    return parse(first);
  } catch (firstError) {
    const retryTokens = Math.min(16384, Math.max(8192, Number(opts.maxTokens ?? 4096) * 2));
    try {
      const second = await chat({
        ...opts,
        model: undefined,
        tier: 'fast',
        json: false,
        temperature: 0,
        maxTokens: retryTokens,
      });
      const parsed = parse(second);
      return {
        ...parsed,
        jsonFallback: {
          used: true,
          reason: firstError.message,
          firstModel: first.model,
          retryModel: second.model,
          retryMaxTokens: retryTokens,
        },
      };
    } catch (secondError) {
      throw new DeepSeekError(
        `JSON 两次解析失败。\n首次报错: ${firstError.message}\n第二次报错: ${secondError.message}`,
        { status: 502, code: 'bad_json' },
      );
    }
  }
}

/**
 * 设置页的连通性测试。
 * 注意：DeepSeek v4 两个模型都会先产出推理 token，max_tokens 给太小会导致
 * 正文被推理吃光而返回空串，因此这里预留 512。
 */
export async function testConnection() {
  const started = Date.now();
  const out = await chat({
    messages: [{ role: 'user', content: '回复两个字：正常' }],
    maxTokens: 512,
    temperature: 0,
  });
  return {
    reply: out.content.trim(),
    model: out.model,
    latencyMs: Date.now() - started,
    usage: out.usage,
  };
}
