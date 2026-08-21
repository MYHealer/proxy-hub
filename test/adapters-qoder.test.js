import test from 'node:test';
import assert from 'node:assert/strict';
import { QoderAdapter, parseCliDelta } from '../adapters/qoder.js';

test('qoder registerModels has qoder- prefixed ids', () => {
  const ad = new QoderAdapter();
  const models = ad.registerModels();
  assert.ok(models.some((m) => m.externalId === 'qoder-qwen3.7-max'));
  assert.ok(models.every((m) => m.externalId.startsWith('qoder-') && !m.externalId.includes('/')));
});

test('parseCliDelta extracts text from assistant record', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
  assert.equal(parseCliDelta(line), 'hello');
});

test('parseCliDelta returns null for non-text or done', () => {
  assert.equal(parseCliDelta(JSON.stringify({ type: 'done' })), null);
  assert.equal(parseCliDelta(JSON.stringify({ type: 'assistant', message: { content: [] } })), null);
});
