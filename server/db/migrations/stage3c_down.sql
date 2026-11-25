-- ============================================================
-- STAGE 3C ROLLBACK SCRIPT
-- Preferred full rollback: stop server and restore pre-migration backup snapshot
-- (e.g. cp data/schoolbackdoor.db.pre3c.bak data/schoolbackdoor.db).
-- Schema-level rollback below drops Stage 3C additive structures cleanly.
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_passkey_recovery_expires;
DROP TABLE IF EXISTS passkey_recovery_tokens;
DROP INDEX IF EXISTS idx_webauthn_challenges_purpose;

-- Optional: remove webauthn_challenges.purpose on SQLite >= 3.35 if reverting completely:
-- ALTER TABLE webauthn_challenges DROP COLUMN purpose;

COMMIT;
PRAGMA foreign_keys = ON;
