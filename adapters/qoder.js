import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const CN_HOME = path.join(os.homedir(), '.qoderworkcn');
const OAUTH_USER = path.join(CN_HOME, '.auth-cn', 'user');
const MODELS = [
  { externalId: 'qoder-qwen3.7-max', cliModel: 'Qwen3.7-Max' },
  { externalId: 'qoder-qwen3.6-plus', cliModel: 'Qwen3.6-Plus' },
  { externalId: 'qoder-glm-5.2', cliModel: 'GLM-5.2' },
  { externalId: 'qoder-glm-5.1', cliModel: 'GLM-5.1' },
  { externalId: 'qoder-kimi-k2.6', cliModel: 'Kimi-K2.6' },
  { externalId: 'qoder-deepseek-v4-pro', cliModel: 'DeepSeek-V4-Pro' },
  { externalId: 'qoder-deepseek-v4-flash', cliModel: 'DeepSeek-V4-Flash' },
];

/** 从 stream-json 单行解析出文本增量；非文本/无文本返回 null */
export function parseCliDelta(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec.type !== 'assistant') return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return text || null;
}

export class QoderAdapter {
  constructor(options = {}) {
    this.id = 'qoder';
    this.command = options.command || process.env.QODERCN_CLI || 'qoderclicn';
    this.pat = options.pat ?? process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  }

  async getAuth() {
    // 有落盘 OAuth 凭据则以其为准；否则需要有 PAT
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

  runCli(args, env, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`qoderclicn exited ${code}: ${stderr.slice(0, 300)}`));
        else resolve(stdout);
      });
      if (input) child.stdin.write(input);
      child.stdin.end();
    });
  }

  async chat(reqBody, emit) {
    await this.getAuth();
    const model = reqBody.model || 'Qwen3.7-Max';
    const system = (reqBody.messages || []).find((m) => m.role === 'system')?.content || '';
    const userMsg = (reqBody.messages || []).filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--model', model,
      '--dangerously-skip-permissions',
      ...(system ? ['--append-system-prompt', system] : []),
      '--',
      String(userMsg),
    ];
    const env = { ...process.env };
    if (this.pat && !fs.existsSync(OAUTH_USER)) env.QODERCN_PERSONAL_ACCESS_TOKEN = this.pat;
    const stdout = await this.runCli(args, env);
    const created = Math.floor(Date.now() / 1000);
    for (const line of stdout.split('\n')) {
      const text = parseCliDelta(line);
      if (text) {
        emit({ id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`, object: 'chat.completion.chunk', created,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
    }
    emit({ id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`, object: 'chat.completion.chunk', created,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
}
