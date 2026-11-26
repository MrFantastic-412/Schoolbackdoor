import fs from 'node:fs';
import path from 'node:path';
import { db, runInTransaction } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { sseManager } from '../realtime/sseManager.js';
import { adminSecurityService } from './adminSecurityService.js';
import { authService, hashPassword, verifyPassword } from './authService.js';
import { presenceService } from './presenceService.js';
import { fileService, getUploadsDir } from './fileService.js';
import { deletionService } from './deletionService.js';
import {
  sanitizeSafeUrl,
  checkRateLimit,
  recordRateLimitEvent,
  escapeLikePattern,
  hashSessionToken,
  SESSION_POLICY,
  recordSecurityEvent,
} from '../utils/security.js';

const DEFAULT_FEATURES = [
  {
    key: 'posts',
    name: 'Campus Commons & Social Feed',
    description: 'Student social timeline for everyday updates, humor, discussions, photos, and school life.',
    category: 'core',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Campus Commons posting is temporarily paused for maintenance.',
    limits_json: JSON.stringify({ maxPostLength: 2000, maxImagesPerPost: 4, retentionHours: 72 }),
    settings_json: JSON.stringify({ allowReactions: true, allowReplies: true, allowReposts: true }),
    nav_tab: 'home',
  },
  {
    key: 'chats',
    name: 'Direct Messages & Threads',
    description: '72-hour ephemeral direct messaging with online presence and block enforcement.',
    category: 'core',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Direct messaging is temporarily in maintenance mode.',
    limits_json: JSON.stringify({ maxMessageLength: 2000, retentionHours: 72 }),
    settings_json: JSON.stringify({}),
    nav_tab: 'chats',
  },
  {
    key: 'groups',
    name: 'Group Rooms & Hangouts',
    description: 'Community group lounges, friend circles, and study rooms inside Messenger.',
    category: 'social',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Group chat rooms are temporarily in maintenance mode.',
    limits_json: JSON.stringify({ maxGroupMembers: 250, retentionHours: 72 }),
    settings_json: JSON.stringify({ allowGroupCreation: true }),
    nav_tab: 'chats',
  },
  {
    key: 'communities',
    name: 'Communities, Hostels & Clubs',
    description: 'Student groups, interest clubs, hostels, faculties, and member rosters.',
    category: 'social',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Communities are temporarily unavailable during maintenance.',
    limits_json: JSON.stringify({ maxCommunitiesPerUser: 20 }),
    settings_json: JSON.stringify({ allowStudentCreation: true }),
    nav_tab: 'communities',
  },
  {
    key: 'updates',
    name: 'Updates & Community Notices',
    description: 'Community notices, student digests, and campus spots.',
    category: 'discovery',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Updates feed is syncing.',
    limits_json: JSON.stringify({ maxPinnedNotices: 10 }),
    settings_json: JSON.stringify({ requireVerificationBadge: true }),
    nav_tab: 'updates',
  },
  {
    key: 'notifications',
    name: 'Real-Time Alerts & Mentions',
    description: 'Notifications for likes, reposts, replies, @mentions, connections, and account notices.',
    category: 'core',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Notification delivery is temporarily paused.',
    limits_json: JSON.stringify({ maxUnreadDisplay: 99 }),
    settings_json: JSON.stringify({ realTimeSseEnabled: true }),
    nav_tab: null,
  },
  {
    key: 'leaderboard',
    name: 'Community Activity Standings',
    description: 'Active community rankings and engagement standings across groups.',
    category: 'discovery',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Leaderboard standings are refreshing.',
    limits_json: JSON.stringify({ topEntriesLimit: 20 }),
    settings_json: JSON.stringify({ rankBy: 'members_and_posts' }),
    nav_tab: null,
  },
  {
    key: 'campus_landmarks',
    name: 'Akure & Campus Spots Pinning',
    description: 'Obanla, Obakekere, and South Gate spot selector on posts and chats.',
    category: 'discovery',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Spot pinning is temporarily paused.',
    limits_json: JSON.stringify({ maxPinsPerPost: 1 }),
    settings_json: JSON.stringify({ allowOffCampusLandmarks: true }),
    nav_tab: null,
  },
  {
    key: 'anonymous_posting',
    name: 'Anonymous Posting',
    description: 'Allows users to hide their visible identity from other users while preserving authorized Admin moderation traceability.',
    category: 'governance',
    enabled: 1,
    visible_in_nav: 1,
    maintenance_mode: 0,
    maintenance_message: 'Anonymous posting is temporarily paused.',
    limits_json: JSON.stringify({ requireAuditTrace: true }),
    settings_json: JSON.stringify({ allowInCommunities: true }),
    nav_tab: null,
  },
];

const DEFAULT_WEBSITE_SETTINGS: Array<{ key: string; value: string; category: string }> = [
  { key: 'site_name', value: 'Schoolbackdoor', category: 'general' },
  { key: 'site_tagline', value: 'Independent Student Social Network', category: 'general' },
  { key: 'campus_zone', value: 'Obanla · Obakekere · South Gate', category: 'general' },
  { key: 'maintenance_mode', value: 'false', category: 'maintenance' },
  {
    key: 'maintenance_message',
    value: 'Scheduled platform maintenance is underway. Normal access will resume shortly.',
    category: 'maintenance',
  },
  { key: 'allow_new_registrations', value: 'true', category: 'access' },
  { key: 'support_email', value: 'support@schoolbackdoor.app', category: 'support' },
  { key: 'support_location', value: 'Independent Student Community Desk · Akure', category: 'support' },
  { key: 'support_hours', value: 'Mon–Fri · 8:00 AM – 5:00 PM WAT', category: 'support' },
  { key: 'support_sla_hours', value: '24', category: 'support' },
  { key: 'storage_quota_gb', value: '10', category: 'storage' },
  { key: 'retention_hours', value: '72', category: 'storage' },
  { key: 'admin_mfa_required', value: 'false', category: 'security' },
];

// RFC-6238 TOTP helpers imported from ../utils/totp

export const adminControlService = {
  /**
   * Ensures platform features and website settings tables contain default entries.
   */
  ensurePlatformDefaults() {
    const insertFeature = db.prepare(`
      INSERT OR IGNORE INTO platform_features (
        key, name, description, category, enabled, visible_in_nav,
        maintenance_mode, maintenance_message, limits_json, settings_json, nav_tab, is_builtin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const f of DEFAULT_FEATURES) {
      insertFeature.run(
        f.key,
        f.name,
        f.description,
        f.category,
        f.enabled,
        f.visible_in_nav,
        f.maintenance_mode,
        f.maintenance_message,
        f.limits_json,
        f.settings_json,
        f.nav_tab
      );
    }

    const insertSetting = db.prepare(`
      INSERT OR IGNORE INTO website_settings (key, value, category)
      VALUES (?, ?, ?)
    `);
    for (const s of DEFAULT_WEBSITE_SETTINGS) {
      insertSetting.run(s.key, s.value, s.category);
    }
  },

  /**
   * Public runtime platform config (features + website settings). Cached for 5s.
   */
  getPublicPlatformConfig() {
    this.ensurePlatformDefaults();
    return cache.getOrCompute('platform:config', 5000, () => {
      const featureRows = db
        .prepare('SELECT * FROM platform_features ORDER BY is_builtin DESC, category ASC, name ASC')
        .all() as any[];
      const settingRows = db.prepare('SELECT key, value, category, updated_at FROM website_settings').all() as any[];

      const settings: Record<string, string> = {};
      for (const s of settingRows) {
        settings[s.key] = s.value;
      }

      const features = featureRows.map((f) => ({
        key: f.key,
        name: f.name,
        description: f.description,
        category: f.category,
        enabled: Boolean(f.enabled),
        visibleInNav: Boolean(f.visible_in_nav),
        maintenanceMode: Boolean(f.maintenance_mode),
        maintenanceMessage: f.maintenance_message || '',
        limits: (() => {
          try {
            return JSON.parse(f.limits_json || '{}');
          } catch {
            return {};
          }
        })(),
        settings: (() => {
          try {
            return JSON.parse(f.settings_json || '{}');
          } catch {
            return {};
          }
        })(),
        navTab: f.nav_tab || null,
        isBuiltin: Boolean(f.is_builtin),
        updatedAt: f.updated_at,
      }));

      return { settings, features };
    });
  },

  /**
   * Checks whether a given platform feature is active & not in maintenance mode.
   */
  checkFeatureAccess(featureKey: string): { allowed: boolean; status: number; reason?: string; limits: Record<string, any> } {
    const config = this.getPublicPlatformConfig();
    if (config.settings.maintenance_mode === 'true') {
      return {
        allowed: false,
        status: 503,
        reason: config.settings.maintenance_message || 'Platform is currently in maintenance mode.',
        limits: {},
      };
    }

    const feat = config.features.find((f) => f.key === featureKey);
    if (!feat) {
      return { allowed: true, status: 200, limits: {} };
    }
    if (!feat.enabled) {
      return {
        allowed: false,
        status: 403,
        reason: `${feat.name} has been temporarily disabled by platform administration.`,
        limits: feat.limits,
      };
    }
    if (feat.maintenanceMode) {
      return {
        allowed: false,
        status: 503,
        reason: feat.maintenanceMessage || `${feat.name} is temporarily in maintenance mode.`,
        limits: feat.limits,
      };
    }
    return { allowed: true, status: 200, limits: feat.limits };
  },

  updateFeature(
    adminId: string,
    key: string,
    patch: {
      name?: string;
      description?: string;
      enabled?: boolean;
      visibleInNav?: boolean;
      maintenanceMode?: boolean;
      maintenanceMessage?: string;
      limits?: Record<string, any>;
      settings?: Record<string, any>;
    }
  ) {
    this.ensurePlatformDefaults();
    const existing = db.prepare('SELECT * FROM platform_features WHERE key = ?').get(key) as any;
    if (!existing) {
      throw new Error(`Feature "${key}" not found.`);
    }

    const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
    const nextVisible = patch.visibleInNav !== undefined ? (patch.visibleInNav ? 1 : 0) : existing.visible_in_nav;
    const nextMaint = patch.maintenanceMode !== undefined ? (patch.maintenanceMode ? 1 : 0) : existing.maintenance_mode;
    const nextMaintMsg =
      patch.maintenanceMessage !== undefined ? String(patch.maintenanceMessage).slice(0, 300) : existing.maintenance_message;
    const nextName = patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : existing.name;
    const nextDesc = patch.description !== undefined ? String(patch.description).trim().slice(0, 300) : existing.description;

    let currentLimits = {};
    try {
      currentLimits = JSON.parse(existing.limits_json || '{}');
    } catch {
      currentLimits = {};
    }
    const mergedLimits = patch.limits ? { ...currentLimits, ...patch.limits } : currentLimits;

    let currentSettings = {};
    try {
      currentSettings = JSON.parse(existing.settings_json || '{}');
    } catch {
      currentSettings = {};
    }
    const mergedSettings = patch.settings ? { ...currentSettings, ...patch.settings } : currentSettings;

    db.prepare(`
      UPDATE platform_features
      SET name = ?, description = ?, enabled = ?, visible_in_nav = ?,
          maintenance_mode = ?, maintenance_message = ?, limits_json = ?,
          settings_json = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
      WHERE key = ?
    `).run(
      nextName,
      nextDesc,
      nextEnabled,
      nextVisible,
      nextMaint,
      nextMaintMsg,
      JSON.stringify(mergedLimits),
      JSON.stringify(mergedSettings),
      adminId,
      key
    );

    cache.invalidatePrefix('platform:config');
    adminSecurityService.logAdminAction(adminId, 'UPDATE_FEATURE_CONFIG', 'feature', key, {
      enabled: Boolean(nextEnabled),
      visibleInNav: Boolean(nextVisible),
      maintenanceMode: Boolean(nextMaint),
    });

    const updated = this.getPublicPlatformConfig();
    sseManager.broadcast('config:updated', updated);
    return updated.features.find((f) => f.key === key);
  },

  registerConfigurableFeature(
    adminId: string,
    input: {
      key: string;
      name: string;
      description: string;
      category?: 'core' | 'social' | 'discovery' | 'governance';
      navTab?: string | null;
      limits?: Record<string, any>;
    }
  ) {
    this.ensurePlatformDefaults();
    const safeKey = String(input.key || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');

    if (!safeKey || safeKey.length < 3 || safeKey.length > 40) {
      throw new Error('Feature key must be 3–40 lowercase letters, numbers, or underscores.');
    }
    if (!input.name?.trim() || !input.description?.trim()) {
      throw new Error('Feature name and description are required.');
    }

    const exists = db.prepare('SELECT key FROM platform_features WHERE key = ?').get(safeKey);
    if (exists) {
      throw new Error(`Feature with key "${safeKey}" already exists.`);
    }

    const category = input.category && ['core', 'social', 'discovery', 'governance'].includes(input.category)
      ? input.category
      : 'discovery';
    const allowedTabs = ['home', 'updates', 'chats', 'communities', null];
    const safeNavTab = allowedTabs.includes(input.navTab ?? null) ? (input.navTab ?? null) : null;

    db.prepare(`
      INSERT INTO platform_features (
        key, name, description, category, enabled, visible_in_nav,
        maintenance_mode, limits_json, settings_json, nav_tab, is_builtin, updated_by
      ) VALUES (?, ?, ?, ?, 1, 1, 0, ?, '{}', ?, 0, ?)
    `).run(
      safeKey,
      input.name.trim().slice(0, 80),
      input.description.trim().slice(0, 300),
      category,
      JSON.stringify(input.limits || {}),
      safeNavTab,
      adminId
    );

    cache.invalidatePrefix('platform:config');
    adminSecurityService.logAdminAction(adminId, 'REGISTER_FEATURE_FLAG', 'feature', safeKey, {
      name: input.name,
      category,
    });

    const updated = this.getPublicPlatformConfig();
    sseManager.broadcast('config:updated', updated);
    return updated.features.find((f) => f.key === safeKey);
  },

  updateWebsiteSettings(adminId: string, updates: Record<string, string>) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('Invalid website settings payload.');
    }
    this.ensurePlatformDefaults();
    const allowedKeys = new Set(DEFAULT_WEBSITE_SETTINGS.map((s) => s.key));
    const booleanKeys = new Set(['maintenance_mode', 'allow_new_registrations', 'admin_mfa_required']);

    runInTransaction(() => {
      const stmt = db.prepare(`
        UPDATE website_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?
      `);
      const appliedUpdates: Record<string, string> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (!allowedKeys.has(k)) continue;
        const strVal = String(v ?? '').trim().slice(0, 500);
        if (booleanKeys.has(k) && strVal !== 'true' && strVal !== 'false') {
          throw new Error(`Invalid boolean value for setting "${k}".`);
        }
        stmt.run(strVal, k);
        appliedUpdates[k] = strVal;
      }
      adminSecurityService.logAdminAction(adminId, 'UPDATE_WEBSITE_SETTINGS', 'system', 'website_settings', appliedUpdates);
    });

    cache.invalidatePrefix('platform:config');
    const updated = this.getPublicPlatformConfig();
    sseManager.broadcast('config:updated', updated);
    return updated.settings;
  },

  // ============================================================
  // 2. USERS & PROFILES MANAGEMENT
  // ============================================================
  listUsers(search?: string, roleFilter?: string, statusFilter?: string, userIdFilter?: string) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (userIdFilter) {
      conditions.push('u.id = ?');
      params.push(userIdFilter);
    }
    if (search && search.trim()) {
      const q = `%${escapeLikePattern(search.trim().toLowerCase())}%`;
      conditions.push(`(LOWER(COALESCE(u.username, '')) LIKE ? ESCAPE '\\' OR LOWER(u.matric_number) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(pr.handle, '')) LIKE ? ESCAPE '\\')`);
      params.push(q, q, q, q);
    }
    if (roleFilter && roleFilter !== 'all') {
      conditions.push('u.role = ?');
      params.push(roleFilter);
    }
    if (statusFilter && statusFilter !== 'all') {
      conditions.push('u.status = ?');
      params.push(statusFilter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        u.id, u.matric_number, u.role, u.status,
        u.is_verified, u.mfa_enabled, u.created_at, u.last_active_at, u.suspension_reason,
        u.account_restricted_until, u.restriction_reason, COALESCE(u.warnings_count, 0) as warnings_count,
        pr.name, pr.handle, pr.department, pr.school, pr.level, pr.hall_of_residence, pr.campus, pr.bio, pr.verified,
        COALESCE(pc.posts_count, 0) as posts_count
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      LEFT JOIN (
        SELECT author_id, COUNT(*) as posts_count
        FROM posts
        GROUP BY author_id
      ) pc ON pc.author_id = u.id
      ${where}
      ORDER BY CASE u.role WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 WHEN 'staff' THEN 3 ELSE 4 END, u.created_at DESC
      LIMIT 150
    `).all(...params) as any[];

    return rows.map((r) => ({
      id: r.id,
      matricNumber: r.matric_number,
      role: r.role,
      status: r.status,
      isVerified: Boolean(r.is_verified || r.verified),
      mfaEnabled: Boolean(r.mfa_enabled),
      name: r.name || 'Student',
      handle: r.handle || '@student',
      department: r.department || 'General Studies',
      school: r.school || 'Student Community',
      level: r.level || '100L',
      hallOfResidence: r.hall_of_residence || 'Off-Campus',
      campus: r.campus || 'Obanla',
      bio: r.bio || '',
      postsCount: Number(r.posts_count || 0),
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at || r.created_at,
      suspensionReason: r.suspension_reason || undefined,
      restrictedUntil: r.account_restricted_until || undefined,
      restrictionReason: r.restriction_reason || undefined,
      warningsCount: Number(r.warnings_count || 0),
    }));
  },

  createUserByAdmin(
    adminId: string,
    input: {
      identifier?: string;
      username: string;
      password: string;
      name: string;
      role?: 'admin' | 'moderator' | 'staff' | 'student';
      department?: string;
      level?: string;
      hallOfResidence?: string;
      matricNumber?: string;
    }
  ) {
    const role = input.role && ['admin', 'moderator', 'staff', 'student'].includes(input.role) ? input.role : 'student';
    const created = authService.register({
      username: input.username,
      password: input.password,
      name: input.name,
      department: input.department,
      level: input.level,
      hall_of_residence: input.hallOfResidence,
      matric_number: input.matricNumber,
    }, undefined, true);

    // Admin-created accounts are assigned desired role and verified community badge
    db.prepare('UPDATE users SET role = ?, verification_code = NULL WHERE id = ?').run(
      role,
      created.user.id
    );
    db.prepare('UPDATE user_profiles SET verified = 1 WHERE user_id = ?').run(created.user.id);

    if (role === 'moderator') {
      db.prepare(`
        INSERT OR IGNORE INTO moderator_permissions (
          user_id, assigned_by, can_review_reports, can_hide_content, can_warn_users,
          can_restrict_users, max_restriction_hours, can_review_communities, can_escalate
        ) VALUES (?, ?, 1, 1, 1, 1, 72, 1, 1)
      `).run(created.user.id, adminId);
    }

    adminSecurityService.logAdminAction(adminId, 'ADMIN_CREATE_ACCOUNT', 'user', created.user.id, {
      username: created.user.username,
      role,
    });
    cache.invalidatePrefix('admin:dashboard');

    return { ...created.user, role, is_verified: true };
  },

  updateUserProfileByAdmin(
    adminId: string,
    targetUserId: string,
    patch: {
      name?: string;
      department?: string;
      level?: string;
      hallOfResidence?: string;
      campus?: string;
      bio?: string;
      verified?: boolean;
    }
  ) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!user) throw new Error('User not found.');

    const profile = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(targetUserId) as any;
    if (!profile) throw new Error('User profile not found.');

    const nextName = patch.name !== undefined ? adminSecurityService.sanitizeText(patch.name.trim()) : profile.name;
    const nextDept = patch.department !== undefined ? adminSecurityService.sanitizeText(patch.department.trim()) : profile.department;
    const nextLevel = patch.level !== undefined ? patch.level.trim() : profile.level;
    const nextHall = patch.hallOfResidence !== undefined ? adminSecurityService.sanitizeText(patch.hallOfResidence.trim()) : profile.hall_of_residence;
    const nextCampus = patch.campus !== undefined ? patch.campus.trim() : profile.campus;
    const nextBio = patch.bio !== undefined ? adminSecurityService.sanitizeText(patch.bio.trim()) : profile.bio;
    const nextVerified = patch.verified !== undefined ? (patch.verified ? 1 : 0) : profile.verified;

    db.prepare(`
      UPDATE user_profiles
      SET name = ?, department = ?, level = ?, hall_of_residence = ?,
          campus = ?, bio = ?, verified = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(nextName, nextDept, nextLevel, nextHall, nextCampus, nextBio, nextVerified, targetUserId);

    adminSecurityService.logAdminAction(adminId, 'ADMIN_UPDATE_PROFILE', 'user', targetUserId, patch);
    cache.invalidatePrefix('posts:');
    return this.listUsers(undefined, undefined, undefined, targetUserId)[0];
  },

  // ============================================================
  // 3. CONTENT, CHATS & NOTIFICATIONS ADMINISTRATION
  // ============================================================
  listContentOverview(search?: string) {
    const q = search?.trim() ? `%${escapeLikePattern(search.trim().toLowerCase())}%` : null;
    const posts = db.prepare(`
      SELECT p.id, p.author_id, p.content, p.school_tag, p.hostel_tag, p.area_key,
             p.likes_count, p.comments_count, COALESCE(p.views_count, 0) as views_count,
             p.is_pinned, COALESCE(p.is_featured, 0) as is_featured,
             COALESCE(p.is_admin_post, 0) as is_admin_post,
             COALESCE(p.distribution_scope, 'standard') as distribution_scope,
             p.is_announcement, p.is_anonymous, COALESCE(p.is_hidden, 0) as is_hidden,
             p.created_at, pr.name as author_name, pr.handle as author_handle
      FROM posts p
      JOIN user_profiles pr ON pr.user_id = p.author_id
      WHERE p.created_at >= datetime('now', '-72 hours')
      ${q ? "AND (LOWER(p.content) LIKE ? ESCAPE '\\' OR LOWER(pr.name) LIKE ? ESCAPE '\\' OR LOWER(pr.handle) LIKE ? ESCAPE '\\')" : ''}
      ORDER BY p.is_pinned DESC, COALESCE(p.is_featured, 0) DESC, p.created_at DESC
      LIMIT 80
    `).all(...(q ? [q, q, q] : [])) as any[];

    const comments = db.prepare(`
      SELECT c.id, c.post_id, c.author_id, c.content, c.created_at,
             pr.name as author_name, pr.handle as author_handle
      FROM comments c
      JOIN user_profiles pr ON pr.user_id = c.author_id
      WHERE c.created_at >= datetime('now', '-72 hours')
      ${q ? "AND (LOWER(c.content) LIKE ? ESCAPE '\\' OR LOWER(pr.handle) LIKE ? ESCAPE '\\')" : ''}
      ORDER BY c.created_at DESC
      LIMIT 60
    `).all(...(q ? [q, q] : [])) as any[];

    return {
      posts: posts.map((p) => ({
        id: p.id,
        authorId: p.author_id,
        authorName: p.author_name,
        authorHandle: p.author_handle,
        content: p.content,
        schoolTag: p.school_tag,
        hostelTag: p.hostel_tag,
        areaKey: p.area_key || undefined,
        likesCount: p.likes_count,
        commentsCount: p.comments_count,
        viewsCount: Number(p.views_count || 0),
        isPinned: Boolean(p.is_pinned),
        isFeatured: Boolean(p.is_featured),
        isAdminPost: Boolean(p.is_admin_post),
        distributionScope: p.distribution_scope || 'standard',
        isAnnouncement: Boolean(p.is_announcement),
        isAnonymous: Boolean(p.is_anonymous),
        isHidden: Boolean(p.is_hidden),
        createdAt: p.created_at,
      })),
      comments: comments.map((c) => ({
        id: c.id,
        postId: c.post_id,
        authorId: c.author_id,
        authorName: c.author_name,
        authorHandle: c.author_handle,
        content: c.content,
        createdAt: c.created_at,
      })),
    };
  },

  createAdminPost(
    adminId: string,
    input: {
      content: string;
      schoolTag?: string;
      hostelTag?: string;
      areaKey?: string;
      isAnnouncement?: boolean;
      announcementUrgency?: 'normal' | 'high';
      isPinned?: boolean;
      isFeatured?: boolean;
      distributionScope?: 'standard' | 'featured' | 'global';
      pushNotification?: boolean;
      notificationTitle?: string;
    }
  ) {
    const content = adminSecurityService.sanitizeText(String(input.content || '').trim()).slice(0, 2000);
    if (content.length < 3) {
      throw new Error('Post content must be at least 3 characters.');
    }

    const postId = `post-adm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const isAnnouncement = input.isAnnouncement !== false ? 1 : 0;
    const urgency = input.announcementUrgency === 'high' ? 'high' : 'normal';
    const isPinned = input.isPinned ? 1 : 0;
    const isFeatured = input.isFeatured !== false ? 1 : 0;
    const distributionScope = ['standard', 'featured', 'global'].includes(String(input.distributionScope || ''))
      ? input.distributionScope!
      : isFeatured
      ? 'global'
      : 'standard';

    runInTransaction(() => {
      db.prepare(`
        INSERT INTO posts (
          id, author_id, content, school_tag, hostel_tag, area_key,
          is_announcement, announcement_urgency, is_pinned, is_featured, is_admin_post, distribution_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        postId,
        adminId,
        content,
        input.schoolTag?.trim().slice(0, 60) || (isAnnouncement ? 'Official Admin' : null),
        input.hostelTag?.trim().slice(0, 60) || null,
        input.areaKey?.trim().slice(0, 40) || null,
        isAnnouncement,
        urgency,
        isPinned,
        isFeatured,
        distributionScope
      );

      adminSecurityService.logAdminAction(adminId, 'ADMIN_CREATE_POST', 'post', postId, {
        isAnnouncement: Boolean(isAnnouncement),
        isPinned: Boolean(isPinned),
        isFeatured: Boolean(isFeatured),
        distributionScope,
      });
    });

    if (input.pushNotification) {
      this.broadcastNotification(adminId, {
        title: input.notificationTitle?.trim() || 'Official Admin Announcement (@THEBACKDOOR)',
        body: content.slice(0, 220),
        link: `/home?post=${postId}`,
      });
    }

    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:');
    sseManager.broadcast('post:admin_published', { postId, isFeatured: Boolean(isFeatured), isPinned: Boolean(isPinned) });

    return this.listContentOverview().posts.find((p) => p.id === postId);
  },

  updatePostByAdmin(
    adminId: string,
    postId: string,
    patch: {
      content?: string;
      schoolTag?: string;
      hostelTag?: string;
      areaKey?: string;
      isAnnouncement?: boolean;
      isPinned?: boolean;
      isFeatured?: boolean;
      distributionScope?: 'standard' | 'featured' | 'global';
    }
  ) {
    const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as any;
    if (!existing) throw new Error('Post not found.');

    const nextContent =
      patch.content !== undefined ? adminSecurityService.sanitizeText(patch.content.trim()).slice(0, 2000) : existing.content;
    if (!nextContent) throw new Error('Post content cannot be empty.');

    const nextSchoolTag = patch.schoolTag !== undefined ? patch.schoolTag.trim().slice(0, 60) || null : existing.school_tag;
    const nextHostelTag = patch.hostelTag !== undefined ? patch.hostelTag.trim().slice(0, 60) || null : existing.hostel_tag;
    const nextAreaKey = patch.areaKey !== undefined ? patch.areaKey.trim().slice(0, 40) || null : existing.area_key;
    const nextAnn = patch.isAnnouncement !== undefined ? (patch.isAnnouncement ? 1 : 0) : existing.is_announcement;
    const nextPinned = patch.isPinned !== undefined ? (patch.isPinned ? 1 : 0) : existing.is_pinned;
    const nextFeatured = patch.isFeatured !== undefined ? (patch.isFeatured ? 1 : 0) : existing.is_featured;
    const nextScope =
      patch.distributionScope && ['standard', 'featured', 'global'].includes(patch.distributionScope)
        ? patch.distributionScope
        : existing.distribution_scope || 'standard';

    db.prepare(`
      UPDATE posts
      SET content = ?, school_tag = ?, hostel_tag = ?, area_key = ?,
          is_announcement = ?, is_pinned = ?, is_featured = ?, distribution_scope = ?,
          edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextContent, nextSchoolTag, nextHostelTag, nextAreaKey, nextAnn, nextPinned, nextFeatured, nextScope, postId);

    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:');
    adminSecurityService.logAdminAction(adminId, 'ADMIN_UPDATE_POST', 'post', postId, patch);
    return {
      success: true,
      postId,
      content: nextContent,
      isAnnouncement: Boolean(nextAnn),
      isPinned: Boolean(nextPinned),
      isFeatured: Boolean(nextFeatured),
      distributionScope: nextScope,
    };
  },

  togglePostVisibility(adminId: string, postId: string, hidden: boolean) {
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    if (!post) throw new Error('Post not found.');

    db.prepare('UPDATE posts SET is_hidden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hidden ? 1 : 0, postId);
    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:dashboard');
    adminSecurityService.logAdminAction(adminId, hidden ? 'HIDE_POST' : 'UNHIDE_POST', 'post', postId);
    return { success: true, postId, isHidden: hidden };
  },

  togglePostPinned(adminId: string, postId: string, pinned: boolean) {
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    if (!post) throw new Error('Post not found.');

    db.prepare('UPDATE posts SET is_pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pinned ? 1 : 0, postId);
    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:dashboard');
    adminSecurityService.logAdminAction(adminId, pinned ? 'PIN_POST' : 'UNPIN_POST', 'post', postId);
    return { success: true, postId, isPinned: pinned };
  },

  togglePostFeatured(adminId: string, postId: string, featured: boolean, scope: 'standard' | 'featured' | 'global' = 'featured') {
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    if (!post) throw new Error('Post not found.');

    const nextScope = featured ? (scope === 'global' ? 'global' : 'featured') : 'standard';
    db.prepare('UPDATE posts SET is_featured = ?, distribution_scope = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      featured ? 1 : 0,
      nextScope,
      postId
    );
    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:dashboard');
    adminSecurityService.logAdminAction(adminId, featured ? 'FEATURE_POST' : 'UNFEATURE_POST', 'post', postId, {
      distributionScope: nextScope,
    });
    return { success: true, postId, isFeatured: featured, distributionScope: nextScope };
  },

  liftUserRestriction(adminId: string, userId: string, reason = 'Restriction lifted by Admin') {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found.');
    db.prepare(`
      UPDATE users
      SET account_restricted_until = NULL,
          restriction_reason = NULL,
          restricted_by = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId);
    adminSecurityService.logAdminAction(adminId, 'LIFT_USER_RESTRICTION', 'user', userId, { reason });
    cache.invalidatePrefix('admin:');
    return { success: true, userId };
  },

  listChatsModerationOverview() {
    const rows = db.prepare(`
      SELECT
        c.id, c.type, c.title, c.handle, c.last_message_at, c.created_at,
        COALESCE(cp_agg.participant_count, 0) as participant_count,
        COALESCE(m_agg.active_messages_count, 0) as active_messages_count,
        COALESCE(r_agg.pending_reports_count, 0) as pending_reports_count
      FROM chats c
      LEFT JOIN (
        SELECT chat_id, COUNT(*) as participant_count
        FROM chat_participants
        GROUP BY chat_id
      ) cp_agg ON cp_agg.chat_id = c.id
      LEFT JOIN (
        SELECT chat_id, COUNT(*) as active_messages_count
        FROM messages
        WHERE created_at >= datetime('now', '-72 hours')
        GROUP BY chat_id
      ) m_agg ON m_agg.chat_id = c.id
      LEFT JOIN (
        SELECT target_id, COUNT(*) as pending_reports_count
        FROM reports
        WHERE target_type = 'chat' AND status = 'pending'
        GROUP BY target_id
      ) r_agg ON r_agg.target_id = c.id
      ORDER BY pending_reports_count DESC, c.last_message_at DESC
      LIMIT 60
    `).all() as any[];

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      handle: r.handle,
      participantCount: Number(r.participant_count || 0),
      activeMessagesCount: Number(r.active_messages_count || 0),
      pendingReportsCount: Number(r.pending_reports_count || 0),
      lastMessageAt: r.last_message_at,
      createdAt: r.created_at,
    }));
  },

  inspectChatForModeration(adminId: string, chatId: string, moderationReason: string) {
    if (!moderationReason || moderationReason.trim().length < 10) {
      throw new Error('A legitimate documented moderation or safety reason (10+ characters) is required before inspecting chat messages.');
    }

    const chat = db.prepare('SELECT id, type, title FROM chats WHERE id = ?').get(chatId) as any;
    if (!chat) throw new Error('Chat thread not found.');

    adminSecurityService.logAdminAction(adminId, 'INSPECT_CHAT_FOR_MODERATION', 'chat', chatId, {
      reason: moderationReason.trim(),
    });

    const msgs = db.prepare(`
      SELECT m.id, m.sender_id, m.text, m.created_at, pr.name as sender_name, pr.handle as sender_handle
      FROM messages m
      LEFT JOIN user_profiles pr ON pr.user_id = m.sender_id
      WHERE m.chat_id = ? AND m.created_at >= datetime('now', '-72 hours')
      ORDER BY m.created_at DESC
      LIMIT 40
    `).all(chatId) as any[];

    return {
      chat,
      messages: msgs.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name || 'Student',
        senderHandle: m.sender_handle || '@student',
        text: m.text || '[media attachment]',
        createdAt: m.created_at,
      })),
    };
  },

  deleteChatByAdmin(adminId: string, chatId: string, reason: string) {
    const chat = db.prepare('SELECT id, title FROM chats WHERE id = ?').get(chatId) as any;
    if (!chat) throw new Error('Chat not found.');

    const candidateMedia: string[] = [];
    for (const m of db.prepare('SELECT images_json FROM messages WHERE chat_id = ? AND images_json IS NOT NULL').all(chatId) as any[]) {
      candidateMedia.push(...fileService.extractUploadFilenames(m.images_json));
    }

    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
    const mediaRes = deletionService.cleanupAfterChatDeletion(chatId, candidateMedia);
    adminSecurityService.logAdminAction(adminId, 'DELETE_CHAT_THREAD', 'chat', chatId, {
      title: chat.title,
      reason,
      filesDeleted: mediaRes.deletedCount,
    });
    cache.invalidatePrefix('admin:dashboard');
    return { success: true, chatId, filesDeleted: mediaRes.deletedCount };
  },

  broadcastNotification(adminId: string, input: { title: string; body: string; targetUserId?: string; link?: string }) {
    if (!input.title?.trim() || !input.body?.trim()) {
      throw new Error('Notification title and message body are required.');
    }
    const title = adminSecurityService.sanitizeText(input.title.trim());
    const body = adminSecurityService.sanitizeText(input.body.trim());
    const link = input.link?.trim()
      ? sanitizeSafeUrl(input.link.trim(), { allowRelative: true }) || '/updates'
      : '/updates';

    let deliveredCount = 0;
    runInTransaction(() => {
      if (input.targetUserId) {
        const u = db.prepare('SELECT id FROM users WHERE id = ?').get(input.targetUserId);
        if (!u) throw new Error('Target user not found.');
        const nid = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        db.prepare(`
          INSERT INTO notifications (id, user_id, type, title, body, link, is_read)
          VALUES (?, ?, 'announcement', ?, ?, ?, 0)
        `).run(nid, input.targetUserId, title, body, link);
        sseManager.sendToUser(input.targetUserId, 'notification:new', { id: nid, type: 'announcement', title, body, link });
        deliveredCount = 1;
      } else {
        const res = db.prepare(`
          INSERT INTO notifications (id, user_id, type, title, body, link, is_read)
          SELECT ('notif-' || ? || '-' || lower(hex(randomblob(6)))), id, 'announcement', ?, ?, ?, 0
          FROM users
          WHERE status = 'active'
        `).run(Date.now(), title, body, link);
        deliveredCount = Number(res.changes || 0);
        sseManager.broadcast('notification:new', { type: 'announcement', title, body, link });
      }
      adminSecurityService.logAdminAction(adminId, 'BROADCAST_NOTIFICATION', 'notification', input.targetUserId || 'all_active_users', {
        title,
        deliveredCount,
      });
    });

    return { success: true, deliveredCount };
  },

  listRecentNotifications(limit = 50) {
    const rows = db.prepare(`
      SELECT n.id, n.user_id, n.type, n.title, n.body, n.is_read, n.created_at,
             pr.name as recipient_name, pr.handle as recipient_handle
      FROM notifications n
      LEFT JOIN user_profiles pr ON pr.user_id = n.user_id
      ORDER BY n.created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      recipientName: r.recipient_name || r.user_id,
      recipientHandle: r.recipient_handle || '',
      type: r.type,
      title: r.title,
      body: r.body,
      isRead: Boolean(r.is_read),
      createdAt: r.created_at,
    }));
  },

  // ============================================================
  // 4. COMMUNITIES & GROUPS ADMINISTRATION
  // ============================================================
  listCommunitiesAdmin(communityIdFilter?: string) {
    const whereClause = communityIdFilter ? 'WHERE c.id = ?' : '';
    const params = communityIdFilter ? [communityIdFilter] : [];
    const rows = db.prepare(`
      SELECT c.*,
             COALESCE(cm_agg.actual_members, 0) as actual_members,
             COALESCE(p_agg.posts_count, 0) as posts_count
      FROM communities c
      LEFT JOIN (
        SELECT community_id, COUNT(*) as actual_members
        FROM community_memberships
        GROUP BY community_id
      ) cm_agg ON cm_agg.community_id = c.id
      LEFT JOIN (
        SELECT community_id, COUNT(*) as posts_count
        FROM posts
        WHERE community_id IS NOT NULL
        GROUP BY community_id
      ) p_agg ON p_agg.community_id = c.id
      ${whereClause}
      ORDER BY c.member_count DESC, c.created_at DESC
    `).all(...params) as any[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      acronym: r.acronym,
      category: r.category,
      description: r.description,
      location: r.location,
      leaders: r.leaders || '',
      isVerified: Boolean(r.is_verified),
      memberCount: Math.max(Number(r.member_count || 0), Number(r.actual_members || 0)),
      postsCount: Number(r.posts_count || 0),
      chatId: r.chat_id || null,
      createdAt: r.created_at,
    }));
  },

  updateCommunityAdmin(
    adminId: string,
    communityId: string,
    patch: { name?: string; description?: string; location?: string; isVerified?: boolean }
  ) {
    const comm = db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId) as any;
    if (!comm) throw new Error('Community not found.');

    db.prepare(`
      UPDATE communities
      SET name = ?, description = ?, location = ?, is_verified = ?
      WHERE id = ?
    `).run(
      patch.name !== undefined ? patch.name.trim() : comm.name,
      patch.description !== undefined ? patch.description.trim() : comm.description,
      patch.location !== undefined ? patch.location.trim() : comm.location,
      patch.isVerified !== undefined ? (patch.isVerified ? 1 : 0) : comm.is_verified,
      communityId
    );

    cache.invalidatePrefix('communities:');
    cache.invalidatePrefix('admin:dashboard');
    adminSecurityService.logAdminAction(adminId, 'ADMIN_UPDATE_COMMUNITY', 'community', communityId, patch);
    return this.listCommunitiesAdmin(communityId)[0];
  },

  deleteCommunityAdmin(adminId: string, communityId: string) {
    const comm = db.prepare('SELECT id, name, chat_id FROM communities WHERE id = ?').get(communityId) as any;
    if (!comm) throw new Error('Community not found.');

    runInTransaction(() => {
      db.prepare('DELETE FROM community_memberships WHERE community_id = ?').run(communityId);
      db.prepare('DELETE FROM communities WHERE id = ?').run(communityId);
      if (comm.chat_id) {
        db.prepare('DELETE FROM chats WHERE id = ?').run(comm.chat_id);
      }
      adminSecurityService.logAdminAction(adminId, 'ADMIN_DELETE_COMMUNITY', 'community', communityId, {
        name: comm.name,
      });
    });
    cache.invalidatePrefix('communities:');
    cache.invalidatePrefix('admin:dashboard');
    return { success: true, communityId };
  },

  // ============================================================
  // 5. STORAGE & ORPHANED FILES MANAGEMENT
  // ============================================================
  getStorageOverview() {
    this.ensurePlatformDefaults();
    return deletionService.getDetailedStorageMetrics();
  },

  cleanOrphanedFiles(adminId: string) {
    const uploadsDir = getUploadsDir();
    const referenced = fileService.getAllReferencedFilenames();

    let deletedCount = 0;
    let freedBytes = 0;

    if (fs.existsSync(uploadsDir)) {
      for (const name of fs.readdirSync(uploadsDir)) {
        const fp = path.join(uploadsDir, name);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && !referenced.has(name)) {
            fs.unlinkSync(fp);
            deletedCount++;
            freedBytes += st.size;
          }
        } catch {
          // ignore unlink errors
        }
      }
    }

    const tempRes = fileService.cleanTemporaryArtifacts(0);
    deletedCount += tempRes.deletedCount;
    freedBytes += tempRes.freedBytes;

    adminSecurityService.logAdminAction(adminId, 'CLEAN_ORPHANED_FILES', 'storage', 'uploads_and_temp', {
      deletedCount,
      freedBytes,
    });
    cache.invalidatePrefix('admin:dashboard');

    return { success: true, deletedCount, freedBytes };
  },

  clearExpiredCaches(adminId: string) {
    const presencePurged = presenceService.expireInactivePresence();
    const expiredSessions = db.prepare(`
      DELETE FROM sessions
      WHERE datetime(COALESCE(refresh_expires_at, expires_at)) <= datetime('now')
         OR (max_expires_at IS NOT NULL AND datetime(max_expires_at) <= datetime('now'))
         OR (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime('now', '-7 days'))
    `).run();
    const prevCacheStats = cache.getStats();
    cache.clear();
    const tempCleaned = fileService.cleanTemporaryArtifacts(0);

    adminSecurityService.logAdminAction(adminId, 'CLEAR_EXPIRED_CACHES', 'system', 'cache_and_sessions', {
      clearedCacheEntries: prevCacheStats.entries,
      expiredSessionsRemoved: Number(expiredSessions.changes || 0),
      expiredPresenceRemoved: presencePurged.purgedUsers,
      tempFilesRemoved: tempCleaned.deletedCount,
      tempBytesFreed: tempCleaned.freedBytes,
    });

    return {
      success: true,
      clearedCacheEntries: prevCacheStats.entries,
      expiredSessionsRemoved: Number(expiredSessions.changes || 0),
      expiredPresenceRemoved: presencePurged.purgedUsers,
      tempFilesRemoved: tempCleaned.deletedCount,
      freedBytes: tempCleaned.freedBytes,
    };
  },

  generateStorageReport(adminId: string) {
    const storage = this.getStorageOverview();
    const dashboard = adminSecurityService.getDashboardStatistics();
    const report = {
      generatedAt: new Date().toISOString(),
      generatedBy: adminId,
      targetLimitGb: storage.quotaGb,
      storage,
      recordCounts: {
        users: dashboard.users.total,
        posts: dashboard.content.posts,
        comments: dashboard.content.comments,
        messages: dashboard.content.messages,
        payments: (db.prepare('SELECT COUNT(*) as c FROM payments').get() as any)?.c || 0,
        retainedAccountingRecords: (db.prepare('SELECT COUNT(*) as c FROM retained_accounting_records').get() as any)?.c || 0,
      },
    };
    adminSecurityService.logAdminAction(adminId, 'GENERATE_STORAGE_REPORT', 'storage', 'report', {
      totalUsedBytes: storage.totalUsedBytes,
      usagePercent: storage.usagePercent,
      alertLevel: storage.alertLevel,
      orphansCount: storage.orphans.count,
    });
    return report;
  },

  // ============================================================
  // 7. ADMINISTRATIVE SECURITY, SESSIONS & TELEMETRY
  // ============================================================
  getSecurityOverview(adminId: string) {
    const adminRow = db.prepare('SELECT id, mfa_enabled FROM users WHERE id = ?').get(adminId) as any;
    const failedAttempts24h = (
      db.prepare("SELECT COUNT(*) as c FROM login_attempts WHERE success = 0 AND attempted_at >= datetime('now', '-1 day')").get() as any
    )?.c || 0;
    const activeSessions = (
      db.prepare(`
        SELECT COUNT(*) as c FROM sessions
        WHERE revoked_at IS NULL
          AND datetime(COALESCE(refresh_expires_at, expires_at)) > datetime('now')
          AND (max_expires_at IS NULL OR datetime(max_expires_at) > datetime('now'))
      `).get() as any
    )?.c || 0;
    const usersWithMultipleDevices = (
      db.prepare(`
        SELECT COUNT(*) as c FROM (
          SELECT user_id
          FROM sessions
          WHERE revoked_at IS NULL
            AND datetime(COALESCE(refresh_expires_at, expires_at)) > datetime('now')
            AND (max_expires_at IS NULL OR datetime(max_expires_at) > datetime('now'))
          GROUP BY user_id
          HAVING COUNT(*) > 1
        )
      `).get() as any
    )?.c || 0;
    const suspiciousEvents24h = (
      db.prepare(`
        SELECT COUNT(*) as c FROM security_events
        WHERE severity IN ('warning', 'high', 'critical')
          AND created_at >= datetime('now', '-1 day')
      `).get() as any
    )?.c || 0;
    const authErrors24h = (
      db.prepare(`
        SELECT COUNT(*) as c FROM security_events
        WHERE event_type IN ('INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_REUSE', 'MFA_VERIFICATION_FAILED', 'LOGIN_COOLDOWN_BLOCKED', 'FAILED_LOGIN_BURST')
          AND created_at >= datetime('now', '-1 day')
      `).get() as any
    )?.c || 0;

    const recentFailedLogins = db.prepare(`
      SELECT identifier, ip_address, attempted_at
      FROM login_attempts
      WHERE success = 0
      ORDER BY attempted_at DESC
      LIMIT 15
    `).all() as any[];

    const activeSessionsList = this.listActiveSessionsForAdmin(35);
    const securityEvents = this.listSecurityEvents(25);

    return {
      mfaEnabled: Boolean(adminRow?.mfa_enabled),
      failedLoginAttempts24h: failedAttempts24h,
      activeSessionsCount: activeSessions,
      usersWithMultipleDevices,
      suspiciousEvents24h,
      authErrors24h,
      sessionTtlDays: SESSION_POLICY.refreshInactivityDays,
      accessTtlMinutes: SESSION_POLICY.accessTtlMinutes,
      sessionMaxLifetimeDays: SESSION_POLICY.sessionMaxLifetimeDays,
      maxActiveDevices: SESSION_POLICY.maxActiveDevices,
      rateLimitRule: 'Escalating cooldowns starting at 5 failures / 15m (15m -> 30m -> 60m -> 180m)',
      passwordHashing: 'Argon2id (m=19456, t=2, p=1) with transparent legacy scrypt upgrade',
      recentFailedLogins: recentFailedLogins.map((r) => ({
        identifier: r.identifier,
        ipAddress: r.ip_address || 'unknown',
        attemptedAt: r.attempted_at,
      })),
      activeSessions: activeSessionsList,
      securityEvents,
    };
  },

  listActiveSessionsForAdmin(limit = 50) {
    const rows = db.prepare(`
      SELECT s.id, s.user_id, s.device_name, s.device_type, s.ip_address, s.last_active_at,
             s.created_at, s.expires_at, s.refresh_expires_at, s.max_expires_at, s.is_suspicious,
             u.username, u.role, pr.name as display_name,
             COUNT(*) OVER (PARTITION BY s.user_id) as user_device_count
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE s.revoked_at IS NULL
        AND datetime(COALESCE(s.refresh_expires_at, s.expires_at)) > datetime('now')
        AND (s.max_expires_at IS NULL OR datetime(s.max_expires_at) > datetime('now'))
      ORDER BY COALESCE(s.last_active_at, s.created_at) DESC
      LIMIT ?
    `).all(Math.min(200, Math.max(1, limit))) as any[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username || '@unknown',
      displayName: r.display_name || r.username || 'Account',
      role: r.role,
      deviceName: r.device_name || 'Web Browser',
      deviceType: r.device_type || 'desktop',
      ipAddress: r.ip_address || 'unknown',
      isSuspicious: Boolean(r.is_suspicious),
      userDeviceCount: Number(r.user_device_count || 1),
      lastActiveAt: r.last_active_at || r.created_at,
      createdAt: r.created_at,
      expiresAt: r.refresh_expires_at || r.expires_at,
      maxExpiresAt: r.max_expires_at || null,
    }));
  },

  listSecurityEvents(limit = 40, severity?: string) {
    const normalizedSeverity =
      severity && ['info', 'warning', 'high', 'critical'].includes(severity) ? severity : null;
    const rows = normalizedSeverity
      ? (db.prepare(`
          SELECT se.*, u.username
          FROM security_events se
          LEFT JOIN users u ON u.id = se.user_id
          WHERE se.severity = ?
          ORDER BY se.created_at DESC
          LIMIT ?
        `).all(normalizedSeverity, Math.min(200, Math.max(1, limit))) as any[])
      : (db.prepare(`
          SELECT se.*, u.username
          FROM security_events se
          LEFT JOIN users u ON u.id = se.user_id
          ORDER BY se.created_at DESC
          LIMIT ?
        `).all(Math.min(200, Math.max(1, limit))) as any[]);

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id || null,
      username: r.username || null,
      eventType: r.event_type,
      severity: r.severity,
      identifier: r.identifier || null,
      ipAddress: r.ip_address || 'unknown',
      deviceName: r.device_name || null,
      details: (() => {
        if (!r.details_json) return null;
        try {
          return JSON.parse(r.details_json);
        } catch {
          return null;
        }
      })(),
      resolved: Boolean(r.resolved),
      createdAt: r.created_at,
    }));
  },

  revokeSessionByAdmin(adminId: string, sessionId: string, reason = 'admin_remote_revocation') {
    const cleanId = String(sessionId || '').trim();
    const target = db.prepare('SELECT token, user_id, device_name FROM sessions WHERE id = ? AND revoked_at IS NULL').get(cleanId) as
      | { token: string; user_id: string; device_name: string | null }
      | undefined;
    if (!target) {
      throw new Error('Active session not found.');
    }
    db.prepare(`
      UPDATE sessions
      SET revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = ?
      WHERE token = ?
    `).run(reason, target.token);

    recordSecurityEvent({
      userId: target.user_id,
      eventType: 'ADMIN_REVOKED_SESSION',
      severity: 'warning',
      deviceName: target.device_name,
      details: { revokedBy: adminId, sessionId: cleanId, reason },
    });
    adminSecurityService.logAdminAction(adminId, 'REVOKE_USER_SESSION', 'session', cleanId, {
      targetUserId: target.user_id,
      reason,
    });
    return { success: true, revokedSessionId: cleanId, targetUserId: target.user_id };
  },

  revokeUserSessionsByAdmin(adminId: string, targetUserId: string, reason = 'admin_account_session_wipe') {
    const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) {
      throw new Error('User not found.');
    }
    const res = db.prepare(`
      UPDATE sessions
      SET revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(reason, targetUserId);
    const revokedCount = Number(res.changes || 0);
    recordSecurityEvent({
      userId: targetUserId,
      eventType: 'ADMIN_REVOKED_ALL_USER_SESSIONS',
      severity: 'high',
      details: { revokedBy: adminId, revokedCount, reason },
    });
    adminSecurityService.logAdminAction(adminId, 'REVOKE_ALL_USER_SESSIONS', 'user', targetUserId, {
      revokedCount,
      reason,
    });
    return { success: true, revokedCount, targetUserId };
  },

  initiateAdminMfaSetup(adminId: string, emailOrHandle: string) {
    return authService.initiateMfaSetup(adminId, emailOrHandle);
  },

  verifyAndEnableAdminMfa(adminId: string, code: string) {
    const res = authService.verifyAndEnableMfa(adminId, code);
    adminSecurityService.logAdminAction(adminId, 'ENABLE_ADMIN_MFA', 'security', adminId);
    return res;
  },

  disableAdminMfa(adminId: string, currentPassword: string) {
    const res = authService.disableMfa(adminId, currentPassword);
    adminSecurityService.logAdminAction(adminId, 'DISABLE_ADMIN_MFA', 'security', adminId);
    return res;
  },

  revokeExpiredOrAllSessions(adminId: string, currentToken?: string) {
    const currentHash = currentToken ? hashSessionToken(currentToken) : null;
    const res = currentHash
      ? db.prepare(`
          UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = 'admin_global_revocation'
          WHERE token != ? AND revoked_at IS NULL
        `).run(currentHash)
      : db.prepare(`
          UPDATE sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revoked_reason = 'admin_global_revocation'
          WHERE user_id != ? AND revoked_at IS NULL
        `).run(adminId);
    const revokedCount = Number(res.changes || 0);
    recordSecurityEvent({
      userId: adminId,
      eventType: 'ADMIN_REVOKED_GLOBAL_SESSIONS',
      severity: 'high',
      details: { revokedCount },
    });
    adminSecurityService.logAdminAction(adminId, 'REVOKE_ACTIVE_SESSIONS', 'security', 'sessions', {
      revokedCount,
    });
    return { success: true, revokedCount };
  },
};
