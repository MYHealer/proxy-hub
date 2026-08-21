import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, familyOf } from '../registry.js';
import { fakeAdapter } from './fixtures.js';

test('resolveModel routes by externalId prefix', () => {
  const reg = new Registry();
  const a = fakeAdapter('cb', ['deepseek-v4-pro', 'glm-5.2']);
  reg.register(a);
  const r = reg.resolveModel('cb-deepseek-v4-pro');
  assert.equal(r.adapter.id, 'cb');
  assert.equal(r.upstreamId, 'deepseek-v4-pro');
});

test('resolveModel returns null for unknown', () => {
  const reg = new Registry();
  reg.register(fakeAdapter('cb', ['glm-5.2']));
  assert.equal(reg.resolveModel('nope-x'), null);
});

test('listModels returns external models across adapters', () => {
  const reg = new Registry();
  reg.register(fakeAdapter('cb', ['glm-5.2']));
  reg.register(fakeAdapter('tr', ['glm-5.2']));
  const ids = reg.listModels().map((m) => m.id).sort();
  assert.deepEqual(ids, ['cb-glm-5.2', 'tr-glm-5.2']);
});

test('familyOf extracts family from model id', () => {
  assert.equal(familyOf('glm-5.2'), 'glm');
  assert.equal(familyOf('deepseek-v4-pro'), 'deepseek');
  assert.equal(familyOf('kimi-k2.6'), 'kimi');
  assert.equal(familyOf('hy3'), 'hy3'); // 无连字符
  assert.equal(familyOf('minimax-m3'), 'minimax');
  assert.equal(familyOf('GLM-5.2'), 'glm'); // 大小写不敏感
  assert.equal(familyOf('DeepSeek-V4-Pro'), 'deepseek');
});

test('modelMatrix groups models by family across providers', () => {
  const reg = new Registry();
  reg.register(fakeAdapter('cb', ['glm-5.2', 'deepseek-v4-pro']));
  reg.register(fakeAdapter('tr', ['glm-5.2', 'glm-5.1']));
  const m = reg.modelMatrix();
  assert.equal(m.glm.models.length, 2); // glm-5.2, glm-5.1
  assert.deepEqual(m.glm.providers.cb, ['glm-5.2']); // cb 在 glm 家族仅 glm-5.2
  assert.ok(m.glm.providers.tr.includes('glm-5.1'));
  assert.ok(m.deepseek.providers.cb.includes('deepseek-v4-pro'));
  assert.deepEqual(m.deepseek.providers.tr, undefined); // tr 无 deepseek
});
