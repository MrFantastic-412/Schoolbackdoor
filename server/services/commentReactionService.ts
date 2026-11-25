import { db, runInTransaction } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { mentionService } from './mentionService.js';
import { notificationService } from './notificationService.js';
import { fileService, PROTECTION_MODE_MAX_UPLOAD_BYTES } from './fileService.js';
import { deletionService } from './deletionService.js';

function assertNotBlockedOnPost(userId: string, postAuthorId: string, isAnonymous: number | boolean) {
  if (!userId || userId === postAuthorId || Boolean(isAnonymous)) return;
  const blocked = db
    .prepare(
      `SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
    )
    .get(userId, postAuthorId, postAuthorId, userId);
  if (blocked) {
    throw new Error('Interaction unavailable due to privacy or block settings.');
  }
}

export const commentReactionService = {
  toggleLike(postId: string, userId: string) {
    const result = runInTransaction(() => {
      const post = db
        .prepare(
          `SELECT id, author_id, is_anonymous FROM posts WHERE id = ? AND COALESCE(is_hidden, 0) = 0 AND created_at >= datetime('now', '-72 hours')`
        )
        .get(postId) as { id: string; author_id: string; is_anonymous: number } | undefined;
      if (!post) {
        throw new Error('Dispatch not found or has expired after 72 hours.');
      }
      assertNotBlockedOnPost(userId, post.author_id, post.is_anonymous);

      const existingLike = db.prepare(`
        SELECT id FROM likes WHERE post_id = ? AND user_id = ?
      `).get(postId, userId) as { id: string } | undefined;

      if (existingLike) {
        db.prepare('DELETE FROM likes WHERE id = ?').run(existingLike.id);
        db.prepare(`
          UPDATE posts
          SET likes_count = MAX(0, likes_count - 1), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(postId);

        const updated = db.prepare('SELECT likes_count FROM posts WHERE id = ?').get(postId) as { likes_count: number };
        return { isLiked: false, likes: updated?.likes_count ?? 0 };
      } else {
        const likeId = `l-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        db.prepare(`
          INSERT INTO likes (id, post_id, user_id)
          VALUES (?, ?, ?)
        `).run(likeId, postId, userId);

        db.prepare(`
          UPDATE posts
          SET likes_count = likes_count + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(postId);

        // Notify post author if not self
        if (post.author_id !== userId) {
          const authorProfile = db.prepare('SELECT name FROM user_profiles WHERE user_id = ?').get(userId) as { name: string } | undefined;
          notificationService.createNotification({
            userId: post.author_id,
            type: 'like',
            title: 'New reaction',
            body: `${authorProfile?.name || 'A student'} liked your dispatch`,
            link: `/home?post=${postId}`,
            actorId: userId,
          });
        }

        const updated = db.prepare('SELECT likes_count FROM posts WHERE id = ?').get(postId) as { likes_count: number };
        return { isLiked: true, likes: updated?.likes_count ?? 0 };
      }
    });
    cache.invalidatePrefix('posts:');
    return result;
  },

  toggleRepost(postId: string, userId: string) {
    const result = runInTransaction(() => {
      const post = db
        .prepare(
          `SELECT id, author_id, is_anonymous FROM posts WHERE id = ? AND COALESCE(is_hidden, 0) = 0 AND created_at >= datetime('now', '-72 hours')`
        )
        .get(postId) as { id: string; author_id: string; is_anonymous: number } | undefined;
      if (!post) {
        throw new Error('Post not found or has expired after 72 hours.');
      }
      assertNotBlockedOnPost(userId, post.author_id, post.is_anonymous);

      const existing = db
        .prepare('SELECT id FROM post_reposts WHERE post_id = ? AND user_id = ?')
        .get(postId, userId) as { id: string } | undefined;

      if (existing) {
        db.prepare('DELETE FROM post_reposts WHERE id = ?').run(existing.id);
        db.prepare(`
          UPDATE posts
          SET reposts_count = MAX(0, reposts_count - 1), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(postId);

        const updated = db.prepare('SELECT reposts_count FROM posts WHERE id = ?').get(postId) as { reposts_count: number };
        return { isReposted: false, reposts: updated?.reposts_count ?? 0 };
      } else {
        const repostId = `rp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        db.prepare(`
          INSERT INTO post_reposts (id, post_id, user_id)
          VALUES (?, ?, ?)
        `).run(repostId, postId, userId);

        db.prepare(`
          UPDATE posts
          SET reposts_count = reposts_count + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(postId);

        if (post.author_id !== userId) {
          const reposter = db.prepare('SELECT name FROM user_profiles WHERE user_id = ?').get(userId) as { name: string } | undefined;
          notificationService.createNotification({
            userId: post.author_id,
            type: 'like',
            title: 'Post reposted',
            body: `${reposter?.name || 'A student'} reposted your post`,
            link: `/home?post=${postId}`,
            actorId: userId,
          });
        }

        const updated = db.prepare('SELECT reposts_count FROM posts WHERE id = ?').get(postId) as { reposts_count: number };
        return { isReposted: true, reposts: updated?.reposts_count ?? 0 };
      }
    });
    cache.invalidatePrefix('posts:');
    return result;
  },

  addComment(
    postId: string,
    authorId: string,
    content: string,
    parentCommentId?: string,
    rawImages?: string[]
  ) {
    const cleanContent = typeof content === 'string' ? content.trim() : '';
    const imageList = Array.isArray(rawImages) ? rawImages : [];
    if (imageList.length > 4) {
      throw new Error('You can attach up to 4 images per comment.');
    }
    if (!cleanContent && imageList.length === 0) {
      throw new Error('Comment content or an image attachment is required.');
    }
    if (cleanContent.length > 2000) {
      throw new Error('Comment exceeds maximum length of 2000 characters.');
    }

    const protectionActive = imageList.length > 0 && deletionService.isStorageProtectionActive().active;
    const externalImages =
      imageList.length > 0
        ? fileService.externalizeImages(imageList, authorId, {
            maxBytesOverride: protectionActive ? PROTECTION_MODE_MAX_UPLOAD_BYTES : undefined,
          })
        : undefined;

    try {
      const result = runInTransaction(() => {
        const post = db
          .prepare(
            `SELECT id, author_id, community_id, is_anonymous FROM posts WHERE id = ? AND COALESCE(is_hidden, 0) = 0 AND created_at >= datetime('now', '-72 hours')`
          )
          .get(postId) as
          | { id: string; author_id: string; community_id: string | null; is_anonymous: number }
          | undefined;
        if (!post) {
          throw new Error('Dispatch not found or has expired after 72 hours.');
        }
        assertNotBlockedOnPost(authorId, post.author_id, post.is_anonymous);

        let parentAuthorId: string | undefined;
        if (parentCommentId) {
          const parent = db
            .prepare('SELECT id, author_id FROM comments WHERE id = ? AND post_id = ?')
            .get(parentCommentId, postId) as { id: string; author_id: string } | undefined;
          if (!parent) {
            throw new Error('Parent comment not found.');
          }
          parentAuthorId = parent.author_id;
        }

        const commentId = `c-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        db.prepare(`
          INSERT INTO comments (id, post_id, author_id, content, images_json, parent_comment_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          commentId,
          postId,
          authorId,
          cleanContent,
          externalImages && externalImages.length > 0 ? JSON.stringify(externalImages) : null,
          parentCommentId || null
        );

        db.prepare(`
          UPDATE posts
          SET comments_count = comments_count + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(postId);

        const authorProfile = db.prepare(`
          SELECT name, handle, department, level, avatar_initials, avatar_bg, avatar_url, avatar_thumb_url, verified
          FROM user_profiles
          WHERE user_id = ?
        `).get(authorId) as any;

        const commentLink = `/home?post=${postId}&comment=${commentId}`;
        const contextTitle = parentCommentId ? 'reply' : 'comment';

        // Process @mentions first (respecting notify_mentions opt-out, blocks, and community visibility)
        const mentionSync = mentionService.syncMentionsOnContent({
          text: cleanContent,
          sourceType: 'comment',
          sourceId: commentId,
          actorId: authorId,
          targetLink: commentLink,
          contextTitle,
          communityId: post.community_id || undefined,
        });

        const alreadyNotified = new Set<string>(mentionSync.notifiedUserIds);

        // Collect post author + parent comment author who have NOT already received a mention notice
        const replyCandidates: Array<{ userId: string; isDirectReply: boolean }> = [];
        if (post.author_id !== authorId && !alreadyNotified.has(post.author_id)) {
          replyCandidates.push({ userId: post.author_id, isDirectReply: false });
        }
        if (
          parentAuthorId &&
          parentAuthorId !== authorId &&
          parentAuthorId !== post.author_id &&
          !alreadyNotified.has(parentAuthorId)
        ) {
          replyCandidates.push({ userId: parentAuthorId, isDirectReply: true });
        }

        if (replyCandidates.length > 0) {
          const ph = replyCandidates.map(() => '?').join(',');
          const prefRows = db
            .prepare(
              `SELECT user_id, COALESCE(notify_replies, 1) as notify_replies FROM user_profiles WHERE user_id IN (${ph})`
            )
            .all(...replyCandidates.map((c) => c.userId)) as Array<{
            user_id: string;
            notify_replies: number;
          }>;
          const allowMap = new Map(prefRows.map((p) => [p.user_id, p.notify_replies !== 0]));

          notificationService.createNotificationsBatch(
            replyCandidates
              .filter((c) => allowMap.get(c.userId) !== false)
              .map((c) => ({
                userId: c.userId,
                type: (c.isDirectReply ? 'reply' : 'comment') as 'reply' | 'comment',
                title: c.isDirectReply ? 'New reply to your comment' : 'New response',
                body: c.isDirectReply
                  ? `${authorProfile?.name || 'Someone'} replied${!cleanContent ? ' with a photo' : ''} to your comment`
                  : `${authorProfile?.name || 'Someone'} commented${!cleanContent ? ' with a photo' : ''} on your post`,
                link: commentLink,
                sourceRef: `comment_reply:${commentId}:${c.userId}`,
                actorId: authorId,
              }))
          );
        }

        return {
          id: commentId,
          parentCommentId: parentCommentId || undefined,
          authorId,
          authorName: authorProfile?.name || 'Student',
          authorHandle: authorProfile?.handle || '@student',
          department: authorProfile?.department || '',
          level: authorProfile?.level || '',
          avatarInitials: authorProfile?.avatar_initials || 'SB',
          avatarBg: authorProfile?.avatar_bg || 'bg-stone-800 text-stone-100',
          avatarUrl: authorProfile?.avatar_url || undefined,
          avatarThumbUrl: authorProfile?.avatar_thumb_url || authorProfile?.avatar_url || undefined,
          verified: Boolean(authorProfile?.verified),
          content: cleanContent,
          images: externalImages && externalImages.length > 0 ? externalImages : undefined,
          mentions: mentionSync.mentions,
          isEdited: false,
          timestamp: 'Just now',
        };
      });
      cache.invalidatePrefix('posts:');
      return result;
    } catch (err) {
      if (externalImages && externalImages.length > 0) {
        const candidates = externalImages.flatMap((u) => fileService.extractUploadFilenames(u));
        fileService.unlinkIfUnreferenced(candidates);
      }
      throw err;
    }
  },

  editComment(commentId: string, userId: string, content: string) {
    const cleanContent = typeof content === 'string' ? content.trim() : '';
    if (!cleanContent) {
      throw new Error('Comment content cannot be empty.');
    }
    if (cleanContent.length > 2000) {
      throw new Error('Comment exceeds maximum length of 2000 characters.');
    }

    const result = runInTransaction(() => {
      const row = db
        .prepare(
          `
          SELECT c.id, c.post_id, c.author_id, c.parent_comment_id, p.community_id, p.created_at as post_created_at
          FROM comments c
          JOIN posts p ON p.id = c.post_id
          WHERE c.id = ? AND COALESCE(p.is_hidden, 0) = 0 AND p.created_at >= datetime('now', '-72 hours')
        `
        )
        .get(commentId) as
        | {
            id: string;
            post_id: string;
            author_id: string;
            parent_comment_id: string | null;
            community_id: string | null;
            post_created_at: string;
          }
        | undefined;

      if (!row) {
        throw new Error('Comment not found or post has expired after 72 hours.');
      }

      if (row.author_id !== userId) {
        throw new Error('Only the author can edit this comment.');
      }

      db.prepare(`
        UPDATE comments
        SET content = ?, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cleanContent, commentId);

      // Only notify users who were NOT previously notified about this comment (either via reply or earlier mention)
      const existingReplyRefs = db
        .prepare(`SELECT user_id FROM notifications WHERE source_ref LIKE ?`)
        .all(`comment_reply:${commentId}:%`) as Array<{ user_id: string }>;

      const mentionSync = mentionService.syncMentionsOnContent({
        text: cleanContent,
        sourceType: 'comment',
        sourceId: commentId,
        actorId: userId,
        targetLink: `/home?post=${row.post_id}&comment=${commentId}`,
        contextTitle: row.parent_comment_id ? 'reply' : 'comment',
        communityId: row.community_id || undefined,
        excludeUserIds: existingReplyRefs.map((r) => r.user_id),
      });

      return {
        id: commentId,
        postId: row.post_id,
        parentCommentId: row.parent_comment_id || undefined,
        content: cleanContent,
        mentions: mentionSync.mentions,
        isEdited: true,
      };
    });

    cache.invalidatePrefix('posts:');
    return result;
  },

  deleteComment(commentId: string, userId: string, userRole: string) {
    const candidateFiles: string[] = [];
    const result = runInTransaction(() => {
      const comment = db.prepare(`
        SELECT post_id, author_id, images_json FROM comments WHERE id = ?
      `).get(commentId) as { post_id: string; author_id: string; images_json: string | null } | undefined;

      if (!comment) {
        throw new Error('Comment not found.');
      }

      if (comment.author_id !== userId && userRole !== 'admin') {
        throw new Error('Unauthorized to delete this comment.');
      }

      candidateFiles.push(...fileService.extractUploadFilenames(comment.images_json));

      const childRows = db
        .prepare('SELECT id, images_json FROM comments WHERE parent_comment_id = ?')
        .all(commentId) as Array<{ id: string; images_json: string | null }>;

      // Clean notifications for child replies + this comment
      for (const child of childRows) {
        candidateFiles.push(...fileService.extractUploadFilenames(child.images_json));
        mentionService.deleteNotificationsBySource('comment', child.id);
        db.prepare('DELETE FROM notifications WHERE source_ref LIKE ?').run(`comment_reply:${child.id}:%`);
      }
      mentionService.deleteNotificationsBySource('comment', commentId);
      db.prepare('DELETE FROM notifications WHERE source_ref LIKE ?').run(`comment_reply:${commentId}:%`);
      db.prepare('DELETE FROM notifications WHERE link LIKE ?').run(`%comment=${commentId}%`);

      // Cascade delete child replies anchored to this comment cleanly
      const childDeleted = db.prepare('DELETE FROM comments WHERE parent_comment_id = ?').run(commentId);
      db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);

      const totalRemoved = 1 + Number(childDeleted.changes || 0);
      db.prepare(`
        UPDATE posts
        SET comments_count = MAX(0, comments_count - ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(totalRemoved, comment.post_id);

      return { success: true, removedCount: totalRemoved };
    });
    if (candidateFiles.length > 0) {
      fileService.unlinkIfUnreferenced(candidateFiles);
    }
    cache.invalidatePrefix('posts:');
    return result;
  },
};
