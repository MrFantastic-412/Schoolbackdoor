import { db, withReadConnection } from '../db/database';
import { sseManager } from '../realtime/sseManager';
import { extractMentionHandles, formatMentionSnippet } from '../utils/mentions';

export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'mention'
  | 'group'
  | 'announcement'
  | 'account'
  | 'message'
  | 'system';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  sourceRef?: string;
  actorId?: string; // If provided, ensures self-actions don't trigger notification
}

export const notificationService = {
  /**
   * Retrieves notifications for a user (paginable with limit & offset)
   */
  getUserNotifications(userId: string, unreadOnly = false, limit = 50, offset = 0) {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const query = unreadOnly
      ? `SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`;

    const rows = withReadConnection((conn) => conn.prepare(query).all(userId, safeLimit, safeOffset) as any[]);

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      sourceRef: r.source_ref || undefined,
      isRead: Boolean(r.is_read),
      timestamp: r.created_at,
    }));
  },

  getUserNotificationsPaginated(userId: string, unreadOnly = false, limit = 25, offset = 0) {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const totalRow = withReadConnection((conn) =>
      conn.prepare(
        unreadOnly
          ? 'SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0'
          : 'SELECT COUNT(*) as c FROM notifications WHERE user_id = ?'
      ).get(userId) as { c: number } | undefined
    );
    const total = Number(totalRow?.c || 0);
    const notifications = this.getUserNotifications(userId, unreadOnly, safeLimit, safeOffset);
    const nextOffset = safeOffset + notifications.length;
    return {
      notifications,
      total,
      hasMore: nextOffset < total,
      nextOffset,
    };
  },

  /**
   * Returns unread notifications count
   */
  getUnreadCount(userId: string) {
    const row = withReadConnection((conn) =>
      conn.prepare(`
        SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0
      `).get(userId) as { count: number }
    );
    return row?.count ?? 0;
  },

  /**
   * Marks a specific notification as read
   */
  markAsRead(notificationId: string, userId: string) {
    db.prepare(`
      UPDATE notifications
      SET is_read = 1
      WHERE id = ? AND user_id = ?
    `).run(notificationId, userId);

    sseManager.broadcastToUser(userId, 'notification:read', { notificationId });
    return { success: true };
  },

  /**
   * Marks all notifications as read for a user
   */
  markAllAsRead(userId: string) {
    db.prepare(`
      UPDATE notifications
      SET is_read = 1
      WHERE user_id = ?
    `).run(userId);

    sseManager.broadcastToUser(userId, 'notification:read_all', {});
    return { success: true };
  },

  /**
   * Creates a notification, strictly avoiding self-notifications and broadcasting via SSE
   */
  createNotification(data: CreateNotificationInput) {
    // Avoid notifying user of their own actions
    if (data.actorId && data.actorId === data.userId) {
      return null;
    }

    const id = `n-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link, source_ref, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(id, data.userId, data.type, data.title, data.body, data.link || null, data.sourceRef || null);

    const notificationPayload = {
      id,
      userId: data.userId,
      type: data.type,
      title: data.title,
      body: data.body,
      link: data.link,
      isRead: false,
      timestamp: new Date().toISOString(),
    };

    // Real-time delivery
    sseManager.broadcastToUser(data.userId, 'notification:new', notificationPayload);

    return notificationPayload;
  },

  /**
   * Inserts multiple notifications in batched multi-row INSERTs (avoids N+1 INSERT loops)
   * and pushes real-time SSE events, skipping self-notifications.
   */
  createNotificationsBatch(inputs: CreateNotificationInput[]) {
    const valid = inputs.filter((d) => !(d.actorId && d.actorId === d.userId));
    if (valid.length === 0) return [];

    const nowIso = new Date().toISOString();
    const payloads = valid.map((d) => ({
      id: `n-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      userId: d.userId,
      type: d.type,
      title: d.title,
      body: d.body,
      link: d.link || null,
      sourceRef: d.sourceRef || null,
      isRead: false,
      timestamp: nowIso,
    }));

    const CHUNK_SIZE = 100;
    for (let i = 0; i < payloads.length; i += CHUNK_SIZE) {
      const chunk = payloads.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, 0)').join(', ');
      const params: any[] = [];
      for (const p of chunk) {
        params.push(p.id, p.userId, p.type, p.title, p.body, p.link, p.sourceRef);
      }
      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, link, source_ref, is_read)
        VALUES ${placeholders}
      `).run(...params);
    }

    for (const p of payloads) {
      sseManager.broadcastToUser(p.userId, 'notification:new', {
        id: p.id,
        userId: p.userId,
        type: p.type,
        title: p.title,
        body: p.body,
        link: p.link || undefined,
        isRead: p.isRead,
        timestamp: p.timestamp,
      });
    }

    return payloads;
  },

  /**
   * Detects and notifies users mentioned with @handle in text using a single
   * JOIN query (respecting blocks + notify_mentions preference) and 1 batched INSERT.
   */
  processMentions(
    text: string,
    actorId: string,
    targetLink: string,
    contextTitle: string,
    options?: { isAnonymous?: boolean; sourceRefPrefix?: string }
  ) {
    const uniqueHandles = extractMentionHandles(text);
    if (uniqueHandles.length === 0) return [];

    const placeholders = uniqueHandles.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT up.user_id, actor.name as actor_name
      FROM user_profiles up
      JOIN users u ON u.id = up.user_id
      LEFT JOIN user_profiles actor ON actor.user_id = ?
      WHERE u.status = 'active'
        AND LOWER(up.handle) IN (${placeholders})
        AND up.user_id != ?
        AND COALESCE(up.notify_mentions, 1) = 1
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = up.user_id AND b.blocked_id = ?)
             OR (b.blocker_id = ? AND b.blocked_id = up.user_id)
        )
    `).all(actorId, ...uniqueHandles, actorId, actorId, actorId) as Array<{
      user_id: string;
      actor_name: string | null;
    }>;

    if (rows.length === 0) return [];

    const actorName = options?.isAnonymous
      ? 'Someone (Anonymous)'
      : rows[0]?.actor_name || 'A student';
    const snippet = formatMentionSnippet(text, 75);

    return this.createNotificationsBatch(
      rows.map((r) => ({
        userId: r.user_id,
        type: 'mention' as const,
        title: `Mentioned in ${contextTitle}`,
        body: snippet ? `${actorName} mentioned you: "${snippet}"` : `${actorName} mentioned you`,
        link: targetLink,
        sourceRef: options?.sourceRefPrefix ? `${options.sourceRefPrefix}:${r.user_id}` : undefined,
        actorId,
      }))
    );
  },
};
