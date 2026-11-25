-- ============================================================
-- STAGE 3C DATABASE MIGRATION (ADDITIVE & NON-DESTRUCTIVE)
-- Run ONLY after taking a WAL checkpoint + backup snapshot!
-- Adds ceremony purpose scoping to webauthn_challenges and
-- single-use hashed Method B passkey recovery tokens.
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- 1. Add explicit ceremony purpose scoping to webauthn_challenges so login,
--    registration, re-authentication, and Method B recovery challenges cannot be cross-replayed.
ALTER TABLE webauthn_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_purpose
  ON webauthn_challenges(challenge, ceremony_type, purpose);

-- 2. Single-use hashed tokens issued ONLY after verified WebAuthn assertion in Method B recovery
CREATE TABLE IF NOT EXISTS passkey_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkey_recovery_expires
  ON passkey_recovery_tokens(expires_at);

COMMIT;
PRAGMA foreign_keys = ON;
