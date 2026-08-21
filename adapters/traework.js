import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { CredentialsCache } from '../credentials.js';
import { decryptTc, traeStoragePath, normalizeTraeEvent } from './traecn.js';

// TraeWork 桌面版（即 TRAE SOLO 升级版）适配器。
// 与 Trae CN 共享同一套 tc 解密算法与上游主机，差异仅在：
//   1. 凭据目录：%APPDATA%\TRAE SOLO CN
//   2. chat function：solo_work_lite（轻排队，而非重排队的 chat_v3）
//   3. 刷新 OAuth ClientID：en1oxy7wnw8j9n（本适配器暂未实现刷新，仅读取）
//   4. 模型表（SOLO 池）

const UPSTREAM_BASE = 'https://trae-api-cn.mchost.guru';
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
    this.cache.invalidate('auth');
    return this.getAuth();
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
        parseTraeSse(res, reqBody.model, emit);
        return;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('TraeWork 所有上游端点均失败');
  }
}

export { SOLO_CLIENT_ID, CHAT_FUNCTION, MODELS };
