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
}
