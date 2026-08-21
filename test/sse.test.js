import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseResponse, collectNonStreaming } from '../sse.js';
import { fakeAdapter } from './fixtures.js';

function mockRes() {
  const out = { chunks: [], headers: {}, ended: false };
  return {
    out,
    writeHead(code, headers) { out.headers = { code, ...headers }; },
    write(s) { out.chunks.push(String(s)); },
    end() { out.ended = true; },
  };
}

test('createSseResponse streams chunks and [DONE]', async () => {
  const res = mockRes();
  await createSseResponse(res, async (emit) => {
    await fakeAdapter('cb', []).chat({}, emit);
  });
  assert.ok(res.out.chunks.join('').includes('data: [DONE]'));
  assert.equal(res.out.ended, true);
});

test('collectNonStreaming aggregates chunks into chat.completion', async () => {
  const ad = fakeAdapter('cb', []);
  const result = await collectNonStreaming(ad, {});
  assert.equal(result.choices[0].message.content, 'hi');
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('collectNonStreaming estimates usage when upstream returns none', async () => {
  const ad = fakeAdapter('cb', []); // fakeAdapter 不上报 usage
  const result = await collectNonStreaming(ad, { messages: [{ role: 'user', content: '12345678' }] });
  assert.ok(result.usage, 'usage should not be null');
  assert.equal(result.usage.prompt_tokens, 2); // 8 chars / 4
  assert.equal(result.usage.completion_tokens, Math.ceil('hi'.length / 4)); // 1
});

test('collectNonStreaming preserves upstream usage when present', async () => {
  const ad = fakeAdapter('cb', []);
  const origChat = ad.chat.bind(ad);
  ad.chat = async (b, emit) => {
    await origChat(b, emit);
    emit({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 225, completion_tokens: 10 } });
  };
  const result = await collectNonStreaming(ad, {});
  assert.equal(result.usage.prompt_tokens, 225);
  assert.equal(result.usage.completion_tokens, 10);
});
