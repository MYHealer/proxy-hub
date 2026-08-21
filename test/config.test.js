import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

test('config defaults applied', () => {
  const cfg = loadConfig();
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.proxyKey, '');
  assert.equal(cfg.adapters.codebuddy, true);
});

test('config reads env overrides', () => {
  process.env.PROXY_HUB_PORT = '9999';
  process.env.PROXY_HUB_KEY = 'secret';
  process.env.PROXY_ADAPTER_QODER = 'false';
  const cfg = loadConfig();
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.proxyKey, 'secret');
  assert.equal(cfg.adapters.qoder, false);
  delete process.env.PROXY_HUB_PORT;
  delete process.env.PROXY_HUB_KEY;
  delete process.env.PROXY_ADAPTER_QODER;
});
