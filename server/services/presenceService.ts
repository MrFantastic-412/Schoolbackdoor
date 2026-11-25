import { db, runInTransaction } from '../db/database.js';
import { cache } from '../utils/cache.js';

// Sliding presence window (90 seconds covers 45s heartbeat interval + network jitter)
export const PRESENCE_TTL_SECONDS = 90;
const PRESENCE_CACHE_KEY = 'presence:online_summary';
const PRESENCE_CACHE_TTL_MS = 3000;

export interface OnlinePresenceSummary {
  onlineCount: number;
  message: string;
  updatedAt: string;
}

export interface AdminOnlineBreakdown {
  visibleOnlineCount: number;
  totalAuthenticatedOnlineCount: number;
  activeClientSessions: number;
}

function formatOnlineMessage(count: number): string {
  return count === 1 ? '1 student online now.' : `${count} students online now.`;
}

function toSqliteUtc(msFromNow = 0): string {
  return new Date(Date.now() + msFromNow)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

export const presenceService = {
  /**
   * Records or refreshes heartbeat for an authenticated user's tab/device.
   * Uses SQLite shared tables (`user_presence` & `user_presence_clients`) so
   * multiple application instances share consistent online state while deduplicating
   * multiple tabs/devices of the same user.
   */
  recordHeartbeat(userId: string, clientId: string, userAgent?: string): OnlinePresenceSummary {
    if (!userId || !clientId) {
      throw new Error('userId and clientId are required for presence heartbeat.');
    }

    const nowStr = toSqliteUtc(0);
    const expiresStr = toSqliteUtc(PRESENCE_TTL_SECONDS * 1000);

    // Look up user status & visibility preference
    const userPref = db.prepare(`
      SELECT u.id, u.status, COALESCE(pr.show_online_status, 1) as show_online_status
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE u.id = ?
    `).get(userId) as { id: string; status: string; show_online_status: number } | undefined;

    if (!userPref || userPref.status !== 'active') {
      return this.getOnlineSummary();
    }

    const sanitizedClientId = String(clientId).slice(0, 128);
    const cleanUa = userAgent ? String(userAgent).slice(0, 200) : null;
    const showOnline = userPref.show_online_status ? 1 : 0;

    runInTransaction(() => {
      db.prepare(`
        INSERT INTO user_presence_clients (client_id, user_id, last_heartbeat_at, expires_at, user_agent)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          user_id = excluded.user_id,
          last_heartbeat_at = excluded.last_heartbeat_at,
          expires_at = excluded.expires_at,
          user_agent = COALESCE(excluded.user_agent, user_presence_clients.user_agent)
      `).run(sanitizedClientId, userId, nowStr, expiresStr, cleanUa);

      // Count active non-expired tabs/devices for this single user
      const tabInfo = db.prepare(`
        SELECT COUNT(*) as tab_count, MAX(expires_at) as max_expires
        FROM user_presence_clients
        WHERE user_id = ? AND expires_at > datetime('now')
      `).get(userId) as { tab_count: number; max_expires: string | null };

      const activeTabs = Math.max(1, tabInfo?.tab_count || 1);
      const effectiveExpires = tabInfo?.max_expires || expiresStr;

      db.prepare(`
        INSERT INTO user_presence (user_id, last_seen_at, expires_at, show_online_status, active_tabs, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at,
          show_online_status = excluded.show_online_status,
          active_tabs = excluded.active_tabs,
          updated_at = CURRENT_TIMESTAMP
      `).run(userId, nowStr, effectiveExpires, showOnline, activeTabs);

      db.prepare(`
        UPDATE users SET last_active_at = ? WHERE id = ?
      `).run(nowStr, userId);
    });

    cache.invalidate(PRESENCE_CACHE_KEY);
    return this.getOnlineSummary();
  },

  /**
   * Batch refreshes presence for all connected authenticated SSE clients in a single transaction
   * instead of N separate per-client transactions on each heartbeat interval.
   */
  recordBatchHeartbeats(entries: Array<{ userId: string; clientId: string }>): void {
    if (!entries || entries.length === 0) return;

    const dedupClients = new Map<string, string>();
    for (const e of entries) {
      if (e.userId && e.clientId) {
        dedupClients.set(String(e.clientId).slice(0, 128), e.userId);
      }
    }
    if (dedupClients.size === 0) return;

    const uniqueUserIds = Array.from(new Set(dedupClients.values()));
    const nowStr = toSqliteUtc(0);
    const expiresStr = toSqliteUtc(PRESENCE_TTL_SECONDS * 1000);

    const userPlaceholders = uniqueUserIds.map(() => '?').join(', ');
    const activeRows = db.prepare(`
      SELECT u.id, COALESCE(pr.show_online_status, 1) as show_online_status
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE u.id IN (${userPlaceholders}) AND u.status = 'active'
    `).all(...uniqueUserIds) as Array<{ id: string; show_online_status: number }>;

    const showStatusByUser = new Map<string, number>();
    for (const r of activeRows) {
      showStatusByUser.set(r.id, r.show_online_status ? 1 : 0);
    }

    const activeClients = Array.from(dedupClients.entries()).filter(([, uid]) => showStatusByUser.has(uid));
    if (activeClients.length === 0) return;

    runInTransaction(() => {
      const CHUNK = 100;
      for (let i = 0; i < activeClients.length; i += CHUNK) {
        const chunk = activeClients.slice(i, i + CHUNK);
        const ph = chunk.map(() => '(?, ?, ?, ?, NULL)').join(', ');
        const params: any[] = [];
        for (const [cid, uid] of chunk) {
          params.push(cid, uid, nowStr, expiresStr);
        }
        db.prepare(`
          INSERT INTO user_presence_clients (client_id, user_id, last_heartbeat_at, expires_at, user_agent)
          VALUES ${ph}
          ON CONFLICT(client_id) DO UPDATE SET
            user_id = excluded.user_id,
            last_heartbeat_at = excluded.last_heartbeat_at,
            expires_at = excluded.expires_at
        `).run(...params);
      }

      const activeUserIds = Array.from(showStatusByUser.keys());
      const uPh = activeUserIds.map(() => '?').join(', ');
      const tabRows = db.prepare(`
        SELECT user_id, COUNT(*) as tab_count, MAX(expires_at) as max_expires
        FROM user_presence_clients
        WHERE user_id IN (${uPh}) AND expires_at > datetime('now')
        GROUP BY user_id
      `).all(...activeUserIds) as Array<{ user_id: string; tab_count: number; max_expires: string | null }>;

      const tabMap = new Map(tabRows.map((t) => [t.user_id, t]));

      for (let i = 0; i < activeUserIds.length; i += CHUNK) {
        const chunk = activeUserIds.slice(i, i + CHUNK);
        const ph = chunk.map(() => '(?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ');
        const params: any[] = [];
        for (const uid of chunk) {
          const info = tabMap.get(uid);
          params.push(
            uid,
            nowStr,
            info?.max_expires || expiresStr,
            showStatusByUser.get(uid) ?? 1,
            Math.max(1, info?.tab_count || 1)
          );
        }
        db.prepare(`
          INSERT INTO user_presence (user_id, last_seen_at, expires_at, show_online_status, active_tabs, updated_at)
          VALUES ${ph}
          ON CONFLICT(user_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            expires_at = excluded.expires_at,
            show_online_status = excluded.show_online_status,
            active_tabs = excluded.active_tabs,
            updated_at = CURRENT_TIMESTAMP
        `).run(...params);

        const idPh = chunk.map(() => '?').join(', ');
        db.prepare(`UPDATE users SET last_active_at = ? WHERE id IN (${idPh})`).run(nowStr, ...chunk);
      }
    });

    cache.invalidate(PRESENCE_CACHE_KEY);
  },

  /**
   * Removes a specific client/tab presence (e.g. tab close or sign-out).
   * Only marks the user offline once all of their active tabs/devices have closed or expired.
   */
  removeClientPresence(userId: string, clientId?: string): OnlinePresenceSummary {
    runInTransaction(() => {
      if (clientId) {
        db.prepare('DELETE FROM user_presence_clients WHERE client_id = ? AND user_id = ?').run(clientId, userId);
      } else {
        db.prepare('DELETE FROM user_presence_clients WHERE user_id = ?').run(userId);
      }

      const remaining = db.prepare(`
        SELECT COUNT(*) as tab_count, MAX(expires_at) as max_expires
        FROM user_presence_clients
        WHERE user_id = ? AND expires_at > datetime('now')
      `).get(userId) as { tab_count: number; max_expires: string | null };

      if (!remaining || remaining.tab_count === 0) {
        db.prepare('DELETE FROM user_presence WHERE user_id = ?').run(userId);
      } else {
        db.prepare(`
          UPDATE user_presence
          SET active_tabs = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).run(remaining.tab_count, remaining.max_expires, userId);
      }
    });

    cache.invalidate(PRESENCE_CACHE_KEY);
    return this.getOnlineSummary();
  },

  /**
   * Updates user's visibility preference in shared presence immediately when toggled in settings.
   */
  syncVisibilityPreference(userId: string, showOnlineStatus: boolean) {
    db.prepare(`
      UPDATE user_presence
      SET show_online_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(showOnlineStatus ? 1 : 0, userId);
    cache.invalidate(PRESENCE_CACHE_KEY);
  },

  /**
   * Purges expired client heartbeats and stale presence records.
   */
  expireInactivePresence(): { purgedClients: number; purgedUsers: number } {
    const result = runInTransaction(() => {
      const clientsRes = db.prepare(`
        DELETE FROM user_presence_clients
        WHERE expires_at <= datetime('now')
      `).run();

      const usersRes = db.prepare(`
        DELETE FROM user_presence
        WHERE expires_at <= datetime('now')
           OR user_id NOT IN (
             SELECT DISTINCT user_id FROM user_presence_clients WHERE expires_at > datetime('now')
           )
      `).run();

      return {
        purgedClients: Number(clientsRes.changes || 0),
        purgedUsers: Number(usersRes.changes || 0),
      };
    });

    if (result.purgedClients > 0 || result.purgedUsers > 0) {
      cache.invalidate(PRESENCE_CACHE_KEY);
    }

    return result;
  },

  /**
   * Returns public unique online user count & clean message ("X students online now.")
   * - Respects users' show_online_status preference
   * - Exposes zero private user information / PII
   */
  getOnlineSummary(): OnlinePresenceSummary {
    return cache.getOrCompute<OnlinePresenceSummary>(PRESENCE_CACHE_KEY, PRESENCE_CACHE_TTL_MS, () => {
      const row = db.prepare(`
        SELECT COUNT(DISTINCT up.user_id) as count
        FROM user_presence up
        JOIN users u ON u.id = up.user_id
        WHERE up.expires_at > datetime('now')
          AND u.status = 'active'
          AND up.show_online_status = 1
      `).get() as { count: number } | undefined;

      const onlineCount = Number(row?.count || 0);
      return {
        onlineCount,
        message: formatOnlineMessage(onlineCount),
        updatedAt: new Date().toISOString(),
      };
    });
  },

  /**
   * Admin-only breakdown showing both visibility-filtered and total authenticated active users + sessions
   */
  getAdminBreakdown(): AdminOnlineBreakdown {
    const visible = (db.prepare(`
      SELECT COUNT(DISTINCT up.user_id) as c
      FROM user_presence up
      JOIN users u ON u.id = up.user_id
      WHERE up.expires_at > datetime('now')
        AND u.status = 'active'
        AND up.show_online_status = 1
    `).get() as any)?.c || 0;

    const total = (db.prepare(`
      SELECT COUNT(DISTINCT up.user_id) as c
      FROM user_presence up
      JOIN users u ON u.id = up.user_id
      WHERE up.expires_at > datetime('now')
        AND u.status = 'active'
    `).get() as any)?.c || 0;

    const sessions = (db.prepare(`
      SELECT COUNT(*) as c
      FROM user_presence_clients
      WHERE expires_at > datetime('now')
    `).get() as any)?.c || 0;

    return {
      visibleOnlineCount: Number(visible),
      totalAuthenticatedOnlineCount: Number(total),
      activeClientSessions: Number(sessions),
    };
  },

  /**
   * Batch lookup for direct chat partner online indicator, honoring show_online_status
   */
  getVisibleOnlineUserIds(userIds: string[]): Set<string> {
    if (!userIds || userIds.length === 0) return new Set();
    const placeholders = userIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT up.user_id
      FROM user_presence up
      JOIN users u ON u.id = up.user_id
      WHERE up.user_id IN (${placeholders})
        AND up.expires_at > datetime('now')
        AND u.status = 'active'
        AND up.show_online_status = 1
    `).all(...userIds) as Array<{ user_id: string }>;

    return new Set(rows.map((r) => r.user_id));
  },
};
