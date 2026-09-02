import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialsCache } from '../credentials.js';
import { postStreamingSSE } from '../sse.js';

const UPSTREAM_BASE = 'https://copilot.tencent.com/v2';

// 兼容 CodeBuddy CLI 与 WorkBuddy 桌面端两种登录凭据文件
const AUTH_FILES = (() => {
  const local =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local');
  return [
    path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'),
  ];
})();

// 固定请求头：模拟 CLI 客户端身份，让上游认为是合法 CodeBuddy CLI 请求
const FIXED_HEADERS = {
  'X-Domain': 'www.codebuddy.cn',
  'X-Product': 'SaaS',
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-IDE-Version': '2.136.0',
  'User-Agent': 'CLI/2.136.0 CodeBuddy/2.136.0',
  'X-Requested-With': 'XMLHttpRequest',
  'x-codebuddy-request': '1',
  'X-Agent-Intent': 'craft',
  'X-Agent-Purpose': 'conversation',
  'X-Private-Data': 'false',
};

const MODELS = [
  'deepseek-v4-pro', 'deepseek-v4-flash', 'minimax-m3', 'minimax-m2.7',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  'kimi-k3-1', 'kimi-k2.7', 'kimi-k2.6', 'hy4-preview', 'hy3',
];

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

export class CodeBuddyAdapter {
  constructor() {
    this.id = 'codebuddy';
    this.cache = new CredentialsCache();
    this.timeoutMs = 180000; // 3min — 复杂推理可能很慢
  }

  async getAuth() {
    return this.cache.get('auth', async () => {
      for (const file of AUTH_FILES) {
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (data?.auth?.accessToken && data?.account?.uid) {
            return { value: { token: data.auth.accessToken, uid: String(data.account.uid) }, expiresAt: Date.now() + 5 * 60 * 1000 };
          }
        } catch {
          // 文件不存在或解析失败，尝试下一个
        }
      }
      throw new Error('未找到 CodeBuddy/WorkBuddy 登录凭据，请先登录 WorkBuddy 桌面端');
    });
  }

  async refreshAuth() {
    this.cache.invalidate('auth');
    return this.getAuth();
  }

  registerModels() {
    return MODELS.map((m) => ({ externalId: `codebuddy-${m}`, upstreamId: m }));
  }

  async chat(reqBody, emit) {
    const { token, uid } = await this.getAuth();
    const headers = {
      ...FIXED_HEADERS,
      Authorization: `Bearer ${token}`,
      'X-User-Id': uid,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const bodyStr = JSON.stringify(reqBody);
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // 重试前刷新凭据 + backoff
        try { await this.refreshAuth(); const a = await this.getAuth(); headers.Authorization = `Bearer ${a.token}`; } catch {}
        await sleep(1000 * attempt);
      }
      try {
        await postStreamingSSE(`${UPSTREAM_BASE}/chat/completions`, headers, bodyStr, this.timeoutMs, emit);
        return; // 成功
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt >= MAX_RETRIES) break;
      }
    }
    throw lastErr || new Error('CodeBuddy upstream failed');
  }
}
