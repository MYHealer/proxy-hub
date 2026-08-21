#!/usr/bin/env node
import http from 'node:http';
import { loadConfig } from './config.js';
import { Registry } from './registry.js';
import { createSseResponse, collectNonStreaming } from './sse.js';
import { CodeBuddyAdapter } from './adapters/codebuddy.js';
import { TraeCnAdapter } from './adapters/traecn.js';
import { QoderAdapter } from './adapters/qoder.js';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorize(config, req) {
  if (!config.proxyKey) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${config.proxyKey}` || h === `x-api-key ${config.proxyKey}`;
}

/** 注册启用的适配器，返回已注册实例数组（供 /status 探测） */
export function registerAdapters(registry, config) {
  const instances = [];
  if (config.adapters.codebuddy) instances.push(new CodeBuddyAdapter());
  if (config.adapters.traecn) instances.push(new TraeCnAdapter());
  if (config.adapters.qoder) instances.push(new QoderAdapter());
  for (const ad of instances) registry.register(ad);
  return instances;
}

/** 探测单个适配器是否就绪（Fail Fast：凭据缺失时报告原因而非抛崩） */
async function probeAdapter(adapter) {
  try {
    const auth = await adapter.getAuth();
    const hasCred = Boolean(auth?.token || auth?.userId || auth?.oauth || auth?.pat || auth?.uid);
    return { id: adapter.id, ready: hasCred, detail: hasCred ? 'ok' : 'auth shape missing' };
  } catch (e) {
    return { id: adapter.id, ready: false, detail: e.message };
  }
}

/** 返回 http handler（不含 listen，便于测试）。usage/adapters 为可选扩展点（Task 10 注入）。 */
export function buildHandler({ config, registry, usage, adapters }) {
  if (!registry) throw new Error('buildHandler requires registry');
  const instances = adapters || registerAdapters(registry, config);

  return (req, res) => {
    const pathname = new URL(req.url, `http://127.0.0.1:${config.port}`).pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (!authorize(config, req)) {
      return sendJson(res, 401, { error: { message: 'Unauthorized: missing or bad proxy key' } });
    }
    if (req.method === 'GET' && pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: registry.listModels() });
    }
    if (req.method === 'GET' && pathname === '/usage') {
      return sendJson(res, 200, usage ? usage.summary() : { message: 'usage tracking disabled' });
    }
    if (req.method === 'GET' && pathname === '/status') {
      return Promise.all(instances.map((a) => probeAdapter(a)))
        .then((s) => sendJson(res, 200, { adapters: s }));
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      return handleChat(req, res, registry, config, usage);
    }
    return sendJson(res, 404, { error: { message: `Not Found: ${pathname}` } });
  };
}

function handleChat(req, res, registry, config, usage) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    }
    const model = body.model || 'auto';
    const resolved = registry.resolveModel(model);
    if (!resolved) {
      const ids = registry.listModels().map((m) => m.id);
      return sendJson(res, 404, { error: { message: `Unknown model: ${model}. Available: ${ids.join(', ')}` } });
    }
    const { adapter, upstreamId } = resolved;
    const upstreamBody = { ...body, model: upstreamId, stream: true };
    try {
      await adapter.getAuth();
    } catch (e) {
      return sendJson(res, 401, { error: { message: `Adapter ${adapter.id} auth failed: ${e.message}` } });
    }
    if (body.stream === true) {
      return createSseResponse(res, (emit) => adapter.chat(upstreamBody, emit));
    }
    try {
      const result = await collectNonStreaming(adapter, upstreamBody);
      if (usage) usage.record(adapter.id, upstreamId, result.usage);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 502, { error: { message: `Upstream failed: ${e.message}` } });
    }
  });
}

export function main() {
  const config = loadConfig();
  const registry = new Registry();
  const handler = buildHandler({ config, registry });
  const server = http.createServer(handler);
  server.timeout = config.timeoutMs;
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`proxy-hub listening on http://127.0.0.1:${config.port}`);
  });
}

// 仅直接运行时启动；被测试引用时不自动监听
if (process.argv[1] && process.argv[1].includes('index.js')) {
  main();
}
