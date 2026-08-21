import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import { CredentialsCache } from '../credentials.js';

const UPSTREAM_BASE_CN = 'https://trae-api-cn.mchost.guru';
const CHAT_ENDPOINTS = [
  '/api/agent/v3/llm_utils_chat',
  '/api/ide/v1/chat',
  '/api/agent/v3/create_agent_task',
];
const X_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION_CN = '3.3.67';
const IDE_VERSION_CODE_CN = '20260401';

const MODELS = ['glm-5.2', 'glm-5.1', 'glm-5', 'qwen-3.7-plus', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash'];

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
    try { finish = JSON.parse(data).finish_reason || 'stop'; } catch { /* 默认 stop */ }
    return [{ id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }] }];
  }
  if (event === 'output') {
    let response = '';
    try { response = JSON.parse(data).response || ''; } catch { /* 忽略无法解析的行 */ }
    return [{ id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: response }, finish_reason: null }] }];
  }
  return [];
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('trae timeout')));
    req.write(buf);
    req.end();
  });
}

function parseTraeSse(res, model, emit, log) {
  if (res.status >= 400) throw new Error(`Trae CN upstream ${res.status}: ${res.body.slice(0, 200)}`);
  let currentEvent = '';
  for (const raw of res.body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); log?.(`sse.event`, currentEvent); continue; }
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      log?.(`sse.data`, `${currentEvent} | ${data.slice(0, 300)}`);
      const chunks = normalizeTraeEvent(currentEvent, data, model);
      if (chunks.length === 0 && currentEvent && currentEvent !== 'done') {
        // 未识别事件被丢弃——工具事件通常就藏在这里
        log?.(`sse.dropped`, `${currentEvent} | ${data.slice(0, 300)}`);
      }
      for (const chunk of chunks) emit(chunk);
    }
  }
}

export class TraeCnAdapter {
  constructor(options = {}) {
    this.id = 'traecn';
    this.upstream = options.upstream || UPSTREAM_BASE_CN;
    this.timeoutMs = options.timeoutMs || 120000;
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
      messages: (reqBody.messages || []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
      })),
      model: reqBody.model,
      function: 'inline_chat',
      stream: true,
      request_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
    };
    if (reqBody.max_tokens) body.max_tokens = reqBody.max_tokens;

    // 诊断：入站是否带工具定义/工具调用记录？出站消息结构如何？function 是否该切换？
    const msgs = reqBody.messages || [];
    this.log('inbound', JSON.stringify({
      model: reqBody.model,
      hasTools: Array.isArray(reqBody.tools) && reqBody.tools.length > 0,
      toolsCount: reqBody.tools?.length ?? 0,
      toolChoice: reqBody.tool_choice,
      roles: msgs.map((m) => m.role),
      hasToolCalls: msgs.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
    }));
    this.log('outbound', JSON.stringify({ function: body.function, messages: body.messages, stream: body.stream }));

    let lastErr = null;
    for (const ep of CHAT_ENDPOINTS) {
      try {
        this.log('upstream', `-> ${ep}`);
        const res = await postJsonBuffer(`${this.upstream}${ep}`, headers, body, this.timeoutMs);
        this.log('upstream', `<- ${ep} status ${res.status}`);
        parseTraeSse(res, reqBody.model, emit, this.log.bind(this));
        return;
      } catch (e) { this.log('upstream', `!! ${ep} ${e.message}`); lastErr = e; }
    }
    throw lastErr || new Error('Trae CN 所有上游端点均失败');
  }
}
