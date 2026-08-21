import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialsCache } from '../credentials.js';

test('get caches value until expiry', async () => {
  const cache = new CredentialsCache();
  let calls = 0;
  const loader = async () => { calls++; return { value: 'v1', expiresAt: Date.now() + 1000 }; };
  await cache.get('a', loader);
  await cache.get('a', loader);
  assert.equal(calls, 1);
});

test('get reloads after expiry', async () => {
  const cache = new CredentialsCache();
  let value = 'old';
  const loader = async () => { value = 'new'; return { value, expiresAt: Date.now() + 1000 }; };
  await cache.get('a', loader);
  await cache.get('a', loader);
  // 强制过期
  cache.set('a', { value, expiresAt: Date.now() - 1 });
  await cache.get('a', loader);
  assert.equal(value, 'new');
});

test('get dedupes in-flight loads', async () => {
  const cache = new CredentialsCache();
  let inFlight = 0; let maxInFlight = 0;
  const loader = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { value: 'v', expiresAt: Date.now() + 1000 };
  };
  await Promise.all([cache.get('a', loader), cache.get('a', loader)]);
  assert.ok(maxInFlight <= 1, `expected no concurrent loads, got ${maxInFlight}`);
});
