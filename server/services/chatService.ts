import { db, runInTransaction } from '../db/database.js';
import { blockService } from './blockService.js';
import { sseManager } from '../realtime/sseManager.js';
import { presenceService } from './presenceService.js';
import { fileService } from './fileService.js';
import { notificationService } from './notificationService.js';
import { mentionService } from './mentionService.js';
import {
  extractMentionHandles,
  formatMentionSnippet,
  ResolvedMention,
} from '../utils/mentions.js';
import { escapeLikePattern, validateLocationInput } from '../utils/security.js';

export interface SendMessageInput {
  text?: string;
  location?: any;
  images?: string[];
  client_id?: string;
}

export const chatService = {
  /**
   * Purges chat messages older than 72 hours from the database
   */
  purgeExpiredMessages(): { purgedCount: number } {
    const expiredImgs = db
      .prepare(`SELECT images_json FROM messages WHERE created_at < datetime('now', '-72 hours') AND images_json IS NOT NULL`)
      .all() as Array<{ images_json: string }>;
    const candidateFiles: string[] = [];
    for (const row of expiredImgs) {
      candidateFiles.push(...fileService.extractUploadFilenames(row.images_json));
    }

    const res = runInTransaction(() => {
      const countRes = db.prepare(`
        SELECT COUNT(*) as count FROM messages WHERE created_at < datetime('now', '-72 hours')
      `).get() as { count: number };

      const purgedCount = countRes?.count || 0;

      if (purgedCount > 0) {
        db.prepare(`
          DELETE FROM messages WHERE created_at < datetime('now', '-72 hours')
        `).run();

        db.prepare(`
          UPDATE chats
          SET last_message = '(Messages expired after 72 hours)'
          WHERE id NOT IN (
            SELECT DISTINCT chat_id FROM messages
          ) AND last_message IS NOT NULL
        `).run();
      }

      return { purgedCount };
    });

    if (candidateFiles.length > 0) {
      fileService.unlinkIfUnreferenced(candidateFiles);
    }

    return res;
  },

  /**
   * Retrieves all chats for a user, enforcing the 72-hour ephemeral messaging filter
   * without N+1 per-chat query loops, and hydrates @mentions strictly within chat participants.
   */
  getUserChats(userId: string) {
    const chats = db.prepare(`
      SELECT 
        c.id,
        c.type,
        c.title,
        c.handle,
        c.subtitle,
        c.avatar_initials,
        c.avatar_bg,
        c.last_message,
        c.last_message_at,
        cp.last_read_at
      FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE cp.user_id = ?
      ORDER BY c.last_message_at DESC
    `).all(userId) as any[];

    if (chats.length === 0) return [];

    const chatIds = chats.map((c) => c.id);
    const placeholders = chatIds.map(() => '?').join(',');

    // Batch fetch 72h messages across all chats in 1 query
    const allMsgs = db.prepare(`
      SELECT 
        m.id,
        m.chat_id,
        m.client_id,
        m.text,
        m.location_json,
        m.images_json,
        m.created_at,
        m.edited_at,
        m.read_at,
        m.sender_id,
        pr.name as sender_name,
        pr.avatar_initials as sender_avatar_initials,
        pr.avatar_bg as sender_avatar_bg,
        pr.avatar_url as sender_avatar_url,
        pr.avatar_thumb_url as sender_avatar_thumb_url
      FROM messages m
      JOIN user_profiles pr ON pr.user_id = m.sender_id
      WHERE m.chat_id IN (${placeholders})
        AND m.created_at >= datetime('now', '-72 hours')
      ORDER BY m.created_at ASC
    `).all(...chatIds) as any[];

    const msgsByChat = new Map<string, any[]>();
    let hasPotentialMentions = false;
    for (const m of allMsgs) {
      if (m.text && m.text.includes('@')) hasPotentialMentions = true;
      if (!msgsByChat.has(m.chat_id)) {
        msgsByChat.set(m.chat_id, []);
      }
      msgsByChat.get(m.chat_id)!.push(m);
    }

    // Batch fetch all participants across chats (enables partner metadata, presence, & chat-scoped @mentions in 1 query)
    const allParticipants = db.prepare(`
      SELECT cp.chat_id, cp.user_id, pr.name, pr.handle, pr.avatar_initials, pr.avatar_bg, pr.avatar_url, pr.avatar_thumb_url
      FROM chat_participants cp
      JOIN users u ON u.id = cp.user_id
      JOIN user_profiles pr ON pr.user_id = cp.user_id
      WHERE cp.chat_id IN (${placeholders})
        AND u.status = 'active'
    `).all(...chatIds) as any[];

    const partnerByDirectChat = new Map<string, any>();
    const chatParticipantIds = new Map<string, string[]>();
    const participantMentionMapByChat = new Map<string, Map<string, ResolvedMention>>();
    const allOtherUserIds = new Set<string>();

    for (const row of allParticipants) {
      if (!participantMentionMapByChat.has(row.chat_id)) {
        participantMentionMapByChat.set(row.chat_id, new Map());
      }
      participantMentionMapByChat.get(row.chat_id)!.set(row.handle.toLowerCase(), {
        userId: row.user_id,
        handle: row.handle,
        name: row.name,
      });

      if (row.user_id !== userId) {
        allOtherUserIds.add(row.user_id);
        if (!partnerByDirectChat.has(row.chat_id)) {
          partnerByDirectChat.set(row.chat_id, row);
        }
        if (!chatParticipantIds.has(row.chat_id)) {
          chatParticipantIds.set(row.chat_id, []);
        }
        chatParticipantIds.get(row.chat_id)!.push(row.user_id);
      }
    }

    // Resolve all bidirectional blocks for viewer so blocked users' messages never surface in group chats or unread counts
    const blockedUserIds = new Set<string>();
    const bRows = db
      .prepare('SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?')
      .all(userId, userId) as Array<{ blocker_id: string; blocked_id: string }>;
    for (const b of bRows) {
      blockedUserIds.add(b.blocker_id === userId ? b.blocked_id : b.blocker_id);
    }

    // Genuine online visibility check (honors partner's show_online_status setting)
    const onlineUserIds = presenceService.getVisibleOnlineUserIds(Array.from(allOtherUserIds));

    return chats.map((c) => {
      const msgs = (msgsByChat.get(c.id) || []).filter(
        (m) => m.sender_id === userId || !blockedUserIds.has(m.sender_id)
      );
      const lastReadTime = c.last_read_at ? new Date(c.last_read_at).getTime() : 0;

      const unreadCount =
        c.type === 'direct'
          ? msgs.filter((m) => m.sender_id !== userId && !m.read_at).length
          : msgs.filter(
              (m) => m.sender_id !== userId && new Date(m.created_at).getTime() > lastReadTime
            ).length;

      let partnerTitle = c.title;
      let partnerHandle = c.handle;
      let partnerInitials = c.avatar_initials;
      let partnerBg = c.avatar_bg;
      let partnerAvatarUrl: string | undefined = undefined;
      let partnerAvatarThumbUrl: string | undefined = undefined;
      let isOnline = false;

      if (c.type === 'direct') {
        const partner = partnerByDirectChat.get(c.id);
        if (partner) {
          partnerTitle = partner.name;
          partnerHandle = partner.handle;
          partnerInitials = partner.avatar_initials;
          partnerBg = partner.avatar_bg;
          partnerAvatarUrl = partner.avatar_url || undefined;
          partnerAvatarThumbUrl = partner.avatar_thumb_url || partner.avatar_url || undefined;
          isOnline = onlineUserIds.has(partner.user_id);
        }
      } else {
        const members = chatParticipantIds.get(c.id) || [];
        isOnline = members.some((uid) => onlineUserIds.has(uid));
      }

      const chatMentionMap = participantMentionMapByChat.get(c.id) || new Map();

      return {
        id: c.id,
        type: c.type,
        title: partnerTitle,
        handle: partnerHandle,
        subtitle: c.subtitle,
        avatarInitials: partnerInitials,
        avatarBg: partnerBg,
        avatarUrl: partnerAvatarUrl,
        avatarThumbUrl: partnerAvatarThumbUrl,
        lastMessage: c.last_message,
        timestamp: c.last_message_at,
        unreadCount,
        isOnline,
        messages: msgs.map((m) => {
          const isMe = m.sender_id === userId;
          const isReadInDirect = c.type === 'direct' && Boolean(m.read_at);
          return {
            id: m.id,
            clientId: m.client_id || undefined,
            senderId: m.sender_id,
            senderName: isMe ? 'You' : m.sender_name,
            senderAvatarInitials: m.sender_avatar_initials || undefined,
            senderAvatarBg: m.sender_avatar_bg || undefined,
            senderAvatarUrl: m.sender_avatar_url || undefined,
            senderAvatarThumbUrl: m.sender_avatar_thumb_url || m.sender_avatar_url || undefined,
            text: m.text || '',
            mentions: mentionService.pickMentionsForText(m.text, chatMentionMap, blockedUserIds),
            isEdited: Boolean(m.edited_at),
            timestamp: m.created_at,
            isMe,
            status: (isMe && isReadInDirect ? 'read' : 'sent') as 'sent' | 'read',
            readAt: isReadInDirect ? m.read_at : undefined,
            location: m.location_json ? JSON.parse(m.location_json) : undefined,
            images: m.images_json ? JSON.parse(m.images_json) : undefined,
          };
        }),
      };
    });
  },

  /**
   * Internal helper to record conversation read state & dispatch direct-chat read receipts via SSE
   */
  _markConversationReadInternal(chatId: string, userId: string, chatType: string) {
    const readAt = new Date().toISOString();
    db.prepare(`
      UPDATE chat_participants
      SET last_read_at = CURRENT_TIMESTAMP
      WHERE chat_id = ? AND user_id = ?
    `).run(chatId, userId);

    let messageIds: string[] = [];
    let senderIds: string[] = [];

    if (chatType === 'direct') {
      const unreadRows = db.prepare(`
        SELECT id, sender_id
        FROM messages
        WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL
      `).all(chatId, userId) as Array<{ id: string; sender_id: string }>;

      if (unreadRows.length > 0) {
        messageIds = unreadRows.map((r) => r.id);
        senderIds = Array.from(new Set(unreadRows.map((r) => r.sender_id)));

        db.prepare(`
          UPDATE messages
          SET read_at = ?
          WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL
        `).run(readAt, chatId, userId);
      }
    }

    const payload = {
      chatId,
      userId,
      readByUserId: userId,
      messageIds,
      readAt,
    };

    if (senderIds.length > 0) {
      sseManager.broadcastToUsers([userId, ...senderIds], 'message:read', payload);
    } else {
      sseManager.broadcastToUser(userId, 'message:read', payload);
    }

    return { readAt, messageIds };
  },

  /**
   * Retrieves messages for a specific conversation, with 72-hour expiry enforcement
   */
  getChatMessages(chatId: string, userId: string) {
    // Security check: verify user is a participant and read chat type
    const membership = db.prepare(`
      SELECT c.type
      FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE c.id = ? AND cp.user_id = ?
    `).get(chatId, userId) as { type: string } | undefined;

    if (!membership) {
      throw new Error('Access denied. You are not a participant in this conversation.');
    }

    const messages = db.prepare(`
      SELECT 
        m.id,
        m.client_id,
        m.text,
        m.location_json,
        m.images_json,
        m.created_at,
        m.edited_at,
        m.read_at,
        m.sender_id,
        pr.name as sender_name,
        pr.avatar_initials as sender_avatar_initials,
        pr.avatar_bg as sender_avatar_bg,
        pr.avatar_url as sender_avatar_url,
        pr.avatar_thumb_url as sender_avatar_thumb_url
      FROM messages m
      JOIN user_profiles pr ON pr.user_id = m.sender_id
      WHERE m.chat_id = ?
        AND m.created_at >= datetime('now', '-72 hours')
        AND (
          m.sender_id = ?
          OR m.sender_id NOT IN (
            SELECT blocked_id FROM user_blocks WHERE blocker_id = ?
            UNION
            SELECT blocker_id FROM user_blocks WHERE blocked_id = ?
          )
        )
      ORDER BY m.created_at ASC
    `).all(chatId, userId, userId, userId) as any[];

    const resolvedMentionMap = mentionService.resolveHandlesBatch(
      messages.map((m) => m.text),
      { viewerId: userId, chatId }
    );

    // Mark chat as read for recipient and notify direct-chat senders if any incoming messages were unread
    this._markConversationReadInternal(chatId, userId, membership.type);

    return messages.map((m) => {
      const isMe = m.sender_id === userId;
      const isReadInDirect = membership.type === 'direct' && Boolean(m.read_at);
      return {
        id: m.id,
        clientId: m.client_id || undefined,
        senderId: m.sender_id,
        senderName: isMe ? 'You' : m.sender_name,
        senderAvatarInitials: m.sender_avatar_initials || undefined,
        senderAvatarBg: m.sender_avatar_bg || undefined,
        senderAvatarUrl: m.sender_avatar_url || undefined,
        senderAvatarThumbUrl: m.sender_avatar_thumb_url || m.sender_avatar_url || undefined,
        text: m.text || '',
        mentions: mentionService.pickMentionsForText(m.text, resolvedMentionMap),
        isEdited: Boolean(m.edited_at),
        timestamp: m.created_at,
        isMe,
        status: (isMe && isReadInDirect ? 'read' : 'sent') as 'sent' | 'read',
        readAt: isReadInDirect ? m.read_at : undefined,
        location: m.location_json ? JSON.parse(m.location_json) : undefined,
        images: m.images_json ? JSON.parse(m.images_json) : undefined,
      };
    });
  },

  /**
   * Paginated latest-window messages for long group or DM threads (never cached in shared memory).
   */
  getChatMessagesPaginated(chatId: string, userId: string, limit = 60, offset = 0) {
    const membership = db.prepare(`
      SELECT c.type
      FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE c.id = ? AND cp.user_id = ?
    `).get(chatId, userId) as { type: string } | undefined;

    if (!membership) {
      throw new Error('Access denied. You are not a participant in this conversation.');
    }

    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);

    const totalRow = db.prepare(`
      SELECT COUNT(*) as c FROM messages
      WHERE chat_id = ?
        AND created_at >= datetime('now', '-72 hours')
        AND (
          sender_id = ?
          OR sender_id NOT IN (
            SELECT blocked_id FROM user_blocks WHERE blocker_id = ?
            UNION
            SELECT blocker_id FROM user_blocks WHERE blocked_id = ?
          )
        )
    `).get(chatId, userId, userId, userId) as { c: number } | undefined;
    const total = Number(totalRow?.c || 0);

    const rowsDesc = db.prepare(`
      SELECT 
        m.id,
        m.client_id,
        m.text,
        m.location_json,
        m.images_json,
        m.created_at,
        m.edited_at,
        m.read_at,
        m.sender_id,
        pr.name as sender_name,
        pr.avatar_initials as sender_avatar_initials,
        pr.avatar_bg as sender_avatar_bg,
        pr.avatar_url as sender_avatar_url,
        pr.avatar_thumb_url as sender_avatar_thumb_url
      FROM messages m
      JOIN user_profiles pr ON pr.user_id = m.sender_id
      WHERE m.chat_id = ?
        AND m.created_at >= datetime('now', '-72 hours')
        AND (
          m.sender_id = ?
          OR m.sender_id NOT IN (
            SELECT blocked_id FROM user_blocks WHERE blocker_id = ?
            UNION
            SELECT blocker_id FROM user_blocks WHERE blocked_id = ?
          )
        )
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(chatId, userId, userId, userId, safeLimit, safeOffset) as any[];

    const chronological = rowsDesc.reverse();
    const resolvedMentionMap = mentionService.resolveHandlesBatch(
      chronological.map((m) => m.text),
      { viewerId: userId, chatId }
    );

    if (safeOffset === 0) {
      this._markConversationReadInternal(chatId, userId, membership.type);
    }

    const nextOffset = safeOffset + rowsDesc.length;
    return {
      messages: chronological.map((m) => {
        const isMe = m.sender_id === userId;
        const isReadInDirect = membership.type === 'direct' && Boolean(m.read_at);
        return {
          id: m.id,
          clientId: m.client_id || undefined,
          senderId: m.sender_id,
          senderName: isMe ? 'You' : m.sender_name,
          senderAvatarInitials: m.sender_avatar_initials || undefined,
          senderAvatarBg: m.sender_avatar_bg || undefined,
          senderAvatarUrl: m.sender_avatar_url || undefined,
          senderAvatarThumbUrl: m.sender_avatar_thumb_url || m.sender_avatar_url || undefined,
          text: m.text || '',
          mentions: mentionService.pickMentionsForText(m.text, resolvedMentionMap),
          isEdited: Boolean(m.edited_at),
          timestamp: m.created_at,
          isMe,
          status: (isMe && isReadInDirect ? 'read' : 'sent') as 'sent' | 'read',
          readAt: isReadInDirect ? m.read_at : undefined,
          location: m.location_json ? JSON.parse(m.location_json) : undefined,
          images: m.images_json ? JSON.parse(m.images_json) : undefined,
        };
      }),
      total,
      hasMore: nextOffset < total,
      nextOffset,
    };
  },

  /**
   * Marks a conversation as read for the user and broadcasts read receipt
   */
  markChatAsRead(chatId: string, userId: string) {
    const membership = db.prepare(`
      SELECT c.type
      FROM chats c
      JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE c.id = ? AND cp.user_id = ?
    `).get(chatId, userId) as { type: string } | undefined;

    if (!membership) {
      throw new Error('Access denied. You are not a participant in this conversation.');
    }

    const readInfo = this._markConversationReadInternal(chatId, userId, membership.type);

    return {
      success: true,
      chatId,
      readCount: readInfo.messageIds.length,
      readAt: readInfo.readAt,
    };
  },

  /**
   * Sends a message with duplicate prevention via client_id, participant-scoped @mentions,
   * notification preference enforcement, and real-time SSE broadcast in O(1) queries.
   */
  sendMessage(chatId: string, senderId: string, input: SendMessageInput) {
    // Security check 1 & 2 (joined in 1 query): verify participation, block status, handles, preferences & metadata
    const participants = db.prepare(`
      SELECT
        cp.user_id,
        c.title as chat_title,
        c.type as chat_type,
        sender_pr.name as sender_name,
        sender_pr.handle as sender_handle,
        sender_pr.avatar_initials as sender_avatar_initials,
        sender_pr.avatar_bg as sender_avatar_bg,
        sender_pr.avatar_url as sender_avatar_url,
        sender_pr.avatar_thumb_url as sender_avatar_thumb_url,
        part_pr.name as part_name,
        part_pr.handle as part_handle,
        COALESCE(part_pr.notify_mentions, 1) as part_notify_mentions,
        COALESCE(part_pr.notify_messages, 1) as part_notify_messages,
        CASE WHEN ub_blocked_sender.id IS NOT NULL THEN 1 ELSE 0 END as blocked_sender,
        CASE WHEN ub_sender_blocked.id IS NOT NULL THEN 1 ELSE 0 END as sender_blocked
      FROM chat_participants cp
      JOIN chats c ON c.id = cp.chat_id
      LEFT JOIN user_profiles sender_pr ON sender_pr.user_id = ?
      LEFT JOIN user_profiles part_pr ON part_pr.user_id = cp.user_id
      LEFT JOIN user_blocks ub_blocked_sender
        ON ub_blocked_sender.blocker_id = cp.user_id AND ub_blocked_sender.blocked_id = ?
      LEFT JOIN user_blocks ub_sender_blocked
        ON ub_sender_blocked.blocker_id = ? AND ub_sender_blocked.blocked_id = cp.user_id
      WHERE cp.chat_id = ?
    `).all(senderId, senderId, senderId, chatId) as Array<{
      user_id: string;
      chat_title: string;
      chat_type: string;
      sender_name: string | null;
      sender_handle: string | null;
      sender_avatar_initials: string | null;
      sender_avatar_bg: string | null;
      sender_avatar_url: string | null;
      sender_avatar_thumb_url: string | null;
      part_name: string | null;
      part_handle: string | null;
      part_notify_mentions: number;
      part_notify_messages: number;
      blocked_sender: number;
      sender_blocked: number;
    }>;

    const senderRow = participants.find((p) => p.user_id === senderId);
    if (!senderRow) {
      throw new Error('Access denied. You cannot send messages to this conversation.');
    }

    const otherParticipants = participants.filter((p) => p.user_id !== senderId);
    for (const part of otherParticipants) {
      if (part.blocked_sender) {
        throw new Error('Communication restricted: You cannot message a student who has blocked you.');
      }
      if (part.sender_blocked) {
        throw new Error('Communication restricted: You have blocked this student. Unblock them first to message.');
      }
    }

    // Duplicate prevention: check if client_id already exists in this chat
    if (input.client_id) {
      const existing = db.prepare(`
        SELECT 
          m.id, m.client_id, m.text, m.location_json, m.images_json, m.created_at, m.edited_at, m.read_at, m.sender_id,
          pr.name as sender_name,
          pr.avatar_initials as sender_avatar_initials,
          pr.avatar_bg as sender_avatar_bg,
          pr.avatar_url as sender_avatar_url,
          pr.avatar_thumb_url as sender_avatar_thumb_url
        FROM messages m
        JOIN user_profiles pr ON pr.user_id = m.sender_id
        WHERE m.chat_id = ? AND m.client_id = ?
      `).get(chatId, input.client_id) as any;

      if (existing) {
        const participantByHandle = new Map<string, ResolvedMention>();
        for (const p of participants) {
          if (p.part_handle && p.part_name) {
            participantByHandle.set(p.part_handle.toLowerCase(), {
              userId: p.user_id,
              handle: p.part_handle,
              name: p.part_name,
            });
          }
        }
        const isMe = existing.sender_id === senderId;
        const isReadInDirect = senderRow.chat_type === 'direct' && Boolean(existing.read_at);
        return {
          id: existing.id,
          clientId: existing.client_id,
          chatId,
          senderId: existing.sender_id,
          senderName: isMe ? 'You' : existing.sender_name,
          senderAvatarInitials: existing.sender_avatar_initials || undefined,
          senderAvatarBg: existing.sender_avatar_bg || undefined,
          senderAvatarUrl: existing.sender_avatar_url || undefined,
          senderAvatarThumbUrl: existing.sender_avatar_thumb_url || existing.sender_avatar_url || undefined,
          text: existing.text || '',
          mentions: mentionService.pickMentionsForText(existing.text, participantByHandle),
          isEdited: Boolean(existing.edited_at),
          timestamp: existing.created_at,
          isMe,
          status: (isMe && isReadInDirect ? 'read' : 'sent') as 'sent' | 'read',
          readAt: isReadInDirect ? existing.read_at : undefined,
          location: existing.location_json ? JSON.parse(existing.location_json) : undefined,
          images: existing.images_json ? JSON.parse(existing.images_json) : undefined,
        };
      }
    }

    const cleanText = typeof input.text === 'string' ? input.text.trim() : '';
    const rawImages = Array.isArray(input.images) ? input.images : [];
    if (rawImages.length > 4) {
      throw new Error('Maximum of 4 images allowed per message.');
    }
    const sanitizedLocation = input.location ? validateLocationInput(input.location) : undefined;
    if (!cleanText && !sanitizedLocation && rawImages.length === 0) {
      throw new Error('Message cannot be empty.');
    }

    // Match @mentions strictly against active chat participants using data from Query #1 (0 extra queries)
    const participantByHandle = new Map<string, ResolvedMention>();
    for (const p of participants) {
      if (p.part_handle && p.part_name) {
        participantByHandle.set(p.part_handle.toLowerCase(), {
          userId: p.user_id,
          handle: p.part_handle,
          name: p.part_name,
        });
      }
    }
    const mentionedHandles = extractMentionHandles(cleanText);
    const resolvedMentions: ResolvedMention[] = [];
    const mentionedRecipientIds = new Set<string>();
    for (const h of mentionedHandles) {
      const m = participantByHandle.get(h);
      if (m) {
        resolvedMentions.push(m);
        if (m.userId !== senderId) {
          mentionedRecipientIds.add(m.userId);
        }
      }
    }

    return runInTransaction(() => {
      const messageId = `m-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const locationJson = sanitizedLocation ? JSON.stringify(sanitizedLocation) : null;
      const externalImages = fileService.externalizeImages(rawImages.length > 0 ? rawImages : undefined, senderId);
      const imagesJson = externalImages && externalImages.length > 0 ? JSON.stringify(externalImages) : null;

      db.prepare(`
        INSERT INTO messages (id, chat_id, sender_id, text, location_json, images_json, client_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, chatId, senderId, cleanText, locationJson, imagesJson, input.client_id || null);

      let lastMessagePreview = cleanText;
      if (!lastMessagePreview) {
        if (sanitizedLocation) lastMessagePreview = `📍 Pinned spot: ${sanitizedLocation.name}`;
        else if (externalImages && externalImages.length > 0) lastMessagePreview = '📷 [Photo attachment]';
      }

      db.prepare(`
        UPDATE chats
        SET last_message = ?, last_message_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(lastMessagePreview, chatId);

      // Update sender's last_read_at
      db.prepare(`
        UPDATE chat_participants
        SET last_read_at = CURRENT_TIMESTAMP
        WHERE chat_id = ? AND user_id = ?
      `).run(chatId, senderId);

      const messagePayload = {
        id: messageId,
        clientId: input.client_id || undefined,
        chatId,
        senderId,
        senderName: senderRow.sender_name || 'Student',
        senderHandle: senderRow.sender_handle || '@student',
        senderAvatarInitials: senderRow.sender_avatar_initials || undefined,
        senderAvatarBg: senderRow.sender_avatar_bg || undefined,
        senderAvatarUrl: senderRow.sender_avatar_url || undefined,
        senderAvatarThumbUrl: senderRow.sender_avatar_thumb_url || senderRow.sender_avatar_url || undefined,
        text: cleanText,
        mentions: resolvedMentions,
        isEdited: false,
        timestamp: new Date().toISOString(),
        location: sanitizedLocation,
        images: externalImages,
        status: 'sent' as const,
      };

      const recipientIds = otherParticipants.map((p) => p.user_id);

      // Real-time broadcast to already-resolved participants (avoids re-querying chat_participants)
      if (recipientIds.length > 0) {
        sseManager.broadcastToUsers(recipientIds, 'message:new', messagePayload);

        const defaultTitle =
          senderRow.chat_type === 'direct'
            ? `Message from ${senderRow.sender_name || 'a student'}`
            : `New dispatch in ${senderRow.chat_title || 'Group'}`;
        const mentionTitle =
          senderRow.chat_type === 'direct'
            ? `${senderRow.sender_name || 'Someone'} mentioned you`
            : `Mentioned in ${senderRow.chat_title || 'Group'}`;
        const snippet = formatMentionSnippet(lastMessagePreview, 80);

        const notifInputs = [];
        for (const p of otherParticipants) {
          if (mentionedRecipientIds.has(p.user_id)) {
            if (p.part_notify_mentions !== 0) {
              notifInputs.push({
                userId: p.user_id,
                type: 'mention' as const,
                title: mentionTitle,
                body: `${senderRow.sender_name || 'Someone'} tagged you: "${snippet}"`,
                link: `/chats?conv=${chatId}`,
                sourceRef: `msg:${messageId}:${p.user_id}`,
                actorId: senderId,
              });
            }
          } else if (p.part_notify_messages !== 0) {
            notifInputs.push({
              userId: p.user_id,
              type: 'message' as const,
              title: defaultTitle,
              body: snippet,
              link: `/chats?conv=${chatId}`,
              actorId: senderId,
            });
          }
        }

        if (notifInputs.length > 0) {
          notificationService.createNotificationsBatch(notifInputs);
        }
      }

      return {
        id: messageId,
        clientId: input.client_id || undefined,
        chatId,
        senderId,
        senderName: 'You',
        senderAvatarInitials: senderRow.sender_avatar_initials || undefined,
        senderAvatarBg: senderRow.sender_avatar_bg || undefined,
        senderAvatarUrl: senderRow.sender_avatar_url || undefined,
        senderAvatarThumbUrl: senderRow.sender_avatar_thumb_url || senderRow.sender_avatar_url || undefined,
        text: cleanText,
        mentions: resolvedMentions,
        isEdited: false,
        timestamp: 'Just now',
        isMe: true,
        status: 'sent' as const,
        location: sanitizedLocation,
        images: externalImages,
      };
    });
  },

  /**
   * Edits an existing chat message (sender-only within 72h), diffs/notifies newly added mentions,
   * updates last_message preview if latest, and pushes real-time `message:updated` SSE event.
   */
  editMessage(chatId: string, messageId: string, userId: string, text: string) {
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Message text cannot be empty.');
    }

    const updated = runInTransaction(() => {
      const row = db
        .prepare(
          `
          SELECT m.id, m.chat_id, m.sender_id, m.created_at, c.title as chat_title, c.type as chat_type
          FROM messages m
          JOIN chats c ON c.id = m.chat_id
          WHERE m.id = ? AND m.chat_id = ? AND m.created_at >= datetime('now', '-72 hours')
        `
        )
        .get(messageId, chatId) as
        | {
            id: string;
            chat_id: string;
            sender_id: string;
            created_at: string;
            chat_title: string;
            chat_type: string;
          }
        | undefined;

      if (!row) {
        throw new Error('Message not found or has expired after 72 hours.');
      }

      if (row.sender_id !== userId) {
        throw new Error('Only the sender can edit this message.');
      }

      db.prepare(`
        UPDATE messages
        SET text = ?, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cleanText, messageId);

      // Update chat last_message if this edited message is the latest message in chat
      const latestMsg = db
        .prepare(
          `SELECT id FROM messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(chatId) as { id: string } | undefined;

      if (latestMsg?.id === messageId) {
        db.prepare(`UPDATE chats SET last_message = ? WHERE id = ?`).run(cleanText, chatId);
      }

      const mentionSync = mentionService.syncMentionsOnContent({
        text: cleanText,
        sourceType: 'msg',
        sourceId: messageId,
        actorId: userId,
        targetLink: `/chats?conv=${chatId}`,
        contextTitle: row.chat_type === 'direct' ? 'direct chat' : row.chat_title,
        chatId,
      });

      const participants = db
        .prepare('SELECT user_id FROM chat_participants WHERE chat_id = ?')
        .all(chatId) as Array<{ user_id: string }>;

      const payload = {
        id: messageId,
        chatId,
        text: cleanText,
        mentions: mentionSync.mentions,
        isEdited: true,
        isLatest: latestMsg?.id === messageId,
      };

      sseManager.broadcastToUsers(
        participants.map((p) => p.user_id),
        'message:updated',
        payload
      );

      return payload;
    });

    return updated;
  },

  /**
   * Deletes an individual chat message (sender or admin), removes orphan mention notifications & media,
   * refreshes `chats.last_message`, and broadcasts `message:deleted` over SSE.
   */
  deleteMessage(chatId: string, messageId: string, userId: string, userRole: string) {
    const existing = db
      .prepare('SELECT id, sender_id, images_json FROM messages WHERE id = ? AND chat_id = ?')
      .get(messageId, chatId) as
      | { id: string; sender_id: string; images_json: string | null }
      | undefined;

    if (!existing) {
      throw new Error('Message not found.');
    }

    if (existing.sender_id !== userId && userRole !== 'admin') {
      throw new Error('Unauthorized to delete this message.');
    }

    const res = runInTransaction(() => {
      db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
      mentionService.deleteNotificationsBySource('msg', messageId);

      const latest = db
        .prepare(
          `SELECT text, location_json, images_json FROM messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(chatId) as { text: string | null; location_json: string | null; images_json: string | null } | undefined;

      let nextLastMessage = 'No messages yet.';
      if (latest) {
        if (latest.text) nextLastMessage = latest.text;
        else if (latest.location_json) nextLastMessage = '📍 Pinned location';
        else if (latest.images_json) nextLastMessage = '📷 [Photo attachment]';
      }

      db.prepare('UPDATE chats SET last_message = ? WHERE id = ?').run(nextLastMessage, chatId);

      const participants = db
        .prepare('SELECT user_id FROM chat_participants WHERE chat_id = ?')
        .all(chatId) as Array<{ user_id: string }>;

      sseManager.broadcastToUsers(
        participants.map((p) => p.user_id),
        'message:deleted',
        { id: messageId, chatId, nextLastMessage }
      );

      return { success: true, deletedMessageId: messageId, chatId, nextLastMessage };
    });

    const candidateFiles = fileService.extractUploadFilenames(existing.images_json);
    if (candidateFiles.length > 0) {
      fileService.unlinkIfUnreferenced(candidateFiles);
    }

    return res;
  },

  /**
   * Creates or returns an existing direct conversation between two users
   */
  createDirectChat(creatorId: string, targetUserId: string) {
    if (creatorId === targetUserId) {
      throw new Error('You cannot start a direct chat with yourself.');
    }

    if (blockService.isBlockedEitherWay(creatorId, targetUserId)) {
      throw new Error('Communication restricted: Cannot start direct conversation due to active block.');
    }

    // Check if direct chat already exists between these 2 users
    const existing = db.prepare(`
      SELECT c.id
      FROM chats c
      JOIN chat_participants p1 ON p1.chat_id = c.id AND p1.user_id = ?
      JOIN chat_participants p2 ON p2.chat_id = c.id AND p2.user_id = ?
      WHERE c.type = 'direct'
    `).get(creatorId, targetUserId) as { id: string } | undefined;

    if (existing) {
      return { chatId: existing.id, isNew: false };
    }

    return runInTransaction(() => {
      const chatId = `conv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const targetProfile = db.prepare('SELECT name, handle, avatar_initials, avatar_bg FROM user_profiles WHERE user_id = ?').get(targetUserId) as any;

      db.prepare(`
        INSERT INTO chats (id, type, title, handle, subtitle, avatar_initials, avatar_bg, last_message)
        VALUES (?, 'direct', ?, ?, 'Direct Chat', ?, ?, 'Conversation opened.')
      `).run(
        chatId,
        targetProfile?.name || 'Student',
        targetProfile?.handle || '@student',
        targetProfile?.avatar_initials || 'ST',
        targetProfile?.avatar_bg || 'bg-stone-800 text-stone-100'
      );

      db.prepare('INSERT INTO chat_participants (id, chat_id, user_id, role) VALUES (?, ?, ?, ?)').run(`cp-${Date.now()}-1`, chatId, creatorId, 'member');
      db.prepare('INSERT INTO chat_participants (id, chat_id, user_id, role, last_read_at) VALUES (?, ?, ?, ?, NULL)').run(`cp-${Date.now()}-2`, chatId, targetUserId, 'member');

      return { chatId, isNew: true };
    });
  },

  /**
   * Searches eligible registered students for starting permitted direct chats
   * Excludes self and excluded blocked students
   */
  searchEligiblePartners(userId: string, query: string, limit = 15) {
    const q = `%${escapeLikePattern(query.trim())}%`;
    const safeLimit = Math.min(30, Math.max(1, limit));
    const permitted = db.prepare(`
      SELECT p.user_id, p.name, p.handle, p.department, p.level, p.avatar_initials, p.avatar_bg, p.avatar_url, p.avatar_thumb_url, p.verified
      FROM user_profiles p
      LEFT JOIN user_blocks ub1 ON ub1.blocker_id = ? AND ub1.blocked_id = p.user_id
      LEFT JOIN user_blocks ub2 ON ub2.blocker_id = p.user_id AND ub2.blocked_id = ?
      WHERE p.user_id != ?
        AND ub1.id IS NULL
        AND ub2.id IS NULL
        AND (p.name LIKE ? ESCAPE '\\' OR p.handle LIKE ? ESCAPE '\\' OR p.department LIKE ? ESCAPE '\\')
      LIMIT ?
    `).all(userId, userId, userId, q, q, q, safeLimit) as any[];

    return permitted.map((c) => ({
      userId: c.user_id,
      name: c.name,
      handle: c.handle,
      department: c.department,
      level: c.level,
      avatarInitials: c.avatar_initials,
      avatarBg: c.avatar_bg,
      avatarUrl: c.avatar_url || undefined,
      avatarThumbUrl: c.avatar_thumb_url || c.avatar_url || undefined,
      verified: Boolean(c.verified),
    }));
  },
};
