import https from 'node:https';

/** 把适配器 emit 出的 OpenAI chunk 序列化为 SSE 写回客户端 */
export async function createSseResponse(res, run) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const emit = (chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  try {
    await run(emit);
  } catch (e) {
    const status = e.message?.match(/upstream (\d+)/)?.[1];
    const code = status ? parseInt(status) : 502;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
    return;
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * 真流式 POST：逐块解析上游 SSE 行，实时通过 emit 回调推给客户端。
 */
export function postStreamingSSE(url, headers, body, timeoutMs, emit) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        if (res.statusCode >= 400) {
          const data = [];
          res.on('data', (c) => data.push(c));
          res.on('end', () => reject(new Error(`upstream ${res.statusCode}: ${Buffer.concat(data).toString('utf8').slice(0, 200)}`)));
          return;
        }
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            try { emit(JSON.parse(payload)); } catch {}
          }
        });
        res.on('end', () => {
          if (buffer.trim()) {
            const t = buffer.trim();
            if (t.startsWith('data:')) {
              const payload = t.slice(5).trim();
              if (payload !== '[DONE]') {
                try { emit(JSON.parse(payload)); } catch {}
              }
            }
          }
          resolve();
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.write(body);
    req.end();
  });
}

/**
 * 真流式 POST（Trae 系列）：逐块解析上游 SSE，支持 event:/data: 行，
 * 通过 normalize 回调转换为 OpenAI chunk 后实时 emit。
 */
export function postStreamingTraeSSE(url, headers, body, timeoutMs, model, normalize, emit) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        if (res.statusCode >= 400) {
          const data = [];
          res.on('data', (c) => data.push(c));
          res.on('end', () => reject(new Error(`upstream ${res.statusCode}: ${Buffer.concat(data).toString('utf8').slice(0, 200)}`)));
          return;
        }
        let buffer = '';
        let currentEvent = '';
        res.on('data', (buf) => {
          buffer += buf.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('event:')) {
              currentEvent = t.slice(6).trim();
              continue;
            }
            if (t.startsWith('data:')) {
              const data = t.slice(5).trim();
              for (const oc of normalize(currentEvent, data, model)) emit(oc);
            }
          }
        });
        res.on('end', () => {
          if (buffer.trim()) {
            const t = buffer.trim();
            if (t.startsWith('event:')) {
              currentEvent = t.slice(6).trim();
            } else if (t.startsWith('data:')) {
              const data = t.slice(5).trim();
              for (const chunk of normalize(currentEvent, data, model)) emit(chunk);
            }
          }
          resolve();
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.write(body);
    req.end();
  });
}

/** 非流式：完整跑适配器，把所有 chunk 聚合成单个 chat.completion 对象 */
export async function collectNonStreaming(adapter, body) {
  const chunks = [];
  await adapter.chat(body, (chunk) => chunks.push(chunk));
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10);
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let usage = null;
  const toolCallMap = new Map();
  const toolCallOrder = [];
  for (const c of chunks) {
    id = c.id || id;
    model = c.model || model;
    created = c.created || created;
    const choice = c.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } });
          toolCallOrder.push(idx);
        }
        const merged = toolCallMap.get(idx);
        if (tc.id) merged.id = tc.id;
        if (tc.type) merged.type = tc.type;
        if (tc.function?.name) merged.function.name = tc.function.name;
        if (tc.function?.arguments) merged.function.arguments += tc.function.arguments;
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (c.usage) usage = c.usage;
  }
  const toolCalls = toolCallOrder.length > 0
    ? toolCallOrder.map(idx => toolCallMap.get(idx))
    : undefined;
  if (toolCalls && finishReason !== 'tool_calls') finishReason = 'tool_calls';
  if (!usage) {
    usage = {
      prompt_tokens: estimatePromptTokens(body?.messages),
      completion_tokens: Math.ceil((content.length + reasoning.length) / 4),
    };
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    usage,
  };
}

function estimatePromptTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const v = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    chars += v.length;
  }
  return Math.ceil(chars / 4);
}
