/**
 * 工具兼容层：将 OpenAI tools 注入为 system prompt 文本，供不支持原生 function calling 的模型使用。
 *
 * 当上游模型（如 deepseek-v4-flash）返回纯文本 `<tool_call>` 标签时，
 * sse.js 的流式解析器会将其转为结构化 tool_calls。
 */

// 支持原生 function calling 的模型关键词（mimo 系列 + Trae 上游的 deepseek/glm/qwen/kimi）
const NATIVE_TOOL_MODELS = ['mimo', 'deepseek', 'glm', 'qwen', 'kimi'];

/**
 * 判断模型是否需要文本注入式工具（不支持原生 function calling）。
 * Trae 上游对所有已知模型都支持原生 tool_calls，因此默认不需要文本注入。
 * @param {string} modelId 上游模型 ID
 * @returns {boolean}
 */
export function needsTextTools(modelId) {
  const lower = (modelId || '').toLowerCase();
  return !NATIVE_TOOL_MODELS.some((k) => lower.includes(k));
}

/**
 * 将 OpenAI tools 数组转为 prompt 文本。
 * @param {Array} tools OpenAI 格式的 tools 数组
 * @returns {string}
 */
export function buildToolPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const lines = [
    '## 可用工具',
    '',
    '如需调用工具，请严格按以下格式输出（不要在标签外添加任何其他内容）：',
    '',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {"arg1": "value1"}}',
    '</tool_call>',
    '',
    '也可以使用 DeepSeek 原生格式：',
    '<|FunctionCallBegin|>[{"name":"tool_name","parameters":{"arg1":"value1"}}]<|FunctionCallEnd|>',
    '',
    '### 工具列表',
    '',
  ];

  for (const t of tools) {
    const fn = t.function || t;
    if (!fn.name) continue;
    lines.push(`#### ${fn.name}`);
    if (fn.description) lines.push(`描述：${fn.description}`);

    const params = fn.parameters;
    if (params && params.properties) {
      lines.push('参数：');
      const required = new Set(params.required || []);
      for (const [name, schema] of Object.entries(params.properties)) {
        const type = schema.type || 'any';
        const desc = schema.description || '';
        const req = required.has(name) ? '必需' : '可选';
        lines.push(`- ${name} (${type}, ${req}): ${desc}`);
      }
    }
    lines.push('');
  }

  lines.push('## 规则');
  lines.push('1. 每次只调用一个工具');
  lines.push('2. arguments 必须是合法 JSON');
  lines.push('3. 不要在工具调用标签外添加其他文本');
  lines.push('');

  return lines.join('\n');
}

/**
 * 将 tools 注入为 system prompt 文本，返回新 body（不修改原对象）。
 * @param {object} body OpenAI 请求体
 * @returns {object} 新的请求体
 */
export function injectTools(body) {
  const prompt = buildToolPrompt(body.tools);
  if (!prompt) return body;

  const messages = [...(body.messages || [])];
  const sysIdx = messages.findIndex((m) => m.role === 'system');

  if (sysIdx >= 0) {
    const sys = messages[sysIdx];
    const content = typeof sys.content === 'string'
      ? sys.content + '\n\n' + prompt
      : Array.isArray(sys.content)
        ? [...sys.content, { type: 'text', text: prompt }]
        : prompt;
    messages[sysIdx] = { ...sys, content };
  } else {
    messages.unshift({ role: 'system', content: prompt });
  }

  const out = { ...body, messages };
  delete out.tools;
  delete out.tool_choice;
  return out;
}
