import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker } from '../usage.js';

test('record accumulates requests and tokens per adapter/model', () => {
  const t = new UsageTracker();
  t.record('codebuddy', 'glm-5.2', { prompt_tokens: 10, completion_tokens: 20 });
  t.record('codebuddy', 'glm-5.2', { prompt_tokens: 5, completion_tokens: 30 });
  const s = t.summary();
  const cb = s.byAdapter.codebuddy;
  assert.equal(cb.requests, 2);
  assert.equal(cb.promptTokens, 15);
  assert.equal(cb.completionTokens, 50);
});

test('record estimates tokens when usage missing', () => {
  const t = new UsageTracker();
  t.record('traecn', 'glm-5.2', { content: '12345678' });
  const s = t.summary();
  assert.equal(s.byAdapter.traecn.promptTokens, 2); // chars/4
});

test('summary groups by day', () => {
  const t = new UsageTracker();
  t.record('qoder', 'qwen', { content: 'x' });
  const s = t.summary();
  assert.ok(s.byDay.length >= 1);
  assert.equal(typeof s.byDay[0].date, 'string');
});
