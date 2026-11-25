-- ============================================================
-- STAGE 3B DATABASE MIGRATION (ADDITIVE & NON-DESTRUCTIVE)
-- Run ONLY after taking a WAL checkpoint + backup snapshot!
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- 1. Make users.email optional legacy data & add recovery code metadata
CREATE TABLE IF NOT EXISTS users_stage3b (
  id TEXT PRIMARY KEY,
  matric_number TEXT UNIQUE NOT NULL,
  email TEXT,
  phone_number TEXT,
  username TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student', 'staff', 'admin', 'moderator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'pending_verification')),
  is_verified INTEGER DEFAULT 0,
  verification_code TEXT,
  suspension_reason TEXT,
  suspended_until DATETIME,
  suspended_by TEXT,
  last_active_at DATETIME,
  mfa_enabled INTEGER DEFAULT 0,
  mfa_secret TEXT,
  account_restricted_until DATETIME,
  restriction_reason TEXT,
  restricted_by TEXT,
  warnings_count INTEGER DEFAULT 0,
  accepted_terms_at DATETIME,
  accepted_terms_version TEXT,
  last_reauthenticated_at DATETIME,
  recovery_codes_generated_at DATETIME,
  recovery_codes_remaining INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_stage3b (
  id, matric_number, email, phone_number, username, password_hash,
  role, status, is_verified, verification_code,
  suspension_reason, suspended_until, suspended_by, last_active_at,
  mfa_enabled, mfa_secret, account_restricted_until, restriction_reason,
  restricted_by, warnings_count, accepted_terms_at, accepted_terms_version,
  last_reauthenticated_at, created_at, updated_at
)
SELECT
  id, matric_number, email, phone_number, username, password_hash,
  role, status, COALESCE(is_verified, 0), verification_code,
  suspension_reason, suspended_until, suspended_by, last_active_at,
  COALESCE(mfa_enabled, 0), mfa_secret, account_restricted_until, restriction_reason,
  restricted_by, COALESCE(warnings_count, 0), accepted_terms_at, accepted_terms_version,
  last_reauthenticated_at, created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_stage3b RENAME TO users;

DROP INDEX IF EXISTS idx_users_email_lower;
CREATE INDEX IF NOT EXISTS idx_users_matric ON users(matric_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username)) WHERE username IS NOT NULL;

-- 2. Track authentication method on sessions
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';

-- 3. Single-use hashed recovery codes
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at DATETIME,
  invalidated_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_active ON recovery_codes(user_id, used_at, invalidated_at);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_hash ON recovery_codes(code_hash);

-- 4. Shared DB account lockout state (temporary cooldowns, anti-victim-DoS)
CREATE TABLE IF NOT EXISTS account_lockouts (
  account_key TEXT PRIMARY KEY,
  user_id TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at DATETIME,
  last_failed_at DATETIME,
  locked_until DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_lockouts_user ON account_lockouts(user_id);

-- 5. Shared DB Proof-of-Work bot challenges (zero personal data)
CREATE TABLE IF NOT EXISTS bot_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL DEFAULT 'register',
  nonce TEXT UNIQUE NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 14,
  ip_address TEXT,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_challenges_expires ON bot_challenges(expires_at);

-- 6. WebAuthn tables (prepared additively for Stage 3C)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  label TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_creds_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  challenge TEXT UNIQUE NOT NULL,
  ceremony_type TEXT NOT NULL CHECK(ceremony_type IN ('registration', 'authentication')),
  rp_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

COMMIT;
PRAGMA foreign_keys = ON;
