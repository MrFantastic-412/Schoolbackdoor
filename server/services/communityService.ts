import { db, runInTransaction, withReadConnection } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { sseManager } from '../realtime/sseManager.js';
import { notificationService } from './notificationService.js';
import { fileService } from './fileService.js';
import { mentionService } from './mentionService.js';
import { extractMentionHandles, ResolvedMention } from '../utils/mentions.js';
import { computePostExpiresAtMs, hydratePollsForRows } from './postService.js';
import { validateLocationInput } from '../utils/security.js';

export interface CommunitySettings {
  isPrivate?: boolean;
  allowMemberDiscussions?: boolean;
  requireApproval?: boolean;
}

function parseCommunitySettings(raw: string | null | undefined): CommunitySettings {
  if (!raw) return { allowMemberDiscussions: true };
  try {
    return JSON.parse(raw);
  } catch {
    return { allowMemberDiscussions: true };
  }
}

function assertCommunityReadAccess(communityId: string, viewerId?: string, viewerRole = 'student') {
  if (viewerRole === 'admin') return;
  const comm = withReadConnection((conn) =>
    conn.prepare('SELECT id, settings_json FROM communities WHERE id = ?').get(communityId) as
      | { id: string; settings_json: string | null }
      | undefined
  );
  if (!comm) return;
  const settings = parseCommunitySettings(comm.settings_json);
  if (!settings.isPrivate) return;

  if (!viewerId) {
    throw new Error('Access denied: Join this private community to view members and discussions.');
  }
  const membership = withReadConnection((conn) =>
    conn
      .prepare('SELECT 1 FROM community_memberships WHERE community_id = ? AND user_id = ?')
      .get(communityId, viewerId)
  );
  if (!membership) {
    throw new Error('Access denied: Join this private community to view members and discussions.');
  }
}

export const communityService = {
  invalidateCache() {
    cache.invalidatePrefix('communities:');
    cache.invalidatePrefix('admin:dashboard');
  },

  getAllCommunities(userId = 'u-ayodele') {
    const baseCommunities = cache.getOrCompute<any[]>('communities:base', 15000, () =>
      withReadConnection((conn) =>
        conn.prepare(`
          SELECT * FROM communities ORDER BY member_count DESC
        `).all() as any[]
      )
    );

    const membershipByComm = new Map<string, string>();
    if (userId) {
      const memberships = withReadConnection((conn) =>
        conn.prepare(`
          SELECT community_id, role FROM community_memberships WHERE user_id = ?
        `).all(userId) as Array<{ community_id: string; role: string }>
      );
      for (const m of memberships) {
        membershipByComm.set(m.community_id, m.role);
      }
    }

    return baseCommunities.map((c) => {
      const userRole = membershipByComm.get(c.id) || null;
      return this.mapRowToCommunity({
        ...c,
        user_role: userRole,
        is_joined: userRole !== null ? 1 : 0,
      });
    });
  },

  getCommunityById(communityId: string, userId = 'u-ayodele') {
    const c = withReadConnection((conn) =>
      conn.prepare(`
        SELECT 
          c.*,
          cm.role as user_role,
          CASE WHEN cm.id IS NOT NULL THEN 1 ELSE 0 END as is_joined
        FROM communities c
        LEFT JOIN community_memberships cm ON cm.community_id = c.id AND cm.user_id = ?
        WHERE c.id = ?
      `).get(userId, communityId) as any
    );

    if (!c) return null;
    return this.mapRowToCommunity(c);
  },

  toggleMembership(communityId: string, userId: string) {
    return runInTransaction(() => {
      const comm = db.prepare('SELECT id, name, chat_id, member_count FROM communities WHERE id = ?').get(communityId) as any;
      if (!comm) {
        throw new Error('Community not found.');
      }

      const existing = db.prepare(`
        SELECT id, role FROM community_memberships
        WHERE community_id = ? AND user_id = ?
      `).get(communityId, userId) as { id: string; role: string } | undefined;

      if (existing) {
        // Prevent leaving if user is the sole lead of community
        if (existing.role === 'lead') {
          const leadCount = db.prepare(`
            SELECT COUNT(*) as count FROM community_memberships WHERE community_id = ? AND role = 'lead'
          `).get(communityId) as { count: number };
          if (leadCount.count <= 1) {
            throw new Error('As the primary lead, please transfer guild leadership before leaving.');
          }
        }

        db.prepare('DELETE FROM community_memberships WHERE id = ?').run(existing.id);
        db.prepare(`
          UPDATE communities
          SET member_count = MAX(0, member_count - 1)
          WHERE id = ?
        `).run(communityId);

        // Remove from linked group chat if exists
        if (comm.chat_id) {
          db.prepare('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?').run(comm.chat_id, userId);
        }

        const updated = db.prepare('SELECT member_count FROM communities WHERE id = ?').get(communityId) as any;
        this.invalidateCache();
        return { isJoined: false, role: null, memberCount: updated?.member_count ?? 0 };
      } else {
        const membershipId = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        db.prepare(`
          INSERT INTO community_memberships (id, community_id, user_id, role)
          VALUES (?, ?, ?, 'member')
        `).run(membershipId, communityId, userId);

        db.prepare(`
          UPDATE communities
          SET member_count = member_count + 1
          WHERE id = ?
        `).run(communityId);

        // Add to linked group chat if exists
        if (comm.chat_id) {
          const partExists = db.prepare('SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?').get(comm.chat_id, userId);
          if (!partExists) {
            db.prepare(`
              INSERT INTO chat_participants (id, chat_id, user_id, role)
              VALUES (?, ?, ?, 'member')
            `).run(`cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, comm.chat_id, userId);
          }
        }

        const updated = db.prepare('SELECT member_count FROM communities WHERE id = ?').get(communityId) as any;
        this.invalidateCache();
        return { isJoined: true, role: 'member', memberCount: updated?.member_count ?? 0 };
      }
    });
  },

  createCommunity(creatorId: string, input: {
    name: string;
    acronym: string;
    category: 'school' | 'hostel' | 'tech' | 'academic' | 'social';
    description: string;
    location: string;
    leaders?: string;
    rules?: string;
    settings?: CommunitySettings;
  }) {
    const cleanAcronym = input.acronym.trim().toUpperCase();
    const communityId = `comm-${Date.now()}`;
    const chatId = `conv-comm-${Date.now()}`;

    runInTransaction(() => {
      const existing = db.prepare('SELECT id FROM communities WHERE acronym = ?').get(cleanAcronym);
      if (existing) {
        throw new Error(`A community with acronym "${cleanAcronym}" already exists.`);
      }

      // 1. Create linked group conversation in chats
      db.prepare(`
        INSERT INTO chats (id, type, title, handle, subtitle, avatar_initials, avatar_bg, last_message)
        VALUES (?, 'group', ?, ?, ?, ?, 'bg-stone-900 text-stone-100', 'Group room established.')
      `).run(
        chatId,
        `${input.name} Guild Chat`,
        `@guild_${cleanAcronym.toLowerCase()}`,
        `${input.category.toUpperCase()} Official Hub`,
        cleanAcronym.slice(0, 2)
      );

      // Add creator to group chat as admin participant
      db.prepare(`
        INSERT INTO chat_participants (id, chat_id, user_id, role)
        VALUES (?, ?, ?, 'admin')
      `).run(`cp-${Date.now()}`, chatId, creatorId);

      // 2. Insert community
      db.prepare(`
        INSERT INTO communities (
          id, name, acronym, category, member_count, description, location, leaders,
          creator_id, chat_id, settings_json, rules, is_verified
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        communityId,
        input.name.trim(),
        cleanAcronym,
        input.category,
        input.description.trim(),
        input.location.trim(),
        input.leaders || null,
        creatorId,
        chatId,
        JSON.stringify(input.settings || { allowMemberDiscussions: true }),
        input.rules || 'Be respectful, observe academic integrity, and keep posts relevant to this guild.'
      );

      // 3. Add creator as community lead
      db.prepare(`
        INSERT INTO community_memberships (id, community_id, user_id, role)
        VALUES (?, ?, ?, 'lead')
      `).run(`cm-${Date.now()}`, communityId, creatorId);

      this.invalidateCache();
    });
    return this.getCommunityById(communityId, creatorId);
  },

  editCommunity(communityId: string, editorId: string, editorRole: string, updates: {
    name?: string;
    description?: string;
    location?: string;
    leaders?: string;
    rules?: string;
    settings?: CommunitySettings;
  }) {
    runInTransaction(() => {
      const comm = db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId) as any;
      if (!comm) {
        throw new Error('Community not found.');
      }

      // Check permission: must be community lead OR system admin/moderator
      const membership = db.prepare(`
        SELECT role FROM community_memberships WHERE community_id = ? AND user_id = ?
      `).get(communityId, editorId) as { role: string } | undefined;

      const isAuthorized =
        membership?.role === 'lead' ||
        editorRole === 'admin' ||
        comm.creator_id === editorId;

      if (!isAuthorized) {
        throw new Error('You do not have authorization to edit this community.');
      }

      const nextName = updates.name !== undefined ? updates.name.trim() : comm.name;
      const nextDesc = updates.description !== undefined ? updates.description.trim() : comm.description;
      const nextLoc = updates.location !== undefined ? updates.location.trim() : comm.location;
      const nextLeaders = updates.leaders !== undefined ? updates.leaders : comm.leaders;
      const nextRules = updates.rules !== undefined ? updates.rules : comm.rules;

      let nextSettingsJson = comm.settings_json;
      if (updates.settings) {
        let currentSettings = {};
        try {
          currentSettings = JSON.parse(comm.settings_json || '{}');
        } catch {
          // ignore
        }
        nextSettingsJson = JSON.stringify({ ...currentSettings, ...updates.settings });
      }

      db.prepare(`
        UPDATE communities
        SET name = ?, description = ?, location = ?, leaders = ?, rules = ?, settings_json = ?
        WHERE id = ?
      `).run(nextName, nextDesc, nextLoc, nextLeaders, nextRules, nextSettingsJson, communityId);

      this.invalidateCache();
    });
    return this.getCommunityById(communityId, editorId);
  },

  getCommunityMembers(communityId: string, limit = 100, offset = 0, viewerId = '', viewerRole = 'student') {
    assertCommunityReadAccess(communityId, viewerId, viewerRole);
    const safeLimit = Math.min(200, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const rows = withReadConnection((conn) =>
      conn.prepare(`
        SELECT 
          cm.id as membership_id,
          cm.role as community_role,
          cm.joined_at,
          u.id as user_id,
          u.role as system_role,
          p.name,
          p.handle,
          p.department,
          p.level,
          p.avatar_initials,
          p.avatar_bg,
          p.avatar_url,
          p.avatar_thumb_url,
          p.verified
        FROM community_memberships cm
        JOIN users u ON u.id = cm.user_id
        LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE cm.community_id = ?
        ORDER BY 
          CASE cm.role 
            WHEN 'lead' THEN 1 
            WHEN 'moderator' THEN 2 
            ELSE 3 
          END ASC,
          cm.joined_at ASC
        LIMIT ? OFFSET ?
      `).all(communityId, safeLimit, safeOffset) as any[]
    );

    return rows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      name: r.name || 'Student',
      handle: r.handle || '@futa_student',
      department: r.department || 'Undergraduate',
      level: r.level || '100L',
      avatarInitials: r.avatar_initials || 'FS',
      avatarBg: r.avatar_bg || 'bg-stone-800 text-stone-100',
      avatarUrl: r.avatar_url || undefined,
      avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
      verified: Boolean(r.verified),
      communityRole: r.community_role as 'lead' | 'moderator' | 'member',
      systemRole: r.system_role,
      joinedAt: r.joined_at,
    }));
  },

  getCommunityMembersPaginated(communityId: string, limit = 50, offset = 0, viewerId = '', viewerRole = 'student') {
    assertCommunityReadAccess(communityId, viewerId, viewerRole);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const totalRow = withReadConnection((conn) =>
      conn.prepare('SELECT COUNT(*) as c FROM community_memberships WHERE community_id = ?').get(communityId) as { c: number } | undefined
    );
    const total = Number(totalRow?.c || 0);
    const members = this.getCommunityMembers(communityId, safeLimit, safeOffset, viewerId, viewerRole);
    const nextOffset = safeOffset + members.length;
    return {
      members,
      total,
      hasMore: nextOffset < total,
      nextOffset,
    };
  },

  updateMemberRole(
    communityId: string,
    callerId: string,
    callerRole: string,
    targetUserId: string,
    newRole: 'lead' | 'moderator' | 'member'
  ) {
    return runInTransaction(() => {
      // Permission: caller must be community 'lead' or system admin
      const callerMembership = db.prepare(`
        SELECT role FROM community_memberships WHERE community_id = ? AND user_id = ?
      `).get(communityId, callerId) as { role: string } | undefined;

      const isAuthorized = callerMembership?.role === 'lead' || callerRole === 'admin';
      if (!isAuthorized) {
        throw new Error('Only the community lead or administrator can assign leadership roles.');
      }

      if (callerId === targetUserId && newRole !== 'lead') {
        const leadCount = db.prepare(`
          SELECT COUNT(*) as count FROM community_memberships WHERE community_id = ? AND role = 'lead'
        `).get(communityId) as { count: number };
        if (leadCount.count <= 1) {
          throw new Error('You cannot demote yourself while being the sole lead.');
        }
      }

      db.prepare(`
        UPDATE community_memberships
        SET role = ?
        WHERE community_id = ? AND user_id = ?
      `).run(newRole, communityId, targetUserId);

      // Update chat participant role if applicable
      const comm = db.prepare('SELECT chat_id FROM communities WHERE id = ?').get(communityId) as any;
      if (comm?.chat_id) {
        const chatRole = (newRole === 'lead' || newRole === 'moderator') ? 'admin' : 'member';
        db.prepare(`
          UPDATE chat_participants
          SET role = ?
          WHERE chat_id = ? AND user_id = ?
        `).run(chatRole, comm.chat_id, targetUserId);
      }

      return { success: true, communityId, targetUserId, newRole };
    });
  },

  removeMember(communityId: string, callerId: string, callerRole: string, targetUserId: string) {
    return runInTransaction(() => {
      const comm = db.prepare('SELECT id, chat_id, member_count FROM communities WHERE id = ?').get(communityId) as any;
      if (!comm) throw new Error('Community not found.');

      // Check caller's role in community
      const callerMembership = db.prepare(`
        SELECT role FROM community_memberships WHERE community_id = ? AND user_id = ?
      `).get(communityId, callerId) as { role: string } | undefined;

      const targetMembership = db.prepare(`
        SELECT role FROM community_memberships WHERE community_id = ? AND user_id = ?
      `).get(communityId, targetUserId) as { role: string } | undefined;

      if (!targetMembership) {
        throw new Error('User is not a member of this community.');
      }

      // Leads and moderators can remove standard members. Only system admins can remove leads.
      const isLead = callerMembership?.role === 'lead';
      const isMod = callerMembership?.role === 'moderator';
      const isSysAdmin = callerRole === 'admin';

      if (!isLead && !isMod && !isSysAdmin) {
        throw new Error('You do not have permission to remove members from this community.');
      }

      if (targetMembership.role === 'lead' && !isSysAdmin) {
        throw new Error('Community leads cannot be removed by moderators.');
      }

      db.prepare(`
        DELETE FROM community_memberships
        WHERE community_id = ? AND user_id = ?
      `).run(communityId, targetUserId);

      db.prepare(`
        UPDATE communities
        SET member_count = MAX(0, member_count - 1)
        WHERE id = ?
      `).run(communityId);

      if (comm.chat_id) {
        db.prepare(`
          DELETE FROM chat_participants
          WHERE chat_id = ? AND user_id = ?
        `).run(comm.chat_id, targetUserId);
      }

      return { success: true, removedUserId: targetUserId };
    });
  },

  getCommunityPosts(communityId: string, viewerId = 'u-ayodele', limit = 50, offset = 0, viewerRole = 'student') {
    assertCommunityReadAccess(communityId, viewerId, viewerRole);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const nowMs = Date.now();
    const rows = withReadConnection((conn) =>
      conn.prepare(`
        SELECT 
          p.*,
          u.role as author_role,
          prof.name as author_name,
          prof.handle as author_handle,
          prof.department as author_dept,
          prof.level as author_level,
          prof.avatar_bg,
          prof.avatar_initials,
          prof.avatar_url,
          prof.avatar_thumb_url,
          prof.verified,
          CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END as is_liked
        FROM posts p
        JOIN users u ON u.id = p.author_id
        LEFT JOIN user_profiles prof ON prof.user_id = u.id
        LEFT JOIN likes l ON l.post_id = p.id AND l.user_id = ?
        WHERE p.community_id = ?
          AND COALESCE(p.is_hidden, 0) = 0
          AND p.created_at >= datetime('now', '-72 hours')
        ORDER BY p.is_announcement DESC, p.is_pinned DESC, p.created_at DESC
        LIMIT ? OFFSET ?
      `).all(viewerId, communityId, safeLimit, safeOffset) as any[]
    );

    const activeRows = rows.filter((r) => computePostExpiresAtMs(r.created_at) > nowMs);
    const pollsByPost = hydratePollsForRows(activeRows, viewerId);
    const resolvedMentionMap = mentionService.resolveHandlesBatch(
      activeRows.map((r) => r.content),
      { viewerId, communityId }
    );
    return activeRows.map((r) =>
      this.formatPostRow(
        r,
        pollsByPost.get(r.id),
        mentionService.pickMentionsForText(r.content, resolvedMentionMap)
      )
    );
  },

  getCommunityPostsPaginated(communityId: string, viewerId = 'u-ayodele', limit = 20, offset = 0, viewerRole = 'student') {
    assertCommunityReadAccess(communityId, viewerId, viewerRole);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const totalRow = withReadConnection((conn) =>
      conn.prepare(`
        SELECT COUNT(*) as c FROM posts
        WHERE community_id = ? AND COALESCE(is_hidden, 0) = 0 AND created_at >= datetime('now', '-72 hours')
      `).get(communityId) as { c: number } | undefined
    );
    const total = Number(totalRow?.c || 0);
    const posts = this.getCommunityPosts(communityId, viewerId, safeLimit, safeOffset, viewerRole);
    const nextOffset = safeOffset + posts.length;
    return {
      posts,
      total,
      hasMore: nextOffset < total,
      nextOffset,
    };
  },

  createCommunityPost(communityId: string, authorId: string, input: {
    content: string;
    isAnnouncement?: boolean;
    announcementUrgency?: 'normal' | 'high';
    location?: any;
    images?: string[];
  }) {
    return runInTransaction(() => {
      const cleanContent = typeof input.content === 'string' ? input.content.trim() : '';
      const hasImages = Array.isArray(input.images) && input.images.length > 0;
      if (!cleanContent && !hasImages) {
        throw new Error('Post content cannot be empty.');
      }

      const comm = db.prepare('SELECT id, name, acronym, settings_json FROM communities WHERE id = ?').get(communityId) as any;
      if (!comm) throw new Error('Community not found.');

      const settings = parseCommunitySettings(comm.settings_json);

      // Check author's membership & role
      const membership = db.prepare(`
        SELECT role FROM community_memberships WHERE community_id = ? AND user_id = ?
      `).get(communityId, authorId) as { role: string } | undefined;

      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(authorId) as { role: string } | undefined;
      const isLeadOrMod = membership?.role === 'lead' || membership?.role === 'moderator' || user?.role === 'admin' || user?.role === 'staff';

      if (input.isAnnouncement) {
        if (!isLeadOrMod) {
          throw new Error('Only community leads, moderators, or verified executives can publish official announcements.');
        }
      } else {
        if (!membership && user?.role !== 'admin') {
          throw new Error('You must be a member of this community to post discussions.');
        }
        if (settings.allowMemberDiscussions === false && !isLeadOrMod) {
          throw new Error('Member discussions are currently disabled by community moderators.');
        }
      }

      const postId = `post-comm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const isAnnouncement = input.isAnnouncement ? 1 : 0;
      const urgency = input.announcementUrgency === 'high' ? 'high' : 'normal';
      const sanitizedLocation = input.location ? validateLocationInput(input.location) : null;
      const externalImages = fileService.externalizeImages(input.images, authorId);

      db.prepare(`
        INSERT INTO posts (
          id, author_id, content, school_tag, community_id, is_announcement, announcement_urgency,
          location_json, images_json, likes_count, comments_count, reposts_count, is_pinned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
      `).run(
        postId,
        authorId,
        cleanContent,
        comm.acronym,
        communityId,
        isAnnouncement,
        urgency,
        sanitizedLocation ? JSON.stringify(sanitizedLocation) : null,
        externalImages && externalImages.length > 0 ? JSON.stringify(externalImages) : null,
        isAnnouncement // Pin announcements automatically
      );

      // Process @mentions if text contains @handles (respects private community membership, blocks & opt-outs)
      const postLink = isAnnouncement
        ? `/communities?id=${communityId}&announcement=${postId}`
        : `/communities?id=${communityId}&post=${postId}`;
      let mentionSync: {
        mentions: ResolvedMention[];
        notifiedUserIds: string[];
      } = { mentions: [], notifiedUserIds: [] };

      if (extractMentionHandles(input.content).length > 0) {
        mentionSync = mentionService.syncMentionsOnContent({
          text: input.content.trim(),
          sourceType: 'post',
          sourceId: postId,
          actorId: authorId,
          targetLink: postLink,
          contextTitle: isAnnouncement ? `${comm.acronym} Announcement` : `${comm.acronym} Guild`,
          communityId,
        });
      }

      // If it is an announcement, fetch members + author name in ONE LEFT JOIN and batch-insert notifications
      // Skip members already notified via explicit @mention so they receive at most 1 alert for the post.
      if (isAnnouncement) {
        const members = db.prepare(`
          SELECT cm.user_id, ap.name as author_name, COALESCE(mp.notify_community_alerts, 1) as notify_comm
          FROM community_memberships cm
          LEFT JOIN user_profiles ap ON ap.user_id = ?
          LEFT JOIN user_profiles mp ON mp.user_id = cm.user_id
          WHERE cm.community_id = ? AND cm.user_id != ?
          LIMIT 200
        `).all(authorId, communityId, authorId) as Array<{
          user_id: string;
          author_name: string | null;
          notify_comm: number;
        }>;

        const mentionNotifiedSet = new Set(mentionSync.notifiedUserIds);
        const targetMembers = members.filter(
          (m) => m.notify_comm !== 0 && !mentionNotifiedSet.has(m.user_id)
        );

        if (targetMembers.length > 0) {
          const authorName = members[0]?.author_name || 'Community Leader';
          const bodyText = `${authorName}: ${input.content.slice(0, 100)}${input.content.length > 100 ? '...' : ''}`;
          const link = `/communities?id=${communityId}&announcement=${postId}`;

          notificationService.createNotificationsBatch(
            targetMembers.map((m) => ({
              userId: m.user_id,
              type: 'announcement' as const,
              title: `${comm.acronym} Guild Announcement`,
              body: bodyText,
              link,
              actorId: authorId,
            }))
          );
        }
      }

      // Return created post
      const rawPost = db.prepare(`
        SELECT 
          p.*,
          u.role as author_role,
          prof.name as author_name,
          prof.handle as author_handle,
          prof.department as author_dept,
          prof.level as author_level,
          prof.avatar_bg,
          prof.avatar_initials,
          prof.avatar_url,
          prof.avatar_thumb_url,
          prof.verified,
          0 as is_liked
        FROM posts p
        JOIN users u ON u.id = p.author_id
        LEFT JOIN user_profiles prof ON prof.user_id = u.id
        WHERE p.id = ?
      `).get(postId) as any;

      cache.invalidatePrefix('posts:');
      this.invalidateCache();
      return this.formatPostRow(rawPost, undefined, mentionSync.mentions);
    });
  },

  formatPostRow(r: any, hydratedPoll?: any, mentions?: ResolvedMention[]) {
    let location = undefined;
    if (r.location_json) {
      try {
        location = JSON.parse(r.location_json);
      } catch {
        // ignore
      }
    }

    let images: string[] = [];
    if (r.images_json) {
      try {
        images = JSON.parse(r.images_json);
      } catch {
        images = [];
      }
    }

    return {
      id: r.id,
      authorId: r.author_id,
      authorName: r.author_name || 'Student Member',
      authorHandle: r.author_handle || '@student',
      department: r.author_dept || 'Community',
      level: r.author_level || 'Member',
      avatarBg: r.avatar_bg || 'bg-stone-800 text-stone-100',
      avatarInitials: r.avatar_initials || 'SM',
      avatarUrl: r.avatar_url || undefined,
      avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
      verified: Boolean(r.verified),
      content: r.content,
      mentions: mentions || [],
      isEdited: Boolean(r.edited_at),
      schoolTag: r.school_tag || undefined,
      hostelTag: r.hostel_tag || undefined,
      communityId: r.community_id || undefined,
      isAnnouncement: Boolean(r.is_announcement),
      announcementUrgency: r.announcement_urgency || 'normal',
      isPinned: Boolean(r.is_pinned),
      isFeatured: Boolean(r.is_featured),
      isAdminPost: Boolean(r.is_admin_post),
      distributionScope: r.distribution_scope || 'standard',
      location,
      images,
      poll: hydratedPoll,
      likes: r.likes_count || 0,
      commentsCount: r.comments_count || 0,
      reposts: r.reposts_count || 0,
      isLiked: Boolean(r.is_liked),
      isReposted: false,
      timestamp: r.created_at,
      comments: [],
    };
  },

  mapRowToCommunity(c: any) {
    let settings: CommunitySettings = { allowMemberDiscussions: true };
    if (c.settings_json) {
      try {
        settings = JSON.parse(c.settings_json);
      } catch {
        // default
      }
    }

    return {
      id: c.id,
      name: c.name,
      acronym: c.acronym,
      category: c.category,
      memberCount: c.member_count,
      description: c.description,
      location: c.location,
      leaders: c.leaders || undefined,
      creatorId: c.creator_id || undefined,
      chatId: c.chat_id || undefined,
      rules: c.rules || 'Be respectful and uphold community standards.',
      settings,
      isJoined: Boolean(c.is_joined),
      userRole: c.user_role || (c.is_joined ? 'member' : null),
    };
  },
};
