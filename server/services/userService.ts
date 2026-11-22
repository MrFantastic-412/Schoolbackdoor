import { db } from '../db/database';
import { cache } from '../utils/cache';
import { presenceService } from './presenceService';
import { fileService, PROTECTION_MODE_MAX_UPLOAD_BYTES } from './fileService';
import { deletionService } from './deletionService';

import { escapeLikePattern } from '../utils/security';

export interface UserProfileRow {
  id: string;
  user_id: string;
  name: string;
  handle: string;
  department: string;
  school: string;
  level: string;
  hall_of_residence: string;
  campus: string;
  bio: string | null;
  avatar_initials: string;
  avatar_bg: string;
  avatar_url?: string | null;
  avatar_thumb_url?: string | null;
  verified: number;
  is_private?: number;
  allow_anonymous_posts?: number;
  show_online_status?: number;
  badges_json: string;
  created_at: string;
  updated_at: string;
}

export interface StudentProfileResult {
  id: string;
  userId: string;
  name: string;
  handle: string;
  department: string;
  school: string;
  level: string;
  hallOfResidence: string;
  campus: string;
  bio: string | null;
  avatarInitials: string;
  avatarBg: string;
  avatarUrl?: string;
  avatarThumbUrl?: string;
  verified: boolean;
  isPrivate: boolean;
  allowAnonymousPosts?: boolean;
  showOnlineStatus: boolean;
  notifyMentions?: boolean;
  notifyReplies?: boolean;
  notifyMessages?: boolean;
  notifyCommunityAlerts?: boolean;
  notifyHostelAlerts?: boolean;
  locationSharingEnabled?: boolean;
  preferredLocationArea?: string | null;
  matricNumber: string;
  email?: string;
  accountCreatedAt: string;
  dispatchesCount: number;
  commentsCount: number;
  guildsCount: number;
  followersCount: number;
  followingCount: number;
  isConnected: boolean;
  isBlocked: boolean;
  isBlockedEitherWay: boolean;
  role?: string;
  acceptedTermsVersion?: string | null;
  badges: string[];
}

export const userService = {
  getUserById(id: string) {
    return db.prepare(`
      SELECT id, matric_number, email, phone_number, username, role, status, is_verified, created_at
      FROM users
      WHERE id = ?
    `).get(id) as {
      id: string;
      matric_number: string;
      email: string;
      phone_number: string | null;
      username: string | null;
      role: string;
      status: string;
      is_verified: number;
      created_at: string;
    } | undefined;
  },

  getProfileByUserId(userId: string, viewerId?: string, viewerRole?: string): StudentProfileResult | null {
    const safeViewer = viewerId && viewerId !== userId ? viewerId : '';
    const profile = db.prepare(`
      SELECT
        p.*,
        u.created_at as account_created_at,
        u.matric_number,
        u.email,
        u.role,
        u.accepted_terms_version,
        COALESCE(pc.c, 0) as posts_count,
        COALESCE(cc.c, 0) as comments_count,
        COALESCE(mc.c, 0) as communities_count,
        COALESCE(fc.c, 0) as followers_count,
        COALESCE(fgc.c, 0) as following_count,
        CASE WHEN ? != '' AND EXISTS (
          SELECT 1 FROM user_connections WHERE follower_id = ? AND following_id = p.user_id
        ) THEN 1 ELSE 0 END as is_connected,
        CASE WHEN ? != '' AND EXISTS (
          SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = p.user_id
        ) THEN 1 ELSE 0 END as is_blocked_by_viewer,
        CASE WHEN ? != '' AND EXISTS (
          SELECT 1 FROM user_blocks WHERE blocker_id = p.user_id AND blocked_id = ?
        ) THEN 1 ELSE 0 END as is_blocked_by_target
      FROM user_profiles p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN (SELECT author_id, COUNT(*) as c FROM posts WHERE author_id = ? GROUP BY author_id) pc ON pc.author_id = u.id
      LEFT JOIN (SELECT author_id, COUNT(*) as c FROM comments WHERE author_id = ? GROUP BY author_id) cc ON cc.author_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) as c FROM community_memberships WHERE user_id = ? GROUP BY user_id) mc ON mc.user_id = u.id
      LEFT JOIN (SELECT following_id, COUNT(*) as c FROM user_connections WHERE following_id = ? GROUP BY following_id) fc ON fc.following_id = u.id
      LEFT JOIN (SELECT follower_id, COUNT(*) as c FROM user_connections WHERE follower_id = ? GROUP BY follower_id) fgc ON fgc.follower_id = u.id
      WHERE p.user_id = ?
    `).get(
      safeViewer,
      safeViewer,
      safeViewer,
      safeViewer,
      safeViewer,
      safeViewer,
      userId,
      userId,
      userId,
      userId,
      userId,
      userId
    ) as any;

    if (!profile) return null;

    const postsCount = Number(profile.posts_count || 0);
    const commentsCount = Number(profile.comments_count || 0);
    const communitiesCount = Number(profile.communities_count || 0);
    const followersCount = Number(profile.followers_count || 0);
    const followingCount = Number(profile.following_count || 0);

    const isOwner = viewerId === userId;
    const isElevated = viewerRole === 'admin';
    const isPrivate = Boolean(profile.is_private);

    const isConnected = Boolean(profile.is_connected);
    const isBlockedByViewer = Boolean(profile.is_blocked_by_viewer);
    const isBlockedEither = isBlockedByViewer || Boolean(profile.is_blocked_by_target);

    // If profile is private and viewer is neither owner nor admin, shield private dossier fields
    if (isPrivate && !isOwner && !isElevated) {
      return {
        id: profile.id,
        userId: profile.user_id,
        name: profile.name,
        handle: profile.handle,
        department: profile.department,
        school: profile.school,
        level: profile.level,
        campus: profile.campus,
        bio: '🔒 This profile is marked private.',
        avatarInitials: profile.avatar_initials,
        avatarBg: profile.avatar_bg,
        avatarUrl: profile.avatar_url || undefined,
        avatarThumbUrl: profile.avatar_thumb_url || profile.avatar_url || undefined,
        verified: Boolean(profile.verified),
        isPrivate: true,
        showOnlineStatus: false,
        accountCreatedAt: profile.account_created_at,
        dispatchesCount: postsCount,
        commentsCount,
        guildsCount: communitiesCount,
        followersCount,
        followingCount,
        isConnected,
        isBlocked: isBlockedByViewer,
        isBlockedEitherWay: isBlockedEither,
        badges: Boolean(profile.verified) ? ['Verified Member'] : [],
        // Shielded fields
        matricNumber: 'CONFIDENTIAL',
        hallOfResidence: 'RESTRICTED',
      };
    }

    return {
      id: profile.id,
      userId: profile.user_id,
      name: profile.name,
      handle: profile.handle,
      department: profile.department,
      school: profile.school,
      level: profile.level,
      hallOfResidence: profile.hall_of_residence,
      campus: profile.campus,
      bio: profile.bio,
      avatarInitials: profile.avatar_initials,
      avatarBg: profile.avatar_bg,
      avatarUrl: profile.avatar_url || undefined,
      avatarThumbUrl: profile.avatar_thumb_url || profile.avatar_url || undefined,
      verified: Boolean(profile.verified),
      isPrivate,
      allowAnonymousPosts: profile.allow_anonymous_posts !== 0,
      showOnlineStatus: profile.show_online_status !== 0,
      ...(isOwner
        ? {
            notifyMentions: profile.notify_mentions !== 0,
            notifyReplies: profile.notify_replies !== 0,
            notifyMessages: profile.notify_messages !== 0,
            notifyCommunityAlerts: profile.notify_community_alerts !== 0,
            notifyHostelAlerts: profile.notify_hostel_alerts !== 0,
            locationSharingEnabled: Boolean(profile.location_sharing_enabled),
            preferredLocationArea: profile.location_sharing_enabled
              ? profile.preferred_location_area || null
              : null,
          }
        : {}),
      matricNumber: isOwner || isElevated ? profile.matric_number : 'CONFIDENTIAL',
      email: isOwner || isElevated ? profile.email : undefined,
      ...(isOwner
        ? {
            role: profile.role,
            acceptedTermsVersion: profile.accepted_terms_version || null,
          }
        : {}),
      accountCreatedAt: profile.account_created_at,
      dispatchesCount: postsCount,
      commentsCount,
      guildsCount: communitiesCount,
      followersCount,
      followingCount,
      isConnected,
      isBlocked: isBlockedByViewer,
      isBlockedEitherWay: isBlockedEither,
      badges: JSON.parse(profile.badges_json || '[]') as string[],
    };
  },

  toggleConnection(followerId: string, targetUserId: string) {
    if (followerId === targetUserId) {
      throw new Error('You cannot connect with your own account.');
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!target) {
      throw new Error('User not found.');
    }

    const blocked = db
      .prepare(
        'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
      )
      .get(followerId, targetUserId, targetUserId, followerId);
    if (blocked) {
      throw new Error('Connection unavailable due to privacy or block settings.');
    }

    const existing = db
      .prepare('SELECT id FROM user_connections WHERE follower_id = ? AND following_id = ?')
      .get(followerId, targetUserId) as { id: string } | undefined;

    if (existing) {
      db.prepare('DELETE FROM user_connections WHERE id = ?').run(existing.id);
    } else {
      const id = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      db.prepare('INSERT INTO user_connections (id, follower_id, following_id) VALUES (?, ?, ?)').run(
        id,
        followerId,
        targetUserId
      );

      const followerProfile = db
        .prepare('SELECT name, handle FROM user_profiles WHERE user_id = ?')
        .get(followerId) as { name?: string; handle?: string } | undefined;
      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, link)
        VALUES (?, ?, 'system', 'New connection', ?, '/home')
      `).run(
        `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        targetUserId,
        `${followerProfile?.name || 'Someone'} (${followerProfile?.handle || ''}) connected with you.`
      );
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM user_connections WHERE following_id = ?) as followers_count,
        (SELECT COUNT(*) FROM user_connections WHERE follower_id = ?) as following_count
    `).get(targetUserId, followerId) as { followers_count: number; following_count: number } | undefined;

    return {
      isConnected: !existing,
      followersCount: Number(stats?.followers_count || 0),
      followingCount: Number(stats?.following_count || 0),
    };
  },

  updateProfile(userId: string, updates: Partial<{
    name: string;
    bio: string;
    avatar_url: string | null;
    avatarUrl: string | null;
    avatar_thumb_url: string | null;
    avatarThumbUrl: string | null;
    avatarDataUrl: string;
    avatarThumbnailDataUrl: string;
    removeAvatar: boolean;
    avatar_bg: string;
    avatar_initials: string;
    department: string;
    level: string;
    hall_of_residence: string;
    campus: string;
    is_private: boolean;
    allow_anonymous_posts: boolean;
    show_online_status: boolean;
    notify_mentions: boolean;
    notifyMentions: boolean;
    notify_replies: boolean;
    notifyReplies: boolean;
    notify_messages: boolean;
    notifyMessages: boolean;
    notify_community_alerts: boolean;
    notifyCommunityAlerts: boolean;
    notify_hostel_alerts: boolean;
    notifyHostelAlerts: boolean;
    location_sharing_enabled: boolean;
    locationSharingEnabled: boolean;
    preferred_location_area: string | null;
    preferredLocationArea: string | null;
    // Protected fields to guard against unauthorized edits:
    matric_number?: string;
    role?: string;
    verified?: boolean;
    status?: string;
  }>, requesterRole = 'student') {
    const existing = this.getProfileByUserId(userId, userId, requesterRole);
    if (!existing) {
      throw new Error('Profile not found.');
    }

    // Security check: Protect non-permitted account fields
    if (updates.matric_number && requesterRole !== 'admin') {
      throw new Error('Permission denied: Matriculation number cannot be changed by student.');
    }
    if (updates.role && requesterRole !== 'admin') {
      throw new Error('Permission denied: Account role cannot be altered.');
    }
    if (updates.verified !== undefined && requesterRole !== 'admin') {
      throw new Error('Permission denied: Verification badge status is managed by Admin.');
    }
    if (updates.status !== undefined && requesterRole !== 'admin') {
      throw new Error('Permission denied: Account status cannot be modified.');
    }

    const name = (typeof updates.name === 'string' ? updates.name.trim().slice(0, 80) : '') || existing.name;
    const bio = updates.bio !== undefined ? String(updates.bio || '').trim().slice(0, 500) : existing.bio;

    const prevAvatarFiles = [
      ...fileService.extractUploadFilenames(existing.avatarUrl),
      ...fileService.extractUploadFilenames(existing.avatarThumbUrl),
    ];

    let avatarUrl: string | null = existing.avatarUrl || null;
    let avatarThumbUrl: string | null = existing.avatarThumbUrl || existing.avatarUrl || null;
    const rawIncomingUrl =
      updates.avatar_url !== undefined ? updates.avatar_url : updates.avatarUrl;
    const rawIncomingThumb =
      updates.avatar_thumb_url !== undefined
        ? updates.avatar_thumb_url
        : updates.avatarThumbUrl ?? updates.avatarThumbnailDataUrl;

    if (updates.removeAvatar === true || rawIncomingUrl === null || rawIncomingUrl === '') {
      avatarUrl = null;
      avatarThumbUrl = null;
    } else if (typeof updates.avatarDataUrl === 'string' && updates.avatarDataUrl.trim()) {
      const protectionActive = deletionService.isStorageProtectionActive().active;
      const saved = fileService.saveAvatarImages(updates.avatarDataUrl.trim(), userId, rawIncomingThumb || undefined, {
        maxBytesOverride: protectionActive ? PROTECTION_MODE_MAX_UPLOAD_BYTES : undefined,
      });
      avatarUrl = saved.avatarUrl;
      avatarThumbUrl = saved.avatarThumbUrl;
    } else if (typeof rawIncomingUrl === 'string' && rawIncomingUrl.trim()) {
      const protectionActive = rawIncomingUrl.trim().startsWith('data:') && deletionService.isStorageProtectionActive().active;
      const saved = fileService.saveAvatarImages(rawIncomingUrl.trim(), userId, rawIncomingThumb || undefined, {
        maxBytesOverride: protectionActive ? PROTECTION_MODE_MAX_UPLOAD_BYTES : undefined,
      });
      avatarUrl = saved.avatarUrl;
      avatarThumbUrl = saved.avatarThumbUrl;
    }
    const rawAvatarBg = typeof (updates.avatar_bg ?? (updates as any).avatarBg) === 'string'
      ? String(updates.avatar_bg ?? (updates as any).avatarBg).trim()
      : '';
    const avatarBg =
      rawAvatarBg && /^[a-z0-9\-\/\[\]#:\s]{3,80}$/i.test(rawAvatarBg)
        ? rawAvatarBg
        : existing.avatarBg;
    const rawInitials = typeof (updates.avatar_initials ?? (updates as any).avatarInitials) === 'string'
      ? String(updates.avatar_initials ?? (updates as any).avatarInitials).trim().slice(0, 4).toUpperCase()
      : '';
    const avatarInitials = rawInitials && /^[A-Z0-9]{1,4}$/.test(rawInitials) ? rawInitials : existing.avatarInitials;
    const department =
      (typeof updates.department === 'string' ? updates.department.trim().slice(0, 80) : '') || existing.department;
    const level = (typeof updates.level === 'string' ? updates.level.trim().slice(0, 24) : '') || existing.level;
    const hall =
      (typeof updates.hall_of_residence === 'string'
        ? updates.hall_of_residence.trim().slice(0, 80)
        : typeof (updates as any).hallOfResidence === 'string'
          ? (updates as any).hallOfResidence.trim().slice(0, 80)
          : '') || existing.hallOfResidence;
    const campus = (typeof updates.campus === 'string' ? updates.campus.trim().slice(0, 60) : '') || existing.campus;

    const isPrivateRaw = updates.is_private !== undefined ? updates.is_private : (updates as any).isPrivate;
    const isPrivate = isPrivateRaw !== undefined ? (isPrivateRaw ? 1 : 0) : (existing.isPrivate ? 1 : 0);

    const allowAnonRaw = updates.allow_anonymous_posts !== undefined ? updates.allow_anonymous_posts : (updates as any).allowAnonymousPosts;
    const allowAnon = allowAnonRaw !== undefined ? (allowAnonRaw ? 1 : 0) : (existing.allowAnonymousPosts ? 1 : 0);

    const showOnlineRaw = updates.show_online_status !== undefined ? updates.show_online_status : (updates as any).showOnlineStatus;
    const showOnline = showOnlineRaw !== undefined ? (showOnlineRaw ? 1 : 0) : (existing.showOnlineStatus ? 1 : 0);

    const notifyMentionsRaw = updates.notify_mentions !== undefined ? updates.notify_mentions : updates.notifyMentions;
    const notifyMentions =
      notifyMentionsRaw !== undefined ? (notifyMentionsRaw ? 1 : 0) : (existing.notifyMentions !== false ? 1 : 0);

    const notifyRepliesRaw = updates.notify_replies !== undefined ? updates.notify_replies : updates.notifyReplies;
    const notifyReplies =
      notifyRepliesRaw !== undefined ? (notifyRepliesRaw ? 1 : 0) : (existing.notifyReplies !== false ? 1 : 0);

    const notifyMessagesRaw = updates.notify_messages !== undefined ? updates.notify_messages : updates.notifyMessages;
    const notifyMessages =
      notifyMessagesRaw !== undefined ? (notifyMessagesRaw ? 1 : 0) : (existing.notifyMessages !== false ? 1 : 0);

    const notifyCommunityRaw =
      updates.notify_community_alerts !== undefined ? updates.notify_community_alerts : updates.notifyCommunityAlerts;
    const notifyCommunityAlerts =
      notifyCommunityRaw !== undefined
        ? notifyCommunityRaw
          ? 1
          : 0
        : existing.notifyCommunityAlerts !== false
          ? 1
          : 0;

    const notifyHostelRaw =
      updates.notify_hostel_alerts !== undefined ? updates.notify_hostel_alerts : updates.notifyHostelAlerts;
    const notifyHostelAlerts =
      notifyHostelRaw !== undefined
        ? notifyHostelRaw
          ? 1
          : 0
        : existing.notifyHostelAlerts !== false
          ? 1
          : 0;

    const locSharingRaw =
      updates.location_sharing_enabled !== undefined
        ? updates.location_sharing_enabled
        : updates.locationSharingEnabled;
    const locationSharingEnabled =
      locSharingRaw !== undefined
        ? locSharingRaw
          ? 1
          : 0
        : existing.locationSharingEnabled
          ? 1
          : 0;

    const rawPreferredArea =
      updates.preferred_location_area !== undefined
        ? updates.preferred_location_area
        : updates.preferredLocationArea;
    // Enforce privacy: only retain coarse area preference when user explicitly opts into location sharing
    const validAreas = new Set([
      'obanla',
      'south_gate',
      'stateline',
      'north_gate',
      'ipinsa',
      'road_block',
      'obakekere',
    ]);
    let preferredLocationArea: string | null = existing.preferredLocationArea || null;
    if (!locationSharingEnabled) {
      preferredLocationArea = null;
    } else if (rawPreferredArea !== undefined) {
      const cleanedArea = typeof rawPreferredArea === 'string' ? rawPreferredArea.trim().toLowerCase() : '';
      preferredLocationArea = validAreas.has(cleanedArea) ? cleanedArea : null;
    }

    db.prepare(`
      UPDATE user_profiles
      SET name = ?, bio = ?, avatar_url = ?, avatar_thumb_url = ?, avatar_bg = ?, avatar_initials = ?,
          department = ?, level = ?, hall_of_residence = ?, campus = ?,
          is_private = ?, allow_anonymous_posts = ?, show_online_status = ?,
          notify_mentions = ?, notify_replies = ?, notify_messages = ?,
          notify_community_alerts = ?, notify_hostel_alerts = ?,
          location_sharing_enabled = ?, preferred_location_area = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(
      name,
      bio,
      avatarUrl || null,
      avatarThumbUrl || null,
      avatarBg,
      avatarInitials,
      department,
      level,
      hall,
      campus,
      isPrivate,
      allowAnon,
      showOnline,
      notifyMentions,
      notifyReplies,
      notifyMessages,
      notifyCommunityAlerts,
      notifyHostelAlerts,
      locationSharingEnabled,
      preferredLocationArea,
      userId
    );

    const avatarChanged = avatarUrl !== (existing.avatarUrl || null) || avatarThumbUrl !== (existing.avatarThumbUrl || null);
    if (avatarChanged && prevAvatarFiles.length > 0) {
      fileService.unlinkIfUnreferenced(prevAvatarFiles);
    }
    if (avatarChanged) {
      fileService.invalidateAccessCache([
        ...prevAvatarFiles,
        ...fileService.extractUploadFilenames(avatarUrl),
        ...fileService.extractUploadFilenames(avatarThumbUrl),
      ]);
      cache.invalidatePrefix('posts:');
      cache.invalidatePrefix('communities:');
      cache.invalidatePrefix('admin:dashboard');
    }

    presenceService.syncVisibilityPreference(userId, Boolean(showOnline));
    cache.invalidate(`posts:viewer_ctx:${userId}`);

    return this.getProfileByUserId(userId, userId, requesterRole);
  },

  searchStudents(query: string, limit = 12, viewerId?: string) {
    const clean = query.trim();
    const q = clean ? `%${escapeLikePattern(clean)}%` : '%';
    const safeLimit = Math.min(30, Math.max(1, limit));

    const rows = db.prepare(`
      SELECT
        p.id,
        p.user_id,
        p.name,
        p.handle,
        p.department,
        p.level,
        p.bio,
        p.avatar_initials,
        p.avatar_bg,
        p.avatar_url,
        p.avatar_thumb_url,
        p.verified,
        p.is_private,
        (SELECT COUNT(*) FROM user_connections c WHERE c.following_id = p.user_id) as followers_count,
        CASE
          WHEN ? != '' AND EXISTS(
            SELECT 1 FROM user_connections c2 WHERE c2.follower_id = ? AND c2.following_id = p.user_id
          ) THEN 1
          ELSE 0
        END as is_connected
      FROM user_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE u.status = 'active'
        AND (? = '' OR p.user_id != ?)
        AND (? = '' OR NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ? AND b.blocked_id = p.user_id)
             OR (b.blocker_id = p.user_id AND b.blocked_id = ?)
        ))
        AND (
          LOWER(p.name) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(p.handle) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(p.department) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(COALESCE(p.bio, '')) LIKE LOWER(?) ESCAPE '\\'
        )
      ORDER BY p.verified DESC, followers_count DESC, p.name ASC
      LIMIT ?
    `).all(
      viewerId || '',
      viewerId || '',
      viewerId || '',
      viewerId || '',
      viewerId || '',
      viewerId || '',
      viewerId || '',
      q,
      q,
      q,
      q,
      safeLimit
    ) as any[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      user_id: r.user_id,
      name: r.name,
      handle: r.handle,
      department: r.department,
      level: r.level,
      bio: r.is_private ? 'Private profile' : r.bio || '',
      avatarInitials: r.avatar_initials,
      avatarBg: r.avatar_bg,
      avatarUrl: r.avatar_url || undefined,
      avatarThumbUrl: r.avatar_thumb_url || r.avatar_url || undefined,
      verified: Boolean(r.verified),
      isPrivate: Boolean(r.is_private),
      followersCount: Number(r.followers_count || 0),
      isConnected: Boolean(r.is_connected),
    }));
  },
};
