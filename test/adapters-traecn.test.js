import test from 'node:test';
import assert from 'node:assert/strict';
import { TraeCnAdapter, normalizeTraeEvent } from '../adapters/traecn.js';

test('traecn registerModels has traecn- prefixed ids without slash', () => {
  const ad = new TraeCnAdapter();
  const models = ad.registerModels();
  assert.ok(models.some((m) => m.externalId === 'traecn-glm-5.2'));
  assert.ok(models.every((m) => m.externalId.startsWith('traecn-') && !m.externalId.includes('/')));
});

test('normalizeTraeEvent maps output event to chunk', () => {
  const chunks = normalizeTraeEvent('output', JSON.stringify({ response: 'hi', reasoning_content: '' }), 'traecn-glm-5.2');
  assert.equal(chunks[0].choices[0].delta.content, 'hi');
});

test('normalizeTraeEvent maps done event to finish chunk', () => {
  const chunks = normalizeTraeEvent('done', JSON.stringify({ finish_reason: 'stop' }), 'traecn-glm-5.2');
  assert.equal(chunks[0].choices[0].finish_reason, 'stop');
});
