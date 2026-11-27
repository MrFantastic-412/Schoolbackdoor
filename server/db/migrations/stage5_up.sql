-- ============================================================
-- STAGE 5 DATABASE MIGRATION (ADDITIVE & NON-DESTRUCTIVE)
--
-- MANDATORY BACKUP STEP FIRST (run BEFORE executing this migration):
--   sqlite3 data/schoolbackdoor.db "PRAGMA wal_checkpoint(TRUNCATE); .backup 'data/schoolbackdoor.db.pre5.bak'"
--   # Or trigger an AES-256-GCM snapshot via POST /api/admin/backups
--
-- Adds:
-- 1. UTC `deleted_at` soft-delete columns on `posts`, `comments`, and `messages`
-- 2. `media_assets` table (upload metadata, EXIF stripping flag, compression sizes, soft-delete `deleted_at`)
-- 3. `job_locks` table (atomic DB concurrency lock to prevent overlapping cleanup runs)
-- 4. Missing performance & integrity indexes across soft-delete, reports, communities, audits & deletion tables
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- 1. Soft-delete columns (UTC ISO timestamps; NULL = active)
ALTER TABLE posts ADD COLUMN deleted_at DATETIME DEFAULT NULL;
ALTER TABLE comments ADD COLUMN deleted_at DATETIME DEFAULT NULL;
ALTER TABLE messages ADD COLUMN deleted_at DATETIME DEFAULT NULL;

-- 2. First-class media metadata & soft-delete tracking
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  thumb_filename TEXT,
  owner_id TEXT,
  context_type TEXT NOT NULL DEFAULT 'upload' CHECK(context_type IN ('profile', 'post', 'comment', 'chat', 'upload')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  original_byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  exif_stripped INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 3. Persistent DB-backed distributed lock for scheduled cleanup jobs
CREATE TABLE IF NOT EXISTS job_locks (
  job_name TEXT PRIMARY KEY,
  locked_by TEXT NOT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- 4. Soft-delete, media, lock, and missing foreign-key/lookup indexes
CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_posts_active_feed ON posts(deleted_at, is_hidden, is_announcement DESC, is_pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_community_active ON posts(community_id, deleted_at, is_hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author_active ON posts(author_id, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_deleted_at ON comments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_post_active ON comments(post_id, deleted_at, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_parent_active ON comments(parent_comment_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_author_active ON comments(author_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat_active ON messages(chat_id, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON media_assets(owner_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_deleted ON media_assets(deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_context_created ON media_assets(context_type, created_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_thumb ON media_assets(thumb_filename);

CREATE INDEX IF NOT EXISTS idx_job_locks_expires ON job_locks(expires_at);

-- Missing lookup/join indexes identified in Stage 5 DB audit
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_assigned ON reports(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_communities_creator ON communities(creator_id);
CREATE INDEX IF NOT EXISTS idx_communities_chat ON communities(chat_id);
CREATE INDEX IF NOT EXISTS idx_deletion_requests_user ON user_deletion_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_appeals_user_status ON appeals(user_id, status);

COMMIT;
PRAGMA foreign_keys = ON;
