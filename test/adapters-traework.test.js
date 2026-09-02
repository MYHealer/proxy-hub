import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../registry.js';
import { normalizeTraeEvent, traeStoragePath, decryptTc } from '../adapters/traecn.js';
import { TraeWorkAdapter, SOLO_CLIENT_ID, CHAT_FUNCTION, MODELS } from '../adapters/traework.js';
import { AUTH_KEY } from '../adapters/traework.js';

test('traework registerModels uses traework- prefix without slash', () => {
  const ad = new TraeWorkAdapter();
  const models = ad.registerModels();
  assert.ok(models.some((m) => m.externalId === 'traework-glm-5.2'));
  assert.ok(models.every((m) => m.externalId.startsWith('traework-') && !m.externalId.includes('/')));
});

test('traework id is "traework" and default storage points to TRAE SOLO CN', () => {
  const ad = new TraeWorkAdapter();
  assert.equal(ad.id, 'traework');
  assert.ok(ad.storageFile.includes('TRAE SOLO CN'));
  assert.equal(traeStoragePath('TRAE SOLO CN'), ad.storageFile);
});

test('traework uses SOLO client id + chat_v3 function', () => {
  assert.equal(SOLO_CLIENT_ID, 'en1oxy7wnw8j9n');
  assert.equal(CHAT_FUNCTION, 'chat_v3');
  assert.ok(MODELS.length > 0);
});

test('traework SSE 复用 normalizeTraeEvent（output→chunk, done→finish）', () => {
  const out = normalizeTraeEvent('output', JSON.stringify({ response: 'hello' }), 'traework-glm-5.2');
  assert.equal(out[0].choices[0].delta.content, 'hello');
  const done = normalizeTraeEvent('done', JSON.stringify({ finish_reason: 'stop' }), 'traework-glm-5.2');
  assert.equal(done[0].choices[0].finish_reason, 'stop');
});

test('traework registers into Registry and resolves with correct model', () => {
  const reg = new Registry();
  reg.register(new TraeWorkAdapter());
  const resolved = reg.resolveModel('traework-glm-5.2');
  assert.ok(resolved);
  assert.equal(resolved.adapter.id, 'traework');
  assert.equal(resolved.upstreamId, 'glm-5.2');
  assert.ok(reg.listModels().some((m) => m.id === 'traework-glm-5.2' && m.owned_by === 'traework'));
});

test('traework missing credential file fails fast with clear error', async () => {
  const tmp = path.join(os.tmpdir(), `proxy-hub-traework-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const storageFile = path.join(tmp, 'storage.json');
  const ad = new TraeWorkAdapter({ storageFile });
  await assert.rejects(() => ad.getAuth(), /ENOENT|storage/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('traework decryptTc is the shared tc algorithm (throws on garbage)', () => {
  // 非法/未加密内容必须在解密阶段抛错（Fail Fast），绝不静默放行
  assert.throws(() => decryptTc(Buffer.from('not-a-valid-tc-blob').toString('base64')));
});

test('traework refreshAuth without refreshToken falls back to disk reload', async () => {
  const tmp = path.join(os.tmpdir(), `proxy-hub-traework-rf-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const storageFile = path.join(tmp, 'storage.json');
  // 明文 auth、无 refreshToken -> refreshAuth 应回退重读磁盘，而非走 ExchangeToken 网络
  fs.writeFileSync(storageFile, JSON.stringify({ [AUTH_KEY]: JSON.stringify({ token: 'disk-token', userId: 'u1' }) }));
  const ad = new TraeWorkAdapter({ storageFile });
  const fresh = await ad.refreshAuth();
  assert.equal(fresh.token, 'disk-token');
  assert.equal(fresh.userId, 'u1');
  assert.equal(ad.cache.has('auth'), true); // 重读结果已写回缓存
  fs.rmSync(tmp, { recursive: true, force: true });
});
