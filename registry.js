/** 适配器注册表：按模型 ID 前缀路由到适配器，维护 对外ID↔上游ID 映射 */
export class Registry {
  constructor() {
    this.adapters = new Map();   // adapterId -> adapter
    this.external = new Map();   // externalId -> {adapterId, upstreamId}
  }

  register(adapter) {
    this.adapters.set(adapter.id, adapter);
    for (const m of adapter.registerModels()) {
      this.external.set(m.externalId, { adapterId: adapter.id, upstreamId: m.upstreamId });
    }
  }

  /** 输入 externalId，返回 { adapter, upstreamId }；未知返回 null */
  resolveModel(externalId) {
    const entry = this.external.get(externalId);
    if (!entry) return null;
    const adapter = this.adapters.get(entry.adapterId);
    return { adapter, upstreamId: entry.upstreamId };
  }

  /** 返回对外模型数组 [{ id, object:'model', owned_by }] */
  listModels() {
    return [...this.external.keys()].map((id) => ({
      id,
      object: 'model',
      owned_by: this.external.get(id).adapterId,
    }));
  }

  /** 跨平台模型能力矩阵：按模型家族分组，展示各适配器是否提供该家族及其模型。 */
  modelMatrix() {
    const families = new Map(); // family -> { models:Set, providers: Map<adapterId, models[]> }
    for (const adapterId of this.adapters.keys()) {
      for (const { upstreamId } of this._modelsOf(adapterId)) {
        const family = familyOf(upstreamId);
        let f = families.get(family);
        if (!f) { f = { models: new Set(), providers: new Map() }; families.set(family, f); }
        f.models.add(upstreamId);
        const list = f.providers.get(adapterId) || [];
        list.push(upstreamId);
        f.providers.set(adapterId, list);
      }
    }
    const out = {};
    for (const [family, f] of [...families].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[family] = {
        models: [...f.models],
        providers: Object.fromEntries([...f.providers].map(([id, models]) => [id, models])),
      };
    }
    return out;
  }

  _modelsOf(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter || typeof adapter.registerModels !== 'function') return [];
    return adapter.registerModels();
  }
}

/** 从模型名推导家族：取连字符首段并转小写（glm-5.2→glm、GLM-5.2→glm、Qwen3.6-Plus→qwen3.6）。 */
export function familyOf(upstreamId) {
  const idx = String(upstreamId).indexOf('-');
  const head = idx > 0 ? String(upstreamId).slice(0, idx) : String(upstreamId);
  return head.toLowerCase();
}
