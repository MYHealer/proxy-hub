/** 通用凭据缓存：TTL + in-flight 去重（并发只触发一次底层刷新） */
export class CredentialsCache {
  constructor() {
    this.entries = new Map();
    this.inflight = new Map();
  }

  has(key) {
    const e = this.entries.get(key);
    if (!e) return false;
    return e.expiresAt > Date.now();
  }

  set(key, { value, expiresAt }) {
    this.entries.set(key, { value, expiresAt });
    return value;
  }

  get(key, loader) {
    if (this.has(key)) return Promise.resolve(this.entries.get(key).value);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = Promise.resolve()
      .then(loader)
      .then(({ value, expiresAt }) => {
        this.entries.set(key, { value, expiresAt });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  invalidate(key) {
    this.entries.delete(key);
    this.inflight.delete(key);
  }
}
