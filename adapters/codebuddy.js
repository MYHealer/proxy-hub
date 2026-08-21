import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

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
  'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'kimi-k3-1', 'kimi-k2.7',
  'kimi-k2.6', 'hy3',
];

// 遍历凭据文件，返回 { token, uid }；全部缺失则抛错（Fail Fast）
function readAuth() {
  for (const file of AUTH_FILES) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.auth?.accessToken && data?.account?.uid) {
        return { token: data.auth.accessToken, uid: String(data.account.uid) };
      }
    } catch {
      // 文件不存在或解析失败，尝试下一个
    }
  }
  throw new Error('未找到 CodeBuddy/WorkBuddy 登录凭据，请先登录 WorkBuddy 桌面端');
}

function postJson(url, headers, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const data = [];
        res.on('data', (c) => data.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.write(body);
    req.end();
  });
}

export class CodeBuddyAdapter {
  constructor() {
    this.id = 'codebuddy';
  }

  async getAuth() {
    return readAuth();
  }

  async refreshAuth() {
    // WorkBuddy 桌面端会自动刷新 token 文件，重新读取即可拿到最新 token
    return readAuth();
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
    const up = await postJson(`${UPSTREAM_BASE}/chat/completions`, headers, JSON.stringify(reqBody));
    if (up.status >= 400) {
      throw new Error(`CodeBuddy upstream ${up.status}: ${up.body.slice(0, 200)}`);
    }
    // 上游为标准 OpenAI SSE：按 data: 行解析并 emit 为 chunk 对象
    const lines = up.body.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { emit(JSON.parse(payload)); } catch { /* 跳过无法解析的行 */ }
    }
  }
}
