import crypto from 'crypto';
import { db } from '../db/database';

export const blockService = {
  blockUser(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new Error('You cannot block your own account.');
    }

    const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(blockedId);
    if (!targetUser) {
      throw new Error('Target student account not found.');
    }

    const existing = db.prepare(`
      SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?
    `).get(blockerId, blockedId);

    if (existing) {
      return { success: true, message: 'User is already blocked.' };
    }

    const id = `blk-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO user_blocks (id, blocker_id, blocked_id)
      VALUES (?, ?, ?)
    `).run(id, blockerId, blockedId);

    db.prepare(`
      DELETE FROM user_connections
      WHERE (follower_id = ? AND following_id = ?)
         OR (follower_id = ? AND following_id = ?)
    `).run(blockerId, blockedId, blockedId, blockerId);

    return { success: true, message: 'User has been blocked from direct communication.' };
  },

  unblockUser(blockerId: string, blockedId: string) {
    db.prepare(`
      DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?
    `).run(blockerId, blockedId);

    return { success: true, message: 'User has been unblocked.' };
  },

  getBlockedUsers(userId: string) {
    const rows = db.prepare(`
      SELECT b.id as block_id, b.blocked_id, b.created_at, pr.name, pr.handle, pr.department, pr.avatar_initials, pr.avatar_bg, pr.avatar_url, pr.avatar_thumb_url
      FROM user_blocks b
      JOIN user_profiles pr ON pr.user_id = b.blocked_id
      WHERE b.blocker_id = ?
      ORDER BY b.created_at DESC
    `).all(userId) as any[];

    return rows.map((r) => ({
      blockId: r.block_id,
      userId: r.blocked_id,
      name: r.name,
      handle: r.handle,
      department: r.department,
      avatarInitials: r.avatar_initials,
      avatarBg: r.avatar_bg,
      avatarUrl: r.avatar_url || undefined,
      avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
      blockedAt: r.created_at,
    }));
  },

  isBlocked(blockerId: string, blockedId: string): boolean {
    const row = db.prepare(`
      SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?
    `).get(blockerId, blockedId);
    return Boolean(row);
  },

  isBlockedEitherWay(userA: string, userB: string): boolean {
    const row = db.prepare(`
      SELECT 1 FROM user_blocks
      WHERE (blocker_id = ? AND blocked_id = ?)
         OR (blocker_id = ? AND blocked_id = ?)
    `).get(userA, userB, userB, userA);
    return Boolean(row);
  },
};
