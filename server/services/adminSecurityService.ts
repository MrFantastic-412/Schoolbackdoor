import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  db,
  runInTransaction,
  checkpointDatabase,
  withReadConnection,
  closeReadPool,
  reopenReadPool,
  DB_FILE,
  DB_DIR,
  BACKUP_DIR,
  TMP_DIR,
} from '../db/database.js';
import { UserRole } from '../middleware/auth.js';
import { presenceService } from './presenceService.js';
import { sseManager } from '../realtime/sseManager.js';
import { cache } from '../utils/cache.js';
import { fileService } from './fileService.js';
import { deletionService } from './deletionService.js';

// Ensure backups directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const BACKUP_ENC_MAGIC = Buffer.from('SBDBENC1', 'utf8'); // 8-byte header for AES-256-GCM encrypted backups

function safeJsonParse(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBackupEncryptionKey(): Buffer {
  const envKey = process.env.SCHOOLBACKDOOR_BACKUP_KEY;
  if (envKey && envKey.trim()) {
    const trimmed = envKey.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    return crypto.createHash('sha256').update(trimmed).digest();
  }

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const keyFile = path.join(DB_DIR, '.backup-key');
  if (fs.existsSync(keyFile)) {
    const rawHex = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(rawHex)) {
      return Buffer.from(rawHex, 'hex');
    }
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
  return generated;
}

function encryptBackupBuffer(plainBytes: Buffer): Buffer {
  const key = getBackupEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_ENC_MAGIC, iv, authTag, encrypted]);
}

function decryptBackupBuffer(storedBytes: Buffer): Buffer {
  if (storedBytes.length >= BACKUP_ENC_MAGIC.length + 28 && storedBytes.subarray(0, 8).equals(BACKUP_ENC_MAGIC)) {
    const key = getBackupEncryptionKey();
    const iv = storedBytes.subarray(8, 20);
    const authTag = storedBytes.subarray(20, 36);
    const ciphertext = storedBytes.subarray(36);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  // Legacy unencrypted snapshot fallback
  return storedBytes;
}

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ['*'], // Single unified Admin role with full authorized platform control
  moderator: [
    'reports:review',
    'content:hide',
    'users:warn',
    'users:restrict',
    'communities:review',
    'reports:escalate',
  ],
  staff: ['announcements:create'],
  student: [],
};

export const adminSecurityService = {
  /**
   * Check if a given role has a specific permission
   */
  hasPermission(role: UserRole | string, permission: string): boolean {
    const perms = ROLE_PERMISSIONS[role as UserRole] || [];
    if (perms.includes('*')) return true;
    return perms.includes(permission);
  },

  /**
   * Log administrative audit action
   */
  logAdminAction(
    adminId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: any,
    ipAddress?: string
  ) {
    // Resolve adminId to a valid user in users table to satisfy FOREIGN KEY constraint
    let validAdminId = adminId;
    const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(adminId);
    if (!userExists) {
      const fallbackStaff = db.prepare("SELECT id FROM users WHERE role IN ('admin', 'staff') LIMIT 1").get() as any;
      validAdminId = fallbackStaff?.id || 'u-admin';
    }

    const id = `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    db.prepare(`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_type, target_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      validAdminId,
      action,
      targetType,
      targetId,
      metadata ? JSON.stringify({ ...metadata, originalActor: adminId, ip: ipAddress || 'local' }) : null
    );
    return id;
  },

  /**
   * Retrieve recent administrative audit logs
   */
  getAuditLogs(limit = 50) {
    const rows = db.prepare(`
      SELECT a.*, pr.name as admin_name, pr.handle as admin_handle
      FROM admin_audit_logs a
      LEFT JOIN user_profiles pr ON pr.user_id = a.admin_id
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      adminId: r.admin_id,
      adminName: r.admin_name || 'System Custodian',
      adminHandle: r.admin_handle || '@THEBACKDOOR',
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      metadata: safeJsonParse(r.metadata_json),
      createdAt: r.created_at,
    }));
  },

  /**
   * Executes a background maintenance job and records run telemetry in background_jobs_log
   */
  runTrackedJob<T>(jobName: string, fn: () => { recordsAffected: number; result: T }): T {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const startMs = Date.now();
    db.prepare(`
      INSERT INTO background_jobs_log (id, job_name, status, records_affected, duration_ms, started_at)
      VALUES (?, ?, 'running', 0, 0, CURRENT_TIMESTAMP)
    `).run(jobId, jobName);

    try {
      const { recordsAffected, result } = fn();
      const durationMs = Math.max(0, Date.now() - startMs);
      db.prepare(`
        UPDATE background_jobs_log
        SET status = 'completed', records_affected = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(recordsAffected, durationMs, jobId);
      cache.invalidatePrefix('admin:dashboard');
      return result;
    } catch (err: any) {
      const durationMs = Math.max(0, Date.now() - startMs);
      db.prepare(`
        UPDATE background_jobs_log
        SET status = 'failed', duration_ms = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(durationMs, String(err?.message || 'Unknown job failure').slice(0, 500), jobId);
      cache.invalidatePrefix('admin:dashboard');
      throw err;
    }
  },

  /**
   * Get real-data administrative dashboard statistics (protected by RBAC)
   */
  getDashboardStatistics() {
    return cache.getOrCompute('admin:dashboard:stats', 5000, () => {
      const dbStartNs = process.hrtime.bigint();
      const counts = withReadConnection((conn) => {
        const totalUsers = (conn.prepare('SELECT COUNT(*) as c FROM users').get() as any)?.c || 0;
        const activeStudents = (conn.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active' AND role = 'student'").get() as any)?.c || 0;
        const suspendedUsers = (conn.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'suspended'").get() as any)?.c || 0;
        const staffCount = (conn.prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('admin', 'staff')").get() as any)?.c || 0;

        const dau = (conn.prepare(`
          SELECT COUNT(DISTINCT id) as c FROM users
          WHERE COALESCE(last_active_at, created_at) >= datetime('now', '-1 day')
            OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-1 day'))
        `).get() as any)?.c || 0;

        const wau = (conn.prepare(`
          SELECT COUNT(DISTINCT id) as c FROM users
          WHERE COALESCE(last_active_at, created_at) >= datetime('now', '-7 days')
            OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-7 days'))
        `).get() as any)?.c || 0;

        const mau = (conn.prepare(`
          SELECT COUNT(DISTINCT id) as c FROM users
          WHERE COALESCE(last_active_at, created_at) >= datetime('now', '-30 days')
            OR id IN (SELECT user_id FROM user_presence WHERE last_seen_at >= datetime('now', '-30 days'))
        `).get() as any)?.c || 0;

        const newReg24h = (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-1 day')").get() as any)?.c || 0;
        const newReg7d = (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-7 days')").get() as any)?.c || 0;
        const newReg30d = (conn.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now', '-30 days')").get() as any)?.c || 0;

        const postsCount = (conn.prepare('SELECT COUNT(*) as c FROM posts').get() as any)?.c || 0;
        const commentsCount = (conn.prepare('SELECT COUNT(*) as c FROM comments').get() as any)?.c || 0;
        const communitiesCount = (conn.prepare('SELECT COUNT(*) as c FROM communities').get() as any)?.c || 0;
        const groupsCount = (conn.prepare("SELECT COUNT(*) as c FROM chats WHERE type = 'group'").get() as any)?.c || 0;
        const messagesCount = (conn.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c || 0;

        const posts24h = (conn.prepare("SELECT COUNT(*) as c FROM posts WHERE created_at >= datetime('now', '-1 day')").get() as any)?.c || 0;
        const comments24h = (conn.prepare("SELECT COUNT(*) as c FROM comments WHERE created_at >= datetime('now', '-1 day')").get() as any)?.c || 0;
        const messages24h = (conn.prepare("SELECT COUNT(*) as c FROM messages WHERE created_at >= datetime('now', '-1 day')").get() as any)?.c || 0;

        const reportsTotal = (conn.prepare('SELECT COUNT(*) as c FROM reports').get() as any)?.c || 0;
        const pendingReports = (conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'").get() as any)?.c || 0;
        const reviewedReports = (conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status IN ('reviewed', 'under_review')").get() as any)?.c || 0;
        const resolvedReports = (conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'resolved'").get() as any)?.c || 0;
        const dismissedReports = (conn.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'dismissed'").get() as any)?.c || 0;

        const warningsCount = (conn.prepare('SELECT COUNT(*) as c FROM user_warnings').get() as any)?.c || 0;
        const appealsTotal = (conn.prepare('SELECT COUNT(*) as c FROM appeals').get() as any)?.c || 0;
        const pendingAppeals = (conn.prepare("SELECT COUNT(*) as c FROM appeals WHERE status IN ('pending', 'under_review')").get() as any)?.c || 0;
        const tombstonesCount = (conn.prepare('SELECT COUNT(*) as c FROM deletion_tombstones').get() as any)?.c || 0;
        const lastPurgeRecord = conn.prepare("SELECT metadata_json, created_at FROM admin_audit_logs WHERE action = 'PURGE_72H_LIFECYCLE' ORDER BY created_at DESC LIMIT 1").get() as any;

        return {
          totalUsers, activeStudents, suspendedUsers, staffCount,
          dau, wau, mau, newReg24h, newReg7d, newReg30d,
          postsCount, commentsCount, communitiesCount, groupsCount, messagesCount,
          posts24h, comments24h, messages24h,
          reportsTotal, pendingReports, reviewedReports, resolvedReports, dismissedReports,
          warningsCount, appealsTotal, pendingAppeals, tombstonesCount, lastPurgeRecord,
        };
      });

      const {
        totalUsers, activeStudents, suspendedUsers, staffCount,
        dau, wau, mau, newReg24h, newReg7d, newReg30d,
        postsCount, commentsCount, communitiesCount, groupsCount, messagesCount,
        posts24h, comments24h, messages24h,
        reportsTotal, pendingReports, reviewedReports, resolvedReports, dismissedReports,
        warningsCount, appealsTotal, pendingAppeals, tombstonesCount, lastPurgeRecord,
      } = counts;

      const online = presenceService.getAdminBreakdown();
      const detailedStorage = deletionService.getDetailedStorageMetrics({ skipProtectionAutoSweep: true });
      const dbSizeBytes = detailedStorage.breakdown.databaseBytes;
      const walSizeBytes = detailedStorage.breakdown.walBytes;
      const backupsBytes = detailedStorage.breakdown.backupsBytes;
      const mediaSizeBytes = detailedStorage.breakdown.mediaBytes;
      const totalStorageBytes = detailedStorage.totalUsedBytes;
      const pendingExpiredMessages = detailedStorage.expiredContent.pendingExpiredMessages;
      const pendingExpiredPosts = detailedStorage.expiredContent.pendingExpiredPosts;
      const pendingUserDeletions = detailedStorage.expiredContent.pendingUserDeletions;

      // Background jobs telemetry
      const failedJobsCount = (db.prepare("SELECT COUNT(*) as c FROM background_jobs_log WHERE status = 'failed'").get() as any)?.c || 0;
      const failedJobs24h = (db.prepare("SELECT COUNT(*) as c FROM background_jobs_log WHERE status = 'failed' AND started_at >= datetime('now', '-1 day')").get() as any)?.c || 0;
      const recentJobs = db.prepare(`
        SELECT id, job_name, status, records_affected, duration_ms, error_message, started_at, completed_at
        FROM background_jobs_log
        ORDER BY started_at DESC
        LIMIT 12
      `).all() as any[];

      const dbLatencyMs = Number((Number(process.hrtime.bigint() - dbStartNs) / 1_000_000).toFixed(2));
      const memUsage = process.memoryUsage();
      const cacheStats = cache.getStats();

      return {
        users: {
          total: totalUsers,
          activeStudents,
          suspended: suspendedUsers,
          staff: staffCount,
          onlineVisible: online.visibleOnlineCount,
          onlineTotal: online.totalAuthenticatedOnlineCount,
          activeClientSessions: online.activeClientSessions,
          dau,
          wau,
          mau,
          newRegistrations24h: newReg24h,
          newRegistrations7d: newReg7d,
          newRegistrations30d: newReg30d,
        },
        content: {
          posts: postsCount,
          comments: commentsCount,
          communities: communitiesCount,
          groups: groupsCount,
          messages: messagesCount,
          posts24h,
          comments24h,
          messages24h,
        },
        moderation: {
          reportsTotal,
          reportsPending: pendingReports,
          reportsUnderReview: reviewedReports,
          reportsResolved: resolvedReports,
          reportsDismissed: dismissedReports,
          warningsIssued: warningsCount,
          appealsTotal,
          appealsPending: pendingAppeals,
        },
        storage: {
          databaseBytes: dbSizeBytes,
          databaseFormatted: (dbSizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
          walBytes: walSizeBytes,
          walFormatted: (walSizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
          backupsBytes,
          backupsFormatted: (backupsBytes / (1024 * 1024)).toFixed(2) + ' MB',
          estimatedMediaBytes: mediaSizeBytes,
          estimatedMediaFormatted: (mediaSizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
          totalBytes: totalStorageBytes,
          totalFormatted: (totalStorageBytes / (1024 * 1024)).toFixed(2) + ' MB',
          quotaBytes: detailedStorage.quotaBytes,
          usagePercent: detailedStorage.usagePercent,
          alertLevel: detailedStorage.alertLevel,
          storageProtectionMode: detailedStorage.storageProtectionMode,
        },
        deletionJobs: {
          accountDeletionsProcessed: tombstonesCount,
          pendingExpiredMessages,
          pendingExpiredPosts,
          pendingUserDeletions,
          totalPendingDeletions: pendingExpiredMessages + pendingExpiredPosts + pendingUserDeletions,
          lastPurgeAt: lastPurgeRecord?.created_at || 'Automatic (Scheduled)',
          retentionPolicy: '72-Hour Ephemeral Lifecycle for All Posts, Comments, Likes, Media & Messages',
        },
        jobs: {
          failedJobsCount,
          failedJobs24h,
          recentJobs: recentJobs.map((j) => ({
            id: j.id,
            jobName: j.job_name,
            status: j.status,
            recordsAffected: j.records_affected,
            durationMs: j.duration_ms,
            errorMessage: j.error_message || undefined,
            startedAt: j.started_at,
            completedAt: j.completed_at || undefined,
          })),
        },
        system: {
          status: failedJobs24h > 3 ? 'degraded' : 'healthy',
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          databaseEngine: 'SQLite 3 WAL (Node 22 native DatabaseSync)',
          dbLatencyMs,
          memoryRssMb: Number((memUsage.rss / (1024 * 1024)).toFixed(1)),
          heapUsedMb: Number((memUsage.heapUsed / (1024 * 1024)).toFixed(1)),
          activeSseConnections: sseManager.getTotalConnectionCount(),
          activeSseUniqueUsers: sseManager.getConnectedUserCount(),
          cacheHitRatePercent: cacheStats.hitRatePercent,
          cacheEntries: cacheStats.entries,
        },
      };
    });
  },

  /**
   * Issue formal account warning to a student
   */
  issueWarning(
    adminId: string,
    adminRole: string,
    userId: string,
    reason: string,
    severity: 'minor' | 'standard' | 'severe' = 'standard',
    details?: string
  ) {
    if (!this.hasPermission(adminRole, 'users:warn')) {
      throw new Error('Forbidden. Insufficient permissions to issue account warnings.');
    }

    const targetUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId) as
      | { id: string; role: string }
      | undefined;
    if (!targetUser) {
      throw new Error('User not found.');
    }
    if (targetUser.id === adminId || targetUser.role === 'admin') {
      throw new Error('Forbidden. Cannot issue warnings to an Admin account.');
    }

    const cleanReason = String(reason || '').trim().slice(0, 300);
    if (cleanReason.length < 3) {
      throw new Error('Warning reason must be at least 3 characters.');
    }
    const allowedSeverity = new Set(['minor', 'standard', 'severe']);
    const cleanSeverity = allowedSeverity.has(severity) ? severity : 'standard';
    const cleanDetails = typeof details === 'string' && details.trim() ? details.trim().slice(0, 600) : null;

    const warningId = `warn-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    runInTransaction(() => {
      db.prepare(`
        INSERT INTO user_warnings (id, user_id, admin_id, reason, severity, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(warningId, userId, adminId, cleanReason, cleanSeverity, cleanDetails);

      db.prepare(`
        UPDATE users SET warnings_count = COALESCE(warnings_count, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(userId);

      // Create high-visibility in-app notice for the student
      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, link)
        VALUES (?, ?, 'system', 'Community Guideline Notice', ?, '/settings')
      `).run(
        `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId,
        `Academic Integrity Notice: A ${cleanSeverity} warning has been issued regarding your recent activity (${cleanReason}). Review our Community Guidelines.`
      );

      this.logAdminAction(adminId, 'ISSUE_WARNING', 'user', userId, {
        warningId,
        reason: cleanReason,
        severity: cleanSeverity,
        details: cleanDetails,
      });
    });

    return {
      success: true,
      warningId,
      userId,
      reason: cleanReason,
      severity: cleanSeverity,
      issuedAt: new Date().toISOString(),
    };
  },

  /**
   * Temporarily suspend a user account
   */
  suspendUser(
    adminId: string,
    adminRole: string,
    userId: string,
    durationDays = 7,
    reason = 'Violation of Campus Guidelines'
  ) {
    if (!this.hasPermission(adminRole, 'users:suspend')) {
      throw new Error('Forbidden. Insufficient permissions to suspend accounts.');
    }

    const parsedDays = Math.floor(Number(durationDays));
    if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > 365) {
      throw new Error('Suspension duration must be between 1 and 365 days.');
    }
    const cleanReason = String(reason || '').trim().slice(0, 300) || 'Violation of Campus Guidelines';

    const targetUser = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(userId) as any;
    if (!targetUser) throw new Error('User not found.');

    // Prevent self-suspension or suspension of an Admin account by non-Admin
    if (targetUser.id === adminId) {
      throw new Error('Forbidden. Administrators cannot suspend their own active account.');
    }
    if (targetUser.role === 'admin' && adminRole !== 'admin') {
      throw new Error('Forbidden. Only an Admin can manage Admin accounts.');
    }

    const suspendedUntil = new Date(Date.now() + parsedDays * 24 * 60 * 60 * 1000).toISOString();

    runInTransaction(() => {
      // 1. Update status
      db.prepare(`
        UPDATE users
        SET status = 'suspended',
            suspension_reason = ?,
            suspended_until = ?,
            suspended_by = ?
        WHERE id = ?
      `).run(cleanReason, suspendedUntil, adminId, userId);

      // 2. Kill all active sessions immediately
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

      // 3. Log audit action
      this.logAdminAction(adminId, 'SUSPEND_USER', 'user', userId, {
        durationDays: parsedDays,
        reason: cleanReason,
        suspendedUntil,
      });
    });

    return {
      success: true,
      userId,
      status: 'suspended',
      suspendedUntil,
      reason: cleanReason,
    };
  },

  /**
   * Lift user account suspension
   */
  unsuspendUser(adminId: string, adminRole: string, userId: string, reason = 'Suspension resolved or appeal granted') {
    if (!this.hasPermission(adminRole, 'users:unsuspend')) {
      throw new Error('Forbidden. Insufficient permissions to lift account suspensions.');
    }

    const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!targetUser) {
      throw new Error('User not found.');
    }

    const cleanReason = String(reason || '').trim().slice(0, 300) || 'Suspension resolved or appeal granted';

    db.prepare(`
      UPDATE users
      SET status = 'active',
          suspension_reason = NULL,
          suspended_until = NULL,
          suspended_by = NULL,
          account_restricted_until = NULL,
          restriction_reason = NULL,
          restricted_by = NULL
      WHERE id = ?
    `).run(userId);

    this.logAdminAction(adminId, 'UNSUSPEND_USER', 'user', userId, { reason: cleanReason });

    return { success: true, userId, status: 'active', reason: cleanReason };
  },

  /**
   * Submit an appeal from a student
   */
  submitAppeal(
    userId: string,
    type: 'suspension' | 'warning' | 'content_removal',
    statement: string,
    targetId?: string
  ) {
    if (!statement || statement.trim().length < 10) {
      throw new Error('Please provide a substantive statement for your appeal (at least 10 characters).');
    }

    const appealId = `appeal-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    db.prepare(`
      INSERT INTO appeals (id, user_id, type, target_id, statement, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(appealId, userId, type, targetId || null, statement.trim());

    return {
      id: appealId,
      userId,
      type,
      statement: statement.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  },

  /**
   * Review an appeal (Admin/Moderator)
   */
  reviewAppeal(
    adminId: string,
    adminRole: string,
    appealId: string,
    status: 'accepted' | 'rejected',
    reviewNotes?: string
  ) {
    if (!this.hasPermission(adminRole, 'appeals:review')) {
      throw new Error('Forbidden. Insufficient permissions to review student appeals.');
    }

    const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId) as any;
    if (!appeal) throw new Error('Appeal not found.');

    runInTransaction(() => {
      db.prepare(`
        UPDATE appeals
        SET status = ?, review_notes = ?, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, reviewNotes || null, adminId, appealId);

      // If accepted suspension appeal, automatically unsuspend the student!
      if (status === 'accepted' && appeal.type === 'suspension') {
        db.prepare(`
          UPDATE users
          SET status = 'active', suspension_reason = NULL, suspended_until = NULL
          WHERE id = ?
        `).run(appeal.user_id);
      }

      // Notify user
      db.prepare(`
        INSERT INTO notifications (id, user_id, type, title, body, link)
        VALUES (?, ?, 'system', 'Moderation Appeal Verdict', ?, '/settings')
      `).run(
        `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        appeal.user_id,
        `Your appeal regarding ${appeal.type} has been ${status.toUpperCase()}. Notes: ${reviewNotes || 'Action processed by moderation committee.'}`
      );

      this.logAdminAction(adminId, `REVIEW_APPEAL_${status.toUpperCase()}`, 'appeal', appealId, {
        verdict: status,
        reviewNotes,
        userId: appeal.user_id,
      });
    });

    return { success: true, appealId, status, reviewNotes };
  },

  /**
   * List student appeals
   */
  getAppeals(status?: string) {
    const query = status
      ? `SELECT a.*, pr.name as student_name, pr.handle as student_handle
         FROM appeals a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN user_profiles pr ON pr.user_id = a.user_id
         WHERE a.status = ?
         ORDER BY a.created_at DESC`
      : `SELECT a.*, pr.name as student_name, pr.handle as student_handle
         FROM appeals a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN user_profiles pr ON pr.user_id = a.user_id
         ORDER BY a.created_at DESC`;

    const rows = (status ? db.prepare(query).all(status) : db.prepare(query).all()) as any[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      studentName: r.student_name || 'Student',
      studentHandle: r.student_handle || '@futa_student',
      type: r.type,
      targetId: r.target_id,
      statement: r.statement,
      status: r.status,
      reviewNotes: r.review_notes,
      reviewedBy: r.reviewed_by,
      createdAt: r.created_at,
    }));
  },

  /**
   * Staff roster and role management
   */
  getStaffRoster() {
    const rows = db.prepare(`
      SELECT u.id, u.matric_number, u.role, u.status, u.created_at,
             pr.name, pr.handle, pr.department
      FROM users u
      LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE u.role IN ('admin', 'moderator', 'staff')
      ORDER BY CASE u.role
        WHEN 'admin' THEN 1
        WHEN 'moderator' THEN 2
        WHEN 'staff' THEN 3
        ELSE 4 END
    `).all() as any[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name || 'Staff Member',
      handle: r.handle || '@staff',
      matricNumber: r.matric_number,
      department: r.department || 'Platform Governance',
      role: r.role as UserRole,
      status: r.status,
      permissions: ROLE_PERMISSIONS[r.role as UserRole] || [],
      createdAt: r.created_at,
    }));
  },

  /**
   * Assign or revoke Admin / Moderator / Staff / Student role.
   * STRICT CHECK: Only authenticated Admin can assign roles. Normal users can never elevate themselves.
   */
  assignStaffRole(
    adminId: string,
    adminRole: string,
    targetUserId: string,
    newRole: UserRole
  ) {
    if (adminRole !== 'admin') {
      throw new Error('Forbidden. Only an Admin can assign or modify platform roles.');
    }

    const validRoles: UserRole[] = ['admin', 'moderator', 'staff', 'student'];
    if (!validRoles.includes(newRole)) {
      throw new Error(`Invalid role: ${newRole}. Allowed roles: admin, moderator, staff, student.`);
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetUserId) as any;
    if (!target) throw new Error('User not found.');

    // Prevent leaving platform without any Admin
    if (target.role === 'admin' && newRole !== 'admin') {
      const adminCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND status = 'active'").get() as any)?.c || 0;
      if (adminCount <= 1) {
        throw new Error('Forbidden. At least one active Admin account must remain on the platform.');
      }
    }

    db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newRole, targetUserId);

    // Ensure default moderator_permissions row exists if promoted to moderator, or clean up if demoted
    if (newRole === 'moderator') {
      db.prepare(`
        INSERT OR IGNORE INTO moderator_permissions (
          user_id, assigned_by, can_review_reports, can_hide_content, can_warn_users,
          can_restrict_users, max_restriction_hours, can_review_communities, can_escalate
        ) VALUES (?, ?, 1, 1, 1, 1, 72, 1, 1)
      `).run(targetUserId, adminId);
    } else {
      db.prepare('DELETE FROM moderator_permissions WHERE user_id = ?').run(targetUserId);
    }

    this.logAdminAction(adminId, 'ASSIGN_ROLE', 'user', targetUserId, {
      previousRole: target.role,
      newRole,
    });
    cache.invalidatePrefix('admin:');

    return {
      success: true,
      userId: targetUserId,
      previousRole: target.role,
      newRole,
    };
  },

  /**
   * Input Sanitization helper to protect against Cross-Site Scripting (XSS)
   */
  sanitizeText(input: string): string {
    if (!input) return '';
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
      .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
      .replace(/<applet\b[^<]*(?:(?!<\/applet>)<[^<]*)*<\/applet>/gi, '')
      .replace(/on\w+\s*=\s*(['\"]).*?\1/gi, '') // Remove on*= event handlers
      .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/javascript\s*:/gi, 'blocked-scheme:');
  },

  /**
   * File upload restriction & validation
   */
  validateFileUpload(dataUrl: string, declaredMimeType: string, maxSizeBytes = 20 * 1024 * 1024) {
    if (!dataUrl) {
      throw new Error('No image payload provided.');
    }

    // Supported formats
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(declaredMimeType.toLowerCase())) {
      throw new Error('Unsupported image format. Allowed formats: JPEG, PNG, WebP.');
    }

    // Size calculation from base64
    const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
    const approximateBytes = Math.floor((base64Data.length * 3) / 4) - padding;

    if (approximateBytes > maxSizeBytes) {
      const limitMb = Number((maxSizeBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, ''));
      const err = new Error(
        `Image exceeds the maximum upload size of ${limitMb}MB. Please choose a JPEG, PNG, or WebP image up to ${limitMb}MB.`
      );
      (err as any).status = 413;
      (err as any).code = 'IMAGE_TOO_LARGE';
      throw err;
    }

    return {
      valid: true,
      mimeType: declaredMimeType,
      approximateBytes,
    };
  },

  /**
   * Bot protection check (Honeypot + velocity)
   */
  verifyBotProtection(body: Record<string, any>): boolean {
    // If the hidden honeypot field is filled, reject as bot submission
    if (body._hp_security_check || body.website_url || body.bot_trap) {
      return false;
    }
    return true;
  },

  /**
   * Run 72-Hour Ephemeral Retention Purge Job
   * Permanently purges all posts, comments, likes, notifications, uploads, temp/cache artifacts, and messages older than 72 hours.
   */
  run72HourPurgeJob(adminId = 'u-system-job') {
    return this.runTrackedJob('purge_72h_lifecycle', () => {
      const summary = deletionService.run72HourExpirySweep(adminId);
      const recordsAffected =
        summary.messagesPurged +
        summary.postsPurged +
        summary.commentsPurged +
        summary.likesPurged +
        summary.notificationsPurged +
        summary.filesDeleted +
        summary.backupsPurged;
      return {
        recordsAffected,
        result: summary,
      };
    });
  },

  /**
   * Permanent Account Deletion ("Right to be Forgotten" / NDPA 2023)
   * Deletes all PII, social data, sessions, and owned upload files while retaining only
   * anonymized financial/tax accounting records (`retained_accounting_records`) + tombstone.
   */
  deleteUserPermanently(targetUserId: string, authorizedActorId: string, reason = 'User requested permanent erasure') {
    const user = db.prepare('SELECT id, matric_number, username, role FROM users WHERE id = ?').get(targetUserId) as any;
    if (!user) {
      throw new Error('User not found or already permanently deleted.');
    }

    if (user.role === 'admin' && authorizedActorId !== targetUserId) {
      throw new Error('Forbidden. Admin accounts cannot be deleted by other accounts without self-confirmation.');
    }

    const reqId = `delreq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO user_deletion_requests (id, user_id, status, requested_at)
      VALUES (?, ?, 'processing', CURRENT_TIMESTAMP)
    `).run(reqId, targetUserId);

    try {
      // Collect upload media references before row deletion
      const candidateMedia: string[] = [];
      const userProfile = db.prepare('SELECT avatar_url, avatar_thumb_url FROM user_profiles WHERE user_id = ?').get(targetUserId) as any;
      if (userProfile?.avatar_url) {
        candidateMedia.push(...fileService.extractUploadFilenames(userProfile.avatar_url));
      }
      if (userProfile?.avatar_thumb_url) {
        candidateMedia.push(...fileService.extractUploadFilenames(userProfile.avatar_thumb_url));
      }
      for (const p of db.prepare('SELECT images_json FROM posts WHERE author_id = ? AND images_json IS NOT NULL').all(targetUserId) as any[]) {
        candidateMedia.push(...fileService.extractUploadFilenames(p.images_json));
      }
      for (const c of db.prepare('SELECT images_json FROM comments WHERE author_id = ? AND images_json IS NOT NULL').all(targetUserId) as any[]) {
        candidateMedia.push(...fileService.extractUploadFilenames(c.images_json));
      }
      for (const m of db.prepare('SELECT images_json FROM messages WHERE sender_id = ? AND images_json IS NOT NULL').all(targetUserId) as any[]) {
        candidateMedia.push(...fileService.extractUploadFilenames(m.images_json));
      }

      const outcome = runInTransaction(() => {
        const userHash = crypto.createHash('sha256').update(`${user.id}:${user.matric_number || ''}`).digest('hex');

        // Archive strictly anonymized payment records (zero PII) for statutory/tax accounting in ONE set-based query
        const retainedRes = db.prepare(`
          INSERT OR IGNORE INTO retained_accounting_records (
            id, payment_id, user_id_hash, reference, amount_kobo, currency,
            channel, purpose, status, paid_at, retention_until
          )
          SELECT
            ('ret-' || id),
            id,
            ?,
            reference,
            amount_kobo,
            COALESCE(currency, 'NGN'),
            channel,
            purpose,
            status,
            COALESCE(paid_at, created_at),
            datetime('now', '+7 years')
          FROM payments
          WHERE user_id = ?
        `).run(userHash, targetUserId);
        const retainedAccountingRows = Number(retainedRes.changes || 0);

        db.prepare('DELETE FROM user_presence_clients WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM user_presence WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM notifications WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM post_views WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM post_shares WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM likes WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM comments WHERE author_id = ?').run(targetUserId);
        db.prepare('DELETE FROM messages WHERE sender_id = ?').run(targetUserId);
        db.prepare('DELETE FROM posts WHERE author_id = ?').run(targetUserId);
        db.prepare('DELETE FROM chat_participants WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM community_memberships WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').run(targetUserId, targetUserId);
        db.prepare('DELETE FROM user_warnings WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM appeals WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM payments WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM saved_locations WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM location_search_history WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(targetUserId);
        db.prepare("DELETE FROM reports WHERE reporter_id = ? OR (target_type = 'user' AND target_id = ?)").run(targetUserId, targetUserId);
        db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

        const tombstoneId = `tomb-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        db.prepare(`
          INSERT INTO deletion_tombstones (id, user_id_hash, reason, records_purged)
          VALUES (?, ?, ?, 19)
        `).run(tombstoneId, userHash, reason);

        let effectiveAdminId = authorizedActorId;
        if (authorizedActorId === targetUserId) {
          const staff = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as any;
          effectiveAdminId = staff?.id || 'u-admin';
        }

        this.logAdminAction(effectiveAdminId, 'PERMANENT_ACCOUNT_DELETION', 'user', targetUserId, {
          tombstoneId,
          userHash,
          reason,
          retainedAccountingRows,
          deletedBySelf: authorizedActorId === targetUserId,
        });

        db.prepare(`
          UPDATE user_deletion_requests
          SET status = 'completed', completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(reqId);

        return {
          success: true,
          deletedUserId: targetUserId,
          tombstoneId,
          retainedAccountingRows,
          status: 'permanently_erased',
          message: 'All personal data, posts, comments, messages, uploaded files, and active credentials have been permanently wiped.',
        };
      });

      const fileCleanup = fileService.unlinkIfUnreferenced(candidateMedia);
      checkpointDatabase();
      cache.invalidatePrefix('posts:');
      cache.invalidatePrefix('presence:');
      cache.invalidatePrefix('admin:dashboard');

      return {
        ...outcome,
        filesDeleted: fileCleanup.deletedCount,
      };
    } catch (err: any) {
      db.prepare(`
        UPDATE user_deletion_requests
        SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(String(err?.message || 'Erasure failed').slice(0, 500), reqId);
      throw err;
    }
  },

  /**
   * Create AES-256-GCM encrypted & SHA-256 checksum-protected database backup snapshot (14-day retention)
   */
  createBackup(adminId: string, adminRole: string) {
    if (!this.hasPermission(adminRole, 'backup:create')) {
      throw new Error('Forbidden. Insufficient permissions to create database backups.');
    }

    const timestamp = Date.now();
    const backupFilename = `schoolbackdoor-backup-${timestamp}.db.enc`;
    const targetPath = path.join(BACKUP_DIR, backupFilename);
    const plainTempPath = path.join(TMP_DIR, `backup-stage-${timestamp}.db`);

    if (!fs.existsSync(DB_FILE)) {
      throw new Error('Primary database file not found.');
    }

    // Remove expired backups automatically before creating a fresh encrypted snapshot
    const expiredBackups = db
      .prepare('SELECT id, filename FROM backup_snapshots WHERE expires_at <= CURRENT_TIMESTAMP')
      .all() as Array<{ id: string; filename: string }>;
    if (expiredBackups.length > 0) {
      for (const eb of expiredBackups) {
        const fp = path.join(BACKUP_DIR, path.basename(eb.filename));
        if (fs.existsSync(fp)) {
          try {
            fs.unlinkSync(fp);
          } catch {
            // ignore
          }
        }
      }
      const expPlaceholders = expiredBackups.map(() => '?').join(', ');
      db.prepare(`DELETE FROM backup_snapshots WHERE id IN (${expPlaceholders})`).run(
        ...expiredBackups.map((b) => b.id)
      );
    }

    // 1. Flush WAL frames so snapshot captures all committed transactions, copy to temp, encrypt AES-256-GCM
    checkpointDatabase();
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }
    fs.copyFileSync(DB_FILE, plainTempPath);
    let encryptedBuffer: Buffer;
    try {
      const plainBytes = fs.readFileSync(plainTempPath);
      encryptedBuffer = encryptBackupBuffer(plainBytes);
      fs.writeFileSync(targetPath, encryptedBuffer, { mode: 0o600 });
    } finally {
      if (fs.existsSync(plainTempPath)) {
        try {
          fs.unlinkSync(plainTempPath);
        } catch {
          // ignore
        }
      }
    }

    // 2. Compute SHA-256 checksum over encrypted artifact on disk & file size
    const checksum = crypto.createHash('sha256').update(encryptedBuffer).digest('hex');
    const sizeBytes = encryptedBuffer.length;

    // 3. Document 14-day retention expiry
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const snapshotId = `snap-${timestamp}`;

    db.prepare(`
      INSERT INTO backup_snapshots (id, filename, size_bytes, checksum, expires_at, created_by, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      backupFilename,
      sizeBytes,
      checksum,
      expiresAt,
      adminId,
      JSON.stringify({
        retentionDays: 14,
        encryption: 'AES-256-GCM Authenticated Application Encryption',
        accessPolicy: 'Authorized Admin Only (0600)',
      })
    );

    this.logAdminAction(adminId, 'CREATE_BACKUP_SNAPSHOT', 'backup', snapshotId, {
      filename: backupFilename,
      sizeBytes,
      checksum,
      expiresAt,
      encrypted: true,
    });

    return {
      id: snapshotId,
      filename: backupFilename,
      sizeBytes,
      sizeFormatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
      checksum,
      createdAt: new Date(timestamp).toISOString(),
      expiresAt,
      retentionPolicy: '14-Day Automated Rotation (AES-256-GCM Encrypted)',
    };
  },

  /**
   * List available database backups
   */
  getBackups() {
    const rows = db.prepare('SELECT * FROM backup_snapshots ORDER BY created_at DESC').all() as any[];
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      sizeBytes: r.size_bytes,
      sizeFormatted: (r.size_bytes / (1024 * 1024)).toFixed(2) + ' MB',
      checksum: r.checksum,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      createdBy: r.created_by,
      metadata: safeJsonParse(r.metadata_json),
    }));
  },

  /**
   * Restore database from encrypted backup with SHA-256 integrity verification & Tombstone Reconciliation
   * Ensures that any users or records deleted after the snapshot are NOT resurrected!
   */
  restoreBackup(adminId: string, adminRole: string, snapshotId: string) {
    if (adminRole !== 'admin') {
      throw new Error('Forbidden. Only an Admin can initiate database restoration.');
    }

    const snapshot = db.prepare('SELECT * FROM backup_snapshots WHERE id = ?').get(snapshotId) as any;
    if (!snapshot) throw new Error('Backup snapshot not found.');

    const snapshotPath = path.join(BACKUP_DIR, path.basename(snapshot.filename));
    if (!fs.existsSync(snapshotPath)) {
      throw new Error('Backup snapshot file missing from storage.');
    }

    // 1. Verify SHA-256 checksum integrity on the stored bytes prior to decryption/restoration
    const snapshotBuffer = fs.readFileSync(snapshotPath);
    const actualChecksum = crypto.createHash('sha256').update(snapshotBuffer).digest('hex');
    if (snapshot.checksum && actualChecksum !== snapshot.checksum) {
      throw new Error('Backup integrity check failed: SHA-256 checksum mismatch.');
    }

    // 2. Decrypt AES-256-GCM payload into a transient 0600 file inside TMP_DIR
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }
    const decryptedTempPath = path.join(TMP_DIR, `restore-${snapshotId}-${Date.now()}.db`);
    const decryptedBuffer = decryptBackupBuffer(snapshotBuffer);
    fs.writeFileSync(decryptedTempPath, decryptedBuffer, { mode: 0o600 });

    // Load active tombstones before restore
    const tombstones = db.prepare('SELECT user_id_hash FROM deletion_tombstones').all() as Array<{ user_id_hash: string }>;
    const tombstoneHashes = new Set(tombstones.map((t) => t.user_id_hash));

    // Attach decrypted snapshot cleanly on the live WAL connection after closing read handles
    closeReadPool();
    const escapedPath = decryptedTempPath.replace(/'/g, "''");
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`ATTACH DATABASE '${escapedPath}' AS snap_restore;`);

    let reconciledCount = 0;
    try {
      const snapTables = (
        db.prepare(`SELECT name FROM snap_restore.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      const mainTables = new Set(
        (
          db.prepare(`SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>
        ).map((r) => r.name)
      );

      reconciledCount = runInTransaction(() => {
        for (const tbl of snapTables) {
          if (!mainTables.has(tbl) || tbl === 'deletion_tombstones' || tbl === 'backup_snapshots' || tbl === 'retained_accounting_records') {
            continue;
          }
          const mainCols = (db.prepare(`PRAGMA main.table_info("${tbl}")`).all() as Array<{ name: string }>).map((c) => c.name);
          const snapCols = new Set(
            (db.prepare(`PRAGMA snap_restore.table_info("${tbl}")`).all() as Array<{ name: string }>).map((c) => c.name)
          );
          const commonCols = mainCols.filter((c) => snapCols.has(c)).map((c) => `"${c}"`);
          if (commonCols.length === 0) continue;

          db.exec(`DELETE FROM main."${tbl}";`);
          db.exec(`INSERT INTO main."${tbl}" (${commonCols.join(', ')}) SELECT ${commonCols.join(', ')} FROM snap_restore."${tbl}";`);
        }

        // Reconciliation: Prune any resurrected records matching active deletion tombstones in batched DELETEs
        const allRestoredUsers = db.prepare('SELECT id, matric_number FROM users').all() as any[];
        const prunedIds: string[] = [];
        for (const u of allRestoredUsers) {
          const hash = crypto.createHash('sha256').update(`${u.id}:${u.matric_number || ''}`).digest('hex');
          if (tombstoneHashes.has(hash)) {
            prunedIds.push(u.id);
          }
        }
        if (prunedIds.length > 0) {
          const ph = prunedIds.map(() => '?').join(', ');
          db.prepare(`DELETE FROM user_presence_clients WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM user_presence WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM sessions WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM notifications WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM likes WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM comments WHERE author_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM messages WHERE sender_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM posts WHERE author_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM saved_locations WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM location_search_history WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM user_profiles WHERE user_id IN (${ph})`).run(...prunedIds);
          db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...prunedIds);
        }
        return prunedIds.length;
      });
    } finally {
      try {
        db.exec('DETACH DATABASE snap_restore;');
      } catch {
        // ignore detach error
      }
      db.exec('PRAGMA foreign_keys = ON;');
      if (fs.existsSync(decryptedTempPath)) {
        try {
          fs.unlinkSync(decryptedTempPath);
        } catch {
          // ignore
        }
      }
      checkpointDatabase();
      reopenReadPool();
    }

    cache.clear();

    this.logAdminAction(adminId, 'RESTORE_BACKUP_SNAPSHOT', 'backup', snapshotId, {
      reconciledPrunedUsers: reconciledCount,
    });

    return {
      success: true,
      snapshotId,
      reconciledPrunedUsers: reconciledCount,
      message: `Database restored and reconciled against ${tombstones.length} deletion tombstones. Resurrected purged users: ${reconciledCount}.`,
    };
  },
};
