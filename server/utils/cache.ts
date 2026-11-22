/**
 * Lightweight bounded in-memory TTL cache with namespace invalidation and hit/miss telemetry.
 * Avoids paid external cache dependencies while sharply reducing repeat SQLite read pressure.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private maxEntries = 500;
  private hits = 0;
  private misses = 0;

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Evict oldest entry if capacity cap reached
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  getOrCompute<T>(key: string, ttlMs: number, compute: () => T): T {
    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const fresh = compute();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [k, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(k);
        purged++;
      }
    }
    return purged;
  }

  getEstimatedBytes(): number {
    let bytes = 0;
    for (const [k, entry] of this.store.entries()) {
      bytes += k.length * 2;
      try {
        bytes += Buffer.byteLength(JSON.stringify(entry.value) || '', 'utf8');
      } catch {
        bytes += 256;
      }
    }
    return bytes;
  }

  getStats() {
    this.purgeExpired();

    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRatePercent: total > 0 ? Number(((this.hits / total) * 100).toFixed(1)) : 0,
      estimatedBytes: this.getEstimatedBytes(),
    };
  }
}

export const cache = new MemoryCache();
