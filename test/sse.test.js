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
