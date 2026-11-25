-- ============================================================
-- STAGE 3B ROLLBACK SCRIPT
-- Preferred full rollback: stop server and restore pre-migration backup snapshot
-- (e.g. cp data/schoolbackdoor.db.pre3b.bak data/schoolbackdoor.db).
-- Schema-level rollback below drops Stage 3B/3C additive tables cleanly.
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

DROP TABLE IF EXISTS webauthn_challenges;
DROP TABLE IF EXISTS webauthn_credentials;
DROP TABLE IF EXISTS bot_challenges;
DROP TABLE IF EXISTS account_lockouts;
DROP TABLE IF EXISTS recovery_codes;

-- Note: Rows with email IS NULL cannot satisfy the legacy NOT NULL constraint
-- unless restored from backup or assigned placeholder legacy values before reverting users.email.
COMMIT;
PRAGMA foreign_keys = ON;
