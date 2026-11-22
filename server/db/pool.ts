import { DatabaseSync } from 'node:sqlite';

interface PooledConnection {
  conn: DatabaseSync;
  inUse: boolean;
}

/**
 * Lightweight SQLite Read Connection Pool for WAL concurrent reads.
 * Distributes read-only SELECT queries across bounded read handles while keeping
 * serialized writes on the primary writer connection and falling back safely for :memory:.
 */
export class SqliteConnectionPool {
  private readonly dbPath: string;
  private readonly writerDb: DatabaseSync;
  private readonly maxConnections: number;
  private pool: PooledConnection[] = [];
  private totalReadQueries = 0;
  private fallbackToWriter = 0;
  private activeLeases = 0;
  private closed = false;

  constructor(dbPath: string, writerDb: DatabaseSync, maxConnections = 4) {
    this.dbPath = dbPath;
    this.writerDb = writerDb;
    this.maxConnections = dbPath === ':memory:' ? 0 : Math.min(8, Math.max(1, maxConnections));
  }

  private openReadOnlyConnection(): DatabaseSync {
    const ro = new DatabaseSync(this.dbPath, { readOnly: true });
    ro.exec('PRAGMA query_only = ON;');
    ro.exec('PRAGMA busy_timeout = 5000;');
    ro.exec('PRAGMA temp_store = MEMORY;');
    ro.exec('PRAGMA cache_size = -8000;');
    ro.exec('PRAGMA mmap_size = 67108864;');
    return ro;
  }

  private acquire(): { conn: DatabaseSync; pooled: PooledConnection | null } {
    if (this.closed || this.maxConnections === 0) {
      this.fallbackToWriter++;
      return { conn: this.writerDb, pooled: null };
    }

    for (const slot of this.pool) {
      if (!slot.inUse) {
        slot.inUse = true;
        this.activeLeases++;
        return { conn: slot.conn, pooled: slot };
      }
    }

    if (this.pool.length < this.maxConnections) {
      try {
        const conn = this.openReadOnlyConnection();
        const slot: PooledConnection = { conn, inUse: true };
        this.pool.push(slot);
        this.activeLeases++;
        return { conn, pooled: slot };
      } catch {
        this.fallbackToWriter++;
        return { conn: this.writerDb, pooled: null };
      }
    }

    // Pool saturated: fall back cleanly without blocking
    this.fallbackToWriter++;
    return { conn: this.writerDb, pooled: null };
  }

  private release(pooled: PooledConnection | null): void {
    if (!pooled) return;
    if (pooled.inUse) {
      pooled.inUse = false;
      this.activeLeases = Math.max(0, this.activeLeases - 1);
    }
  }

  withReadConnection<T>(fn: (conn: DatabaseSync) => T): T {
    this.totalReadQueries++;
    const lease = this.acquire();
    try {
      return fn(lease.conn);
    } finally {
      this.release(lease.pooled);
    }
  }

  getStats() {
    return {
      poolEnabled: this.maxConnections > 0 && !this.closed,
      maxConnections: this.maxConnections,
      openConnections: this.pool.length,
      activeLeases: this.activeLeases,
      totalReadQueries: this.totalReadQueries,
      fallbackToWriter: this.fallbackToWriter,
    };
  }

  closeAll(): void {
    this.closed = true;
    for (const slot of this.pool) {
      try {
        slot.conn.close();
      } catch {
        // ignore close error
      }
    }
    this.pool = [];
    this.activeLeases = 0;
  }

  reopen(): void {
    this.closed = false;
  }
}
