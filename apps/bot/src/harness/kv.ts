// In-memory TTL key-value store replacing the chat-sdk's Postgres-backed
// state. Everything stored here is a rebuildable cache (opt-in allowlist,
// user/channel name lookups), so process-lifetime persistence is enough — the
// allowlist is rebuilt from channel membership at startup and the caches
// refill on demand.

interface Entry {
  expiresAt: number | null;
  value: unknown;
}

export class MemoryKV {
  private readonly entries = new Map<string, Entry>();

  get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.entries.set(key, {
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
      value,
    });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}
