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
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/** 非流式：完整跑适配器，把所有 chunk 聚合成单个 chat.completion 对象；返回带 usage 供用量统计 */
export async function collectNonStreaming(adapter, body) {
  const chunks = [];
  await adapter.chat(body, (chunk) => chunks.push(chunk));
  let content = '';
  let finishReason = '';
  let id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10);
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let usage = null;
  for (const c of chunks) {
    id = c.id || id;
    model = c.model || model;
    created = c.created || created;
    const choice = c.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (c.usage) usage = c.usage;
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason || 'stop' }],
    usage,
  };
}
