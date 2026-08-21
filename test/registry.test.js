import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../registry.js';
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
