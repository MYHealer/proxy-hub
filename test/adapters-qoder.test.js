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
  const result = parseCliDelta(line);
  assert.equal(result.type, 'text');
  assert.equal(result.content, 'hello');
});

test('parseCliDelta returns null for non-text or done', () => {
  assert.equal(parseCliDelta(JSON.stringify({ type: 'done' })), null);
  assert.equal(parseCliDelta(JSON.stringify({ type: 'assistant', message: { content: [] } })), null);
});

test('parseCliDelta parses foxy1402 format {"tool_call":{...}}', () => {
  const tc = JSON.stringify({ tool_call: { name: 'read_file', arguments: { path: 'test.js' } } });
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: tc }] } });
  const result = parseCliDelta(line);
  assert.equal(result.type, 'tool_call');
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  assert.equal(result.tool_calls[0].function.arguments, '{"path":"test.js"}');
  assert.equal(result.content, null);
});

test('parseCliDelta parses foxy1402 format wrapped in code fence', () => {
  const text = 'Let me read it.\n```json\n{"tool_call":{"name":"read_file","arguments":{"path":"a.txt"}}}\n```';
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const result = parseCliDelta(line);
  assert.equal(result.type, 'tool_call');
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  assert.equal(result.content, 'Let me read it.');
});

test('parseCliDelta extracts tool_call from <tool_call> tag', () => {
  const text = 'I will read the file.\n<tool_call>\n{"name":"read_file","arguments":{"path":"test.js"}}\n</tool_call>';
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const result = parseCliDelta(line);
  assert.equal(result.type, 'tool_call');
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  assert.equal(result.content, 'I will read the file.');
});

test('parseCliDelta extracts tool_call from ```json block with name/arguments', () => {
  const text = 'Let me check.\n```json\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}\n```';
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const result = parseCliDelta(line);
  assert.equal(result.type, 'tool_call');
  assert.equal(result.tool_calls[0].function.name, 'write_file');
});
