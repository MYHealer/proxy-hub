import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyAdapter } from '../adapters/codebuddy.js';

test('codebuddy registerModels has codebuddy- prefixed ids', () => {
  const ad = new CodeBuddyAdapter();
  const models = ad.registerModels();
  assert.ok(models.some((m) => m.externalId === 'codebuddy-deepseek-v4-pro'));
  assert.ok(models.every((m) => m.externalId.startsWith('codebuddy-') && !m.externalId.includes('/')));
});
