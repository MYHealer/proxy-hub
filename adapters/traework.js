import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { CredentialsCache } from '../credentials.js';
import { decryptTc, traeStoragePath, normalizeTraeEvent, TraeEventNormalizer } from './traecn.js';
import { postStreamingTraeSSE } from '../sse.js';
import { needsTextTools, injectTools } from '../tool-compat.js';

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
  for (const code of RETRYABLE) {
    if (m.includes(`upstream ${code}`)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  async chat(reqBody, emit) {
    const { token, userId } = await this.getAuth();
    const machineId = crypto.randomBytes(16).toString('hex');
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': `Trae/${IDE_VERSION}`,
      Authorization: `Cloud-IDE-JWT ${token}`,
      'X-Cloudide-Token': token,
      'X-Ide-Token': token,
      'X-Uid': userId || '',
      'X-App-Id': X_APP_ID,
      'X-App-Version': 'default',
      'X-App-Version-Code': IDE_VERSION_CODE,
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
    const body = {
      messages: (reqBody.messages || []).map((m) => {
        // developer → system（上游只接受 system/assistant/user/tool）
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
          const out = { role, content: m.content ?? null };
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
    // 仅在 work credits 模式下添加会话字段（与参考实现对齐）
    // session_id / conversation_id 使用 '6a' + hex(21) 格式
    const hex21 = crypto.randomBytes(11).toString('hex').slice(0, 21);
    body.session_id = '6a' + hex21;
    body.conversation_id = '6a' + crypto.randomBytes(11).toString('hex').slice(0, 21);
    body.user_input = extractUserInput(reqBody.messages);
    body.access_type = 1;
    body.metadata = { is_remote_req: false };
    body.request_seq = 1;
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
      } else {
        // 客户端未指定 → 用 auto 让模型自由选择文本/工具。
        // 注意：不能用 'required'——强制调工具会让模型在本该输出文本时
        // 编造空参数的 tool_call，导致 "required parameter missing" 报错。
        body.tool_choice = 'auto';
      }
    }

    const bodyStr = JSON.stringify(body);
    // 诊断日志：记录实际发给上游的请求
    const _toolNames = (body.tools || []).slice(0, 5).map(t => t.function?.name || '?').join(',');
    const _toolTotal = body.tools?.length || 0;
    console.error(`[traework] UPSTREAM: ${bodyStr.length}B, tools=${_toolTotal}(${_toolNames}...), function=${body.function}, msgs=${body.messages?.length}`);
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        try { await this.refreshAuth(); const a = await this.getAuth(); headers.Authorization = `Cloud-IDE-JWT ${a.token}`; headers['X-Cloudide-Token'] = a.token; } catch {}
        await sleep(1000 * attempt);
      }
      for (const ep of CHAT_ENDPOINTS) {
        try {
          const normalizer = new TraeEventNormalizer(reqBody.model);
          await postStreamingTraeSSE(`${this.upstream}${ep}`, headers, bodyStr, this.timeoutMs, reqBody.model, (ev, d, _m) => normalizer.normalize(ev, d), emit);
          return; // 成功
        } catch (e) {
          lastErr = e;
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
}

/** 标记认证失败的信号错误（用于触发一次自动刷新重试） */
class TraeAuthError extends Error {
  constructor() { super('TraeWork auth expired'); this.code = 'TRAE_AUTH'; }
}

export { SOLO_CLIENT_ID, CHAT_FUNCTION, MODELS };
