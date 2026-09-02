import test from 'node:test';
import assert from 'node:assert/strict';
import { needsTextTools, buildToolPrompt, injectTools } from '../tool-compat.js';

test('needsTextTools returns false for deepseek models (native tool support)', () => {
  assert.equal(needsTextTools('deepseek-v4-flash'), false);
  assert.equal(needsTextTools('deepseek-v4-pro'), false);
  assert.equal(needsTextTools('DeepSeek-V4-Flash'), false);
});

test('needsTextTools returns false for other known models (native tool support)', () => {
  assert.equal(needsTextTools('glm-5'), false);
  assert.equal(needsTextTools('qwen-3.7-plus'), false);
  assert.equal(needsTextTools('kimi-k2.6'), false);
});

test('needsTextTools returns false for mimo models', () => {
  assert.equal(needsTextTools('mimo'), false);
  assert.equal(needsTextTools('mimo-pro'), false);
  assert.equal(needsTextTools('mimo-omni'), false);
  assert.equal(needsTextTools('xiaomi/mimo'), false);
  assert.equal(needsTextTools('xiaomi/mimo-pro'), false);
});

test('needsTextTools returns true for empty/null model', () => {
  assert.equal(needsTextTools(''), true);
  assert.equal(needsTextTools(null), true);
  assert.equal(needsTextTools(undefined), true);
});

test('buildToolPrompt generates correct format', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather information',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          unit: { type: 'string', description: 'Temperature unit' },
        },
        required: ['city'],
      },
    },
  }];
  const prompt = buildToolPrompt(tools);
  assert.ok(prompt.includes('# Available Tools'));
  assert.ok(prompt.includes('### get_weather'));
  assert.ok(prompt.includes('Get weather information'));
  assert.ok(prompt.includes('`city`'));
  assert.ok(prompt.includes('`unit`'));
  assert.ok(prompt.includes('<tool_call>'));
  assert.ok(prompt.includes('</tool_call>'));
});

test('buildToolPrompt returns empty for empty tools', () => {
  assert.equal(buildToolPrompt([]), '');
  assert.equal(buildToolPrompt(null), '');
});

test('injectTools adds tool prompt to system message', () => {
  const body = {
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{
      type: 'function',
      function: { name: 'fn', description: 'test', parameters: { type: 'object', properties: {} } },
    }],
  };
  const result = injectTools(body);
  assert.ok(!result.tools, 'tools should be removed');
  assert.ok(!result.tool_choice, 'tool_choice should be removed');
  assert.ok(result.messages[0].content.includes('You are helpful.'));
  assert.ok(result.messages[0].content.includes('### fn'));
});

test('injectTools creates system message if none exists', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: { name: 'fn', description: 'test' },
    }],
  };
  const result = injectTools(body);
  assert.equal(result.messages[0].role, 'system');
  assert.ok(result.messages[0].content.includes('### fn'));
  assert.equal(result.messages[1].role, 'user');
});

test('injectTools handles array content system message', () => {
  const body = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    ],
    tools: [{
      type: 'function',
      function: { name: 'fn', description: 'test' },
    }],
  };
  const result = injectTools(body);
  const sysContent = result.messages[0].content;
  assert.ok(Array.isArray(sysContent));
  assert.ok(sysContent.some((p) => p.text === 'sys'));
  assert.ok(sysContent.some((p) => p.text.includes('### fn')));
});

test('injectTools does not modify original body', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'fn' } }],
  };
  const result = injectTools(body);
  assert.ok(body.tools, 'original body.tools should still exist');
  assert.ok(!result.tools, 'result should not have tools');
});
