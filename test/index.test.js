import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../config.js';
import { Registry } from '../registry.js';
import { UsageTracker } from '../usage.js';
import { fakeAdapter } from './fixtures.js';
import { buildHandler } from '../index.js';

function rawReq(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function request(handler, method, pathname, opts = {}) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      rawReq(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then((r) => { server.close(); resolve(r); }).catch((e) => { server.close(); reject(e); });
    });
  });
}

test('GET /health returns ok', async () => {
  const reg = new Registry();
  const handler = buildHandler({ config: loadConfig(), registry: reg });
  const r = await request(handler, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.data).status === 'ok');
});

test('POST /v1/chat/completions routes to adapter and returns content', async () => {
  const reg = new Registry();
  reg.register(fakeAdapter('cb', ['deepseek-v4-pro']));
  const handler = buildHandler({ config: loadConfig(), registry: reg });
  const r = await request(handler, 'POST', '/v1/chat/completions', {
    body: { model: 'cb-deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: false },
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.data);
  assert.equal(body.choices[0].message.content, 'hi');
});

test('proxyKey auth rejects missing key', async () => {
  const reg = new Registry();
  const handler = buildHandler({ config: { ...loadConfig(), proxyKey: 'secret' }, registry: reg });
  const r = await request(handler, 'POST', '/v1/chat/completions', {
    body: { model: 'cb-x', messages: [] },
  });
  assert.equal(r.status, 401);
});

test('GET /usage returns summary after a chat', async () => {
  const reg = new Registry();
  reg.register(fakeAdapter('cb', ['deepseek-v4-pro']));
  const usage = new UsageTracker();
  const handler = buildHandler({ config: loadConfig(), registry: reg, usage, adapters: [fakeAdapter('cb', [])] });
  await request(handler, 'POST', '/v1/chat/completions', {
    body: { model: 'cb-deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: false },
  });
  const r = await request(handler, 'GET', '/usage');
  const body = JSON.parse(r.data);
  assert.equal(body.byAdapter.cb.requests, 1);
});

test('GET /status reports ready state', async () => {
  const reg = new Registry();
  const ad = fakeAdapter('cb', []);
  const handler = buildHandler({ config: loadConfig(), registry: reg, adapters: [ad] });
  const r = await request(handler, 'GET', '/status');
  const body = JSON.parse(r.data);
  assert.equal(body.adapters[0].id, 'cb');
  assert.equal(body.adapters[0].ready, true);
});
