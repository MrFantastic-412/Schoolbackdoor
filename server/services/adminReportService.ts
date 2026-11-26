import { db } from '../db/database.js';
import { cache } from '../utils/cache.js';
import { sseManager } from '../realtime/sseManager.js';
import { adminSecurityService } from './adminSecurityService.js';
import { notificationService } from './notificationService.js';

export const adminReportService = {
  createReport(reporterId: string, input: {
    target_type: 'post' | 'comment' | 'user' | 'chat';
    target_id: string;
    reason: string;
    details?: string;
  }) {
    const allowedTypes = new Set(['post', 'comment', 'user', 'chat']);
    if (!input || !allowedTypes.has(input.target_type)) {
      throw new Error('Invalid report target type.');
    }
    const targetId = String(input.target_id || '').trim();
    if (!targetId) {
      throw new Error('Report target ID is required.');
    }
    const cleanReason = String(input.reason || '').trim().slice(0, 120);
    if (cleanReason.length < 3) {
      throw new Error('Please select or provide a clear reason for reporting.');
    }
    const cleanDetails = input.details ? String(input.details).trim().slice(0, 600) : null;

    let targetSnippet = '';
    if (input.target_type === 'post') {
      const post = db
        .prepare('SELECT id, content FROM posts WHERE id = ?')
        .get(targetId) as { id: string; content: string } | undefined;
      if (!post) {
        throw new Error('The post you are trying to report no longer exists or has expired.');
      }
      targetSnippet = String(post.content || '').trim().slice(0, 80);
    } else if (input.target_type === 'comment') {
      const comment = db
        .prepare('SELECT id, content FROM comments WHERE id = ?')
        .get(targetId) as { id: string; content: string } | undefined;
      if (!comment) {
        throw new Error('The comment you are trying to report no longer exists.');
      }
      targetSnippet = String(comment.content || '').trim().slice(0, 80);
    } else if (input.target_type === 'user') {
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
      if (!user) {
        throw new Error('The account you are trying to report no longer exists.');
      }
    } else if (input.target_type === 'chat') {
      const chat = db.prepare('SELECT id, title FROM chats WHERE id = ?').get(targetId) as { id: string; title: string } | undefined;
      if (!chat) {
        throw new Error('The conversation you are trying to report no longer exists.');
      }
      targetSnippet = String(chat.title || '').trim().slice(0, 80);
    }

    const existingPending = db
      .prepare(
        `SELECT id FROM reports
         WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'
         LIMIT 1`
      )
      .get(reporterId, input.target_type, targetId) as { id: string } | undefined;

    if (existingPending) {
      throw new Error('You have already reported this content and it is awaiting Admin review.');
    }

    const id = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, reporterId, input.target_type, targetId, cleanReason, cleanDetails);

    const reporterProfile = db
      .prepare('SELECT name, handle FROM user_profiles WHERE user_id = ?')
      .get(reporterId) as { name?: string; handle?: string } | undefined;

    const enrichedReport = {
      id,
      reporter_id: reporterId,
      reporter_name: reporterProfile?.name || 'Student',
      reporter_handle: reporterProfile?.handle || '@student',
      target_type: input.target_type,
      target_id: targetId,
      reason: cleanReason,
      details: cleanDetails || undefined,
      status: 'pending' as const,
      created_at: nowIso,
      updated_at: nowIso,
    };

    // Notify all active Admins in-app & push live alert to Admin Dashboard via SSE
    const adminRows = db
      .prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")
      .all() as Array<{ id: string }>;

    const modRows = db
      .prepare(`
        SELECT u.id
        FROM users u
        LEFT JOIN moderator_permissions mp ON mp.user_id = u.id
        WHERE u.role = 'moderator' AND u.status = 'active' AND COALESCE(mp.can_review_reports, 1) = 1
      `)
      .all() as Array<{ id: string }>;

    const reporterLabel = reporterProfile?.handle || reporterProfile?.name || 'A student';
    const snippetSuffix = targetSnippet ? ` — "${targetSnippet}${targetSnippet.length >= 80 ? '...' : ''}"` : '';

    if (adminRows.length > 0) {
      const adminIds = adminRows.map((a) => a.id);
      notificationService.createNotificationsBatch(
        adminIds.map((adminId) => ({
          userId: adminId,
          type: 'system',
          title: `Flagged ${input.target_type} report`,
          body: `${reporterLabel} flagged a ${input.target_type} for "${cleanReason}"${snippetSuffix}`,
          link: '/admin?section=moderation',
        }))
      );
      sseManager.broadcastToUsers(adminIds, 'admin:report:new', enrichedReport);
    }

    if (modRows.length > 0) {
      const modIds = modRows.map((m) => m.id);
      notificationService.createNotificationsBatch(
        modIds.map((modId) => ({
          userId: modId,
          type: 'system',
          title: `Moderation queue: flagged ${input.target_type}`,
          body: `${reporterLabel} reported a ${input.target_type} for "${cleanReason}"${snippetSuffix}`,
          link: '/mod',
        }))
      );
      sseManager.broadcastToUsers(modIds, 'mod:report:new', enrichedReport);
    }

    cache.invalidatePrefix('admin:');

    return enrichedReport;
  },

  getAllReports(status?: string) {
    const query = status
      ? `SELECT r.*, pr.name as reporter_name, pr.handle as reporter_handle,
                esc.handle as escalated_by_handle, rev.handle as reviewed_by_handle
         FROM reports r
         JOIN user_profiles pr ON pr.user_id = r.reporter_id
         LEFT JOIN user_profiles esc ON esc.user_id = r.escalated_by
         LEFT JOIN user_profiles rev ON rev.user_id = r.reviewed_by
         WHERE r.status = ?
         ORDER BY COALESCE(r.escalated_to_admin, 0) DESC, r.created_at DESC`
      : `SELECT r.*, pr.name as reporter_name, pr.handle as reporter_handle,
                esc.handle as escalated_by_handle, rev.handle as reviewed_by_handle
         FROM reports r
         JOIN user_profiles pr ON pr.user_id = r.reporter_id
         LEFT JOIN user_profiles esc ON esc.user_id = r.escalated_by
         LEFT JOIN user_profiles rev ON rev.user_id = r.reviewed_by
         ORDER BY COALESCE(r.escalated_to_admin, 0) DESC, r.created_at DESC`;

    const rows = (status ? db.prepare(query).all(status) : db.prepare(query).all()) as any[];
    return rows.map((r) => ({
      ...r,
      escalated_to_admin: Boolean(r.escalated_to_admin),
    }));
  },

  updateReportStatus(
    reportId: string,
    adminId: string,
    status: 'reviewed' | 'dismissed' | 'resolved',
    resolutionNotes?: string,
    actionTaken?: string
  ) {
    const allowedStatuses = new Set(['reviewed', 'dismissed', 'resolved']);
    if (!allowedStatuses.has(status)) {
      throw new Error('Invalid report status. Allowed values: reviewed, dismissed, resolved.');
    }
    const cleanNotes =
      typeof resolutionNotes === 'string' && resolutionNotes.trim()
        ? resolutionNotes.trim().slice(0, 500)
        : null;
    const cleanAction =
      typeof actionTaken === 'string' && actionTaken.trim()
        ? actionTaken.trim().slice(0, 120)
        : null;

    const res = db.prepare(`
      UPDATE reports
      SET status = ?,
          resolution_notes = ?,
          action_taken = COALESCE(?, action_taken),
          reviewed_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, cleanNotes, cleanAction, adminId, reportId);

    if (!res.changes) {
      throw new Error('Report not found.');
    }

    adminSecurityService.logAdminAction(adminId, `RESOLVE_REPORT_${status.toUpperCase()}`, 'report', reportId, {
      resolutionNotes: cleanNotes,
      ...(cleanAction ? { actionTaken: cleanAction } : {}),
    });
    cache.invalidatePrefix('admin:');

    return { success: true, reportId, status, ...(cleanAction ? { actionTaken: cleanAction } : {}) };
  },

  getAuditLogs(limit = 50) {
    return adminSecurityService.getAuditLogs(limit);
  },

  getPlatformStats() {
    const usersCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any)?.c || 0;
    const postsCount = (db.prepare('SELECT COUNT(*) as c FROM posts').get() as any)?.c || 0;
    const commentsCount = (db.prepare('SELECT COUNT(*) as c FROM comments').get() as any)?.c || 0;
    const communitiesCount = (db.prepare('SELECT COUNT(*) as c FROM communities').get() as any)?.c || 0;
    const messagesCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c || 0;
    const pendingReportsCount = (db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'").get() as any)?.c || 0;

    return {
      usersCount,
      postsCount,
      commentsCount,
      communitiesCount,
      messagesCount,
      pendingReportsCount,
      database: 'SQLite (Node 22 native DatabaseSync)',
      status: 'healthy',
    };
  },
};
