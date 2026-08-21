import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { CredentialsCache } from '../credentials.js';
import { decryptTc, traeStoragePath, normalizeTraeEvent } from './traecn.js';

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
const IDE_VERSION = '3.3.67';
const IDE_VERSION_CODE = '20260401';
const CHAT_FUNCTION = 'solo_work_lite';
const SOLO_CLIENT_ID = 'en1oxy7wnw8j9n';
const PRODUCT_DIR = 'TRAE SOLO CN';
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
export { AUTH_KEY };

const MODELS = ['glm-5.2', 'glm-5.1', 'glm-5', 'qwen-3.7-plus', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash'];

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

function parseTraeSse(res, model, emit) {
  if (res.status >= 400) throw new Error(`TraeWork upstream ${res.status}: ${res.body.slice(0, 200)}`);
  let currentEvent = '';
  for (const raw of res.body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      for (const chunk of normalizeTraeEvent(currentEvent, data, model)) emit(chunk);
    }
  }
}

export class TraeWorkAdapter {
  constructor(options = {}) {
    this.id = 'traework';
    this.upstream = options.upstream || UPSTREAM_BASE;
    this.authHost = options.authHost || AUTH_BASE;
    this.timeoutMs = options.timeoutMs || 120000;
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
    return MODELS.map((m) => ({ externalId: `traework-${m}`, upstreamId: m }));
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
      'x-ide-version': IDE_VERSION,
      'x-ide-version-code': IDE_VERSION_CODE,
      'x-device-type': 'windows',
      'x-os-version': 'Windows 10',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const body = {
      messages: (reqBody.messages || []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
      })),
      model: reqBody.model,
      function: CHAT_FUNCTION,
      stream: true,
      request_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
    };
    if (reqBody.max_tokens) body.max_tokens = reqBody.max_tokens;

    let lastErr = null;
    for (const ep of CHAT_ENDPOINTS) {
      try {
        const res = await postJsonBuffer(`${this.upstream}${ep}`, headers, body, this.timeoutMs);
        if (res.status === 401 || res.status === 403) lastErr = new TraeAuthError();
        parseTraeSse(res, reqBody.model, emit);
        return;
      } catch (e) { lastErr = e; }
    }
    if (lastErr instanceof TraeAuthError) {
      await this.refreshAuth(); // 持久刷新已自动换新 token
      const fresh = await this.getAuth();
      headers.Authorization = `Cloud-IDE-JWT ${fresh.token}`;
      headers['X-Cloudide-Token'] = fresh.token;
      for (const ep of CHAT_ENDPOINTS) {
        try {
          const res = await postJsonBuffer(`${this.upstream}${ep}`, headers, body, this.timeoutMs);
          parseTraeSse(res, reqBody.model, emit);
          return;
        } catch (e2) { lastErr = e2; }
      }
    }
    throw lastErr || new Error('TraeWork 所有上游端点均失败');
  }
}

/** 标记认证失败的信号错误（用于触发一次自动刷新重试） */
class TraeAuthError extends Error {
  constructor() { super('TraeWork auth expired'); this.code = 'TRAE_AUTH'; }
}

export { SOLO_CLIENT_ID, CHAT_FUNCTION, MODELS };
