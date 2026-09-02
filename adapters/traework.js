import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { CredentialsCache } from '../credentials.js';
import { decryptTc, traeStoragePath, normalizeTraeEvent, TraeEventNormalizer } from './traecn.js';
import { postStreamingTraeSSE } from '../sse.js';
import { injectTools } from '../tool-compat.js';

const LOG_PATH = 'C:/Users/MR/Desktop/mix_api_bridge_src/proxy-hub/debug.log';
const _debugEnabled = (() => { const v = process.env.PROXY_HUB_DEBUG; return v === '1' || v === 'true' || v === 'traework'; })();
function dbg(msg) { if (_debugEnabled) try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch {} }

// TraeWork 桌面版（即 TRAE SOLO 升级版）适配器。
// 与 Trae CN 共享同一套 tc 解密算法与上游主机，差异仅在：
//   1. 凭据目录：%APPDATA%\TRAE SOLO CN
//   2. chat function：solo_work_lite（轻排队，而非重排队的 chat_v3）
//   3. 刷新 OAuth ClientID：en1oxy7wnw8j9n（ExchangeToken 换新 token）
//   4. 模型表（SOLO 池）

const UPSTREAM_BASE = 'https://trae-api-cn.mchost.guru';
const AUTH_BASE = 'https://api.trae.cn';
const CHAT_ENDPOINTS = [
  '/api/agent/v3/llm_utils_chat',
  '/api/ide/v1/chat',
  '/api/agent/v3/create_agent_task',
];
const X_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION = '0.1.43';
const IDE_VERSION_CODE = '20260716';
const CHAT_FUNCTION = 'solo_work_lite';
const SOLO_CLIENT_ID = 'en1oxy7wnw8j9n';
const PRODUCT_DIR = 'TRAE SOLO CN';
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
export { AUTH_KEY };

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

// 动态模型缓存（1h TTL，失败负缓存 5min）
const MODELS_ENDPOINT = '/api/ide/v1/get_detail_param';
let dynamicModelsCache = { models: null, fetched: 0, lastFail: 0 };
const MODELS_TTL = 60 * 60 * 1000; // 1h
const MODELS_FAIL_COOLDOWN = 5 * 60 * 1000; // 5min

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;

/** 从消息数组中提取最后一条用户消息的文本 */
function extractUserInput(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const texts = c.filter(x => x && x.type === 'text' && x.text).map(x => x.text);
      if (texts.length) return texts.join('\n');
    }
  }
  return '';
}

function isRetryable(err) {
  const m = err?.message || '';
  if (m.includes('timeout') || m.includes('ECONNRESET') || m.includes('ETIMEDOUT')) return true;
  if (m.includes('SSL') || m.includes('ssl') || m.includes('alert') || m.includes('bad record mac')) return true;
  for (const code of RETRYABLE) {
    if (m.includes(`upstream ${code}`)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 回退到不支持 native tools 的端点时，清洗消息体：
 * 1. 用 injectTools() 将 tools 注入为 system prompt 文本
 * 2. assistant 消息带 tool_calls → 合并为纯文本 content
 * 3. tool 消息 → 转为 user 消息（附加工具名提示）
 */
function sanitizeForFallback(body) {
  const out = injectTools(body);
  out.messages = out.messages.map(m => {
    if (m.role === 'assistant' && m.tool_calls) {
      // assistant + tool_calls → 将调用意图转为文本
      const texts = [];
      if (m.content) {
        const c = typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : '';
        if (c) texts.push(c);
      }
      for (const tc of m.tool_calls) {
        const fn = tc.function_call || tc.function;
        if (fn?.name) texts.push(`[Called tool: ${fn.name}(${fn.arguments || '{}'})]`);
      }
      return { role: 'assistant', content: [{ type: 'text', text: texts.join('\n') }] };
    }
    if (m.role === 'tool') {
      // tool 结果 → user 消息
      const c = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : String(m.content || '');
      return { role: 'user', content: [{ type: 'text', text: `[Tool result]\n${c}` }] };
    }
    return m;
  });
  return out;
}

/** 读取 TraeWork/SOLO CN 本地凭据（与 Trae CN 相同的 tc 解密），返回 { token, refreshToken, userId } */
function readStorageAuth(storageFile, authKey) {
  const storage = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  const blob = storage[authKey];
  if (!blob) throw new Error(`storage.json 缺少 ${authKey}，请先登录 TraeWork 桌面端`);
  if (blob.trim().startsWith('{')) return JSON.parse(blob); // 明文分支（国际版 SG）
  return JSON.parse(decryptTc(blob));
}

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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('traework timeout')));
    req.write(buf);
    req.end();
  });
}

export class TraeWorkAdapter {
  constructor(options = {}) {
    this.id = 'traework';
    this.upstream = options.upstream || UPSTREAM_BASE;
    this.authHost = options.authHost || AUTH_BASE;
    this.timeoutMs = options.timeoutMs || 180000; // 3min
    this.storageFile = options.storageFile || traeStoragePath(PRODUCT_DIR);
    this.authKey = options.authKey || AUTH_KEY;
    this.cache = new CredentialsCache();
  }

  async getAuth() {
    return this.cache.get('auth', async () => {
      const a = readStorageAuth(this.storageFile, this.authKey);
      return { value: a, expiresAt: Date.now() + 10 * 60 * 1000 };
    });
  }

  async refreshAuth() {
    const current = await this.getAuth();
    // 上游未提供 refreshToken 时退回重读磁盘（桌面端若在线会更新文件）
    if (!current?.refreshToken) {
      this.cache.invalidate('auth');
      return this.getAuth();
    }
    // 持久刷新：用 refreshToken 调 ExchangeToken 换新 token，写回内存缓存
    const fresh = await this.exchangeToken(current.refreshToken, current.userId);
    this.cache.set('auth', { value: fresh, expiresAt: Date.now() + 50 * 60 * 1000 });
    return fresh;
  }

  /** 调用 Trae OAuth ExchangeToken，用 refreshToken 换新 token（SOLO CN ClientID） */
  async exchangeToken(refreshToken, userId) {
    const url = `${this.authHost}/cloudide/api/v3/trae/oauth/ExchangeToken`;
    const res = await postJsonBuffer(
      url,
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      { ClientID: SOLO_CLIENT_ID, RefreshToken: refreshToken, ClientSecret: '-', UserID: userId },
      this.timeoutMs,
    );
    if (res.status >= 400) throw new Error(`TraeWork ExchangeToken failed: ${res.status} ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    const token = data?.token || data?.access_token || data?.accessToken;
    if (!token) throw new Error(`TraeWork ExchangeToken 响应缺少 token: ${res.body.slice(0, 200)}`);
    return {
      token,
      refreshToken: data?.refreshToken || data?.refresh_token || refreshToken,
      userId: data?.userId || data?.uid || userId,
    };
  }

  registerModels() {
    // 优先返回动态缓存，回退静态列表
    const dynamic = this.getDynamicModels();
    if (dynamic.length > 0) {
      return dynamic.map((m) => ({ externalId: `traework-${m}`, upstreamId: m }));
    }
    return MODELS.map((m) => ({ externalId: `traework-${m}`, upstreamId: m }));
  }

  /** 从上游 get_detail_param 拉模型表，缓存 1h */
  getDynamicModels() {
    const now = Date.now();
    if (dynamicModelsCache.models && now - dynamicModelsCache.fetched < MODELS_TTL) {
      return dynamicModelsCache.models;
    }
    if (dynamicModelsCache.lastFail && now - dynamicModelsCache.lastFail < MODELS_FAIL_COOLDOWN) {
      return [];
    }
    // 异步拉取，同步返回缓存（首次空）
    this.fetchModels().catch(() => {});
    return dynamicModelsCache.models || [];
  }

  async fetchModels() {
    const { token } = await this.getAuth();
    const body = {
      function: CHAT_FUNCTION,
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    };
    const res = await postJsonBuffer(
      `${this.upstream}${MODELS_ENDPOINT}`,
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Cloud-IDE-JWT ${token}`,
        'X-Cloudide-Token': token,
        'X-App-Id': X_APP_ID,
        'X-Ide-Version': IDE_VERSION,
        'X-Ide-Version-Code': IDE_VERSION_CODE,
      },
      body,
      this.timeoutMs,
    );
    if (res.status >= 400) {
      dynamicModelsCache.lastFail = Date.now();
      return;
    }
    const data = JSON.parse(res.body);
    const list = data?.config_info_list || [];
    const models = list
      .map((c) => c.config_name)
      .filter((n) => n && typeof n === 'string');
    if (models.length > 0) {
      dynamicModelsCache = { models, fetched: Date.now(), lastFail: 0 };
      console.error(`[traework] 动态模型列表: ${models.join(', ')}`);
    } else {
      dynamicModelsCache.lastFail = Date.now();
    }
  }

  /**
   * 估算文本的 token 数（中英混合启发式）
   * 中文约 1.5 token/字，英文约 0.25 token/char（1 token ≈ 4 chars）
   */
  _estimateTokens(text) {
    if (!text) return 0;
    let cn = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) > 0x7f) cn++;
    }
    const en = text.length - cn;
    return Math.ceil(cn * 1.5 + en / 4);
  }

  /**
   * 获取单条消息的 token 估算值
   */
  _msgTokens(msg) {
    if (!msg) return 0;
    if (typeof msg.content === 'string') return this._estimateTokens(msg.content);
    if (Array.isArray(msg.content)) {
      return msg.content.reduce((s, c) => s + this._estimateTokens(c.text || c.content || JSON.stringify(c)), 0);
    }
    return this._estimateTokens(JSON.stringify(msg.content));
  }

  /**
   * 自动压缩对话历史：token 预算制，分层保留策略
   *
   * 优先级：user 消息（指令/代码）> assistant 消息（可压缩）> tool 消息（可丢弃）
   * 策略：
   *   1. system 始终保留
   *   2. user 消息全部保留（截断超长的），因为它们包含任务指令
   *   3. 从最新 assistant/tool 往前填充剩余预算
   *   4. 被丢弃的 assistant 消息摘要化保留在 marker 中
   */
  _compressMessages(messages, maxTurns = 15) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const TOKEN_BUDGET = 30000;
    const MAX_SINGLE_MSG = 8000;

    const systemMsgs = messages.filter(m => m.role === 'system');
    const dialogMsgs = messages.filter(m => m.role !== 'system');

    const systemTokens = systemMsgs.reduce((s, m) => s + this._msgTokens(m), 0);
    let budget = TOKEN_BUDGET - systemTokens;

    // ── Pass 1: 处理 user 消息（全部保留，截断超长的）──
    const userMsgs = [];
    let userTokens = 0;
    for (const msg of dialogMsgs) {
      if (msg.role !== 'user') continue;
      const tok = this._msgTokens(msg);
      if (tok > MAX_SINGLE_MSG) {
        const truncated = this._truncateMsgContent(msg, MAX_SINGLE_MSG);
        userMsgs.push(truncated);
        userTokens += this._msgTokens(truncated);
      } else {
        userMsgs.push(msg);
        userTokens += tok;
      }
    }

    // ── Pass 2: 从最新非 user 消息往前填充剩余预算 ──
    const nonUserMsgs = dialogMsgs.filter(m => m.role !== 'user');
    const keptNonUser = [];
    let nonUserTokens = 0;
    const remaining = budget - userTokens;

    for (let i = nonUserMsgs.length - 1; i >= 0; i--) {
      const msg = nonUserMsgs[i];
      const tok = this._msgTokens(msg);
      if (tok > MAX_SINGLE_MSG) {
        const truncated = this._truncateMsgContent(msg, MAX_SINGLE_MSG);
        const truncTok = this._msgTokens(truncated);
        if (nonUserTokens + truncTok > remaining) break;
        keptNonUser.unshift(truncated);
        nonUserTokens += truncTok;
      } else {
        if (nonUserTokens + tok > remaining) break;
        keptNonUser.unshift(msg);
        nonUserTokens += tok;
      }
    }

    const droppedNonUser = nonUserMsgs.length - keptNonUser.length;

    // ── Pass 3: 合并并按原始顺序排列 ──
    const keptSet = new Set([...userMsgs, ...keptNonUser]);
    const ordered = dialogMsgs.filter(m => keptSet.has(m));

    if (droppedNonUser > 0) {
      // 对被丢弃的 assistant 消息生成摘要
      const droppedAssistants = nonUserMsgs.filter(m => !keptNonUser.includes(m) && m.role === 'assistant');
      const summaries = droppedAssistants
        .map(m => {
          const text = typeof m.content === 'string' ? m.content : '';
          return text.slice(0, 100).replace(/\n/g, ' ');
        })
        .filter(Boolean);

      const markerText = summaries.length > 0
        ? `[Earlier ${droppedNonUser} messages compressed. Key context: ${summaries.slice(-3).join(' | ')}]`
        : `[Earlier ${droppedNonUser} messages compressed to fit context window]`;

      const marker = { role: 'user', content: markerText };
      const result = [...systemMsgs, marker, ...ordered];
      dbg(`[compress] user=${userTokens} nonUser=${nonUserTokens}/${TOKEN_BUDGET} dropped=${droppedNonUser} kept-user=${userMsgs.length} kept-other=${keptNonUser.length}`);
      return result;
    }

    return [...systemMsgs, ...ordered];
  }

  /** 截断单条消息内容到指定 token 预算 */
  _truncateMsgContent(msg, maxTokens) {
    if (this._msgTokens(msg) <= maxTokens) return msg;
    const newMsg = { ...msg };
    if (typeof newMsg.content === 'string') {
      const ratio = maxTokens / this._msgTokens(newMsg.content);
      const charLimit = Math.floor(newMsg.content.length * ratio * 0.8);
      newMsg.content = newMsg.content.slice(0, charLimit) + '\n[... truncated ...]';
    } else if (Array.isArray(newMsg.content)) {
      newMsg.content = [{ type: 'text', text: '[Long tool output truncated]' }];
    }
    return newMsg;
  }

  async chat(reqBody, emit) {
    const { token, userId } = await this.getAuth();
    const machineId = crypto.randomBytes(16).toString('hex');

    // 自动压缩对话历史（保留 system + 最近 15 轮对话）
    const compressedMessages = this._compressMessages(reqBody.messages, 15);

    const body = {
      messages: compressedMessages.map((m, idx) => {
        // developer → system（上游只接受 system/assistant/user/tool）
        const role = m.role === 'developer' ? 'system' : m.role;
        dbg(`msg[${idx}] role=${role} content=${typeof m.content === 'string' ? m.content.slice(0, 80) : typeof m.content}`);
        // system 消息：转为数组格式，不注入额外内容（与 Go 参考对齐）
        if (role === 'system') {
          const content = typeof m.content === 'string'
            ? [{ type: 'text', text: m.content }]
            : Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
          return { ...m, role, content };
        }
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
        // 普通消息：字符串 content 转为 Trae 数组格式
        return {
          role,
          content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
        };
      }),
      model: normalizeModel(reqBody.model),
      config_name: normalizeModel(reqBody.model),
      function: CHAT_FUNCTION,
      stream: true,
      request_id: crypto.randomUUID(),
    };
    // 与 Go 参考实现对齐：不设置 session_id/conversation_id，上游靠 messages 数组维持上下文
    body.user_input = extractUserInput(reqBody.messages);
    body.access_type = 1;
    body.metadata = { is_remote_req: false };
    body.request_seq = 1;
    if (reqBody.max_tokens) body.max_tokens = reqBody.max_tokens;
    // 创建 headers（与 Go 参考 SOLOHeaders 对齐，不使用 Extra 头）
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': `Trae/${IDE_VERSION}`,
      Authorization: `Cloud-IDE-JWT ${token}`,
      'X-Cloudide-Token': token,
      'X-Ide-Token': token,
      'X-Uid': userId || '',
      'X-App-Id': X_APP_ID,
      'X-Ide-Version': IDE_VERSION,
      'X-Ide-Version-Code': IDE_VERSION_CODE,
      'X-Ide-Version-Type': 'stable',
      'X-Device-Type': 'windows',
      'X-OS-Version': 'Windows 11 Pro',
      'X-Device-Brand': '83DG',
      'Request-Traffic-Type': 'prod',
      'X-Device-Id': crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32),
      'X-Machine-Id': machineId,
    };
    // tools 处理：llm_utils_chat 支持原生 tools，不需要文本注入（双保险反而让模型混乱）。
    // 文本注入只给不支持 tools 的回退端点用（但当前端点列表都是先尝试 llm_utils_chat）。
    if (reqBody.tools?.length > 0) {
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
      // 与 Go 参考对齐：客户端未指定 tool_choice 时不添加（由上游决定）
    }

    const bodyStr = JSON.stringify(body);
    const _toolNames = (body.tools || []).slice(0, 5).map(t => t.function?.name || '?').join(',');
    const _toolTotal = body.tools?.length || 0;
    console.error(`[traework] UPSTREAM: ${bodyStr.length}B, tools=${_toolTotal}(${_toolNames}...), function=${body.function}, msgs=${body.messages?.length}`);
    if (_debugEnabled) {
      const _tc = body.tool_choice ?? 'none';
      const _msgSummary = body.messages.map(m => {
        if (m.role === 'assistant' && m.tool_calls) return `assistant[${m.tool_calls.length}tc]`;
        if (m.role === 'tool') return `tool[${m.tool_call_id?.slice(0,10) ?? '?'}]`;
        return `${m.role}[${typeof m.content === 'string' ? m.content.slice(0,30) : typeof m.content}]`;
      }).join(' → ');
      const _sysMsg = body.messages.find(m => m.role === 'system');
      const _sysLen = typeof _sysMsg?.content === 'string' ? _sysMsg.content.length : Array.isArray(_sysMsg?.content) ? _sysMsg.content.reduce((a,p) => a + (p.text?.length || 0), 0) : 0;
      dbg(`UPSTREAM body: tool_choice=${_tc}, tools=${_toolTotal}, msgs=${body.messages?.length}, sysLen=${_sysLen}\n  flow: ${_msgSummary}`);
    }
    let lastErr = null;
    // 标记是否已回退过（回退后需要清洗消息体）
    let fallbackSanitized = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        try { await this.refreshAuth(); const a = await this.getAuth(); headers.Authorization = `Cloud-IDE-JWT ${a.token}`; headers['X-Cloudide-Token'] = a.token; } catch {}
        await sleep(1000 * attempt);
      }
      for (const ep of CHAT_ENDPOINTS) {
        try {
          const normalizer = new TraeEventNormalizer(reqBody.model);
          const responseBuffer = [];
          const bufferEmit = (chunk) => { responseBuffer.push(chunk); emit(chunk); };
          // 回退到非 tools 端点时，清洗消息体（剥离 tool_calls/tool results，注入文本工具）
          let curBodyStr = bodyStr;
          if (fallbackSanitized) {
            const sanitized = sanitizeForFallback(JSON.parse(bodyStr));
            curBodyStr = JSON.stringify(sanitized);
            dbg(`FALLBACK sanitized body: ${curBodyStr.length}B, msgs=${sanitized.messages?.length}`);
          }
          dbg(`CALLING upstream ${ep}...`);
          await postStreamingTraeSSE(`${this.upstream}${ep}`, headers, curBodyStr, this.timeoutMs, reqBody.model, (ev, d, _m) => {
            const chunks = normalizer.normalize(ev, d);
            dbg(`SSE event=${ev} dataLen=${d?.length ?? 0} chunks=${chunks.length}`);
            return chunks;
          }, bufferEmit);
          if (_debugEnabled) {
            const _respContent = responseBuffer.filter(c => c.choices?.[0]?.delta?.content).map(c => c.choices[0].delta.content).join('');
            const _respToolCalls = responseBuffer.filter(c => c.choices?.[0]?.delta?.tool_calls).flatMap(c => c.choices[0].delta.tool_calls).map(tc => tc.function?.name || '?').join(',');
            dbg(`UPSTREAM response (${ep}): ${responseBuffer.length} chunks, content=${_respContent.slice(0, 200)}, toolCalls=${_respToolCalls}`);
          }
          return;
        } catch (e) {
          lastErr = e;
          dbg(`ENDPOINT FAILED ${ep}: ${e.message?.slice(0, 200)}`);
          // llm_utils_chat 失败后，标记下次循环需要清洗
          if (ep === CHAT_ENDPOINTS[0]) fallbackSanitized = true;
          if (e.message.includes('401') || e.message.includes('403')) {
            // 认证错误：刷新后重试整个端点列表
            try { await this.refreshAuth(); const a = await this.getAuth(); headers.Authorization = `Cloud-IDE-JWT ${a.token}`; headers['X-Cloudide-Token'] = a.token; } catch {}
            break;
          }
        }
      }
      if (!isRetryable(lastErr)) break;
    }
    throw lastErr || new Error('TraeWork 所有上游端点均失败');
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
    return postJsonBuffer(url, headers, {}, this.timeoutMs);
  }

  /** 查询签到状态 */
  async checkinStatus() {
    const res = await this._ugRequest('/trae/api/v2/ug/checkin_credits/status');
    if (res.status >= 400) throw new Error(`checkinStatus ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body);
  }

  /** 领取签到奖励 */
  async checkinClaim() {
    const res = await this._ugRequest('/trae/api/v2/ug/checkin_credits/claim');
    if (res.status >= 400) throw new Error(`checkinClaim ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body);
  }

  /** 查询剩余额度 */
  async entUsage() {
    const res = await this._ugRequest('/trae/api/v2/pay/ide_user_ent_usage');
    if (res.status >= 400) throw new Error(`entUsage ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body);
  }
}

/** 标记认证失败的信号错误（用于触发一次自动刷新重试） */
class TraeAuthError extends Error {
  constructor() { super('TraeWork auth expired'); this.code = 'TRAE_AUTH'; }
}

export { SOLO_CLIENT_ID, CHAT_FUNCTION, MODELS };
