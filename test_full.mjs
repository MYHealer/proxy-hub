/**
 * 全量测试：TraeEventNormalizer 直接转发行为（对齐 cpa-multi-plugins）
 */
import { TraeEventNormalizer, normalizeTraeEvent } from './adapters/traecn.js';

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// ==================== 1. TraeEventNormalizer — 直接转发 ====================
console.log('\n=== 1. TraeEventNormalizer — 直接转发 ===');
{
  const n = new TraeEventNormalizer('test-model');
  const c1 = n.normalize('output', JSON.stringify({
    tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function_call: { name: 'Bash', arguments: '' } }]
  }));
  assert(c1.length === 1, '首块(name only)直接转发');
  assert(c1[0].choices[0].delta.tool_calls[0].function.name === 'Bash', 'name = Bash');

  const c2 = n.normalize('output', JSON.stringify({
    tool_calls: [{ index: 0, id: '', type: '', function_call: { name: '', arguments: '{"command"' } }]
  }));
  assert(c2.length === 1, '参数分片直接转发');

  const c3 = n.normalize('output', JSON.stringify({
    tool_calls: [{ index: 0, id: '', type: '', function_call: { name: '', arguments: '{"command":"ls -la"}' } }]
  }));
  assert(c3.length === 1, '参数完整快照直接转发');

  const done = n.normalize('done', JSON.stringify({ finish_reason: 'tool_calls' }));
  assert(done.length === 1, 'done 事件发 finish_reason');
  assert(done[0].choices[0].finish_reason === 'tool_calls', 'finish_reason = tool_calls');
}

// ==================== 2. 同块索引重复 ====================
console.log('\n=== 2. 同块索引重复 ===');
{
  const n = new TraeEventNormalizer('test-model');
  const c1 = n.normalize('output', JSON.stringify({
    tool_calls: [
      { index: 0, id: 'call_x', type: 'function', function_call: { name: 'Read', arguments: '{"file_path":"/' } },
      { index: 0, id: 'call_x', type: 'function', function_call: { name: 'Read', arguments: '{"file_path":"/tmp/test.txt"}' } },
    ]
  }));
  assert(c1.length === 1, '同块重复合并为一个 chunk');
  const tc = c1[0].choices[0].delta.tool_calls;
  assert(tc.length === 2, '两个 tool_call 都转发');

  const done = n.normalize('done', JSON.stringify({ finish_reason: 'stop' }));
  assert(done[0].choices[0].finish_reason === 'tool_calls', 'done → finish_reason: tool_calls');
}

// ==================== 3. 并行工具调用 ====================
console.log('\n=== 3. 并行工具调用 ===');
{
  const n = new TraeEventNormalizer('test-model');
  const c1 = n.normalize('output', JSON.stringify({
    tool_calls: [{ index: 0, id: 'c1', type: 'function', function_call: { name: 'Bash', arguments: '{"command":"ls"}' } }]
  }));
  assert(c1.length === 1, 'Bash 直接转发');
  assert(c1[0].choices[0].delta.tool_calls[0].function.name === 'Bash', 'name = Bash');
  assert(c1[0].choices[0].delta.tool_calls[0].index === 0, 'index = 0');

  const c2 = n.normalize('output', JSON.stringify({
    tool_calls: [{ index: 1, id: 'c2', type: 'function', function_call: { name: 'Read', arguments: '{"file_path":"/a"}' } }]
  }));
  assert(c2.length === 1, 'Read 直接转发');
  assert(c2[0].choices[0].delta.tool_calls[0].function.name === 'Read', 'name = Read');
  assert(c2[0].choices[0].delta.tool_calls[0].index === 1, 'index = 1');

  const done = n.normalize('done', JSON.stringify({ finish_reason: 'tool_calls' }));
  assert(done[0].choices[0].finish_reason === 'tool_calls', 'finish_reason = tool_calls');
}

// ==================== 4. 空 name 但有 arguments 仍转发 ====================
console.log('\n=== 4. 空 name 转发行为 ===');
{
  const n = new TraeEventNormalizer('test-model');
  const c1 = n.normalize('output', JSON.stringify({
    tool_calls: [{ index: 0, id: '', type: 'function', function_call: { name: '', arguments: '{"cmd":"ls"}' } }]
  }));
  assert(c1.length === 1, '有 arguments 的分片直接转发');

  const n2 = new TraeEventNormalizer('test-model');
  const c2 = n2.normalize('output', JSON.stringify({
    tool_calls: [{ index: 0, id: 'c1', type: 'function', function_call: { name: '', arguments: '' } }]
  }));
  assert(c2.length === 0, 'name 和 arguments 都空 → 过滤');
}

// ==================== 5. 文本事件透传 ====================
console.log('\n=== 5. 文本事件透传 ===');
{
  const n = new TraeEventNormalizer('test-model');
  const c1 = n.normalize('output', JSON.stringify({ response: 'hello' }));
  assert(c1.length === 1, '文本事件直接透传');
  assert(c1[0].choices[0].delta.content === 'hello', 'content = hello');

  const c2 = n.normalize('output', JSON.stringify({ reasoning_content: 'thinking' }));
  assert(c2.length === 1, '思考链事件直接透传');
  assert(c2[0].choices[0].delta.reasoning_content === 'thinking', 'reasoning = thinking');
}

// ==================== 6. done 事件无 tool_calls ====================
console.log('\n=== 6. done 事件无 tool_calls ===');
{
  const n = new TraeEventNormalizer('test-model');
  n.normalize('output', JSON.stringify({ response: 'hello' }));
  const done = n.normalize('done', JSON.stringify({ finish_reason: 'stop' }));
  assert(done.length === 1, 'done 发 finish_reason');
  assert(done[0].choices[0].finish_reason === 'stop', 'finish_reason = stop');
}

// ==================== 总结 ====================
console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
