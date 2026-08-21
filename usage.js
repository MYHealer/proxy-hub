/** 用量统计：按 adapterId+model 与 日期 累计请求数与 token。纯内存，可选落盘。 */
export class UsageTracker {
  constructor() {
    this.store = new Map(); // "adapterId|model|date" -> {requests, promptTokens, completionTokens}
  }

  today() {
    return new Date().toISOString().slice(0, 10);
  }

  /** 记录一次对话。usage 可为 null/undefined（上游未返回用量），此时按 content 长度估算 token（chars/4）。 */
  record(adapterId, model, usage = {}) {
    const u = usage || {};
    const key = `${adapterId}|${model}|${this.today()}`;
    const promptTokens = u.prompt_tokens ?? Math.ceil((u.content?.length || 0) / 4);
    const completionTokens = u.completion_tokens ?? Math.ceil((u.content?.length || 0) / 4);
    const cur = this.store.get(key) || { requests: 0, promptTokens: 0, completionTokens: 0 };
    cur.requests += 1;
    cur.promptTokens += promptTokens;
    cur.completionTokens += completionTokens;
    this.store.set(key, cur);
  }

  /** 汇总：byAdapter（按适配器+模型）+ byDay（每日趋势）。 */
  summary() {
    const byAdapter = {};
    const byDayMap = new Map();
    for (const [key, v] of this.store) {
      const [adapterId, model, date] = key.split('|');
      const ad = (byAdapter[adapterId] = byAdapter[adapterId] || { requests: 0, promptTokens: 0, completionTokens: 0, models: {} });
      ad.requests += v.requests;
      ad.promptTokens += v.promptTokens;
      ad.completionTokens += v.completionTokens;
      const mod = (ad.models[model] = ad.models[model] || { requests: 0, tokens: 0 });
      mod.requests += v.requests;
      mod.tokens += v.promptTokens + v.completionTokens;
      const day = byDayMap.get(date) || { date, requests: 0, tokens: 0 };
      day.requests += v.requests;
      day.tokens += v.promptTokens + v.completionTokens;
      byDayMap.set(date, day);
    }
    return { byAdapter, byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }
}
