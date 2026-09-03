import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { injectQoderTools } from '../tool-compat.js';

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

/**
 * 从 stream-json 单行解析出文本增量。
 * 同时解析多种 tool call 格式，转为结构化 tool_calls。
 */
export function parseCliDelta(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec.type !== 'assistant') return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;

  // 1. CLI 原生 tool_use（type: "tool_use"，--dangerously-skip-permissions 激活）
  const toolUseParts = content.filter((c) => c.type === 'tool_use');
  if (toolUseParts.length > 0) {
    return {
      type: 'tool_call',
      tool_calls: toolUseParts.map((tc, i) => ({
        index: i,
        id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: tc.name || '',
          arguments: typeof tc.input === 'object' ? JSON.stringify(tc.input || {}) : (tc.input || ''),
        },
      })),
      content: null,
    };
  }

  const fullText = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (!fullText) return null;

  // 2. foxy1402 格式: {"tool_call":{"name":"X","arguments":{...}}}
  if (fullText.trim().startsWith('{"tool_call"')) {
    const parsed = parseToolCallJson(fullText.trim());
    if (parsed) return { type: 'tool_call', tool_calls: [parsed], content: null };
  }

  // 3. <tool_call> 标签格式
  const tcBegin = fullText.indexOf('<tool_call>');
  if (tcBegin >= 0) {
    const tcEnd = fullText.indexOf('</tool_call>');
    const jsonStr = fullText.substring(tcBegin + '<tool_call>'.length, tcEnd >= 0 ? tcEnd : undefined);
    try {
      const call = JSON.parse(jsonStr.trim());
      const before = fullText.substring(0, tcBegin).trim();
      const after = tcEnd >= 0 ? fullText.substring(tcEnd + '</tool_call>'.length).trim() : '';
      const cleanText = (before + (after ? ' ' + after : '')).trim();
      return {
        type: 'tool_call',
        tool_calls: [toToolCallObj(call)],
        content: cleanText || null,
      };
    } catch {}
  }

  // 4. ```json code block 格式
  const jsonBlockMatch = fullText.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) {
    const inner = jsonBlockMatch[1].trim();
    if (inner.includes('"tool_call"')) {
      const parsed = parseToolCallJson(inner);
      if (parsed) {
        const before = fullText.substring(0, jsonBlockMatch.index).trim();
        const after = fullText.substring(jsonBlockMatch.index + jsonBlockMatch[0].length).trim();
        return { type: 'tool_call', tool_calls: [parsed], content: (before + (after ? ' ' + after : '')).trim() || null };
      }
    }
    try {
      const parsed = JSON.parse(inner);
      if (parsed.name && (parsed.arguments || parsed.parameters)) {
        const before = fullText.substring(0, jsonBlockMatch.index).trim();
        const after = fullText.substring(jsonBlockMatch.index + jsonBlockMatch[0].length).trim();
        return { type: 'tool_call', tool_calls: [toToolCallObj(parsed)], content: (before + (after ? ' ' + after : '')).trim() || null };
      }
    } catch {}
  }

  // 5. 普通文本
  return { type: 'text', content: fullText };
}

/** 解析 {"tool_call":{"name":"X","arguments":{...}}} 格式 */
function parseToolCallJson(text) {
  // 直接尝试
  try {
    const obj = JSON.parse(text);
    if (obj.tool_call && obj.tool_call.name) {
      return toToolCallObj(obj.tool_call);
    }
  } catch {}

  // 花括号匹配（处理前后有多余文本的情况）
  const start = text.indexOf('{"tool_call"');
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(text.slice(start, end));
    if (obj.tool_call && obj.tool_call.name) return toToolCallObj(obj.tool_call);
  } catch {}
  return null;
}

/** 转为 OpenAI tool_call 对象 */
function toToolCallObj(call) {
  return {
    index: 0,
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: {
      name: call.name || '',
      arguments: typeof call.arguments === 'object' ? JSON.stringify(call.arguments || {}) : (call.arguments || ''),
    },
  };
}

/**
 * 构建 CLI 工具名 → 客户端工具名的映射表。
 * CLI 内置工具（Read/Write/Edit/Bash/Glob/Grep 等）可能与客户端定义的工具名不同。
 * 映射基于功能相似性：如果客户端有功能相似的工具，映射过去；否则保留 CLI 原名。
 */
function buildToolNameMap(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const map = {};
  // CLI 内置工具名 → 可能的客户端工具名（按功能匹配）
  const cliToClient = {
    'read_file': 'Read', 'Read': 'read_file',
    'write_file': 'Write', 'Write': 'write_file',
    'edit_file': 'Edit', 'Edit': 'edit_file',
    'execute_command': 'Bash', 'Bash': 'execute_command',
    'list_files': 'Glob', 'Glob': 'list_files',
    'search_files': 'Grep', 'Grep': 'search_files',
  };

  const clientToolNames = new Set(tools.map(t => (t.function || t).name).filter(Boolean));

  for (const [cliName, clientName] of Object.entries(cliToClient)) {
    if (clientToolNames.has(clientName)) {
      map[cliName] = clientName;
    }
  }

  return Object.keys(map).length > 0 ? map : null;
}

/** 把 OpenAI messages 格式化为 CLI 文本 */
function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  // 跳过 system(已用 --append-system-prompt 处理)
  // 跳过 tool 角色消息（CLI 不理解 tool result）
  const msgs = messages.filter((m) => m.role !== 'system' && m.role !== 'tool');
  // 单条消息直接返回内容
  if (msgs.length <= 1) {
    const c = msgs[0]?.content;
    return typeof c === 'string' ? c : '';
  }
  // 多轮对话：用 role 标签标注
  return msgs.map((m) => {
    const c = typeof m.content === 'string' ? m.content : '';
    // assistant 消息带 tool_calls：转为文本描述
    if (m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map(tc => {
        const fn = tc.function || tc;
        return `[called tool: ${fn.name} with ${fn.arguments}]`;
      }).join('\n');
      return c ? `[${m.role}]\n${c}\n${calls}` : `[${m.role}]\n${calls}`;
    }
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

    // 注入 tools 到 system prompt（CLI 不支持原生 function calling）
    // 使用 foxy1402 格式的强制 tool prompt
    const injected = injectQoderTools(reqBody);
    const system = (injected.messages || []).find((m) => m.role === 'system')?.content || '';
    const userMsg = formatMessages(injected.messages);

    // 构建 CLI 工具名 → 客户端工具名的映射表
    // CLI 会用内置工具名（Read/Write/Edit/Bash），需要映射回客户端的工具名
    const toolMap = buildToolNameMap(reqBody.tools);

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--model', model,
      '--no-session-persistence',
      '--max-model-request-retries', '0',
      ...(system ? ['--append-system-prompt', system] : []),
    ];

    const env = {
      ...process.env,
      CI: '1',
      NO_BROWSER: '1',
    };
    if (this.pat && !fs.existsSync(OAUTH_USER)) env.QODERCN_PERSONAL_ACCESS_TOKEN = this.pat;

    const created = Math.floor(Date.now() / 1000);
    let lastErr = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(1000 * attempt);
      try {
        await this._runStream(model, args, env, created, emit, userMsg, toolMap);
        return;
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt >= MAX_RETRIES) break;
      }
    }
    throw lastErr || new Error('qoder upstream failed');
  }

  _runStream(model, args, env, created, emit, prompt, toolMap) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let lineBuffer = '';
      let errorOutput = '';
      let usageChunk = null;
      let modelUsage = null;
      let totalCredits = null;
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
          const parsed = parseCliDelta(line);
          if (!parsed) {
            // result record → capture usage
            try {
              const rec = JSON.parse(line);
              if (rec.type === 'result') {
                if (rec.usage) usageChunk = rec.usage;
                if (rec.modelUsage) modelUsage = rec.modelUsage;
                if (rec.total_credits !== undefined) totalCredits = rec.total_credits;
              }
            } catch {}
            continue;
          }

          if (parsed.type === 'tool_call' && parsed.tool_calls) {
            // 工具调用：映射 CLI 工具名 → 客户端工具名
            const mappedCalls = parsed.tool_calls.map(tc => {
              if (toolMap && tc.function?.name && toolMap[tc.function.name]) {
                return { ...tc, function: { ...tc.function, name: toolMap[tc.function.name] } };
              }
              return tc;
            });
            emit({
              id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
              object: 'chat.completion.chunk', created,
              choices: [{ index: 0, delta: { tool_calls: mappedCalls }, finish_reason: null }],
            });
            // 如果工具调用前后有文本，也发送
            if (parsed.content) {
              emit({
                id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
                object: 'chat.completion.chunk', created,
                choices: [{ index: 0, delta: { content: parsed.content }, finish_reason: null }],
              });
            }
          } else if (parsed.content) {
            // 普通文本
            emit({
              id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
              object: 'chat.completion.chunk', created,
              choices: [{ index: 0, delta: { content: parsed.content }, finish_reason: null }],
            });
          }
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
        if (modelUsage || totalCredits !== null) {
          const detail = {};
          if (modelUsage) detail.model_usage = modelUsage;
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
          if (Object.keys(detail).length > 0) stopChunk.usage_details = detail;
        }
        emit(stopChunk);
        resolve();
      });

      // 通过 stdin 传入 prompt
      child.stdin.write(prompt || '');
      child.stdin.end();
    });
  }
}
