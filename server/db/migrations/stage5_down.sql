-- ============================================================
-- STAGE 5 ROLLBACK SCRIPT
--
-- Preferred full rollback: stop server and restore pre-migration backup snapshot:
--   cp data/schoolbackdoor.db.pre5.bak data/schoolbackdoor.db
--
-- Schema-level rollback below drops Stage 5 indexes, tables, and columns cleanly
-- (SQLite >= 3.35.0 required for DROP COLUMN).
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_appeals_user_status;
DROP INDEX IF EXISTS idx_admin_audit_target;
DROP INDEX IF EXISTS idx_admin_audit_created;
DROP INDEX IF EXISTS idx_deletion_requests_user;
DROP INDEX IF EXISTS idx_communities_chat;
DROP INDEX IF EXISTS idx_communities_creator;
DROP INDEX IF EXISTS idx_reports_assigned;
DROP INDEX IF EXISTS idx_reports_target;
DROP INDEX IF EXISTS idx_reports_reporter;

DROP INDEX IF EXISTS idx_job_locks_expires;
DROP INDEX IF EXISTS idx_media_assets_thumb;
DROP INDEX IF EXISTS idx_media_assets_context_created;
DROP INDEX IF EXISTS idx_media_assets_deleted;
DROP INDEX IF EXISTS idx_media_assets_owner;

DROP INDEX IF EXISTS idx_messages_sender;
DROP INDEX IF EXISTS idx_messages_chat_active;
DROP INDEX IF EXISTS idx_messages_deleted_at;

DROP INDEX IF EXISTS idx_comments_author_active;
DROP INDEX IF EXISTS idx_comments_parent_active;
DROP INDEX IF EXISTS idx_comments_post_active;
DROP INDEX IF EXISTS idx_comments_deleted_at;

DROP INDEX IF EXISTS idx_posts_author_active;
DROP INDEX IF EXISTS idx_posts_community_active;
DROP INDEX IF EXISTS idx_posts_active_feed;
DROP INDEX IF EXISTS idx_posts_deleted_at;

DROP TABLE IF EXISTS job_locks;
DROP TABLE IF EXISTS media_assets;

ALTER TABLE messages DROP COLUMN deleted_at;
ALTER TABLE comments DROP COLUMN deleted_at;
ALTER TABLE posts DROP COLUMN deleted_at;

COMMIT;
PRAGMA foreign_keys = ON;
