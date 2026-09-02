import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const TOOL_CALL_LOG = 'C:/Users/MR/Desktop/mix_api_bridge_src/proxy-hub/debug.log';
function logToolCall(label, name, args) {
  try { fs.appendFileSync(TOOL_CALL_LOG, `[${new Date().toISOString()}] ${label}: ${name} => ${(args || '').slice(0,600)}\n`); } catch {}
}
function logDebug(label, msg) {
  try { fs.appendFileSync(TOOL_CALL_LOG, `[${new Date().toISOString()}] [DBG] ${label}: ${msg}\n`); } catch {}
}
import { CredentialsCache } from '../credentials.js';
import { postStreamingTraeSSE } from '../sse.js';
import { needsTextTools, injectTools } from '../tool-compat.js';
import https from 'node:https';

function postJsonBuffer(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request(u, { method: 'POST', headers: { ...headers, 'Content-Length': buf.length } }, (res) => {
      const data = [];
      res.on('data', (c) => data.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('traecn timeout')));
    req.write(buf);
    req.end();
  });
}

const UPSTREAM_BASE_CN = 'https://trae-api-cn.mchost.guru';
const CHAT_ENDPOINTS = [
  '/api/agent/v3/llm_utils_chat',
  '/api/ide/v1/chat',
  '/api/agent/v3/create_agent_task',
];
const X_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION_CN = '3.3.67';
const IDE_VERSION_CODE_CN = '20260401';

const MODELS = ['glm-5.2', 'glm-5.1', 'glm-5', 'qwen-3.7-plus', 'kimi-k2.6', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash'];

// 上游模型名归一化表（小写 → 正确大小写）
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'DeepSeek-V4-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
  'deepseek-flash': 'DeepSeek-V4-Flash',
  'deepseek-pro': 'DeepSeek-V4-Pro',
};

function normalizeModel(name) {
  const lower = (name || '').toLowerCase();
  return MODEL_ALIASES[lower] || name;
}

// Trae CN 前端 JS 逆向出的四组 64B 盐值（来源：laojichao/trae-local-api，原样拷贝，勿改）
const SALT_A = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const SALT_C = Buffer.from([
  191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176,
  135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156,
  51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6,
  18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
]);
const SALT_D = Buffer.from([
  246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145,
  50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106,
  175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154,
  86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
]);

function storagePath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json');
}

/** 调试开关：环境变量 PROXY_HUB_DEBUG 为 "1"/"true"/"traecn" 时开启；默认关闭，零日志开销。 */
function debugEnabled() {
  const v = process.env.PROXY_HUB_DEBUG;
  if (v === undefined) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'traecn';
}

/** Trae 桌面版 storage.json 路径（productDir 形如 'Trae CN' / 'TRAE SOLO CN' / 'Trae'）。 */
export function traeStoragePath(productDir) {
  return path.join(os.homedir(), 'AppData', 'Roaming', productDir, 'User', 'globalStorage', 'storage.json');
}

function xorSalts(a, b, len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** 对上游 SSE 某行事件（event + data）返回一个或多个 OpenAI chunk */
export function normalizeTraeEvent(event, data, model) {
  const created = Math.floor(Date.now() / 1000);
  if (event === 'done') {
    let finish = 'stop';
    try { finish = JSON.parse(data).finish_reason || 'stop'; } catch {}
    return [{ id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }] }];
  }
  if (event === 'token_usage') {
    let usage = null;
    try { const d = JSON.parse(data); usage = { prompt_tokens: d.prompt_tokens, completion_tokens: d.completion_tokens }; } catch {}
    if (!usage) return [];
    return [{ id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: null }], usage }];
  }
  if (event === 'output') {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return []; }
    const delta = {};
    // 文本内容：检测工具调用文本，转为结构化 tool_calls
    if (parsed.response) {
      const text = parsed.response;
      let parsed_text_tc = false;
      // DeepSeek 原始格式: <|FunctionCallBegin|>[{"name":"X","parameters":{...}}]<|FunctionCallEnd|>
      const fcBegin = text.indexOf('<|FunctionCallBegin|>');
      // 文本注入格式: <tool_call>{"name":"X","arguments":{...}}</tool_call>
      const tcTagBegin = text.indexOf('<tool_call>');
      if (fcBegin >= 0) {
        const fcEnd = text.indexOf('<|FunctionCallEnd|>');
        const jsonStart = fcBegin + '<|FunctionCallBegin|>'.length;
        const jsonStr = fcEnd >= 0 ? text.substring(jsonStart, fcEnd) : text.substring(jsonStart);
        try {
          let calls = JSON.parse(jsonStr);
          if (!Array.isArray(calls)) calls = [calls];
          delta.tool_calls = calls.map((c, i) => ({
            index: i,
            id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: {
              name: c.name || c.function || '',
              arguments: typeof c.parameters === 'object' ? JSON.stringify(c.parameters || {}) : (c.arguments || c.parameters || ''),
            },
          }));
          parsed_text_tc = true;
          logDebug('DEEPSEEK_TC', JSON.stringify(delta.tool_calls).slice(0, 400));
        } catch {}
        const before = text.substring(0, fcBegin).trim();
        const after = fcEnd >= 0 ? text.substring(fcEnd + '<|FunctionCallEnd|>'.length).trim() : '';
        const cleanText = (before + (after ? ' ' + after : '')).trim();
        if (cleanText) delta.content = cleanText;
      } else if (tcTagBegin >= 0) {
        const tcTagEnd = text.indexOf('</tool_call>');
        const jsonStart = tcTagBegin + '<tool_call>'.length;
        const jsonStr = tcTagEnd >= 0 ? text.substring(jsonStart, tcTagEnd) : text.substring(jsonStart);
        try {
          let call = JSON.parse(jsonStr.trim());
          delta.tool_calls = [{
            index: 0,
            id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: {
              name: call.name || '',
              arguments: typeof call.arguments === 'object' ? JSON.stringify(call.arguments || {}) : (call.arguments || ''),
            },
          }];
          parsed_text_tc = true;
          logDebug('TEXT_TC', JSON.stringify(delta.tool_calls).slice(0, 400));
        } catch {}
        const before = text.substring(0, tcTagBegin).trim();
        const after = tcTagEnd >= 0 ? text.substring(tcTagEnd + '</tool_call>'.length).trim() : '';
        const cleanText = (before + (after ? ' ' + after : '')).trim();
        if (cleanText) delta.content = cleanText;
      } else {
        delta.content = text;
        // 记录纯文本输出（用于诊断模型是否正确使用工具）
        if (text.length > 10) logDebug('TEXT_ONLY', text.slice(0, 200));
      }
    }
    // 思考链
    if (parsed.reasoning_content) delta.reasoning_content = parsed.reasoning_content;
    // 工具调用：SOLO 用 function_call 字段 → 转成 OpenAI 的 function（优先级高于文本解析）
    if (parsed.tool_calls && parsed.tool_calls !== 'null') {
      let tc = parsed.tool_calls;
      if (typeof tc === 'string') { try { tc = JSON.parse(tc); } catch { tc = null; } }
      // 记录上游原始 tool_calls 用于诊断空参数问题
      try { logToolCall('RAW_TC', String(tc?.[0]?.function_call?.name ?? tc?.[0]?.function?.name ?? '?'), JSON.stringify(tc)); } catch {}
      if (tc) {
        if (!Array.isArray(tc)) tc = [tc];
        delta.tool_calls = tc.map(call => {
          const fc = call.function_call || call.function;
          if (!fc) return call;
          // 清理 SOLO 专属字段（参考 cpa-multi-plugins solosse.go:395-398）
          delete fc.namespace;
          delete fc.partial_arguments;
          // 确保 arguments 始终是合法 JSON 字符串（Trae 上游有时传空值）
          let args = fc.arguments;
          if (!args || args === 'null' || args === 'undefined') {
            args = '';
          } else if (typeof args === 'object') {
            args = JSON.stringify(args);
          }
          // 清理 arguments 中的污染字段（模型偶尔混入 description/namespace 等元数据）
          if (args && typeof args === 'string' && args.includes('"description"')) {
            try {
              const parsed = JSON.parse(args);
              if (parsed && typeof parsed === 'object') {
                let changed = false;
                for (const key of ['description', 'namespace', 'partial_arguments', 'type', 'id']) {
                  if (key in parsed && typeof parsed[key] === 'string') {
                    delete parsed[key];
                    changed = true;
                  }
                }
                if (changed) args = JSON.stringify(parsed);
              }
            } catch {}
          }
          // index 必须保留：上游用它区分并行调用，丢失会把多个调用全并到 index 0
          const out = {
            index: call.index ?? 0,
            id: call.id,
            type: call.type || 'function',
            function: { name: fc.name || '', arguments: args },
          };
          return out;
        });
        // 注意：此处不能过滤无 name 的块——上游后续分片只有 arguments 没有 name，
        // 过滤掉会导致参数永远累积不完整。完整性校验交给 TraeEventNormalizer 在流末统一做。
        if (delta.tool_calls.length === 0) delete delta.tool_calls;
      }
    }
    if (Object.keys(delta).length === 0) return [];
    return [{ id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: null }] }];
  }
  // 错误事件：记录并返回错误信息
  if (event === 'error') {
    console.error(`[normalizeTraeEvent] upstream error: ${data}`);
    return [];
  }
  return [];
}

export class TraeEventNormalizer {
  constructor(model) {
    this.model = model;
    this.toolState = new Map(); // idx → { id, type, name, args }
    this.seenToolCalls = false;
    this.finished = false;
    // 文本工具调用累积缓冲：处理分片的 <|FunctionCallBegin|>...<|FunctionCallEnd|>
    this.textBuf = '';
    this.inTextToolCall = false;
  }

  /**
   * 累积 tool_call 片段，不转发。
   * 上游 SOLO 发送增量分片（先 name，再 arguments 片段），
   * 必须等到 done 事件才能产生合法的完整 tool_call。
   */
  accumulateToolCalls(tcArray) {
    for (const tc of tcArray) {
      const idx = tc.index ?? 0;
      const fc = tc.function || {};
      let state = this.toolState.get(idx);
      if (!state) {
        state = { id: null, type: 'function', name: '', args: '' };
        this.toolState.set(idx, state);
      }
      if (tc.id && !state.id) state.id = tc.id;
      if (tc.type) state.type = tc.type;
      if (fc.name && !state.name) state.name = fc.name;
      if (fc.arguments) state.args += fc.arguments;
    }
    // 不返回任何 delta — 全部缓冲到 done 再 flush
    return [];
  }

  /** 流末 flush：返回所有已累积的完整 tool_call（JSON 修复后） */
  flushToolCalls() {
    const out = [];
    for (const [idx, st] of [...this.toolState.entries()].sort((a, b) => a[0] - b[0])) {
      if (!st.name) continue;
      const args = repairJsonArgs(st.args.trim());
      if (!args) continue;
      out.push({
        index: idx,
        id: st.id || `call_${idx}`,
        type: st.type || 'function',
        function: { name: st.name, arguments: args },
      });
    }
    return out;
  }

  normalize(event, data) {
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${crypto.randomUUID()}`;

    // done 事件：flush 累积的 tool_calls + 未完成的文本缓冲
    if (event === 'done') {
      this.finished = true;
      const result = [];

      // 处理未完成的文本工具调用缓冲
      if (this.inTextToolCall && this.textBuf.length > 0) {
        const tcResult = parseTextToolCalls(this.textBuf);
        if (tcResult) {
          this.seenToolCalls = true;
          this.accumulateToolCalls(tcResult.calls);
          if (tcResult.remainder) {
            result.push({ id, object: 'chat.completion.chunk', created, model: this.model,
              choices: [{ index: 0, delta: { content: tcResult.remainder }, finish_reason: null }] });
          }
        } else {
          // 解析失败，当普通文本发出
          result.push({ id, object: 'chat.completion.chunk', created, model: this.model,
            choices: [{ index: 0, delta: { content: this.textBuf }, finish_reason: null }] });
        }
        this.textBuf = '';
        this.inTextToolCall = false;
      }

      if (this.seenToolCalls) {
        const finalCalls = this.flushToolCalls();
        if (finalCalls.length > 0) {
          result.push(
            { id, object: 'chat.completion.chunk', created, model: this.model,
              choices: [{ index: 0, delta: { tool_calls: finalCalls }, finish_reason: null }] },
            { id, object: 'chat.completion.chunk', created, model: this.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          );
          return result;
        }
      }
      let finish = 'stop';
      try { finish = JSON.parse(data).finish_reason || 'stop'; } catch {}
      result.push({ id, object: 'chat.completion.chunk', created, model: this.model,
        choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      return result;
    }

    // output 事件：累积 tool_calls，转发 content/reasoning
    if (event === 'output') {
      let parsed;
      try { parsed = JSON.parse(data); } catch { return []; }
      const chunks = [];

      // content 文本（含文本工具调用检测 + 分片累积）
      if (parsed.response) {
        let text = parsed.response;

        // 如果正在累积文本工具调用，继续缓冲
        if (this.inTextToolCall) {
          this.textBuf += text;
          const fcEnd = this.textBuf.indexOf('<|FunctionCallEnd|>');
          if (fcEnd >= 0) {
            // 完整标签出现，解析并清空缓冲
            const fullText = this.textBuf;
            this.textBuf = '';
            this.inTextToolCall = false;
            const tcResult = parseTextToolCalls(fullText);
            if (tcResult) {
              this.seenToolCalls = true;
              this.accumulateToolCalls(tcResult.calls);
              if (tcResult.remainder) {
                chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
                  choices: [{ index: 0, delta: { content: tcResult.remainder }, finish_reason: null }] });
              }
            } else {
              // 解析失败，把累积内容当普通文本发出
              chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
                choices: [{ index: 0, delta: { content: fullText }, finish_reason: null }] });
            }
          }
          // FunctionCallEnd 还没出现，继续缓冲，不转发
          return chunks;
        }

        // 非累积模式：检测 FunctionCallBegin
        const fcBegin = text.indexOf('<|FunctionCallBegin|>');
        if (fcBegin >= 0) {
          const fcEnd = text.indexOf('<|FunctionCallEnd|>');
          if (fcEnd >= 0) {
            // 完整标签在同一个 chunk 里
            const tcResult = parseTextToolCalls(text);
            if (tcResult) {
              this.seenToolCalls = true;
              this.accumulateToolCalls(tcResult.calls);
              if (tcResult.remainder) {
                chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
                  choices: [{ index: 0, delta: { content: tcResult.remainder }, finish_reason: null }] });
              }
            } else {
              chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
            }
          } else {
            // FunctionCallBegin 出现但 FunctionCallEnd 还没出现 → 开始累积
            this.inTextToolCall = true;
            this.textBuf = text;
            // FunctionCallBegin 之前的文本可以先发出
            const before = text.substring(0, fcBegin).trim();
            if (before) {
              chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
                choices: [{ index: 0, delta: { content: before }, finish_reason: null }] });
            }
          }
        } else {
          // 没有工具调用标签，正常转发
          chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        }
      }

      // reasoning
      if (parsed.reasoning_content) {
        chunks.push({ id, object: 'chat.completion.chunk', created, model: this.model,
          choices: [{ index: 0, delta: { reasoning_content: parsed.reasoning_content }, finish_reason: null }] });
      }

      // 原生 tool_calls
      if (parsed.tool_calls && parsed.tool_calls !== 'null') {
        let tc = parsed.tool_calls;
        if (typeof tc === 'string') { try { tc = JSON.parse(tc); } catch { tc = null; } }
        if (tc) {
          if (!Array.isArray(tc)) tc = [tc];
          try { logToolCall('RAW_TC', String(tc[0]?.function_call?.name ?? tc[0]?.function?.name ?? '?'), JSON.stringify(tc)); } catch {}
          // 转换 function_call → function，清理 SOLO 字段
          const normalized = tc.map(call => {
            const fc = call.function_call || call.function;
            if (!fc) return call;
            delete fc.namespace;
            delete fc.partial_arguments;
            let args = fc.arguments;
            if (!args || args === 'null' || args === 'undefined') args = '';
            else if (typeof args === 'object') args = JSON.stringify(args);
            // 清理 arguments 中的污染字段
            if (args && typeof args === 'string' && args.includes('"description"')) {
              try {
                const p = JSON.parse(args);
                if (p && typeof p === 'object') {
                  let changed = false;
                  for (const key of ['description', 'namespace', 'partial_arguments', 'type', 'id']) {
                    if (key in p && typeof p[key] === 'string') { delete p[key]; changed = true; }
                  }
                  if (changed) args = JSON.stringify(p);
                }
              } catch {}
            }
            return { index: call.index ?? 0, id: call.id, type: call.type || 'function',
              function: { name: fc.name || '', arguments: args } };
          });
          this.seenToolCalls = true;
          this.accumulateToolCalls(normalized);
          // 不转发增量 — 全部缓冲到 done 再 flush
        }
      }

      return chunks;
    }

    // token_usage / 其他事件
    if (event === 'token_usage') {
      let usage = null;
      try { const d = JSON.parse(data); usage = { prompt_tokens: d.prompt_tokens, completion_tokens: d.completion_tokens }; } catch {}
      if (!usage) return [];
      return [{ id, object: 'chat.completion.chunk', created, model: this.model,
        choices: [{ index: 0, delta: {}, finish_reason: null }], usage }];
    }

    return [];
  }
}

/** 尽力修复被流式截断的 JSON arguments */
function repairJsonArgs(raw) {
  if (!raw) return null;
  try { JSON.parse(raw); return raw; } catch {}
  let s = raw.trim();
  // 补齐未闭合的字符串
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]; if (c === '\\') { i++; continue; } if (c === '"') inStr = !inStr;
  }
  let candidate = inStr ? s + '"' : s;
  // 补齐未闭合的括号
  let depth = 0; inStr = false;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i]; if (c === '\\') { i++; continue; }
    if (c === '"') { inStr = !inStr; continue; } if (inStr) continue;
    if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') depth--;
  }
  for (let i = 0; i < depth; i++) candidate += '}';
  try {
    const p = JSON.parse(candidate);
    if (p && typeof p === 'object' && Object.keys(p).length > 0) return JSON.stringify(p);
  } catch {}
  // 二次：去悬空逗号/冒号
  let c2 = candidate.replace(/,\s*$/, '');
  if (/:\s*$/.test(c2)) c2 = c2.replace(/:\s*$/, '').replace(/,\s*$/, '').replace(/,\s*"[^"]*"?\s*$/, '');
  for (let i = 0; i < depth; i++) c2 += '}';
  try {
    const p = JSON.parse(c2);
    if (p && typeof p === 'object' && Object.keys(p).length > 0) return JSON.stringify(p);
  } catch {}
  return null;
}

/** 检测文本中的工具调用格式（DeepSeek/文本注入），返回 {calls, remainder} 或 null */
function parseTextToolCalls(text) {
  // DeepSeek 原生格式
  const fcBegin = text.indexOf('<|FunctionCallBegin|>');
  if (fcBegin >= 0) {
    const fcEnd = text.indexOf('<|FunctionCallEnd|>');
    const endPos = fcEnd >= 0 ? fcEnd + '<|FunctionCallEnd|>'.length : text.length;
    const jsonStr = text.substring(fcBegin + '<|FunctionCallBegin|>'.length, fcEnd >= 0 ? fcEnd : undefined).trim();
    try {
      let calls = JSON.parse(jsonStr);
      if (!Array.isArray(calls)) calls = [calls];
      const remainder = (text.substring(0, fcBegin) + ' ' + text.substring(endPos)).trim();
      return {
        calls: calls.map((c, i) => ({
          index: i, id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: { name: c.name || c.function || '', arguments: typeof c.parameters === 'object' ? JSON.stringify(c.parameters || {}) : (c.arguments || c.parameters || '') },
        })),
        remainder,
      };
    } catch {
      // JSON 解析失败 → 尝试从畸形 JSON 中提取工具名
      const remainder = (text.substring(0, fcBegin) + ' ' + text.substring(endPos)).trim();
      // 正则匹配 "name":"tool-name" 或 "name": "tool-name" 模式
      const nameMatch = jsonStr.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch && nameMatch[1]) {
        return {
          calls: [{
            index: 0, id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name: nameMatch[1], arguments: '{}' },
          }],
          remainder,
        };
      }
      // 纯文本工具名（如 agent-skills:code-review）
      if (jsonStr.length > 0 && jsonStr.length < 200) {
        return {
          calls: [{
            index: 0, id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name: jsonStr, arguments: '{}' },
          }],
          remainder,
        };
      }
    }
  }
  // 文本注入格式
  const tcBegin = text.indexOf('<tool_call>');
  if (tcBegin >= 0) {
    const tcEnd = text.indexOf('</tool_call>');
    const endPos = tcEnd >= 0 ? tcEnd + '</tool_call>'.length : text.length;
    const jsonStr = text.substring(tcBegin + '<tool_call>'.length, tcEnd >= 0 ? tcEnd : undefined);
    try {
      const call = JSON.parse(jsonStr.trim());
      const remainder = (text.substring(0, tcBegin) + ' ' + text.substring(endPos)).trim();
      return {
        calls: [{
          index: 0, id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: { name: call.name || '', arguments: typeof call.arguments === 'object' ? JSON.stringify(call.arguments || {}) : (call.arguments || '') },
        }],
        remainder,
      };
    } catch {}
  }
  return null;
}

/** tc AES-128-CBC + SHA-512 完整性 解密 Trae 的单个加密值 */
export function decryptTc(base64Value) {
  const buf = Buffer.from(base64Value, 'base64');
  const header = buf.subarray(0, 6);
  const randomBytes = buf.subarray(6, 38);
  const encrypted = buf.subarray(38);
  const isPrivate = header[0] === 18 && header[1] === 57; // AES_PRIVATE
  const salt = isPrivate ? xorSalts(SALT_C, SALT_D, 64) : xorSalts(SALT_A, SALT_B, 64);
  const h1 = crypto.createHash('sha512').update(randomBytes).digest();
  const h2 = crypto.createHash('sha512').update(Buffer.concat([h1, salt])).digest();
  const key = h2.subarray(0, 16);
  const iv = h2.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const storedHash = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const computed = crypto.createHash('sha512').update(plaintext).digest();
  if (!storedHash.equals(computed)) throw new Error('Trae CN tc 完整性校验失败');
  return plaintext.toString('utf8');
}

/** 读取 Trae CN 本地登录凭据（tc 解密），返回 { token, refreshToken, userId } */
function readStorageAuth() {
  const storage = JSON.parse(fs.readFileSync(storagePath(), 'utf8'));
  const blob = storage['iCubeAuthInfo://icube.cloudide'];
  if (!blob) throw new Error('Trae CN storage.json 缺少 iCubeAuthInfo，请先登录 Trae CN IDE');
  if (blob.trim().startsWith('{')) return JSON.parse(blob); // 明文分支（SG 版）
  return JSON.parse(decryptTc(blob));
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;

function isRetryable(err) {
  const m = err?.message || '';
  if (m.includes('timeout') || m.includes('ECONNRESET') || m.includes('ETIMEDOUT')) return true;
  for (const code of RETRYABLE) {
    if (m.includes(`upstream ${code}`)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export class TraeCnAdapter {
  constructor(options = {}) {
    this.id = 'traecn';
    this.upstream = options.upstream || UPSTREAM_BASE_CN;
    this.timeoutMs = options.timeoutMs || 180000; // 3min — 复杂推理需要更长
    this.cache = new CredentialsCache();
    this.debug = options.debug !== undefined ? options.debug : debugEnabled();
  }

  log(label, ...args) {
    if (this.debug) console.error(`[traecn][${label}]`, ...args);
  }

  async getAuth() {
    return this.cache.get('auth', async () => {
      const a = await readStorageAuth();
      return { value: a, expiresAt: Date.now() + 10 * 60 * 1000 };
    });
  }

  async refreshAuth() {
    this.cache.invalidate('auth');
    return this.getAuth();
  }

  registerModels() {
    return MODELS.map((m) => ({ externalId: `traecn-${m}`, upstreamId: m }));
  }

  async chat(reqBody, emit) {
    const { token, userId } = await this.getAuth();
    const machineId = crypto.randomBytes(16).toString('hex');
    const headers = {
      Authorization: `Cloud-IDE-JWT ${token}`,
      'X-Cloudide-Token': token,
      'x-uid': userId || '',
      'x-app-id': X_APP_ID,
      'x-device-id': crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32),
      'x-machine-id': machineId,
      'x-request-id': crypto.randomUUID(),
      'x-ide-version': IDE_VERSION_CN,
      'x-ide-version-code': IDE_VERSION_CODE_CN,
      'x-device-type': 'windows',
      'x-os-version': 'Windows 10',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const body = {
      messages: (reqBody.messages || []).map((m) => {
        const role = m.role === 'developer' ? 'system' : m.role;
        // tool 角色消息：content 转为数组格式（与参考实现对齐），保留 tool_call_id
        if (role === 'tool') {
          const out = { role, content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content };
          if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
          return out;
        }
        // assistant 消息带 tool_calls：OpenAI function → Trae function_call（含 index）
        if (m.tool_calls) {
          const tcs = m.tool_calls
            .map((tc, i) => {
              const fn = tc.function;
              if (!fn) return null;
              if (!fn.name?.trim()) return null;
              let args = fn.arguments;
              if (typeof args !== 'string') args = JSON.stringify(args ?? {});
              return {
                index: i,
                id: tc.id || '',
                type: tc.type || 'function',
                function_call: { name: fn.name, arguments: args },
              };
            })
            .filter(Boolean);
          const out = { role, content: m.content == null ? null : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content) };
          if (tcs.length > 0) out.tool_calls = tcs;
          return out;
        }
        return {
          role,
          content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
        };
      }),
      model: normalizeModel(reqBody.model),
      config_name: normalizeModel(reqBody.model),
      function: 'chat_v3',
      stream: true,
      request_id: crypto.randomUUID(),
    };
    if (reqBody.max_tokens) body.max_tokens = reqBody.max_tokens;
    // tools 处理：不支持原生 function calling 的模型走文本注入
    if (reqBody.tools?.length > 0 && needsTextTools(reqBody.model)) {
      const injected = injectTools({ ...reqBody, messages: body.messages });
      body.messages = injected.messages;
    } else if (reqBody.tools) {
      // 原生工具支持：与参考实现对齐——parameters → JSON 字符串，description 保留
      body.tools = reqBody.tools
        .filter(t => t.type === 'function' && t.function)
        .map(t => {
          const fn = t.function;
          const out = {
            type: 'function',
            function: {
              name: fn.name,
              description: fn.description || '',
            },
          };
          if (fn.parameters !== undefined) {
            out.function.parameters = typeof fn.parameters === 'string'
              ? fn.parameters
              : JSON.stringify(fn.parameters);
          }
          return out;
        })
        .filter(t => t.function.name?.trim());
      if (body.tools.length === 0) {
        delete body.tools;
      } else if (reqBody.tool_choice) {
        // 客户端显式指定 tool_choice：归一化后透传
        const tc = reqBody.tool_choice;
        if (typeof tc === 'string') {
          if (tc.toLowerCase() === 'none') delete body.tools;
          else body.tool_choice = tc;
        } else if (typeof tc === 'object') {
          const typ = (tc.type || '').toLowerCase();
          if (typ === 'none') delete body.tools;
          else if (typ === 'auto' || typ === 'required') body.tool_choice = typ;
          else if (typ === 'function' && tc.function?.name) body.tool_choice = tc.function.name;
        }
      }
      // 客户端未指定 tool_choice 时不添加（与 Go 参考对齐）
    }

    const bodyStr = JSON.stringify(body);
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        try { await this.refreshAuth(); const a = await this.getAuth(); headers.Authorization = `Cloud-IDE-JWT ${a.token}`; headers['X-Cloudide-Token'] = a.token; } catch {}
        await sleep(1000 * attempt);
      }
      for (const ep of CHAT_ENDPOINTS) {
        try {
          this.log('upstream', `-> ${ep} (attempt ${attempt})`);
          const normalizer = new TraeEventNormalizer(reqBody.model);
          await postStreamingTraeSSE(`${this.upstream}${ep}`, headers, bodyStr, this.timeoutMs, reqBody.model, (ev, d, _m) => normalizer.normalize(ev, d), emit);
          return; // 成功
        } catch (e) {
          this.log('upstream', `!! ${ep} ${e.message}`);
          lastErr = e;
          if (e.message.includes('401') || e.message.includes('403')) {
            // 认证错误：刷新后重试整个端点列表
            break;
          }
        }
      }
      // 非可重试错误，提前退出
      if (!isRetryable(lastErr)) break;
    }
    throw lastErr || new Error('Trae CN 所有上游端点均失败');
  }

  /** Trae 签到 API 通用调用 */
  async _ugRequest(path) {
    const { token } = await this.getAuth();
    const url = `https://api.trae.cn${path}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `Trae/${IDE_VERSION}`,
      Authorization: `Cloud-IDE-JWT ${token}`,
      'X-User-Region': 'CN',
    };
    return postJsonBuffer(url, headers, {}, this.timeoutMs || 180000);
  }

  async checkinStatus() {
    const res = await this._ugRequest('/trae/api/v2/ug/checkin_credits/status');
    if (res.status >= 400) throw new Error(`checkinStatus ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body);
  }

  async checkinClaim() {
    const res = await this._ugRequest('/trae/api/v2/ug/checkin_credits/claim');
    if (res.status >= 400) throw new Error(`checkinClaim ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body);
  }

  async entUsage() {
    const res = await this._ugRequest('/trae/api/v2/pay/ide_user_ent_usage');
    if (res.status >= 400) throw new Error(`entUsage ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body);
  }
}
