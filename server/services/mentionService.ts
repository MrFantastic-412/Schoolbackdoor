import { db, withReadConnection } from '../db/database';
import { notificationService } from './notificationService';
import {
  extractMentionHandles,
  formatMentionSnippet,
  ResolvedMention,
} from '../utils/mentions';
import { escapeLikePattern } from '../utils/security';

export type MentionSourceType = 'post' | 'comment' | 'msg';

export interface SyncMentionsInput {
  text: string | null | undefined;
  sourceType: MentionSourceType;
  sourceId: string;
  actorId: string;
  targetLink: string;
  contextTitle: string;
  isAnonymous?: boolean;
  communityId?: string;
  chatId?: string;
  excludeUserIds?: string[];
  /**
   * When true, skips inserting mention notifications cleanly for users whose
   * notification settings disable mentions, while still returning all valid
   * resolved mentions for UI linkification.
   */
  createNotifications?: boolean;
}

export interface MentionCandidate {
  userId: string;
  name: string;
  handle: string;
  department: string;
  level: string;
  avatarInitials: string;
  avatarBg: string;
  verified: boolean;
  isConnected?: boolean;
}

function isCommunityPrivate(communityId: string): boolean {
  const row = withReadConnection((conn) =>
    conn.prepare('SELECT settings_json FROM communities WHERE id = ?').get(communityId) as
      | { settings_json: string | null }
      | undefined
  );
  if (!row?.settings_json) return false;
  try {
    const parsed = JSON.parse(row.settings_json);
    return Boolean(parsed?.isPrivate);
  } catch {
    return false;
  }
}

export const mentionService = {
  /**
   * Batch-resolves all unique @handles appearing in a set of texts with a single SQL query.
   * Excludes suspended/non-active users, mutual blocks with viewerId, and non-members
   * when scoped to a chat or private community.
   */
  resolveHandlesBatch(
    texts: Array<string | null | undefined>,
    options: { viewerId?: string; communityId?: string; chatId?: string } = {}
  ): Map<string, ResolvedMention> {
    const handleSet = new Set<string>();
    for (const t of texts) {
      if (!t) continue;
      for (const h of extractMentionHandles(t)) {
        handleSet.add(h);
      }
    }

    const resolvedMap = new Map<string, ResolvedMention>();
    if (handleSet.size === 0) return resolvedMap;

    const handles = Array.from(handleSet);
    const placeholders = handles.map(() => '?').join(', ');
    const viewerId = options.viewerId || '';

    const params: any[] = [...handles];
    let scopeJoin = '';
    const extraWhere: string[] = [];

    if (options.chatId) {
      scopeJoin += ' JOIN chat_participants cp ON cp.user_id = up.user_id AND cp.chat_id = ?';
      params.unshift(options.chatId);
    } else if (options.communityId && isCommunityPrivate(options.communityId)) {
      scopeJoin += ' JOIN community_memberships cm ON cm.user_id = up.user_id AND cm.community_id = ?';
      params.unshift(options.communityId);
    }

    if (viewerId) {
      extraWhere.push(`
        NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id)
             OR (b.blocker_id = up.user_id AND b.blocked_id = ?)
        )
      `);
      params.push(viewerId, viewerId);
    }

    const rows = withReadConnection((conn) =>
      conn
        .prepare(
          `
          SELECT up.user_id, up.handle, up.name
          FROM user_profiles up
          JOIN users u ON u.id = up.user_id
          ${scopeJoin}
          WHERE u.status = 'active'
            AND LOWER(up.handle) IN (${placeholders})
            ${extraWhere.length > 0 ? 'AND ' + extraWhere.join(' AND ') : ''}
        `
        )
        .all(...params) as Array<{ user_id: string; handle: string; name: string }>
    );

    for (const r of rows) {
      resolvedMap.set(r.handle.toLowerCase(), {
        userId: r.user_id,
        handle: r.handle,
        name: r.name,
      });
    }

    return resolvedMap;
  },

  /**
   * Filters a pre-resolved handle map down to mentions actually present in a single piece of text,
   * optionally excluding mutually blocked users.
   */
  pickMentionsForText(
    text: string | null | undefined,
    resolvedMap: Map<string, ResolvedMention>,
    blockedUserIds?: Set<string>
  ): ResolvedMention[] {
    if (!text || resolvedMap.size === 0) return [];
    const handles = extractMentionHandles(text);
    const out: ResolvedMention[] = [];
    for (const h of handles) {
      const m = resolvedMap.get(h);
      if (m && (!blockedUserIds || !blockedUserIds.has(m.userId))) {
        out.push(m);
      }
    }
    return out;
  },

  /**
   * Synchronizes mention notifications on create or edit:
   * - Validates handle existence, active status, blocks, and chat/private-community scope.
   * - Respects each recipient's `notify_mentions` preference.
   * - Never notifies self, already-notified recipients (for edits), or anonymous identity leaks.
   * - Cleans up stale notifications for removed @handles on edit.
   */
  syncMentionsOnContent(input: SyncMentionsInput): {
    mentions: ResolvedMention[];
    notifiedUserIds: string[];
    validRecipientUserIds: string[];
  } {
    const handles = extractMentionHandles(input.text);
    const prefixRef = `${input.sourceType}:${input.sourceId}:`;

    if (handles.length === 0) {
      // If text was edited to remove all mentions, remove prior mention notifications for this item
      db.prepare('DELETE FROM notifications WHERE source_ref LIKE ?').run(`${prefixRef}%`);
      return { mentions: [], notifiedUserIds: [], validRecipientUserIds: [] };
    }

    const placeholders = handles.map(() => '?').join(', ');
    const queryParams: any[] = [];
    let scopeJoin = '';

    if (input.chatId) {
      scopeJoin += ' JOIN chat_participants cp ON cp.user_id = up.user_id AND cp.chat_id = ?';
      queryParams.push(input.chatId);
    } else if (input.communityId && isCommunityPrivate(input.communityId)) {
      scopeJoin += ' JOIN community_memberships cm ON cm.user_id = up.user_id AND cm.community_id = ?';
      queryParams.push(input.communityId);
    }

    queryParams.push(...handles, input.actorId, input.actorId);

    const rows = db
      .prepare(
        `
        SELECT
          up.user_id,
          up.handle,
          up.name,
          COALESCE(up.notify_mentions, 1) as notify_mentions
        FROM user_profiles up
        JOIN users u ON u.id = up.user_id
        ${scopeJoin}
        WHERE u.status = 'active'
          AND LOWER(up.handle) IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = up.user_id AND b.blocked_id = ?)
               OR (b.blocker_id = ? AND b.blocked_id = up.user_id)
          )
      `
      )
      .all(...queryParams) as Array<{
      user_id: string;
      handle: string;
      name: string;
      notify_mentions: number;
    }>;

    // Order resolved mentions consistently with appearance in text
    const rowByHandle = new Map(rows.map((r) => [r.handle.toLowerCase(), r]));
    const orderedRows = handles
      .map((h) => rowByHandle.get(h))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));

    const mentions: ResolvedMention[] = orderedRows.map((r) => ({
      userId: r.user_id,
      handle: r.handle,
      name: r.name,
    }));

    // Eligible recipients (never notify self)
    const recipientRows = orderedRows.filter((r) => r.user_id !== input.actorId);
    const validRecipientIds = new Set(recipientRows.map((r) => r.user_id));

    // Clean up mention notifications for handles that were edited out
    const existingRefs = db
      .prepare('SELECT id, user_id, source_ref FROM notifications WHERE source_ref LIKE ?')
      .all(`${prefixRef}%`) as Array<{ id: string; user_id: string; source_ref: string }>;

    const alreadyNotifiedUsers = new Set<string>();
    const staleNotifIds: string[] = [];
    for (const ref of existingRefs) {
      if (!validRecipientIds.has(ref.user_id)) {
        staleNotifIds.push(ref.id);
      } else {
        alreadyNotifiedUsers.add(ref.user_id);
      }
    }

    if (staleNotifIds.length > 0) {
      const delPlaceholders = staleNotifIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM notifications WHERE id IN (${delPlaceholders})`).run(...staleNotifIds);
    }

    if (input.createNotifications === false) {
      return {
        mentions,
        notifiedUserIds: [],
        validRecipientUserIds: Array.from(validRecipientIds),
      };
    }

    const excludeSet = new Set(input.excludeUserIds || []);
    const toNotify = recipientRows.filter(
      (r) =>
        r.notify_mentions !== 0 &&
        !alreadyNotifiedUsers.has(r.user_id) &&
        !excludeSet.has(r.user_id)
    );

    if (toNotify.length === 0) {
      return {
        mentions,
        notifiedUserIds: [],
        validRecipientUserIds: Array.from(validRecipientIds),
      };
    }

    let actorDisplayName = 'Someone (Anonymous)';
    if (!input.isAnonymous) {
      const actor = db
        .prepare('SELECT name, handle FROM user_profiles WHERE user_id = ?')
        .get(input.actorId) as { name?: string; handle?: string } | undefined;
      actorDisplayName = actor?.name ? `${actor.name}` : 'A student';
    }

    const snippet = formatMentionSnippet(input.text, 75);
    const bodyText = snippet
      ? `${actorDisplayName} mentioned you: "${snippet}"`
      : `${actorDisplayName} mentioned you in ${input.contextTitle}`;

    notificationService.createNotificationsBatch(
      toNotify.map((r) => ({
        userId: r.user_id,
        type: 'mention' as const,
        title: `Mentioned in ${input.contextTitle}`,
        body: bodyText,
        link: input.targetLink,
        sourceRef: `${prefixRef}${r.user_id}`,
        actorId: input.actorId,
      }))
    );

    return {
      mentions,
      notifiedUserIds: toNotify.map((r) => r.user_id),
      validRecipientUserIds: Array.from(validRecipientIds),
    };
  },

  /**
   * Deletes mention/interaction notifications tied to a deleted post, comment, or message.
   */
  deleteNotificationsBySource(sourceType: MentionSourceType, sourceId: string) {
    try {
      db.prepare('DELETE FROM notifications WHERE source_ref LIKE ?').run(
        `${sourceType}:${sourceId}:%`
      );
    } catch {
      // ignore on partial DB state
    }
  },

  /**
   * Context-aware mention autocomplete lookup:
   * - Direct & Group Chats: strictly restricts suggestions to chat participants (never leaks non-participants).
   * - Private Communities: restricts suggestions to community members.
   * - Public Feeds / Public Communities / Comments / Replies: suggests active non-blocked users,
   *   prioritizing exact handle prefix matches, community members, and connected friends.
   */
  getCandidates(options: {
    viewerId: string;
    query: string;
    chatId?: string;
    communityId?: string;
    limit?: number;
  }): MentionCandidate[] {
    const cleanRaw = String(options.query || '').trim().replace(/^@+/, '');
    const safeLimit = Math.min(15, Math.max(1, options.limit || 8));
    const prefixHandlePattern = `${escapeLikePattern(cleanRaw.toLowerCase())}%`;
    const containPattern = `%${escapeLikePattern(cleanRaw.toLowerCase())}%`;

    // 1. Scoped strictly to chat participants
    if (options.chatId) {
      const scopedChatId = options.chatId;
      const isParticipant = withReadConnection((conn) =>
        conn
          .prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?')
          .get(scopedChatId, options.viewerId)
      );
      if (!isParticipant) return [];

      const rows = withReadConnection((conn) =>
        conn
          .prepare(
            `
            SELECT
              up.user_id, up.name, up.handle, up.department, up.level,
              up.avatar_initials, up.avatar_bg, up.avatar_url, up.avatar_thumb_url, up.verified,
              CASE WHEN LOWER(up.handle) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END as prefix_rank
            FROM chat_participants cp
            JOIN user_profiles up ON up.user_id = cp.user_id
            JOIN users u ON u.id = up.user_id
            WHERE cp.chat_id = ?
              AND cp.user_id != ?
              AND u.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id)
                   OR (b.blocker_id = up.user_id AND b.blocked_id = ?)
              )
              AND (
                ? = ''
                OR LOWER(SUBSTR(up.handle, 2)) LIKE ? ESCAPE '\\'
                OR LOWER(up.name) LIKE ? ESCAPE '\\'
              )
            ORDER BY prefix_rank ASC, up.verified DESC, up.name ASC
            LIMIT ?
          `
          )
          .all(
            `@${prefixHandlePattern}`,
            scopedChatId,
            options.viewerId,
            options.viewerId,
            options.viewerId,
            cleanRaw,
            containPattern,
            containPattern,
            safeLimit
          ) as any[]
      );

      return rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        handle: r.handle,
        department: r.department,
        level: r.level,
        avatarInitials: r.avatar_initials,
        avatarBg: r.avatar_bg,
        avatarUrl: r.avatar_url || undefined,
        avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
        verified: Boolean(r.verified),
      }));
    }

    // 2. Private community scope check
    if (options.communityId && isCommunityPrivate(options.communityId)) {
      const scopedCommunityId = options.communityId;
      const isMember = withReadConnection((conn) =>
        conn
          .prepare('SELECT 1 FROM community_memberships WHERE community_id = ? AND user_id = ?')
          .get(scopedCommunityId, options.viewerId)
      );
      if (!isMember) return [];

      const rows = withReadConnection((conn) =>
        conn
          .prepare(
            `
            SELECT
              up.user_id, up.name, up.handle, up.department, up.level,
              up.avatar_initials, up.avatar_bg, up.avatar_url, up.avatar_thumb_url, up.verified,
              CASE WHEN LOWER(up.handle) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END as prefix_rank
            FROM community_memberships cm
            JOIN user_profiles up ON up.user_id = cm.user_id
            JOIN users u ON u.id = up.user_id
            WHERE cm.community_id = ?
              AND cm.user_id != ?
              AND u.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id)
                   OR (b.blocker_id = up.user_id AND b.blocked_id = ?)
              )
              AND (
                ? = ''
                OR LOWER(SUBSTR(up.handle, 2)) LIKE ? ESCAPE '\\'
                OR LOWER(up.name) LIKE ? ESCAPE '\\'
              )
            ORDER BY prefix_rank ASC, up.verified DESC, up.name ASC
            LIMIT ?
          `
          )
          .all(
            `@${prefixHandlePattern}`,
            scopedCommunityId,
            options.viewerId,
            options.viewerId,
            options.viewerId,
            cleanRaw,
            containPattern,
            containPattern,
            safeLimit
          ) as any[]
      );

      return rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        handle: r.handle,
        department: r.department,
        level: r.level,
        avatarInitials: r.avatar_initials,
        avatarBg: r.avatar_bg,
        avatarUrl: r.avatar_url || undefined,
        avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
        verified: Boolean(r.verified),
      }));
    }

    // 3. Global feeds, public communities, comments, and replies
    const commId = options.communityId || '';
    const rows = withReadConnection((conn) =>
      conn
        .prepare(
          `
          SELECT
            up.user_id, up.name, up.handle, up.department, up.level,
            up.avatar_initials, up.avatar_bg, up.avatar_url, up.avatar_thumb_url, up.verified,
            CASE WHEN uc.id IS NOT NULL THEN 1 ELSE 0 END as is_connected,
            CASE WHEN ? != '' AND cm.id IS NOT NULL THEN 0 ELSE 1 END as comm_rank,
            CASE WHEN LOWER(up.handle) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END as prefix_rank
          FROM user_profiles up
          JOIN users u ON u.id = up.user_id
          LEFT JOIN user_connections uc ON uc.follower_id = ? AND uc.following_id = up.user_id
          LEFT JOIN community_memberships cm ON ? != '' AND cm.community_id = ? AND cm.user_id = up.user_id
          WHERE u.status = 'active'
            AND up.user_id != ?
            AND LOWER(up.handle) != '@anonymous'
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = ? AND b.blocked_id = up.user_id)
                 OR (b.blocker_id = up.user_id AND b.blocked_id = ?)
            )
            AND (
              ? = ''
              OR LOWER(SUBSTR(up.handle, 2)) LIKE ? ESCAPE '\\'
              OR LOWER(up.name) LIKE ? ESCAPE '\\'
            )
          ORDER BY prefix_rank ASC, comm_rank ASC, is_connected DESC, up.verified DESC, up.name ASC
          LIMIT ?
        `
        )
        .all(
          commId,
          `@${prefixHandlePattern}`,
          options.viewerId,
          commId,
          commId,
          options.viewerId,
          options.viewerId,
          options.viewerId,
          cleanRaw,
          containPattern,
          containPattern,
          safeLimit
        ) as any[]
    );

    return rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      handle: r.handle,
      department: r.department,
      level: r.level,
      avatarInitials: r.avatar_initials,
      avatarBg: r.avatar_bg,
      avatarUrl: r.avatar_url || undefined,
      avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
      verified: Boolean(r.verified),
      isConnected: Boolean(r.is_connected),
    }));
  },
};
