import { db, runInTransaction } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { sseManager } from '../realtime/sseManager.js';
import { adminSecurityService } from './adminSecurityService.js';
import { authService } from './authService.js';
import { notificationService } from './notificationService.js';

export interface ModeratorPermissionSet {
  userId: string;
  assignedBy: string;
  canReviewReports: boolean;
  canHideContent: boolean;
  canWarnUsers: boolean;
  canRestrictUsers: boolean;
  maxRestrictionHours: number;
  canReviewCommunities: boolean;
  canEscalate: boolean;
  assignedAreas: string[];
  notes: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ModeratorCapability =
  | 'canReviewReports'
  | 'canHideContent'
  | 'canWarnUsers'
  | 'canRestrictUsers'
  | 'canReviewCommunities'
  | 'canEscalate';

export class ForbiddenModeratorActionError extends Error {
  status = 403;
  code: string;
  constructor(message: string, code = 'MODERATOR_PERMISSION_DENIED') {
    super(message);
    this.name = 'ForbiddenModeratorActionError';
    this.code = code;
  }
}

function mapPermissionRow(row: any): ModeratorPermissionSet {
  let assignedAreas: string[] = [];
  if (row?.assigned_areas_json) {
    try {
      const parsed = JSON.parse(row.assigned_areas_json);
      if (Array.isArray(parsed)) assignedAreas = parsed.map((x) => String(x));
    } catch {
      assignedAreas = [];
    }
  }
  return {
    userId: row.user_id,
    assignedBy: row.assigned_by,
    canReviewReports: Boolean(row.can_review_reports),
    canHideContent: Boolean(row.can_hide_content),
    canWarnUsers: Boolean(row.can_warn_users),
    canRestrictUsers: Boolean(row.can_restrict_users),
    maxRestrictionHours: Math.max(1, Math.min(720, Number(row.max_restriction_hours || 72))),
    canReviewCommunities: Boolean(row.can_review_communities),
    canEscalate: Boolean(row.can_escalate),
    assignedAreas,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const moderatorService = {
  /**
   * Returns active permission configuration for a moderator (with safe defaults if row exists or minimal false if missing)
   */
  getModeratorPermissions(userId: string): ModeratorPermissionSet | null {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId) as
      | { id: string; role: string }
      | undefined;
    if (!user) return null;

    if (user.role === 'admin') {
      return {
        userId,
        assignedBy: userId,
        canReviewReports: true,
        canHideContent: true,
        canWarnUsers: true,
        canRestrictUsers: true,
        maxRestrictionHours: 720,
        canReviewCommunities: true,
        canEscalate: true,
        assignedAreas: [],
        notes: 'Full Admin authority',
      };
    }

    if (user.role !== 'moderator') return null;

    const row = db.prepare('SELECT * FROM moderator_permissions WHERE user_id = ?').get(userId) as any;
    if (!row) {
      return {
        userId,
        assignedBy: 'u-admin',
        canReviewReports: true,
        canHideContent: true,
        canWarnUsers: true,
        canRestrictUsers: false,
        maxRestrictionHours: 24,
        canReviewCommunities: true,
        canEscalate: true,
        assignedAreas: [],
        notes: '',
      };
    }
    return mapPermissionRow(row);
  },

  /**
   * Backend capability guard enforced on every Moderator action
   */
  assertCapability(actorId: string, actorRole: string, capability: ModeratorCapability): ModeratorPermissionSet {
    if (actorRole !== 'moderator' && actorRole !== 'admin') {
      throw new ForbiddenModeratorActionError('Forbidden. Moderator or Admin role required.');
    }
    const perms = this.getModeratorPermissions(actorId);
    if (!perms) {
      throw new ForbiddenModeratorActionError('Forbidden. Active moderator credentials not found.');
    }
    if (!perms[capability]) {
      throw new ForbiddenModeratorActionError(
        `Forbidden. Your Moderator account does not currently have "${capability}" permission.`,
        'MODERATOR_CAPABILITY_DISABLED'
      );
    }
    return perms;
  },

  /**
   * Admin-only: List all moderator accounts + granular permissions + recent activity counts
   */
  listModerators() {
    const rows = db.prepare(`
      SELECT u.id, u.matric_number, u.email, u.username, u.role, u.status, u.last_active_at, u.created_at,
             pr.name, pr.handle, pr.department, pr.campus,
             mp.assigned_by, mp.can_review_reports, mp.can_hide_content, mp.can_warn_users,
             mp.can_restrict_users, mp.max_restriction_hours, mp.can_review_communities,
             mp.can_escalate, mp.assigned_areas_json, mp.notes, mp.updated_at as perms_updated_at,
             (SELECT COUNT(*) FROM admin_audit_logs a WHERE a.admin_id = u.id) as actions_count,
             (SELECT COUNT(*) FROM reports r WHERE r.reviewed_by = u.id OR r.assigned_to = u.id) as handled_reports_count
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      LEFT JOIN moderator_permissions mp ON mp.user_id = u.id
      WHERE u.role = 'moderator'
      ORDER BY u.created_at DESC
    `).all() as any[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name || 'Moderator',
      handle: r.handle || r.username || '@moderator',
      email: r.email,
      matricNumber: r.matric_number,
      department: r.department || 'Community Safety',
      campus: r.campus || 'Main Campus',
      status: r.status,
      lastActiveAt: r.last_active_at || r.created_at,
      createdAt: r.created_at,
      actionsCount: Number(r.actions_count || 0),
      handledReportsCount: Number(r.handled_reports_count || 0),
      permissions: r.assigned_by
        ? mapPermissionRow({ ...r, user_id: r.id, updated_at: r.perms_updated_at })
        : {
            userId: r.id,
            assignedBy: 'u-admin',
            canReviewReports: true,
            canHideContent: true,
            canWarnUsers: true,
            canRestrictUsers: true,
            maxRestrictionHours: 72,
            canReviewCommunities: true,
            canEscalate: true,
            assignedAreas: [],
            notes: '',
          },
    }));
  },

  /**
   * Admin-only: Create a new moderator account OR promote an existing non-admin user with granular permissions
   */
  assignModerator(
    adminId: string,
    input: {
      userId?: string;
      identifier?: string;
      username?: string;
      password?: string;
      name?: string;
      department?: string;
      permissions?: Partial<ModeratorPermissionSet>;
    }
  ) {
    let targetUserId = input.userId?.trim();

    return runInTransaction(() => {
      if (!targetUserId) {
        if (!input.username || !input.password) {
          throw new Error('Provide an existing userId OR @username and strong password to create a Moderator.');
        }
        const created = authService.register(
          {
            username: input.username,
            password: input.password,
            name: input.name || input.username.replace('@', ''),
            department: input.department || 'Community Moderation',
            level: 'Moderator',
          },
          undefined,
          true
        );
        targetUserId = created.user.id;
        db.prepare('UPDATE user_profiles SET verified = 1 WHERE user_id = ?').run(targetUserId);
      }

      const target = db.prepare('SELECT id, role, email FROM users WHERE id = ?').get(targetUserId) as any;
      if (!target) {
        throw new Error('Target user account not found.');
      }
      if (target.role === 'admin') {
        throw new Error('Forbidden. The primary Admin account (@THEBACKDOOR) cannot be converted into a Moderator.');
      }

      db.prepare("UPDATE users SET role = 'moderator', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(targetUserId);

      // Update profile badge cleanly
      const prof = db.prepare('SELECT badges_json FROM user_profiles WHERE user_id = ?').get(targetUserId) as
        | { badges_json?: string }
        | undefined;
      let badges: string[] = [];
      try {
        badges = prof?.badges_json ? JSON.parse(prof.badges_json) : [];
      } catch {
        badges = [];
      }
      if (!badges.includes('Moderator')) badges.unshift('Moderator');
      db.prepare('UPDATE user_profiles SET badges_json = ? WHERE user_id = ?').run(
        JSON.stringify(badges.slice(0, 6)),
        targetUserId
      );

      const p = input.permissions || {};
      const maxHours = Math.max(1, Math.min(720, Number(p.maxRestrictionHours ?? 72)));
      const assignedAreas = Array.isArray(p.assignedAreas) ? p.assignedAreas.map(String).slice(0, 20) : [];

      db.prepare(`
        INSERT INTO moderator_permissions (
          user_id, assigned_by, can_review_reports, can_hide_content, can_warn_users,
          can_restrict_users, max_restriction_hours, can_review_communities, can_escalate,
          assigned_areas_json, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          assigned_by = excluded.assigned_by,
          can_review_reports = excluded.can_review_reports,
          can_hide_content = excluded.can_hide_content,
          can_warn_users = excluded.can_warn_users,
          can_restrict_users = excluded.can_restrict_users,
          max_restriction_hours = excluded.max_restriction_hours,
          can_review_communities = excluded.can_review_communities,
          can_escalate = excluded.can_escalate,
          assigned_areas_json = excluded.assigned_areas_json,
          notes = excluded.notes,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        targetUserId,
        adminId,
        p.canReviewReports !== false ? 1 : 0,
        p.canHideContent !== false ? 1 : 0,
        p.canWarnUsers !== false ? 1 : 0,
        p.canRestrictUsers !== false ? 1 : 0,
        maxHours,
        p.canReviewCommunities !== false ? 1 : 0,
        p.canEscalate !== false ? 1 : 0,
        JSON.stringify(assignedAreas),
        String(p.notes || '').slice(0, 300)
      );

      notificationService.createNotificationsBatch([
        {
          userId: targetUserId,
          type: 'system',
          title: 'Moderator Role Assigned',
          body: 'You have been assigned Moderator permissions on Schoolbackdoor. Please review moderation guidelines carefully.',
          link: '/mod',
        },
      ]);

      adminSecurityService.logAdminAction(adminId, 'ASSIGN_MODERATOR', 'user', targetUserId, {
        maxRestrictionHours: maxHours,
        canRestrictUsers: p.canRestrictUsers !== false,
      });
      cache.invalidatePrefix('admin:');

      return this.listModerators().find((m) => m.id === targetUserId)!;
    });
  },

  /**
   * Admin-only: Update a moderator's granular permission flags
   */
  updateModeratorPermissions(adminId: string, modUserId: string, patch: Partial<ModeratorPermissionSet>) {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(modUserId) as
      | { id: string; role: string }
      | undefined;
    if (!user || user.role !== 'moderator') {
      throw new Error('Moderator account not found.');
    }
    const current = this.getModeratorPermissions(modUserId)!;
    const nextMaxHours =
      patch.maxRestrictionHours !== undefined
        ? Math.max(1, Math.min(720, Number(patch.maxRestrictionHours)))
        : current.maxRestrictionHours;
    const nextAreas =
      patch.assignedAreas !== undefined ? patch.assignedAreas.map(String).slice(0, 20) : current.assignedAreas;

    db.prepare(`
      INSERT INTO moderator_permissions (
        user_id, assigned_by, can_review_reports, can_hide_content, can_warn_users,
        can_restrict_users, max_restriction_hours, can_review_communities, can_escalate,
        assigned_areas_json, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        assigned_by = excluded.assigned_by,
        can_review_reports = excluded.can_review_reports,
        can_hide_content = excluded.can_hide_content,
        can_warn_users = excluded.can_warn_users,
        can_restrict_users = excluded.can_restrict_users,
        max_restriction_hours = excluded.max_restriction_hours,
        can_review_communities = excluded.can_review_communities,
        can_escalate = excluded.can_escalate,
        assigned_areas_json = excluded.assigned_areas_json,
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      modUserId,
      adminId,
      (patch.canReviewReports ?? current.canReviewReports) ? 1 : 0,
      (patch.canHideContent ?? current.canHideContent) ? 1 : 0,
      (patch.canWarnUsers ?? current.canWarnUsers) ? 1 : 0,
      (patch.canRestrictUsers ?? current.canRestrictUsers) ? 1 : 0,
      nextMaxHours,
      (patch.canReviewCommunities ?? current.canReviewCommunities) ? 1 : 0,
      (patch.canEscalate ?? current.canEscalate) ? 1 : 0,
      JSON.stringify(nextAreas),
      String(patch.notes ?? current.notes).slice(0, 300)
    );

    adminSecurityService.logAdminAction(adminId, 'UPDATE_MODERATOR_PERMISSIONS', 'user', modUserId, patch);
    cache.invalidatePrefix('admin:');
    return this.listModerators().find((m) => m.id === modUserId)!;
  },

  /**
   * Admin-only: Revoke moderator role back to student and terminate elevated sessions
   */
  revokeModerator(adminId: string, modUserId: string) {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(modUserId) as
      | { id: string; role: string }
      | undefined;
    if (!user || user.role !== 'moderator') {
      throw new Error('Moderator account not found.');
    }

    runInTransaction(() => {
      db.prepare("UPDATE users SET role = 'student', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(modUserId);
      db.prepare('DELETE FROM moderator_permissions WHERE user_id = ?').run(modUserId);
      const prof = db.prepare('SELECT badges_json FROM user_profiles WHERE user_id = ?').get(modUserId) as
        | { badges_json?: string }
        | undefined;
      if (prof?.badges_json) {
        try {
          const filtered = (JSON.parse(prof.badges_json) as string[]).filter((b) => b !== 'Moderator');
          db.prepare('UPDATE user_profiles SET badges_json = ? WHERE user_id = ?').run(
            JSON.stringify(filtered),
            modUserId
          );
        } catch {
          // ignore
        }
      }
      adminSecurityService.logAdminAction(adminId, 'REVOKE_MODERATOR', 'user', modUserId);
    });
    cache.invalidatePrefix('admin:');
    return { success: true, userId: modUserId, newRole: 'student' };
  },

  /**
   * Scoped Moderator Dashboard Overview (ZERO financial, payment, ad, or unrestricted user dumps)
   */
  getModeratorDashboard(modId: string, actorRole: string) {
    const perms = this.assertCapability(modId, actorRole, 'canReviewReports');

    const pendingReports = (db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'").get() as any)?.c || 0;
    const escalatedReports = (
      db.prepare("SELECT COUNT(*) as c FROM reports WHERE COALESCE(escalated_to_admin, 0) = 1").get() as any
    )?.c || 0;
    const myHandledReports = (
      db.prepare('SELECT COUNT(*) as c FROM reports WHERE reviewed_by = ? OR assigned_to = ?').get(modId, modId) as any
    )?.c || 0;
    const hiddenPostsCount = (
      db.prepare("SELECT COUNT(*) as c FROM posts WHERE COALESCE(is_hidden, 0) = 1 AND created_at >= datetime('now', '-72 hours')").get() as any
    )?.c || 0;
    const activeRestrictedUsers = (
      db.prepare('SELECT COUNT(*) as c FROM users WHERE account_restricted_until > CURRENT_TIMESTAMP').get() as any
    )?.c || 0;
    const myActionsCount = (
      db.prepare('SELECT COUNT(*) as c FROM admin_audit_logs WHERE admin_id = ?').get(modId) as any
    )?.c || 0;

    return {
      permissions: perms,
      stats: {
        pendingReports: Number(pendingReports),
        escalatedReports: Number(escalatedReports),
        myHandledReports: Number(myHandledReports),
        hiddenPostsCount: Number(hiddenPostsCount),
        activeRestrictedUsers: Number(activeRestrictedUsers),
        myActionsCount: Number(myActionsCount),
      },
    };
  },

  /**
   * Moderator-scoped reports queue with contextual snippet of flagged item ONLY
   */
  listReportsForModerator(modId: string, actorRole: string, filters: { status?: string; scope?: 'all' | 'assigned' | 'escalated' } = {}) {
    this.assertCapability(modId, actorRole, 'canReviewReports');

    const whereParts: string[] = [];
    const params: any[] = [];
    if (filters.status && filters.status !== 'all') {
      whereParts.push('r.status = ?');
      params.push(filters.status);
    }
    if (filters.scope === 'assigned') {
      whereParts.push('r.assigned_to = ?');
      params.push(modId);
    } else if (filters.scope === 'escalated') {
      whereParts.push('COALESCE(r.escalated_to_admin, 0) = 1');
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT r.*,
             rp.name as reporter_name, rp.handle as reporter_handle,
             rev.handle as reviewed_by_handle
      FROM reports r
      LEFT JOIN user_profiles rp ON rp.user_id = r.reporter_id
      LEFT JOIN user_profiles rev ON rev.user_id = r.reviewed_by
      ${whereSql}
      ORDER BY COALESCE(r.escalated_to_admin, 0) DESC,
               CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
               r.created_at DESC
      LIMIT 120
    `).all(...params) as any[];

    return rows.map((r) => {
      let targetPreview: any = null;
      if (r.target_type === 'post') {
        const post = db.prepare(`
          SELECT p.id, p.author_id, p.content, COALESCE(p.is_hidden, 0) as is_hidden, p.community_id,
                 pr.name as author_name, pr.handle as author_handle, u.role as author_role,
                 u.account_restricted_until, COALESCE(u.warnings_count, 0) as warnings_count
          FROM posts p
          JOIN users u ON u.id = p.author_id
          LEFT JOIN user_profiles pr ON pr.user_id = p.author_id
          WHERE p.id = ?
        `).get(r.target_id) as any;
        if (post) {
          targetPreview = {
            exists: true,
            targetUserId: post.author_id,
            authorName: post.author_name || 'Student',
            authorHandle: post.author_handle || '@student',
            authorRole: post.author_role,
            snippet: String(post.content || '').slice(0, 280),
            isHidden: Boolean(post.is_hidden),
            communityId: post.community_id || undefined,
            restrictedUntil: post.account_restricted_until || undefined,
            warningsCount: Number(post.warnings_count || 0),
          };
        }
      } else if (r.target_type === 'comment') {
        const comment = db.prepare(`
          SELECT c.id, c.post_id, c.author_id, c.content,
                 pr.name as author_name, pr.handle as author_handle, u.role as author_role
          FROM comments c
          JOIN users u ON u.id = c.author_id
          LEFT JOIN user_profiles pr ON pr.user_id = c.author_id
          WHERE c.id = ?
        `).get(r.target_id) as any;
        if (comment) {
          targetPreview = {
            exists: true,
            targetUserId: comment.author_id,
            postId: comment.post_id,
            authorName: comment.author_name || 'Student',
            authorHandle: comment.author_handle || '@student',
            authorRole: comment.author_role,
            snippet: String(comment.content || '').slice(0, 280),
          };
        }
      } else if (r.target_type === 'user') {
        const targetUser = db.prepare(`
          SELECT u.id, u.role, u.status, u.account_restricted_until, COALESCE(u.warnings_count, 0) as warnings_count,
                 pr.name, pr.handle, pr.department
          FROM users u
          LEFT JOIN user_profiles pr ON pr.user_id = u.id
          WHERE u.id = ?
        `).get(r.target_id) as any;
        if (targetUser) {
          targetPreview = {
            exists: true,
            targetUserId: targetUser.id,
            authorName: targetUser.name || 'Student',
            authorHandle: targetUser.handle || '@student',
            authorRole: targetUser.role,
            accountStatus: targetUser.status,
            restrictedUntil: targetUser.account_restricted_until || undefined,
            warningsCount: Number(targetUser.warnings_count || 0),
            snippet: `${targetUser.department || 'Campus'} · Status: ${targetUser.status}`,
          };
        }
      } else if (r.target_type === 'chat') {
        const chat = db.prepare('SELECT id, type, title, handle FROM chats WHERE id = ?').get(r.target_id) as any;
        if (chat) {
          targetPreview = {
            exists: true,
            authorName: chat.title,
            authorHandle: chat.handle,
            snippet: `Reported ${chat.type} thread (${chat.title}) — flagged content only`,
          };
        }
      }

      return {
        ...r,
        escalated_to_admin: Boolean(r.escalated_to_admin),
        targetPreview: targetPreview || { exists: false, snippet: '[Target removed or expired]' },
      };
    });
  },

  /**
   * Moderator reviews/resolves/dismisses a report
   */
  reviewReportByModerator(
    modId: string,
    actorRole: string,
    reportId: string,
    status: 'reviewed' | 'dismissed' | 'resolved',
    resolutionNotes?: string,
    actionTaken?: string
  ) {
    this.assertCapability(modId, actorRole, 'canReviewReports');
    const allowed = new Set(['reviewed', 'dismissed', 'resolved']);
    if (!allowed.has(status)) {
      throw new Error('Invalid report status. Allowed: reviewed, dismissed, resolved.');
    }

    const report = db.prepare('SELECT id FROM reports WHERE id = ?').get(reportId);
    if (!report) throw new Error('Report not found.');

    const cleanNotes = resolutionNotes?.trim() ? resolutionNotes.trim().slice(0, 500) : null;
    const cleanAction = actionTaken?.trim() ? actionTaken.trim().slice(0, 120) : null;

    db.prepare(`
      UPDATE reports
      SET status = ?,
          resolution_notes = ?,
          action_taken = COALESCE(?, action_taken),
          reviewed_by = ?,
          assigned_to = COALESCE(assigned_to, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, cleanNotes, cleanAction, modId, modId, reportId);

    adminSecurityService.logAdminAction(modId, `MODERATOR_REPORT_${status.toUpperCase()}`, 'report', reportId, {
      resolutionNotes: cleanNotes,
      actionTaken: cleanAction,
    });
    cache.invalidatePrefix('admin:');
    return { success: true, reportId, status };
  },

  /**
   * Escalate serious report case to Admin (@THEBACKDOOR)
   */
  escalateReportToAdmin(modId: string, actorRole: string, reportId: string, reason: string) {
    this.assertCapability(modId, actorRole, 'canEscalate');
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (cleanReason.length < 5) {
      throw new Error('Please provide a clear escalation reason (at least 5 characters) for the Admin.');
    }

    const report = db.prepare('SELECT id, target_type, target_id, reason FROM reports WHERE id = ?').get(reportId) as any;
    if (!report) throw new Error('Report not found.');

    db.prepare(`
      UPDATE reports
      SET escalated_to_admin = 1,
          escalation_reason = ?,
          escalated_by = ?,
          escalated_at = CURRENT_TIMESTAMP,
          priority = 'urgent',
          status = CASE WHEN status = 'pending' THEN 'reviewed' ELSE status END,
          reviewed_by = COALESCE(reviewed_by, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cleanReason, modId, modId, reportId);

    const modProf = db.prepare('SELECT handle FROM user_profiles WHERE user_id = ?').get(modId) as
      | { handle?: string }
      | undefined;

    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all() as Array<{ id: string }>;
    if (admins.length > 0) {
      notificationService.createNotificationsBatch(
        admins.map((a) => ({
          userId: a.id,
          type: 'system',
          title: 'Escalated Moderation Case',
          body: `${modProf?.handle || 'Moderator'} escalated ${report.target_type} report (${report.reason}): "${cleanReason}"`,
          link: '/admin?section=reports',
        }))
      );
      sseManager.broadcastToUsers(
        admins.map((a) => a.id),
        'admin:escalation:new',
        { reportId, targetType: report.target_type, reason: cleanReason, escalatedBy: modId }
      );
    }

    adminSecurityService.logAdminAction(modId, 'MODERATOR_ESCALATE_REPORT', 'report', reportId, {
      reason: cleanReason,
    });
    cache.invalidatePrefix('admin:');
    return { success: true, reportId, escalatedToAdmin: true, reason: cleanReason };
  },

  /**
   * Moderator hides or removes violating posts/comments (respects canHideContent & blocks hiding Admin official posts)
   */
  moderateContentByModerator(
    modId: string,
    actorRole: string,
    targetType: 'post' | 'comment',
    targetId: string,
    action: 'hide' | 'unhide' | 'remove',
    reason: string
  ) {
    this.assertCapability(modId, actorRole, 'canHideContent');
    const cleanReason = String(reason || '').trim().slice(0, 300) || 'Community guideline violation';

    if (targetType === 'post') {
      const post = db
        .prepare('SELECT id, author_id, is_admin_post, community_id FROM posts WHERE id = ?')
        .get(targetId) as any;
      if (!post) throw new Error('Post not found.');

      const author = db.prepare('SELECT role FROM users WHERE id = ?').get(post.author_id) as { role?: string } | undefined;
      if ((Boolean(post.is_admin_post) || author?.role === 'admin') && actorRole !== 'admin') {
        throw new ForbiddenModeratorActionError('Forbidden. Moderators cannot hide or remove Official Admin posts.');
      }

      if (action === 'remove') {
        // Moderators hide violating posts cleanly with audit trace; Admin retains permanent hard-delete authority
        db.prepare('UPDATE posts SET is_hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetId);
      } else {
        db.prepare('UPDATE posts SET is_hidden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          action === 'hide' ? 1 : 0,
          targetId
        );
      }

      cache.invalidatePrefix('posts:');
      cache.invalidatePrefix('communities:');
      adminSecurityService.logAdminAction(
        modId,
        `MODERATOR_${action.toUpperCase()}_POST`,
        'post',
        targetId,
        { reason: cleanReason, communityId: post.community_id }
      );
      return { success: true, targetType, targetId, action, isHidden: action !== 'unhide' };
    }

    if (targetType === 'comment') {
      const comment = db.prepare('SELECT id, post_id, author_id FROM comments WHERE id = ?').get(targetId) as any;
      if (!comment) throw new Error('Comment not found.');
      const author = db.prepare('SELECT role FROM users WHERE id = ?').get(comment.author_id) as
        | { role?: string }
        | undefined;
      if (author?.role === 'admin' && actorRole !== 'admin') {
        throw new ForbiddenModeratorActionError('Forbidden. Moderators cannot remove Admin comments.');
      }

      runInTransaction(() => {
        db.prepare('DELETE FROM comments WHERE id = ?').run(targetId);
        db.prepare(
          'UPDATE posts SET comments_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?) WHERE id = ?'
        ).run(comment.post_id, comment.post_id);
      });
      cache.invalidatePrefix('posts:');
      adminSecurityService.logAdminAction(modId, 'MODERATOR_REMOVE_COMMENT', 'comment', targetId, {
        reason: cleanReason,
        postId: comment.post_id,
      });
      return { success: true, targetType, targetId, action: 'remove' };
    }

    throw new Error('Unsupported content target type.');
  },

  /**
   * Moderator issues a formal warning to a non-Admin, non-Moderator user
   */
  warnUserByModerator(
    modId: string,
    actorRole: string,
    targetUserId: string,
    reason: string,
    severity: 'minor' | 'standard' | 'severe' = 'standard',
    details?: string
  ) {
    this.assertCapability(modId, actorRole, 'canWarnUsers');

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetUserId) as any;
    if (!target) throw new Error('User not found.');
    if (target.id === modId) {
      throw new ForbiddenModeratorActionError('Forbidden. You cannot warn your own account.');
    }
    if ((target.role === 'admin' || target.role === 'moderator') && actorRole !== 'admin') {
      throw new ForbiddenModeratorActionError('Forbidden. Moderators cannot issue warnings to Admin or Moderator accounts.');
    }

    const cleanReason = String(reason || '').trim().slice(0, 200);
    if (cleanReason.length < 3) {
      throw new Error('Please specify a warning reason (at least 3 characters).');
    }

    const warningId = `warn-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    runInTransaction(() => {
      db.prepare(`
        INSERT INTO user_warnings (id, user_id, admin_id, reason, severity, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(warningId, targetUserId, modId, cleanReason, severity, details?.slice(0, 500) || null);

      db.prepare('UPDATE users SET warnings_count = COALESCE(warnings_count, 0) + 1 WHERE id = ?').run(targetUserId);

      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, link)
        VALUES (?, ?, 'system', 'Community Guideline Warning', ?, '/settings')
      `).run(
        `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        targetUserId,
        `A ${severity} moderation warning was issued: ${cleanReason}. Repeated violations may result in temporary account restrictions.`
      );

      adminSecurityService.logAdminAction(modId, 'MODERATOR_ISSUE_WARNING', 'user', targetUserId, {
        warningId,
        reason: cleanReason,
        severity,
      });
    });

    cache.invalidatePrefix('admin:');
    return { success: true, warningId, userId: targetUserId, reason: cleanReason, severity };
  },

  /**
   * Moderator places a time-bounded temporary restriction on a student/staff user
   */
  restrictUserByModerator(
    modId: string,
    actorRole: string,
    targetUserId: string,
    durationHours: number,
    reason: string
  ) {
    const perms = this.assertCapability(modId, actorRole, 'canRestrictUsers');

    const hours = Number(durationHours);
    if (!Number.isFinite(hours) || hours < 1) {
      throw new Error('Restriction duration must be at least 1 hour.');
    }
    if (actorRole !== 'admin' && hours > perms.maxRestrictionHours) {
      throw new ForbiddenModeratorActionError(
        `Forbidden. Your temporary restriction limit is ${perms.maxRestrictionHours} hour(s). Escalate to Admin for longer restrictions.`,
        'MODERATOR_DURATION_EXCEEDED'
      );
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetUserId) as any;
    if (!target) throw new Error('User not found.');
    if (target.id === modId) {
      throw new ForbiddenModeratorActionError('Forbidden. You cannot restrict your own account.');
    }
    if ((target.role === 'admin' || target.role === 'moderator') && actorRole !== 'admin') {
      throw new ForbiddenModeratorActionError('Forbidden. Moderators cannot restrict Admin or Moderator accounts.');
    }

    const cleanReason = String(reason || '').trim().slice(0, 300) || 'Temporary posting/messaging restriction';
    const restrictedUntil = new Date(Date.now() + Math.min(720, hours) * 60 * 60 * 1000).toISOString();

    runInTransaction(() => {
      db.prepare(`
        UPDATE users
        SET account_restricted_until = ?,
            restriction_reason = ?,
            restricted_by = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(restrictedUntil, cleanReason, modId, targetUserId);

      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, link)
        VALUES (?, ?, 'account', 'Temporary Account Restriction', ?, '/settings')
      `).run(
        `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        targetUserId,
        `Your posting and messaging privileges are temporarily restricted until ${restrictedUntil}. Reason: ${cleanReason}`
      );

      adminSecurityService.logAdminAction(modId, 'MODERATOR_RESTRICT_USER', 'user', targetUserId, {
        durationHours: hours,
        restrictedUntil,
        reason: cleanReason,
      });
    });

    cache.invalidatePrefix('admin:');
    return {
      success: true,
      userId: targetUserId,
      restrictedUntil,
      durationHours: hours,
      reason: cleanReason,
    };
  },

  /**
   * Moderator-scoped community safety review queue (flagged community posts & public group metadata)
   */
  listCommunitiesForModerator(modId: string, actorRole: string) {
    this.assertCapability(modId, actorRole, 'canReviewCommunities');

    const flaggedPosts = db.prepare(`
      SELECT p.id as post_id, p.community_id, p.author_id, p.content, COALESCE(p.is_hidden, 0) as is_hidden, p.created_at,
             c.name as community_name, c.acronym as community_acronym,
             pr.handle as author_handle,
             COUNT(r.id) as reports_count
      FROM reports r
      JOIN posts p ON p.id = r.target_id AND r.target_type = 'post'
      JOIN communities c ON c.id = p.community_id
      LEFT JOIN user_profiles pr ON pr.user_id = p.author_id
      GROUP BY p.id
      ORDER BY reports_count DESC, p.created_at DESC
      LIMIT 40
    `).all() as any[];

    const communities = db.prepare(`
      SELECT c.id, c.name, c.acronym, c.category, c.member_count, c.location,
             (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.created_at >= datetime('now', '-72 hours')) as active_posts_count,
             (SELECT COUNT(*) FROM reports r
              JOIN posts p ON p.id = r.target_id AND r.target_type = 'post'
              WHERE p.community_id = c.id AND r.status = 'pending') as pending_reports_count
      FROM communities c
      ORDER BY pending_reports_count DESC, active_posts_count DESC, c.member_count DESC
      LIMIT 40
    `).all() as any[];

    return {
      flaggedPosts: flaggedPosts.map((f) => ({
        postId: f.post_id,
        communityId: f.community_id,
        communityName: f.community_name,
        communityAcronym: f.community_acronym,
        authorHandle: f.author_handle || '@student',
        content: String(f.content || '').slice(0, 280),
        isHidden: Boolean(f.is_hidden),
        reportsCount: Number(f.reports_count || 0),
        createdAt: f.created_at,
      })),
      communities: communities.map((c) => ({
        id: c.id,
        name: c.name,
        acronym: c.acronym,
        category: c.category,
        memberCount: Number(c.member_count || 0),
        location: c.location,
        activePostsCount: Number(c.active_posts_count || 0),
        pendingReportsCount: Number(c.pending_reports_count || 0),
      })),
    };
  },

  /**
   * Moderation History (scoped to moderation actions only — excludes payment/settings/backup admin ops)
   */
  getModerationHistory(modId: string, actorRole: string, scope: 'mine' | 'team' = 'mine', limit = 60) {
    this.assertCapability(modId, actorRole, 'canReviewReports');

    const safeLimit = Math.min(120, Math.max(1, limit));
    const rows = (
      scope === 'mine'
        ? db.prepare(`
            SELECT a.*, pr.name as actor_name, pr.handle as actor_handle, u.role as actor_role
            FROM admin_audit_logs a
            LEFT JOIN user_profiles pr ON pr.user_id = a.admin_id
            LEFT JOIN users u ON u.id = a.admin_id
            WHERE a.admin_id = ?
            ORDER BY a.created_at DESC
            LIMIT ?
          `).all(modId, safeLimit)
        : db.prepare(`
            SELECT a.*, pr.name as actor_name, pr.handle as actor_handle, u.role as actor_role
            FROM admin_audit_logs a
            LEFT JOIN user_profiles pr ON pr.user_id = a.admin_id
            LEFT JOIN users u ON u.id = a.admin_id
            WHERE a.action LIKE 'MODERATOR_%'
               OR a.action LIKE 'RESOLVE_REPORT_%'
               OR a.action IN ('HIDE_POST', 'UNHIDE_POST', 'ISSUE_WARNING')
            ORDER BY a.created_at DESC
            LIMIT ?
          `).all(safeLimit)
    ) as any[];

    return rows.map((r) => ({
      id: r.id,
      actorId: r.admin_id,
      actorName: r.actor_name || 'Moderator',
      actorHandle: r.actor_handle || '@moderator',
      actorRole: r.actor_role || 'moderator',
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      metadata: (() => {
        try {
          return r.metadata_json ? JSON.parse(r.metadata_json) : null;
        } catch {
          return null;
        }
      })(),
      createdAt: r.created_at,
    }));
  },
};
