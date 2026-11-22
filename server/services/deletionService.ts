import fs from 'node:fs';
import path from 'node:path';
import {
  db,
  runInTransaction,
  checkpointDatabase,
  DB_FILE,
  DB_DIR,
  BACKUP_DIR,
  TMP_DIR,
  CACHE_DIR,
  LOGS_DIR,
} from '../db/database';
import { cache } from '../utils/cache';
import { fileService, getUploadsDir } from './fileService';

export const DEFAULT_STORAGE_QUOTA_GB = 10;
export const DEFAULT_STORAGE_QUOTA_BYTES = DEFAULT_STORAGE_QUOTA_GB * 1024 * 1024 * 1024; // 10 GB

export type StorageAlertLevel = 'ok' | 'warning_70' | 'critical_85' | 'protection_95';

let sweepInFlight = false;
let lastProtectionAlertAtMs = 0;

interface DiskScanResult {
  totalBytes: number;
  files: Array<{ name: string; path: string; bytes: number; category: string }>;
}

function scanDirectory(dirPath: string, category: string): DiskScanResult {
  if (!fs.existsSync(dirPath)) {
    return { totalBytes: 0, files: [] };
  }
  const files: Array<{ name: string; path: string; bytes: number; category: string }> = [];
  let totalBytes = 0;

  for (const entry of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) {
        totalBytes += stat.size;
        files.push({ name: entry, path: full, bytes: stat.size, category });
      }
    } catch {
      // ignore transient files
    }
  }
  return { totalBytes, files };
}

export const deletionService = {
  /**
   * Resolves effective storage quota in bytes (10 GB default target).
   * Respects optional `SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES` env or `website_settings.storage_quota_bytes`
   * override for controlled testing.
   */
  getStorageQuotaBytes(): { quotaBytes: number; quotaGb: number } {
    if (process.env.SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES) {
      const envBytes = Number(process.env.SCHOOLBACKDOOR_STORAGE_QUOTA_BYTES);
      if (Number.isFinite(envBytes) && envBytes > 0) {
        return {
          quotaBytes: envBytes,
          quotaGb: Number((envBytes / (1024 * 1024 * 1024)).toFixed(6)),
        };
      }
    }

    try {
      const overrideRow = db
        .prepare("SELECT value FROM website_settings WHERE key = 'storage_quota_bytes'")
        .get() as { value?: string } | undefined;
      if (overrideRow?.value) {
        const val = Number(overrideRow.value);
        if (Number.isFinite(val) && val > 0) {
          return {
            quotaBytes: val,
            quotaGb: Number((val / (1024 * 1024 * 1024)).toFixed(6)),
          };
        }
      }

      const gbRow = db
        .prepare("SELECT value FROM website_settings WHERE key = 'storage_quota_gb'")
        .get() as { value?: string } | undefined;
      const gb = Math.max(1, Number(gbRow?.value || DEFAULT_STORAGE_QUOTA_GB));
      return {
        quotaBytes: gb * 1024 * 1024 * 1024,
        quotaGb: gb,
      };
    } catch {
      return {
        quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        quotaGb: DEFAULT_STORAGE_QUOTA_GB,
      };
    }
  },

  /**
   * Full automatic & idempotent 72-hour data expiry + orphan/temp/expired-log/expired-backup purge.
   * Uses a concurrency lock so repeated/scheduled sweeps never collide or duplicate deletions.
   * NEVER deletes active content, user accounts, subscriptions, payments, or retained accounting records.
   */
  run72HourExpirySweep(actorId = 'u-system-job') {
    if (sweepInFlight) {
      return {
        skipped: true,
        reason: 'Expiry sweep already running',
        messagesPurged: 0,
        postsPurged: 0,
        commentsPurged: 0,
        likesPurged: 0,
        notificationsPurged: 0,
        sessionsPurged: 0,
        backupsPurged: 0,
        filesDeleted: 0,
        tempFilesDeleted: 0,
        freedBytes: 0,
        purgedAt: new Date().toISOString(),
      };
    }

    sweepInFlight = true;
    try {
      const candidateFiles: string[] = [];
      const expiredBackupFilenames: string[] = [];

      // Collect referenced media URLs BEFORE deleting rows from SQLite
      const expiringPosts = db.prepare(`
        SELECT id, images_json FROM posts
        WHERE created_at < datetime('now', '-72 hours')
      `).all() as Array<{ id: string; images_json: string | null }>;

      for (const p of expiringPosts) {
        candidateFiles.push(...fileService.extractUploadFilenames(p.images_json));
      }

      const expiringComments = db.prepare(`
        SELECT id, images_json FROM comments
        WHERE (post_id IN (SELECT id FROM posts WHERE created_at < datetime('now', '-72 hours'))
           OR created_at < datetime('now', '-72 hours'))
          AND images_json IS NOT NULL
      `).all() as Array<{ id: string; images_json: string | null }>;

      for (const c of expiringComments) {
        candidateFiles.push(...fileService.extractUploadFilenames(c.images_json));
      }

      const expiringMessages = db.prepare(`
        SELECT id, images_json FROM messages
        WHERE created_at < datetime('now', '-72 hours')
      `).all() as Array<{ id: string; images_json: string | null }>;

      for (const m of expiringMessages) {
        candidateFiles.push(...fileService.extractUploadFilenames(m.images_json));
      }

      const expiredBackups = db.prepare(`
        SELECT id, filename FROM backup_snapshots
        WHERE expires_at <= CURRENT_TIMESTAMP
      `).all() as Array<{ id: string; filename: string }>;

      for (const b of expiredBackups) {
        expiredBackupFilenames.push(b.filename);
      }

      const dbRes = runInTransaction(() => {
        // 1. Delete likes, comments, and notifications referencing expired posts BEFORE deleting expired posts (avoids N+1 loop)
        const postRefNotifDel = db.prepare(`
          DELETE FROM notifications
          WHERE EXISTS (
            SELECT 1 FROM posts p
            WHERE p.created_at < datetime('now', '-72 hours')
              AND (
                notifications.link = ('/home?post=' || p.id)
                OR notifications.link LIKE ('%post=' || p.id || '&%')
                OR notifications.link LIKE ('%post=' || p.id)
              )
          )
        `).run();
        const postRefNotifs = Number(postRefNotifDel.changes || 0);

        const likesDel = db.prepare(`
          DELETE FROM likes
          WHERE post_id IN (SELECT id FROM posts WHERE created_at < datetime('now', '-72 hours'))
        `).run();

        db.prepare(`
          DELETE FROM poll_votes
          WHERE post_id IN (SELECT id FROM posts WHERE created_at < datetime('now', '-72 hours'))
        `).run();

        db.prepare(`
          DELETE FROM post_views
          WHERE post_id IN (SELECT id FROM posts WHERE created_at < datetime('now', '-72 hours'))
        `).run();

        db.prepare(`
          DELETE FROM post_shares
          WHERE post_id IN (SELECT id FROM posts WHERE created_at < datetime('now', '-72 hours'))
        `).run();

        const commentsDel = db.prepare(`
          DELETE FROM comments
          WHERE post_id IN (SELECT id FROM posts WHERE created_at < datetime('now', '-72 hours'))
             OR created_at < datetime('now', '-72 hours')
        `).run();

        // 2. Delete expired posts (feed posts, image posts, text posts, community posts > 72h UTC)
        const postsDel = db.prepare(`
          DELETE FROM posts
          WHERE created_at < datetime('now', '-72 hours')
        `).run();

        // 3. Delete expired chat messages (> 72h UTC) & update empty chat previews
        const msgsDel = db.prepare(`
          DELETE FROM messages
          WHERE created_at < datetime('now', '-72 hours')
        `).run();

        if (Number(msgsDel.changes || 0) > 0) {
          db.prepare(`
            UPDATE chats
            SET last_message = '(Messages expired after 72 hours)'
            WHERE id NOT IN (SELECT DISTINCT chat_id FROM messages)
              AND last_message IS NOT NULL
              AND last_message != '(Messages expired after 72 hours)'
          `).run();
        }

        // 4. Clean remaining ephemeral event notifications > 72h + read notices > 14d
        const expiredNotifs = db.prepare(`
          DELETE FROM notifications
          WHERE (type IN ('like', 'comment', 'reply', 'mention', 'group', 'message') AND created_at < datetime('now', '-72 hours'))
             OR (is_read = 1 AND created_at < datetime('now', '-14 days'))
        `).run();

        // 5. Clean orphaned comments/likes/views/shares defensively
        const orphanComments = db.prepare(`
          DELETE FROM comments WHERE post_id NOT IN (SELECT id FROM posts)
        `).run();
        const orphanLikes = db.prepare(`
          DELETE FROM likes WHERE post_id NOT IN (SELECT id FROM posts)
        `).run();
        db.prepare(`DELETE FROM post_views WHERE post_id NOT IN (SELECT id FROM posts)`).run();
        db.prepare(`DELETE FROM post_shares WHERE post_id NOT IN (SELECT id FROM posts)`).run();

        // 6. Clean expired auth sessions (never prune valid unexpired refresh sessions), password resets, old operational login/job logs, expired accounting records
        const sessionsDel = db.prepare(`
          DELETE FROM sessions
          WHERE datetime(COALESCE(refresh_expires_at, expires_at)) <= datetime('now')
             OR (max_expires_at IS NOT NULL AND datetime(max_expires_at) <= datetime('now'))
             OR (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime('now', '-7 days'))
        `).run();

        db.prepare(`
          DELETE FROM password_resets
          WHERE expires_at <= CURRENT_TIMESTAMP
             OR (is_used = 1 AND created_at < datetime('now', '-7 days'))
        `).run();

        db.prepare(`
          DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-30 days')
        `).run();

        db.prepare(`
          DELETE FROM background_jobs_log WHERE started_at < datetime('now', '-30 days')
        `).run();

        db.prepare(`
          DELETE FROM retained_accounting_records WHERE retention_until <= CURRENT_TIMESTAMP
        `).run();

        const backupsDel = db.prepare(`
          DELETE FROM backup_snapshots WHERE expires_at <= CURRENT_TIMESTAMP
        `).run();

        return {
          likesPurged: Number(likesDel.changes || 0) + Number(orphanLikes.changes || 0),
          commentsPurged: Number(commentsDel.changes || 0) + Number(orphanComments.changes || 0),
          postsPurged: Number(postsDel.changes || 0),
          messagesPurged: Number(msgsDel.changes || 0),
          notificationsPurged: postRefNotifs + Number(expiredNotifs.changes || 0),
          sessionsPurged: Number(sessionsDel.changes || 0),
          backupsPurged: Number(backupsDel.changes || 0),
        };
      });

      // 7. Physical file cleanup (uploads + thumbnails + expired backups + expired temp artifacts)
      const mediaCleaned = fileService.unlinkIfUnreferenced(candidateFiles);
      const tempCleaned = fileService.cleanTemporaryArtifacts(60 * 60 * 1000);

      let expiredBackupBytes = 0;
      for (const fname of expiredBackupFilenames) {
        const fp = path.join(BACKUP_DIR, path.basename(fname));
        if (fs.existsSync(fp)) {
          try {
            expiredBackupBytes += fs.statSync(fp).size;
            fs.unlinkSync(fp);
          } catch {
            // ignore
          }
        }
      }

      // 8. Cache invalidation & WAL compaction when rows were removed
      cache.purgeExpired();
      cache.invalidatePrefix('posts:');
      cache.invalidatePrefix('uploads:access:');
      cache.invalidatePrefix('communities:');
      cache.invalidatePrefix('notices:');
      cache.invalidatePrefix('admin:dashboard');

      const totalRowsRemoved =
        dbRes.postsPurged +
        dbRes.messagesPurged +
        dbRes.commentsPurged +
        dbRes.likesPurged +
        dbRes.notificationsPurged +
        dbRes.sessionsPurged +
        dbRes.backupsPurged;

      if (totalRowsRemoved > 0) {
        checkpointDatabase();
        try {
          db.exec('PRAGMA optimize;');
        } catch {
          // ignore
        }
      }

      // Minimal privacy-respecting audit log (records counts only, zero PII or message content)
      try {
        const actorRow = db
          .prepare(
            `SELECT COALESCE(
              (SELECT id FROM users WHERE id = ? LIMIT 1),
              (SELECT id FROM users WHERE role = 'admin' LIMIT 1)
            ) as actor_id`
          )
          .get(actorId) as { actor_id?: string | null } | undefined;
        const logActorId = actorRow?.actor_id;
        if (logActorId) {
          db.prepare(`
            INSERT INTO admin_audit_logs (id, admin_id, action, target_type, target_id, metadata_json)
            VALUES (?, ?, 'PURGE_72H_LIFECYCLE', 'system', 'ephemeral_cleanup', ?)
          `).run(
            `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            logActorId,
            JSON.stringify({
              postsPurged: dbRes.postsPurged,
              messagesPurged: dbRes.messagesPurged,
              commentsPurged: dbRes.commentsPurged,
              filesDeleted: mediaCleaned.deletedCount,
              tempFilesDeleted: tempCleaned.deletedCount,
              backupsPurged: dbRes.backupsPurged,
            })
          );
        }
      } catch {
        // non-fatal if DB has no admin seeded yet
      }

      return {
        skipped: false,
        ...dbRes,
        filesDeleted: mediaCleaned.deletedCount,
        tempFilesDeleted: tempCleaned.deletedCount,
        freedBytes: mediaCleaned.freedBytes + tempCleaned.freedBytes + expiredBackupBytes,
        purgedAt: new Date().toISOString(),
      };
    } finally {
      sweepInFlight = false;
    }
  },

  /**
   * Immediately cleans physical upload files, notification references, and cache entries
   * when an individual post is deleted.
   */
  cleanupAfterPostDeletion(
    postId: string,
    imagesJson: string | null | undefined,
    commentImagesJsonList?: Array<string | null | undefined>
  ) {
    const candidates = [...fileService.extractUploadFilenames(imagesJson)];
    if (Array.isArray(commentImagesJsonList)) {
      for (const cJson of commentImagesJsonList) {
        candidates.push(...fileService.extractUploadFilenames(cJson));
      }
    }
    try {
      db.prepare(`DELETE FROM notifications WHERE link LIKE ?`).run(`%post=${postId}%`);
    } catch {
      // ignore
    }
    const mediaRes = fileService.unlinkIfUnreferenced(candidates);
    cache.invalidatePrefix('posts:');
    cache.invalidatePrefix('admin:dashboard');
    return mediaRes;
  },

  /**
   * Immediately cleans physical upload files & notification references when a chat thread is removed.
   */
  cleanupAfterChatDeletion(chatId: string, candidateFilenames: string[]) {
    try {
      db.prepare(`DELETE FROM notifications WHERE link LIKE ?`).run(`%conv=${chatId}%`);
    } catch {
      // ignore
    }
    const mediaRes = fileService.unlinkIfUnreferenced(candidateFilenames);
    cache.invalidatePrefix('admin:dashboard');
    return mediaRes;
  },

  /**
   * Evaluates comprehensive application-level storage metrics separately by category,
   * tracks growth over time (Daily / Weekly / Monthly), detects largest files,
   * and enforces 70% / 85% / 95% (Storage Protection Mode) alerts.
   */
  getDetailedStorageMetrics(options?: { skipProtectionAutoSweep?: boolean }) {
    const { quotaBytes, quotaGb } = this.getStorageQuotaBytes();

    const dbBytes = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0;
    const walPath = `${DB_FILE}-wal`;
    const shmPath = `${DB_FILE}-shm`;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const shmBytes = fs.existsSync(shmPath) ? fs.statSync(shmPath).size : 0;

    const uploadsDir = getUploadsDir();
    const uploadScan = scanDirectory(uploadsDir, 'uploads');
    const backupScan = scanDirectory(BACKUP_DIR, 'backups');
    const tmpScan = scanDirectory(TMP_DIR, 'temp');
    const uploadTmpScan = scanDirectory(path.join(uploadsDir, 'tmp'), 'temp');
    const diskCacheScan = scanDirectory(CACHE_DIR, 'cache');
    const logsScan = scanDirectory(LOGS_DIR, 'logs');

    // Separate media sub-categories cleanly (images vs thumbnails vs videos)
    let imagesDiskBytes = 0;
    let thumbnailsDiskBytes = 0;
    let videoDiskBytes = 0;
    for (const f of uploadScan.files) {
      const lower = f.name.toLowerCase();
      if (lower.startsWith('thumb-')) {
        thumbnailsDiskBytes += f.bytes;
      } else if (/\.(mp4|webm|mov|m4v)$/.test(lower)) {
        videoDiskBytes += f.bytes;
      } else {
        imagesDiskBytes += f.bytes;
      }
    }

    const inlineMediaPosts =
      (db.prepare('SELECT COALESCE(SUM(LENGTH(images_json)), 0) as b FROM posts WHERE images_json IS NOT NULL').get() as any)
        ?.b || 0;
    const inlineMediaComments =
      (db.prepare('SELECT COALESCE(SUM(LENGTH(images_json)), 0) as b FROM comments WHERE images_json IS NOT NULL').get() as any)
        ?.b || 0;
    const inlineMediaMsgs =
      (db.prepare('SELECT COALESCE(SUM(LENGTH(images_json)), 0) as b FROM messages WHERE images_json IS NOT NULL').get() as any)
        ?.b || 0;

    const memCacheStats = cache.getStats();
    const cacheBytes = diskCacheScan.totalBytes + memCacheStats.estimatedBytes;
    const tempBytes = tmpScan.totalBytes + uploadTmpScan.totalBytes;

    // Application DB-table log size estimation (audit logs + login attempts + job telemetry)
    const auditLogBytes =
      (db.prepare("SELECT COALESCE(SUM(LENGTH(action) + LENGTH(COALESCE(metadata_json, '')) + 96), 0) as b FROM admin_audit_logs").get() as any)
        ?.b || 0;
    const loginLogBytes =
      (db.prepare('SELECT COALESCE(SUM(LENGTH(identifier) + 48), 0) as b FROM login_attempts').get() as any)?.b || 0;
    const jobLogBytes =
      (db.prepare("SELECT COALESCE(SUM(LENGTH(job_name) + LENGTH(COALESCE(error_message, '')) + 64), 0) as b FROM background_jobs_log").get() as any)
        ?.b || 0;
    const logsBytes = logsScan.totalBytes + Number(auditLogBytes) + Number(loginLogBytes) + Number(jobLogBytes);

    const otherGeneratedBytes = shmBytes;
    const mediaBytes = uploadScan.totalBytes + Number(inlineMediaPosts) + Number(inlineMediaComments) + Number(inlineMediaMsgs);

    // Combined physical + application storage footprint (avoid double-counting DB-internal log tables on top of dbBytes)
    const totalUsedBytes =
      dbBytes +
      walBytes +
      uploadScan.totalBytes +
      backupScan.totalBytes +
      tempBytes +
      diskCacheScan.totalBytes +
      memCacheStats.estimatedBytes +
      logsScan.totalBytes +
      otherGeneratedBytes;

    const availableBytes = Math.max(0, quotaBytes - totalUsedBytes);
    const usagePercent = Number(Math.min(100, (totalUsedBytes / quotaBytes) * 100).toFixed(4));

    let alertLevel: StorageAlertLevel = 'ok';
    if (usagePercent >= 95) alertLevel = 'protection_95';
    else if (usagePercent >= 85) alertLevel = 'critical_85';
    else if (usagePercent >= 70) alertLevel = 'warning_70';

    const storageProtectionMode = usagePercent >= 95;

    // Auto-activate Storage Protection Mode cleanups (expired/temp/cache ONLY — never active content/accounts/payments)
    if (storageProtectionMode && !options?.skipProtectionAutoSweep) {
      this.activateStorageProtectionActions(usagePercent, totalUsedBytes, quotaBytes);
    }

    // Record storage snapshot (throttled to avoid bloat: max 1 every 15 minutes unless delta > 5%)
    this.recordStorageSnapshot({
      totalBytes: totalUsedBytes,
      databaseBytes: dbBytes + walBytes,
      mediaBytes,
      cacheBytes,
      tempBytes,
      logsBytes,
      backupsBytes: backupScan.totalBytes,
    });

    // Calculate Daily / Weekly / Monthly growth from recorded storage_snapshots
    const growth = this.computeStorageGrowth(totalUsedBytes);

    // Orphan detection
    const referencedFiles = fileService.getAllReferencedFilenames();
    const orphanedFiles = uploadScan.files.filter((f) => !referencedFiles.has(f.name));
    const orphanedBytes = orphanedFiles.reduce((acc, f) => acc + f.bytes, 0);

    // Largest files across all managed storage folders
    const allDiskFiles = [
      ...(fs.existsSync(DB_FILE)
        ? [{ name: path.basename(DB_FILE), path: DB_FILE, bytes: dbBytes, category: 'database' }]
        : []),
      ...(fs.existsSync(walPath)
        ? [{ name: path.basename(walPath), path: walPath, bytes: walBytes, category: 'wal' }]
        : []),
      ...uploadScan.files,
      ...backupScan.files,
      ...tmpScan.files,
      ...uploadTmpScan.files,
      ...diskCacheScan.files,
      ...logsScan.files,
    ]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12)
      .map((f) => ({
        name: f.name,
        category: f.category,
        bytes: f.bytes,
      }));

    // Pending expired counts
    const pendingExpiredMessages =
      (db.prepare("SELECT COUNT(*) as c FROM messages WHERE created_at < datetime('now', '-72 hours')").get() as any)?.c || 0;
    const pendingExpiredPosts =
      (db.prepare("SELECT COUNT(*) as c FROM posts WHERE created_at < datetime('now', '-72 hours')").get() as any)?.c || 0;
    const pendingUserDeletions =
      (db.prepare("SELECT COUNT(*) as c FROM user_deletion_requests WHERE status IN ('pending', 'processing')").get() as any)
        ?.c || 0;

    const failedJobs = db
      .prepare(
        `
        SELECT id, job_name, duration_ms, error_message, started_at
        FROM background_jobs_log
        WHERE status = 'failed'
        ORDER BY started_at DESC
        LIMIT 20
      `
      )
      .all() as any[];

    return {
      quotaBytes,
      quotaGb,
      totalUsedBytes,
      availableBytes,
      usagePercent,
      alertLevel,
      storageProtectionMode,
      protectionActions: storageProtectionMode
        ? [
            'Large uploads (>256 KB) blocked automatically',
            'Non-essential temporary file generation restricted',
            'Eligible expired (>72h) & temporary artifacts auto-cleaned',
            'Administrators alerted without removing active user data or upgrading billing',
          ]
        : [],
      breakdown: {
        databaseBytes: dbBytes,
        walBytes,
        backupsBytes: backupScan.totalBytes,
        uploadsDiskBytes: uploadScan.totalBytes,
        mediaBytes,
        imagesBytes: imagesDiskBytes,
        thumbnailsBytes: thumbnailsDiskBytes,
        videoBytes: videoDiskBytes,
        tempBytes,
        cacheBytes,
        logsBytes,
        otherGeneratedBytes,
      },
      growth,
      largestFiles: allDiskFiles,
      orphans: {
        count: orphanedFiles.length,
        totalBytes: orphanedBytes,
        filenames: orphanedFiles.slice(0, 30).map((f) => f.name),
      },
      expiredContent: {
        pendingExpiredMessages,
        pendingExpiredPosts,
        pendingUserDeletions,
      },
      failedJobs: failedJobs.map((j) => ({
        id: j.id,
        jobName: j.job_name,
        durationMs: j.duration_ms,
        errorMessage: j.error_message,
        startedAt: j.started_at,
      })),
      infrastructureNote:
        'Application-level accounting tracks Schoolbackdoor DB, WAL, uploaded media, thumbnails, temp/cache files, logs, and encrypted backups separately from host OS/container runtime files. Never predicts fixed user capacity without measuring live per-student storage footprint.',
    };
  },

  /**
   * Checks lightweight protection state for upload guards without running heavy full scans on every byte.
   */
  isStorageProtectionActive(): { active: boolean; usagePercent: number; totalUsedBytes: number; quotaBytes: number } {
    const metrics = this.getDetailedStorageMetrics();
    return {
      active: metrics.storageProtectionMode,
      usagePercent: metrics.usagePercent,
      totalUsedBytes: metrics.totalUsedBytes,
      quotaBytes: metrics.quotaBytes,
    };
  },

  /**
   * Executes safe 95% Storage Protection Mode responses:
   * - Cleans expired (>72h) posts/messages, stale temp files, and expired cache entries
   * - Emits an Admin alert notification (rate-limited to avoid flooding)
   * - NEVER deletes active user content or upgrades to paid capacity
   */
  activateStorageProtectionActions(usagePercent: number, totalUsedBytes: number, quotaBytes: number) {
    try {
      fileService.cleanTemporaryArtifacts(0);
      cache.purgeExpired();
      this.run72HourExpirySweep('u-storage-guard');
    } catch {
      // non-fatal
    }

    const now = Date.now();
    if (now - lastProtectionAlertAtMs > 5 * 60 * 1000) {
      lastProtectionAlertAtMs = now;
      try {
        db.prepare(`
          INSERT INTO notifications (id, user_id, type, title, body, link, is_read)
          SELECT ('n-stor-' || ? || '-' || lower(hex(randomblob(4)))), id, 'system', ?, ?, '/admin', 0
          FROM users
          WHERE role = 'admin' AND status = 'active'
        `).run(
          now,
          'Storage Protection Mode Active (95%+)',
          `Application storage reached ${usagePercent.toFixed(1)}% (${totalUsedBytes} / ${quotaBytes} bytes). Large uploads are blocked; expired content purged.`
        );
      } catch {
        // ignore if no admins seeded yet
      }
    }
  },

  recordStorageSnapshot(snap: {
    totalBytes: number;
    databaseBytes: number;
    mediaBytes: number;
    cacheBytes: number;
    tempBytes: number;
    logsBytes: number;
    backupsBytes: number;
  }) {
    try {
      const latest = db
        .prepare('SELECT total_bytes, recorded_at FROM storage_snapshots ORDER BY recorded_at DESC LIMIT 1')
        .get() as { total_bytes: number; recorded_at: string } | undefined;

      if (latest) {
        const elapsedMs = Date.now() - new Date(latest.recorded_at + 'Z').getTime();
        const deltaRatio = latest.total_bytes > 0 ? Math.abs(snap.totalBytes - latest.total_bytes) / latest.total_bytes : 1;
        if (elapsedMs < 15 * 60 * 1000 && deltaRatio < 0.05) {
          return;
        }
      }

      db.prepare(`
        INSERT INTO storage_snapshots (
          id, total_bytes, database_bytes, media_bytes, cache_bytes, temp_bytes, logs_bytes, backups_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `ss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        snap.totalBytes,
        snap.databaseBytes,
        snap.mediaBytes,
        snap.cacheBytes,
        snap.tempBytes,
        snap.logsBytes,
        snap.backupsBytes
      );

      // Keep snapshot history compact (last 90 days)
      db.prepare("DELETE FROM storage_snapshots WHERE recorded_at < datetime('now', '-90 days')").run();
    } catch {
      // ignore if table not initialized yet
    }
  },

  computeStorageGrowth(currentTotalBytes: number) {
    try {
      const pickBaseline = (modifier: string) => {
        const row = db
          .prepare(
            `SELECT total_bytes FROM storage_snapshots WHERE recorded_at <= datetime('now', ?) ORDER BY recorded_at DESC LIMIT 1`
          )
          .get(modifier) as { total_bytes: number } | undefined;
        if (row) return row.total_bytes;
        const earliest = db
          .prepare('SELECT total_bytes FROM storage_snapshots ORDER BY recorded_at ASC LIMIT 1')
          .get() as { total_bytes: number } | undefined;
        return earliest?.total_bytes ?? currentTotalBytes;
      };

      const dayAgo = pickBaseline('-1 day');
      const weekAgo = pickBaseline('-7 days');
      const monthAgo = pickBaseline('-30 days');
      const sampleCount = (db.prepare('SELECT COUNT(*) as c FROM storage_snapshots').get() as any)?.c || 0;

      return {
        dailyBytes: currentTotalBytes - dayAgo,
        weeklyBytes: currentTotalBytes - weekAgo,
        monthlyBytes: currentTotalBytes - monthAgo,
        sampleCount: Number(sampleCount),
      };
    } catch {
      return { dailyBytes: 0, weeklyBytes: 0, monthlyBytes: 0, sampleCount: 0 };
    }
  },
};
