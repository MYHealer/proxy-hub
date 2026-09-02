import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const CN_HOME = path.join(os.homedir(), '.qoderworkcn');
const OAUTH_USER = path.join(CN_HOME, '.auth-cn', 'user');

function findCli() {
  if (process.env.QODERCN_CLI) return process.env.QODERCN_CLI;
  const candidates = [
    path.join(os.homedir(), '.qoder', 'bin', 'qodercli', 'qodercli.exe'),
    'qodercli',
    'qoderclicn',
  ];
  for (const c of candidates) {
    try { if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) return c; } } catch {}
  }
  return candidates[candidates.length - 1];
}

const MODELS = [
  { externalId: 'qoder-qwen3.8-max', cliModel: 'Qwen3.8-Max' },
  { externalId: 'qoder-qwen3.8-flash', cliModel: 'Qwen3.8-Flash' },
  { externalId: 'qoder-qwen3.7-max', cliModel: 'Qwen3.7-Max' },
  { externalId: 'qoder-qwen3.7-plus', cliModel: 'Qwen3.7-Plus' },
  { externalId: 'qoder-glm-5.3', cliModel: 'GLM-5.3' },
  { externalId: 'qoder-glm-5.3-flash', cliModel: 'GLM-5.3-Flash' },
  { externalId: 'qoder-kimi-k3', cliModel: 'Kimi-K3' },
  { externalId: 'qoder-kimi-k2.7-code', cliModel: 'Kimi-K2.7-Code' },
  { externalId: 'qoder-deepseek-v4-pro', cliModel: 'DeepSeek-V4-Pro' },
  { externalId: 'qoder-deepseek-v4-flash', cliModel: 'DeepSeek-V4-Flash' },
  { externalId: 'qoder-minimax-m3', cliModel: 'MiniMax-M3' },
];

/** 从 stream-json 单行解析出文本增量 */
function parseCliDelta(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec.type !== 'assistant') return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return text || null;
}

/** 把 OpenAI messages 格式化为 CLI 文本 */
function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  // 跳过 system(已用 --append-system-prompt 处理)
  const msgs = messages.filter((m) => m.role !== 'system');
  // 单条消息直接返回内容
  if (msgs.length <= 1) {
    const c = msgs[0]?.content;
    return typeof c === 'string' ? c : '';
  }
  // 多轮对话：用 role 标签标注
  return msgs.map((m) => {
    const c = typeof m.content === 'string' ? m.content : '';
    return `[${m.role}]\n${c}`;
  }).join('\n\n');
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;

function isRetryable(err) {
  const m = err?.message || '';
  if (m.includes('timeout') || m.includes('ECONNRESET') || m.includes('ETIMEDOUT')) return true;
  for (const code of RETRYABLE) {
    if (m.includes(`exited ${code}`) || m.includes(`exit code ${code}`)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export class QoderAdapter {
  constructor(options = {}) {
    this.id = 'qoder';
    this.command = options.command || findCli();
    this.pat = options.pat ?? process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    this.timeoutMs = 180000;
  }

  async getAuth() {
    if (fs.existsSync(OAUTH_USER)) return { oauth: true };
    if (this.pat) return { pat: this.pat };
    throw new Error('Qoder: 既无 qoderclicn login 落盘凭据，也无 QODERCN_PERSONAL_ACCESS_TOKEN');
  }

  async refreshAuth() {
    return this.getAuth();
  }

  registerModels() {
    return MODELS.map((m) => ({ externalId: m.externalId, upstreamId: m.cliModel }));
  }

  async chat(reqBody, emit) {
    await this.getAuth();
    const model = reqBody.model || 'Qwen3.7-Max';
    const system = (reqBody.messages || []).find((m) => m.role === 'system')?.content || '';
    const userMsg = formatMessages(reqBody.messages);

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--model', model,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--max-model-request-retries', '0',
      ...(system ? ['--append-system-prompt', system] : []),
      '--',
      String(userMsg),
    ];

    const env = { ...process.env };
    if (this.pat && !fs.existsSync(OAUTH_USER)) env.QODERCN_PERSONAL_ACCESS_TOKEN = this.pat;

    const created = Math.floor(Date.now() / 1000);
    let lastErr = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(1000 * attempt);
      try {
        await this._runStream(model, args, env, created, emit);
        return;
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt >= MAX_RETRIES) break;
      }
    }
    throw lastErr || new Error('qoder upstream failed');
  }

  _runStream(model, args, env, created, emit) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let lineBuffer = '';
      let errorOutput = '';
      let usageChunk = null;     // result.usage
      let modelUsage = null;     // result.modelUsage — 额度明细
      let totalCredits = null;   // result.total_credits
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        reject(new Error('qoderclicn timeout'));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          // 1. assistant content → emit immediately
          const text = parseCliDelta(line);
          if (text) {
            emit({ id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`, object: 'chat.completion.chunk', created,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
            continue;
          }
          // 2. result record → capture usage + credits
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'result') {
              if (rec.usage) usageChunk = rec.usage;
              if (rec.modelUsage) modelUsage = rec.modelUsage;
              if (rec.total_credits !== undefined) totalCredits = rec.total_credits;
            }
          } catch {}
        }
      });

      child.stderr.on('data', (c) => { errorOutput += c; });

      child.on('error', (e) => { clearTimeout(timer); reject(e); });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          reject(new Error(`qoderclicn exited ${code}: ${errorOutput.slice(0, 300)}`));
          return;
        }
        // Build stop chunk with usage
        const stopChunk = {
          id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
          object: 'chat.completion.chunk',
          created,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        if (usageChunk) {
          stopChunk.usage = {
            prompt_tokens: usageChunk.input_tokens ?? usageChunk.prompt_tokens ?? 0,
            completion_tokens: usageChunk.output_tokens ?? usageChunk.completion_tokens ?? 0,
            total_tokens: (usageChunk.input_tokens ?? usageChunk.prompt_tokens ?? 0) + (usageChunk.output_tokens ?? usageChunk.completion_tokens ?? 0),
          };
        }
        // Attach detailed model usage / credits if available
        if (modelUsage || totalCredits !== null) {
          const detail = {};
          if (modelUsage) {
            // modelUsage 是 { [modelName]: { credits, costUSD, ... } }
            detail.model_usage = modelUsage;
          }
          // 汇总所有模型的 credits
          let totalCreditsFromModels = 0;
          let totalCost = 0;
          if (modelUsage && typeof modelUsage === 'object') {
            for (const val of Object.values(modelUsage)) {
              if (val && typeof val === 'object') {
                totalCreditsFromModels += val.credits || 0;
                totalCost += val.costUSD || 0;
              }
            }
          }
          if (totalCreditsFromModels > 0) detail.total_credits = totalCreditsFromModels;
          if (totalCost > 0) detail.total_cost_usd = totalCost;
          if (Object.keys(detail).length > 0) {
            stopChunk.usage_details = detail;
          }
        }
        emit(stopChunk);
        resolve();
      });

      child.stdin.end();
    });
  }
}